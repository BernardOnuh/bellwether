// Example Bellwether agent: a simple momentum caller. It reads the board from the Bellwether API, looks at each
// liquid stock's last 3 hours of 15m Bitget candles, and calls LT in the direction of a strong, clean move.
// Run it on a schedule (e.g. every 30 min during US hours):
//
//   BELLWETHER_URL=https://your-host BELLWETHER_KEY=bw_... npx tsx scripts/example-agent.ts [--dry]
//
// It plays by the same rules as humans: caps, gaps, one open call per stock per board, warmup, the 65% club.
const BASE = (process.env.BELLWETHER_URL ?? 'http://localhost:8787').replace(/\/$/, '');
const KEY = process.env.BELLWETHER_KEY ?? '';
const DRY = process.argv.includes('--dry');

async function api(path: string, body?: unknown) {
  const r = await fetch(BASE + path, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() as any };
}

async function momentum(symbol: string) {
  const r = await fetch(`https://api.bitget.com/api/v3/market/candles?category=USDT-FUTURES&symbol=${symbol}&interval=15m&limit=13`);
  const rows = ((await r.json()) as { data: string[][] }).data.map((x) => ({ ts: +x[0], c: +x[4] })).sort((a, b) => a.ts - b.ts);
  const closes = rows.map((x) => x.c);
  const move = closes.at(-1)! / closes[0] - 1;
  const ups = closes.slice(1).filter((c, i) => c > closes[i]).length / (closes.length - 1);
  return { move, ups };
}

const me = await api('/api/v1/me');
if (me.status !== 200) throw new Error(`auth failed: ${JSON.stringify(me.body)}`);
console.log(`Agent ${me.body.name} · 65% club: last ${me.body.club.n} → ${me.body.club.wins} pass · warmup ${me.body.club.warmup.done ? 'done' : `day ${me.body.club.warmup.days}`}`);

const market = (await api('/api/v1/market')).body;
if (!market.session.open) { console.log(market.session.line); process.exit(0); }
const open = new Set(((await api('/api/v1/calls?status=open')).body.calls as { pair: string; board: string }[]).map((c) => `${c.pair}:${c.board}`));

const ideas = [];
for (const p of market.pairs.filter((x: { group: string }) => x.group === 'liquid')) {
  const lt = p.boards.find((b: { id: string }) => b.id === 'swing');
  if (!lt?.listed || lt.weekendBlocked || open.has(`${p.symbol}:swing`)) continue;
  const m = await momentum(p.symbol);
  const band = lt.bps / 1e4;
  // a move of at least half the band over 3h, with most 15m bars agreeing
  if (Math.abs(m.move) >= band / 2 && (m.move > 0 ? m.ups >= 0.6 : m.ups <= 0.4)) ideas.push({ p, m, score: Math.abs(m.move) / band });
}
ideas.sort((a, b) => b.score - a.score);
if (!ideas.length) console.log('No clean moves right now.');
for (const { p, m } of ideas.slice(0, 1)) {   // LT allows 3 calls a day, 1 hour apart: take the best idea only
  const direction = m.move > 0 ? 'long' : 'short';
  console.log(`${p.label}: ${(m.move * 100).toFixed(2)}% over 3h, ${(m.ups * 100).toFixed(0)}% up bars → ${direction} LT${DRY ? ' (dry run)' : ''}`);
  if (DRY) continue;
  const r = await api('/api/v1/calls', { symbol: p.label, direction, board: 'LT' });
  console.log(r.body.accepted ? `ACCEPTED #${r.body.call.id} entry ${r.body.call.entry} TP ${r.body.call.target} SL ${r.body.call.stop}` : `NOT ACCEPTED: ${r.body.reason}`);
}

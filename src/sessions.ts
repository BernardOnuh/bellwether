import { SESSION } from './config.js';

const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const WD: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 };

/** New York weekday (0 = Sunday) and minute of day. */
export function etParts(t: number) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { wd: WD[p.weekday], min: Number(p.hour) * 60 + Number(p.minute) };
}

/** Can a call be locked at t? Mon–Fri 04:00–16:00 ET (no holiday calendar). */
export function sessionOpen(t: number, mode = SESSION.mode): boolean {
  if (mode === 'always') return true;
  const { wd, min } = etParts(t);
  return wd >= 1 && wd <= 5 && min >= SESSION.openMin && min < SESSION.closeMin;
}

/** A call may not still be running into the weekend (after Friday 20:00 ET). */
export function crossesWeekend(expiresAt: number): boolean {
  if (SESSION.mode === 'always') return false;
  const { wd, min } = etParts(expiresAt);
  return wd === 6 || wd === 0 || (wd === 5 && min > SESSION.weekendCutoffMin);
}

export function nextOpen(t: number): number {
  let x = Math.ceil(t / 60_000) * 60_000;
  for (let i = 0; i < 4 * 24 * 4 && !sessionOpen(x); i++) x += 15 * 60_000;
  // land on the exact opening minute
  while (sessionOpen(x - 60_000)) x -= 60_000;
  return x;
}

export function humanDelta(ms: number) {
  const m = Math.round(ms / 60_000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m % 60}m` : `${m}m`;
}

export function sessionLine(now: number) {
  if (SESSION.mode === 'always') return '🟢 Demo mode: session calendar off';
  if (sessionOpen(now)) {
    const { min } = etParts(now);
    return `🟢 Market open · calls close at 16:00 ET (in ${humanDelta((SESSION.closeMin - min) * 60_000)})`;
  }
  const o = nextOpen(now);
  return `🔴 Market closed · calls reopen ${new Date(o).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit' })} ET (in ${humanDelta(o - now)})`;
}

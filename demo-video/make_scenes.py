# Builds 1920x1080 scene frames for the Bellwether demo video from raw captures (demo-video/raw).
import json, os, html
from PIL import Image
V = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(V, 'raw'); OUT = os.path.join(V, 'scenes'); os.makedirs(OUT, exist_ok=True)
LOGO = os.path.abspath(os.path.join(V, '..', 'assets', 'brand', 'logo.svg'))

def crop(name, h, w=None, y=0):
    im = Image.open(os.path.join(RAW, name + '.png'))
    w = w or im.width
    out = os.path.join(RAW, f'{name}-crop-{y}-{h}.png')
    im.crop((0, y, w, min(im.height, y + h))).save(out)
    return out

CSS = f"""
<style>
@import url('https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700;800&display=swap');
*{{box-sizing:border-box}} html,body{{margin:0;width:1920px;height:1080px;overflow:hidden;background:#04070c;color:#eaf4ff;font-family:Sora,system-ui,sans-serif}}
.bg{{position:absolute;inset:0;background:radial-gradient(900px 700px at 10% 0%,rgba(74,168,238,.35),transparent 60%),radial-gradient(800px 600px at 100% 100%,rgba(43,143,220,.28),transparent 60%),radial-gradient(700px 500px at 70% 10%,rgba(124,200,247,.12),transparent 60%),#04070c}}
.wrap{{position:absolute;inset:0;display:flex;align-items:center;gap:70px;padding:70px 90px}}
.cap{{width:560px;flex:none}}
.k{{font-size:20px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#7cc8f7}}
.t{{font-size:64px;line-height:1.04;font-weight:800;letter-spacing:-.03em;margin:16px 0 22px}}
.t .sky{{background:linear-gradient(90deg,#d7f0ff,#7cc8f7 45%,#4aa8ee);-webkit-background-clip:text;background-clip:text;color:transparent}}
.b{{font-size:25px;line-height:1.5;color:#a3b7cb}}
.b b{{color:#eaf4ff}}
.stage{{flex:1;display:flex;align-items:center;justify-content:center;gap:28px;height:100%;min-width:0}}
.phone{{height:900px;aspect-ratio:1/2;border-radius:56px;padding:12px;background:linear-gradient(160deg,#1c2a3a,#0a121c);box-shadow:0 40px 90px rgba(0,0,0,.6),0 0 0 1px rgba(124,200,247,.25),0 0 80px rgba(74,168,238,.18)}}
.phone img{{width:100%;height:100%;object-fit:cover;object-position:top;border-radius:46px;display:block}}
.phone.sm{{height:680px;border-radius:44px;padding:10px}} .phone.sm img{{border-radius:36px}}
.browser{{width:1100px;border-radius:22px;overflow:hidden;background:#0b121b;box-shadow:0 40px 90px rgba(0,0,0,.6),0 0 0 1px rgba(124,200,247,.25)}}
.browser .bar{{height:44px;display:flex;align-items:center;gap:8px;padding:0 16px;background:#101b27;border-bottom:1px solid rgba(124,200,247,.15)}}
.browser .bar i{{width:12px;height:12px;border-radius:50%;background:#2a3a4c}}
.browser .bar span{{margin-left:16px;font-size:15px;color:#7f97ad;background:#0a121b;padding:5px 14px;border-radius:999px}}
.browser img{{width:100%;display:block}}
.foot{{position:absolute;left:90px;bottom:40px;display:flex;align-items:center;gap:12px;font-size:18px;color:#6c8399}}
.foot img{{width:28px;height:28px}}
.center{{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}}
.chip{{display:inline-block;font-size:20px;font-weight:700;padding:10px 20px;border-radius:999px;background:rgba(124,200,247,.1);border:1px solid rgba(124,200,247,.3);color:#a5dcff;margin:6px}}
.flow{{display:flex;align-items:center;gap:12px;flex-wrap:nowrap;justify-content:center;max-width:1800px}}
.flow div{{padding:20px 18px;border-radius:22px;background:rgba(255,255,255,.05);border:1px solid rgba(124,200,247,.25);font-size:22px;font-weight:700;text-align:center;width:235px}}
.flow div small{{display:block;font-size:16px;font-weight:400;color:#a3b7cb;margin-top:6px}}
.flow span{{font-size:28px;color:#7cc8f7}}
</style>"""

def page(body): return f"<!doctype html><html><head><meta charset='utf-8'>{CSS}</head><body><div class='bg'></div>{body}<div class='foot'><img src='file://{LOGO}'>Bellwether · bellwether-27b6.onrender.com · @BellWetherCallsbot</div></body></html>"
def cap(k, t, b): return f"<div class='cap'><div class='k'>{k}</div><div class='t'>{t}</div><div class='b'>{b}</div></div>"
def phones(*names, sm=False): return "<div class='stage'>" + ''.join(f"<div class='phone{' sm' if sm else ''}'><img src='file://{os.path.join(RAW, n + '.png')}'></div>" for n in names) + "</div>"
def browser(path, url, h=900): return f"<div class='stage'><div class='browser'><div class='bar'><i></i><i></i><i></i><span>{url}</span></div><img src='file://{path}'></div></div>"

S = []
S.append(('01-title', 4, page(f"""<div class='center'><img src='file://{LOGO}' style='width:150px;filter:drop-shadow(0 0 50px rgba(74,168,238,.6))'>
  <div class='t' style='font-size:110px;margin:30px 0 10px'>Bellwether</div>
  <div class='b' style='font-size:34px;color:#cfe6ff'>Call US stocks. Earn your tier. <span style='color:#7cc8f7'>Lead the agent.</span></div>
  <div style='margin-top:40px'><span class='chip'>Bitget stock perps</span><span class='chip'>Telegram bot + Mini App</span><span class='chip'>AI Trading Desk</span></div></div>""")))
S.append(('02-problem', 5, page("""<div class='center'><div class='k'>The problem</div>
  <div class='t' style='font-size:84px;max-width:1500px'>Everyone posts stock calls.<br><span class='sky'>Nobody can prove who's actually good.</span></div>
  <div class='b' style='font-size:30px;max-width:1300px'>Cherry-picked entries, moving targets, deleted losers. Bellwether turns calls into a fair, graded game on live Bitget prices, and lets an AI agent follow only the proven callers.</div></div>""")))
S.append(('03-site', 6, page("<div class='wrap'>" + cap('Live now', "One link.<br><span class='sky'>Join or connect an agent.</span>", "The public site shows live stats, the week's leaderboard and how it works. <b>Join on Telegram</b> opens the bot; <b>Connect your agent</b> opens the API.") + browser(crop('site-home', 1060), 'bellwether-27b6.onrender.com') + "</div>")))
S.append(('04-tour', 6, page("<div class='wrap'>" + cap('First open', "A Wrapped-style<br><span class='sky'>walkthrough.</span>", "Full-screen story slides inside the Telegram Mini App: tap to advance, hold to pause. The rules in under a minute.") + phones('app-tour-0', 'app-tour-2', 'app-tour-3', sm=True) + "</div>")))
S.append(('05-rules', 6, page("<div class='wrap'>" + cap('The game', "Four boards.<br><span class='sky'>One fair bar.</span>", "<b>HT</b> 2h · <b>LT</b> 8h for liquid stocks, <b>D1</b> 24h · <b>D2</b> 48h for long-term ones. An <b>8-day warmup</b>, then the <b>65% club</b> and tiers up to 🐺 WOLF.") + phones('app-tour-4', 'app-tour-6', 'app-tour-7', sm=True) + "</div>")))
S.append(('06-trade', 6, page("<div class='wrap'>" + cap('Make a call', "Pick a stock.<br><span class='sky'>Pick a side.</span>", "30 Bitget stock perps. The house sets take-profit and stop at the <b>same distance</b> (1:1), sized to each stock's normal move, so every call is an equal test of skill.") + phones('app-trade', 'app-sheet') + "</div>")))
S.append(('07-accepted', 6, page("<div class='wrap'>" + cap('Locked', "<span class='sky'>ACCEPTED</span><br>at the live price.", "The tap locks the live Bitget price, stamped by the exchange clock. The call is <b>sealed with a sha256 hash</b> so nobody can copy it until it resolves.") + phones('app-accepted', 'app-calls') + "</div>")))
S.append(('08-rejected', 5, page("<div class='wrap'>" + cap('Same rules for everyone', "No gaming<br><span class='sky'>the board.</span>", "Market hours, daily caps, minimum gaps, one open call per stock, no calls into the weekend. Copying one trader turns your copied passes into fails.") + phones('app-rejected') + "</div>")))
S.append(('09-graded', 6, page("<div class='wrap'>" + cap('Graded by the market', "<span class='sky'>PASS</span> or <span style='color:#ff6b6b'>FAILED.</span>", "Every call resolves on 1-minute Bitget candles: take-profit first is a PASS, stop first is FAILED, neither in time doesn't count. Public profiles show each trader's last 5 calls.") + phones('app-profile') + "</div>")))
S.append(('10-league', 6, page("<div class='wrap'>" + cap('The League', "Keep 65%.<br><span class='sky'>Share the pool.</span>", "Every trading day, players past warmup with 65%+ over their last 20 share <b>1,000 points</b>, weighted by tier. Ranking uses a confidence test, so luck doesn't qualify.<br><br><span style='font-size:18px;color:#6c8399'>Players tagged DEMO are seeded with simulated skill, graded on real Bitget prices.</span>") + phones('app-league', 'app-league-ada') + "</div>")))
S.append(('11-wrapped', 5, page("<div class='wrap'>" + cap('Your Wrapped', "Your run,<br><span class='sky'>as a story.</span>", "Calls made, favorite stock, hit rate, best stock, tier and rank: shareable, Spotify-Wrapped style.") + phones('app-wrapped-2', 'app-wrapped-4', sm=True) + "</div>")))
S.append(('12-profile', 6, page("<div class='wrap'>" + cap('Data access', "See 5 calls.<br><span class='sky'>Request the rest.</span>", "Anyone can see a trader's last 5 calls. Full histories need an <b>approved data key</b>: requested in Telegram, approved by the admin with one tap.") + browser(crop('site-profile', 1060), 'bellwether-27b6.onrender.com/#/trader/maya') + "</div>")))
S.append(('13-agents', 6, page("<div class='wrap'>" + cap('AI agents', "Agents play<br><span class='sky'>by the same rules.</span>", "<code style='color:#7cc8f7'>/apikey new my_agent</code> in the bot, then <b>POST /api/v1/calls</b>. Agents climb the same leaderboard, with the same warmup and 65% club.") + browser(crop('site-agents', 1060), 'bellwether-27b6.onrender.com/#/agents') + "</div>")))
S.append(('14-research', 7, page("<div class='wrap'>" + cap('Does it work?', "Ranking<br><span class='sky'>finds skill.</span>", "In a 21-day replay on real Bitget candles (simulated traders), following <b>tiered callers</b> beat following everyone: LT +0.05R vs −0.04R per trade after fees. Honest caveat: the skill is simulated; real calls are what count.") + browser(crop('site-research', 1060), 'bellwether-27b6.onrender.com/#/research') + "</div>")))
S.append(('15-agent', 7, page("""<div class='center'><div class='k'>From crowd to trade</div><div class='t' style='font-size:70px'>When the best agree, <span class='sky'>the agent acts.</span></div>
  <div class='flow'><div>Calls<small>humans + AI agents</small></div><span>→</span><div>Ranking<small>Wilson gate · tiers</small></div><span>→</span><div>Consensus<small>qualified agreement</small></div><span>→</span><div>Risk gate<small>kill switch · max 3 · −3R/day · costs</small></div><span>→</span><div>Human confirms<small>Telegram ✅ button</small></div><span>→</span><div>Bitget demo<small>bgc --paper-trading</small></div></div>
  <div class='b' style='margin-top:40px;font-size:24px'>AI assists, a human decides. Paper trading only: there is no live-trading code path, and every order is logged.</div></div>""")))
S.append(('16-close', 6, page(f"""<div class='center'><img src='file://{LOGO}' style='width:120px;filter:drop-shadow(0 0 50px rgba(74,168,238,.6))'>
  <div class='t' style='font-size:84px;margin:26px 0 10px'>Play <span class='sky'>Bellwether</span></div>
  <div class='b' style='font-size:32px;color:#cfe6ff'>Telegram: <b>@BellWetherCallsbot</b> · Web: <b>bellwether-27b6.onrender.com</b></div>
  <div style='margin-top:36px'><span class='chip'>Join on Telegram</span><span class='chip'>Connect your agent</span><span class='chip'>Request API access</span></div>
  <div class='b' style='margin-top:30px;font-size:20px;color:#6c8399'>Paper trading only · no deposits · not financial advice</div></div>""")))

manifest = []
for name, dur, doc in S:
    p = os.path.join(OUT, name + '.html')
    open(p, 'w').write(doc); manifest.append({'name': name, 'dur': dur, 'html': p})
json.dump(manifest, open(os.path.join(V, 'scenes.json'), 'w'), indent=1)
print(len(manifest), 'scenes,', sum(m['dur'] for m in manifest), 's')

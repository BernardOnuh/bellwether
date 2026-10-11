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
FOOT_EX = "<div style='position:absolute;right:90px;bottom:40px;font-size:16px;color:#6c8399'>Bot messages shown with example values</div>"
def scene(name, dur, body, sfx=()): S.append((name, dur, page(body), list(sfx)))

scene('01-hook', 5, f"""<div class='center'><img src='file://{LOGO}' style='width:120px;filter:drop-shadow(0 0 50px rgba(74,168,238,.6))'>
  <div class='t' style='font-size:96px;max-width:1600px;margin:30px 0 18px'>What if traders <span class='sky'>everywhere</span><br>powered one AI?</div>
  <div class='b' style='font-size:30px;color:#cfe6ff;max-width:1300px'>Bellwether turns crowd stock calls into a <b>risk-capped trading agent</b> on Bitget.</div></div>""", [(0, 'whoosh'), (0.9, 'chime')])
scene('02-247', 5, f"""<div class='center'><div class='k'>Markets never sleep</div>
  <div class='t' style='font-size:92px;margin:16px 0 26px'>Neither does <span class='sky'>Bellwether.</span></div>
  <div style='display:flex;gap:26px;justify-content:center;margin-bottom:30px'>
    {''.join(f"<div style='padding:22px 30px;border-radius:24px;background:rgba(255,255,255,.05);border:1px solid rgba(124,200,247,.25);min-width:230px'><div style='font-size:46px'>{e}</div><div style='font-size:28px;font-weight:800;margin-top:6px'>{c}</div><div style='font-size:18px;color:#a3b7cb'>{s2}</div></div>" for e, c, s2 in [('🌏', 'Asia', 'Sun 20:00 ET →'), ('🌍', 'Europe', 'overnight'), ('🌎', 'US', 'pre-market + regular')])}
  </div>
  <div><span class='chip'>Bitget stock perps trade 24/7</span><span class='chip'>D1 · D2 calls open 24/5</span><span class='chip'>HT · LT in US hours</span></div></div>""", [(0, 'whoosh')])
scene('03-tg-call', 6, "<div class='wrap'>" + cap('Telegram', "Call it<br><span class='sky'>in one message.</span>", "Type <b>TSLA long LT</b> in the bot, or tap through the Mini App. The call locks at the <b>live Bitget price</b>, sealed so nobody can copy it.") + phones('tg-1', 'app-accepted') + "</div>", [(0, 'whoosh'), (1.1, 'chime'), (2.3, 'chime2')])
scene('04-tg-pass', 6, "<div class='wrap'>" + cap('Graded by the market', "<span class='sky'>PASS</span> lands<br>in your chat.", "Take-profit first is a <b>PASS</b>, stop first is <b>FAILED</b>, on 1-minute Bitget candles. Keep 65% and the daily points drop straight into Telegram.") + phones('tg-2', 'tg-3') + "</div>" + FOOT_EX, [(0, 'whoosh'), (1.0, 'success'), (3.0, 'coin')])
scene('05-crowd', 6, "<div class='wrap'>" + cap('A worldwide crowd', "Everyone trades<br><span class='sky'>on demo.</span>", "Anyone with Telegram, in any time zone, calls 30 US stocks with paper money: <b>no deposits, no risk to them</b>. Every call becomes a graded data point.") + phones('app-league', 'app-profile') + "</div>", [(0, 'whoosh'), (1.4, 'tap')])
scene('06-agents', 5, "<div class='wrap'>" + cap('Humans + AI agents', "Trading bots<br><span class='sky'>compete too.</span>", "Builders plug their AI agents in with an API key. Same rules, same leaderboard, same 65% bar: the best signal wins, whoever sends it.") + browser(crop('site-agents', 1060), 'bellwether-27b6.onrender.com/#/agents') + "</div>", [(0, 'whoosh')])
scene('07-data', 6, "<div class='wrap'>" + cap('Signal, not noise', "Every call is<br><span class='sky'>labeled data.</span>", "Who called what, when, at what price, and how it ended: a clean, tamper-proof dataset (sha256-sealed) that our AI learns who to trust from.") + phones('app-calls', 'app-wrapped-2') + "</div>", [(0, 'whoosh'), (1.2, 'tap')])
scene('08-filter', 6, "<div class='wrap'>" + cap('Only the proven count', "Luck and copycats<br><span class='sky'>filtered out.</span>", "65% over the last 20 calls, a 90%-confidence test against coin-flipping, tiers up to 🐺 WOLF, and copy detection. Only proven callers move the AI.") + phones('app-tour-6', 'app-tour-7', sm=False) + "</div>", [(0, 'whoosh')])
scene('09-agent', 7, "<div class='wrap'>" + cap('From crowd to trade', "When the best agree,<br><span class='sky'>the AI trades.</span>", "Consensus of top callers → risk gate → <b>one tap to confirm</b> in Telegram → order on the <b>Bitget demo account</b>. AI assists, a human decides.") + phones('tg-admin') + "</div>" + FOOT_EX, [(0, 'whoosh'), (1.2, 'chime'), (3.4, 'tap'), (3.6, 'success')])
scene('10-profit', 7, "<div class='wrap'>" + cap('Built for profit', "Follow the winners.<br><span class='sky'>Skip the fees.</span>", "✔ Trades only when proven 65%+ callers agree<br>✔ Skips any trade where fees would eat over 25% of the target<br>✔ Replay: tiered callers <b>+0.05R</b> per trade vs <b>−0.04R</b> following everyone<br><span style='font-size:17px;color:#6c8399'>Replay uses simulated traders on real Bitget candles. Not a guarantee of returns.</span>") + browser(crop('site-research', 1060), 'bellwether-27b6.onrender.com/#/research') + "</div>", [(0, 'whoosh'), (2.0, 'coin')])
scene('11-risk', 6, """<div class='center'><div class='k'>Risk, capped</div>
  <div style='font-size:260px;font-weight:800;letter-spacing:-.05em;line-height:1;background:linear-gradient(180deg,#fff,#7cc8f7);-webkit-background-clip:text;background-clip:text;color:transparent'>10%</div>
  <div class='t' style='font-size:64px;margin:6px 0 18px'>maximum drawdown. <span class='sky'>By design.</span></div>
  <div class='b' style='font-size:27px;max-width:1350px'>Before every trade, the agent assumes <b>everything open hits its stop</b>. If that could take the account more than 10% below its peak, it doesn't trade. Plus a 3R daily stop and a kill switch.</div></div>""", [(0, 'boom')])
scene('12-hooked', 5, "<div class='wrap'>" + cap('Built to come back to', "Streaks. Tiers.<br><span class='sky'>Your Wrapped.</span>", "A Spotify-Wrapped-style tour on first open, daily points, streaks and a weekly league. Traders come back every day.") + phones('app-tour-0', 'app-wrapped-4', 'app-league-ada', sm=True) + "</div>", [(0, 'whoosh'), (1.0, 'chime')])
scene('13-site', 5, "<div class='wrap'>" + cap('One link', "Live now.", "Public leaderboard, trader profiles, agent API and data access, all at <b>bellwether-27b6.onrender.com</b>.") + browser(crop('site-home', 1060), 'bellwether-27b6.onrender.com') + "</div>", [(0, 'whoosh')])
scene('14-cta', 6, f"""<div class='center'><img src='file://{LOGO}' style='width:130px;filter:drop-shadow(0 0 60px rgba(74,168,238,.7))'>
  <div class='t' style='font-size:96px;margin:26px 0 12px'>Join the <span class='sky'>League.</span></div>
  <div class='b' style='font-size:34px;color:#cfe6ff'>Telegram <b>@BellWetherCallsbot</b> · <b>bellwether-27b6.onrender.com</b></div>
  <div style='margin-top:34px'><span class='chip'>📈 Make a call</span><span class='chip'>🤖 Connect your agent</span><span class='chip'>🔓 Request API access</span></div>
  <div class='b' style='margin-top:30px;font-size:19px;color:#6c8399'>Paper trading only · no deposits · not financial advice</div></div>""", [(0, 'whoosh'), (0.6, 'success'), (1.6, 'coin')])

manifest = []
for name, dur, doc, sfx in S:
    p = os.path.join(OUT, name + '.html')
    open(p, 'w').write(doc); manifest.append({'name': name, 'dur': dur, 'html': p, 'sfx': sfx})
json.dump(manifest, open(os.path.join(V, 'scenes.json'), 'w'), indent=1)
print(len(manifest), 'scenes,', sum(m['dur'] for m in manifest), 's')

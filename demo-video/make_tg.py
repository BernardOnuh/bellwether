# Telegram-style chat screens using the bot's real message formats (src/bot.ts). Values marked as examples in the video.
import os, html
V = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.join(V, 'tg'); os.makedirs(OUT, exist_ok=True)
LOGO = os.path.abspath(os.path.join(V, '..', 'assets', 'brand', 'logo.svg'))
CSS = """<style>
*{box-sizing:border-box} html,body{margin:0;width:100vw;height:100vh;overflow:hidden;font:15.5px/1.38 -apple-system,'SF Pro Text',system-ui,sans-serif;color:#fff}
body{background:#0e1621 url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='60' height='60'%3E%3Ccircle cx='10' cy='10' r='1.2' fill='%23ffffff' fill-opacity='.04'/%3E%3Ccircle cx='40' cy='35' r='1' fill='%23ffffff' fill-opacity='.04'/%3E%3C/svg%3E")}
.top{position:absolute;top:0;left:0;right:0;height:96px;padding:44px 14px 0;display:flex;align-items:center;gap:12px;background:#17212b;border-bottom:1px solid #0b1219}
.top .back{color:#6ab3f3;font-size:26px;margin-right:2px}.top img{width:40px;height:40px;border-radius:50%}
.top b{display:block;font-size:17px}.top span{font-size:13px;color:#7f91a4}
.chat{position:absolute;top:96px;bottom:64px;left:0;right:0;padding:12px 10px;display:flex;flex-direction:column;justify-content:flex-end;gap:8px}
.m{max-width:86%;padding:8px 11px 6px;border-radius:16px;white-space:pre-wrap;word-wrap:break-word;position:relative;box-shadow:0 1px 1px rgba(0,0,0,.25)}
.m .t{display:block;text-align:right;font-size:11.5px;color:rgba(255,255,255,.5);margin-top:2px}
.in{align-self:flex-start;background:#182533;border-bottom-left-radius:6px}.out{align-self:flex-end;background:#2b5278;border-bottom-right-radius:6px}
.out .t{color:#7fb0dd}
.m code{font-family:ui-monospace,Menlo,monospace;font-size:13px;color:#9fd3ff}
.kb{align-self:flex-start;width:86%;display:grid;gap:4px;margin-top:-4px}.kb div{display:flex;gap:4px}
.kb span{flex:1;text-align:center;padding:9px 6px;border-radius:10px;background:rgba(43,82,120,.55);font-size:14px;font-weight:600}
.bar{position:absolute;bottom:0;left:0;right:0;height:64px;background:#17212b;display:flex;align-items:center;gap:10px;padding:0 10px}
.bar .menu{background:#6ab3f3;color:#0e1621;font-weight:700;font-size:14px;padding:8px 12px;border-radius:10px}
.bar .in2{flex:1;color:#7f91a4;font-size:15px}
.pop{animation:none}
</style>"""
def page(msgs, title='Bellwether', sub='bot'):
    body = ''.join(msgs)
    return f"<!doctype html><html><head><meta charset='utf-8'>{CSS}</head><body><div class='top'><span class='back'>‹</span><img src='file://{LOGO}'><div><b>{title}</b><span>{sub}</span></div></div><div class='chat'>{body}</div><div class='bar'><span class='menu'>Open app</span><span class='in2'>Message</span></div></body></html>"
def out(text, t='10:41'): return f"<div class='m out'>{text}<span class='t'>{t} ✓✓</span></div>"
def bot(text, t='10:41'): return f"<div class='m in'>{text}<span class='t'>{t}</span></div>"
def kb(*rows): return "<div class='kb'>" + ''.join('<div>' + ''.join(f'<span>{b}</span>' for b in r) + '</div>' for r in rows) + "</div>"

accepted = bot("✅ <b>ACCEPTED</b> — TSLA LONG LT (8h)\nEntry 383.07 · TP 387.94 · SL 378.21 (±1.27%)\nResult at Mon, 01:11 PM ET or sooner: I'll message you <b>PASS</b> or <b>FAILED</b>.\n<i>Sealed de6fdccdba8e: others can't see it until it resolves.</i>")
passed = bot("✅ <b>PASS</b>\nTSLA LONG LT from 383.07 — take-profit 387.94 hit\n\n65% club: last 20 → 14 pass (70%, need 13)\nLT: 🎯 SHARP · 9 pass / 3 failed\n<i>Revealed salt 9f1c04ab77e2… (hash de6fdccdba8e)</i>", '15:02')
club = bot("🏆 <b>2026-10-12: you made the 65% club!</b>\n+412 points · last 20: 14 wins · 🔥 streak 3", '00:05')
S = {
  'tg-1': [out('TSLA long lt'), accepted],
  'tg-2': [out('TSLA long lt'), accepted, passed, kb(['📈 Call again'])],
  'tg-3': [passed, kb(['📈 Call again']), club, kb(['📈 Make a call', '🏆 Leaderboard'])],
  'tg-admin': [bot("📡 Consensus: NVDA LONG · LT · 3 traders · 84% of weight\n🤖 Agent #12 NVDA LONG 8h qty 3.92 entry 230.87 TP 233.41 SL 228.33 [proposed]\n\n3 qualified traders called NVDA long on the LT board within 120 min, carrying 84% of the weighted vote: Maya Chen (WOLF), quant_koji (SHARP), Dami O. (SHARP). House band ±1.10%, 1:1, expiry 8h.", '11:20'),
               kb(['✅ Confirm (paper)', '✖️ Reject']),
               out('✅ Confirm (paper)', '11:20'),
               bot("🤖 Agent #12 NVDA LONG 8h qty 3.92 entry 230.91 TP 233.45 SL 228.37 [open]\nOrder placed on the Bitget demo account (bgc --paper-trading).", '11:20')],
}
for k, msgs in S.items():
    open(os.path.join(OUT, k + '.html'), 'w').write(page(msgs, sub='bot' if k != 'tg-admin' else 'bot · admin'))
print('ok', len(S))

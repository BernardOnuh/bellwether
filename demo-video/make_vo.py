# Narration: one clip per scene from narration.json, using a macOS voice (VOICE env, default Ava Premium if installed).
import json, os, subprocess, sys
V = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.join(V, 'vo'); os.makedirs(OUT, exist_ok=True)
lines = json.load(open(os.path.join(V, 'narration.json')))
voices = subprocess.run(['say', '-v', '?'], capture_output=True, text=True).stdout
want = os.environ.get('VOICE')
if not want:
    for cand in ['Ava (Premium)', 'Zoe (Premium)', 'Ava (Enhanced)', 'Zoe (Enhanced)', 'Samantha (Enhanced)', 'Samantha']:
        if cand in voices: want = cand; break
rate = os.environ.get('RATE', '178')
print('voice:', want, 'rate:', rate)
meta = {}
for name, text in lines.items():
    aiff, wav = os.path.join(OUT, name + '.aiff'), os.path.join(OUT, name + '.wav')
    subprocess.run(['say', '-v', want, '-r', rate, '-o', aiff, text], check=True)
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', aiff, '-ar', '44100', '-ac', '1', '-af', 'silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse', wav], check=True)
    d = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', wav], capture_output=True, text=True).stdout)
    meta[name] = {'wav': wav, 'dur': round(d, 2)}
json.dump({'voice': want, 'lines': meta}, open(os.path.join(V, 'vo.json'), 'w'), indent=1)
print('total speech', round(sum(m['dur'] for m in meta.values()), 1), 's')
for k, m in meta.items(): print(f"  {k:12} {m['dur']:5.2f}s")

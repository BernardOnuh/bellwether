# Renders scene HTML -> PNG (headless Chrome) -> clips with push-in -> crossfaded video -> muxed with soundtrack.
import json, os, subprocess, time, glob, shutil
V = os.path.dirname(os.path.abspath(__file__)); os.chdir(V)
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
PROFILE = os.environ.get('TMPDIR', '/tmp') + '/bw-render-profile'
M = json.load(open('scenes.json')); FPS = 30; XF = 0.6
os.makedirs('clips', exist_ok=True)
for m in M:
    png = f"scenes/{m['name']}.png"
    if os.path.exists(png): os.remove(png)
    p = subprocess.Popen([CHROME, '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', '--allow-file-access-from-files',
                          '--window-size=1920,1080', '--force-device-scale-factor=1', '--virtual-time-budget=4000', f'--user-data-dir={PROFILE}-{m["name"]}',
                          f'--screenshot={V}/{png}', f"file://{V}/scenes/{m['name']}.html"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(60):
        if os.path.exists(png) and os.path.getsize(png) > 0: break
        time.sleep(0.5)
    time.sleep(0.5); p.kill(); shutil.rmtree(f'{PROFILE}-{m["name"]}', ignore_errors=True)
    n, d = m['name'], m['dur']; frames = int(d * FPS)
    vf = f"scale=3840:2160,zoompan=z='1+0.04*on/{frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={frames}:s=1920x1080:fps={FPS},format=yuv420p"
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-loop', '1', '-i', png, '-vf', vf, '-t', str(d), '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-r', str(FPS), f'clips/{n}.mp4'], check=True)
    print('scene', n, d, 's', flush=True)
inputs, filt, last, off = [], [], '0:v', 0.0
for m in M: inputs += ['-i', f"clips/{m['name']}.mp4"]
for i in range(1, len(M)):
    off += M[i - 1]['dur'] - XF; filt.append(f"[{last}][{i}:v]xfade=transition=fade:duration={XF}:offset={off:.2f}[v{i}]"); last = f'v{i}'
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', *inputs, '-filter_complex', ';'.join(filt), '-map', f'[{last}]', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', 'video-only.mp4'], check=True)
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', 'video-only.mp4', '-i', 'soundtrack.wav', '-filter_complex',
                '[1:a]aecho=0.8:0.4:40:0.08,highpass=f=30,loudnorm=I=-14:TP=-1.0:LRA=11,aformat=channel_layouts=stereo[a]',
                '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', 'bellwether-demo.mp4'], check=True)
os.remove('video-only.mp4'); print('done: bellwether-demo.mp4')

# Original soundtrack for the Bellwether demo: a synth music bed + notification SFX, synthesized here (no samples, no licensing).
import json, math, random, struct, wave, os
V = os.path.dirname(os.path.abspath(__file__)); SR = 44100; XF = 0.6
M = json.load(open(os.path.join(V, 'scenes.json')))
starts, t = [], 0.0
for i, m in enumerate(M):
    starts.append(t); t += m['dur'] - (XF if i < len(M) - 1 else 0)
T = t; N = int(T * SR) + SR
music = [0.0] * N; sfx = [0.0] * N
random.seed(7)
TAU = 2 * math.pi

# ---------- music bed: A minor, Am–F–C–G, 100 BPM ----------
BPM = 100; beat = 60 / BPM; bar = 4 * beat
CHORDS = [(220.0, 261.63, 329.63), (174.61, 220.0, 261.63), (261.63, 329.63, 392.0), (196.0, 246.94, 293.66)]
beat_in = starts[1]                     # drums enter with scene 2
risk_s, risk_e = starts[10], starts[11] # strip back to pads under the 10% scene for impact
end_fade = T - 3.0
ph = [0.0] * 6
for n in range(N):
    tt = n / SR
    ci = int(tt / bar) % 4; chord = CHORDS[ci]
    tb = tt % bar
    env = min(1.0, tb / 0.35) * (0.85 + 0.15 * math.cos(TAU * tt / bar))
    # pads: three detuned voices with a soft 2nd harmonic
    pad = 0.0
    for v, f in enumerate(chord):
        pad += math.sin(TAU * f * tt) + 0.22 * math.sin(TAU * 2 * f * tt + v) + 0.5 * math.sin(TAU * f * 1.003 * tt)
    pad *= 0.045 * env
    x = pad
    drums = tt >= beat_in and not (risk_s <= tt < risk_e) and tt < end_fade + 1.5
    if drums:
        tq = tt % beat; b16 = tt % (beat / 4); idx16 = int(tt / (beat / 4)) % 16
        # bass on beats 1 and 3
        tbass = tt % (2 * beat)
        x += 0.16 * math.sin(TAU * (chord[0] / 2) * tt) * math.exp(-3.5 * tbass)
        # kick: four on the floor, pitch-dropping sine
        x += 0.42 * math.sin(TAU * (48 + 110 * math.exp(-28 * tq)) * tq) * math.exp(-9 * tq)
        # hat on the offbeat 8ths
        th = (tt - beat / 2) % beat
        x += 0.05 * (random.random() * 2 - 1) * math.exp(-55 * th)
        # arpeggio: chord tones up an octave, 16ths
        f = chord[[0, 1, 2, 1][idx16 % 4]] * 2
        x += 0.035 * math.sin(TAU * f * tt) * math.exp(-14 * b16)
    # global fades
    g = min(1.0, tt / 1.5) * (1.0 if tt < end_fade else max(0.0, 1 - (tt - end_fade) / 3.0))
    music[n] = x * g

# ---------- SFX ----------
def add(t0, gen, dur, gain):
    s0 = int(t0 * SR)
    for i in range(int(dur * SR)):
        if s0 + i < N: sfx[s0 + i] += gain * gen(i / SR)
def bell(f, decay=4.0):
    return lambda x: (math.sin(TAU * f * x) + 0.35 * math.sin(TAU * f * 2.76 * x) * math.exp(-3 * x)) * math.exp(-decay * x)
def chime(t0):     add(t0, bell(1318.5), 1.4, 0.32); add(t0 + 0.09, bell(1975.5), 1.4, 0.26)
def chime2(t0):    add(t0, bell(1568.0, 5), 1.0, 0.22)
def success(t0):
    for k, f in enumerate([1046.5, 1318.5, 1568.0, 2093.0]): add(t0 + 0.085 * k, bell(f, 5.5), 1.2, 0.24)
def coin(t0):
    sq = lambda f: (lambda x: (math.sin(TAU * f * x) + 0.3 * math.sin(TAU * 3 * f * x)) * math.exp(-7 * x))
    add(t0, sq(987.8), 0.08, 0.22); add(t0 + 0.075, sq(1318.5), 0.6, 0.22)
    for k in range(5): add(t0 + 0.12 + 0.05 * k, bell(2637 + 220 * k, 18), 0.3, 0.07)
def tap(t0): add(t0, lambda x: math.sin(TAU * 1800 * x) * math.exp(-180 * x) + (random.random() * 2 - 1) * math.exp(-400 * x) * 0.5, 0.05, 0.35)
def whoosh(t0, dur=0.55):
    st = {'y': 0.0}
    def g(x):
        p = x / dur; a = 0.03 + 0.5 * p * p
        st['y'] += a * ((random.random() * 2 - 1) - st['y'])
        return st['y'] * math.sin(math.pi * min(1, p))
    add(t0 - 0.25, g, dur, 0.55)
def boom(t0):
    add(t0, lambda x: math.sin(TAU * (45 + 50 * math.exp(-5 * x)) * x) * math.exp(-2.6 * x), 1.8, 0.7)
    add(t0, lambda x: (random.random() * 2 - 1) * math.exp(-12 * x), 0.4, 0.25)
    chime(t0 + 0.4)
FX = {'chime': chime, 'chime2': chime2, 'success': success, 'coin': coin, 'tap': tap, 'whoosh': whoosh, 'boom': boom}
for s0, m in zip(starts, M):
    for off, kind in m.get('sfx', []):
        if kind == 'whoosh' and s0 == 0: continue
        FX[kind](max(0.0, s0 + off))

# ---------- mix ----------
out = os.path.join(V, 'soundtrack.wav')
with wave.open(out, 'w') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    frames = bytearray()
    for n in range(int(T * SR)):
        y = 0.62 * music[n] + 0.95 * sfx[n]
        y = math.tanh(1.3 * y) / math.tanh(1.3)          # gentle soft-clip
        frames += struct.pack('<h', int(max(-1, min(1, y)) * 32000))
    w.writeframes(bytes(frames))
print(f'soundtrack {T:.1f}s, {sum(len(m.get("sfx", [])) for m in M)} sound cues')

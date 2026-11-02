# Generates index.html from the beat grid. beat(k) = 0.06 + k * 0.48387 s (124.0 BPM). Run: python3 build_index.py
import json
B = 0.48387
O = 0.06
F = 1 / 30
def b(k): return round(O + k * B, 4)
peaks = json.load(open('assets/sfx/peaks.json'))
TOTAL = 29.0

hosts = [  # id, file, start, duration
    ('l1', 'l1-treasury', 0, round(b(6) + 0.5, 3)),
    ('l2', 'l2-six', b(6), round(b(18) - b(6) + 0.5, 3)),
    ('l3', 'l3-gate', b(18), round(b(38) - b(18) + 0.5, 3)),
    ('l4', 'l4-stop', b(38), round(b(47) - b(38) + 0.5, 3)),
    ('l5', 'l5-end', b(47), round(TOTAL - b(47), 3)),
]

sfx = []  # (name, file, picture hit s, volume, duration, extras)
def add(name, f, hit, vol, dur=None, **kw): sfx.append((name, f, hit, vol, dur, kw))

# L1: the treasury, the key.
add('l1-t1', 'key-press.mp3', 0.3, 0.5)
for i, k in enumerate([0.7, 1.1, 1.5]): add(f'l1-bar-{i+1}', 'click-soft.mp3', b(k) + 0.05, 0.5)
add('l1-key', 'impact-bass-2.mp3', b(3), 0.5, 1.0, **{'data-fade-out': '0.4'})
add('l1-line', 'whoosh-short.mp3', b(3.3) + 0.15, 0.4)
# L2: the six calls.
add('l2-flood', 'whoosh.mp3', b(6) + 0.15, 0.6)
add('l2-t', 'key-press.mp3', b(6.5) + 0.1, 0.5)
for i in range(6): add(f'l2-row-{i+1}', 'pop.mp3', b(7 + i) + 0.1, 0.55)
add('l2-n1', 'key-press.mp3', b(12.7) + 0.1, 0.45)
add('l2-n2', 'key-press.mp3', b(13.6) + 0.1, 0.45)
# L3: the gate. Hits: A0 b20 (passes), A1 b24 and A2 b28 (call policy), A3 b32 (passes) and b33.5 (swap helper).
add('l3-wipe', 'whoosh.mp3', b(18) + 0.1, 0.7)
add('l3-kbox', 'pop.mp3', b(19) + 0.1, 0.5)
HITS = [20, 24, 28, 32]
for i, k in enumerate(HITS):
    add(f'l3-a{i}-code', 'key-press.mp3', b(k) - 0.4, 0.4)
    add(f'l3-a{i}-chip', 'whoosh-short.mp3', b(k) - 0.15, 0.35)
add('l3-a0-ping', 'ping.mp3', b(20) + 0.28, 0.65)
add('l3-a1-gate', 'click-soft.mp3', b(24) - 0.36, 0.55)
for i in [1, 2]:
    k = HITS[i]
    add(f'l3-a{i}-deny', 'click-soft.mp3', b(k), 0.9)
    add(f'l3-a{i}-thud', 'impact-bass-2.mp3', b(k), 0.4, 0.9, **{'data-fade-out': '0.4'})
add('l3-meter', 'pop.mp3', b(27.2) + 0.1, 0.5)
add('l3-a3-gate', 'click-soft.mp3', b(30.6) + 0.06, 0.5)
add('l3-a3-pass', 'ping.mp3', b(32), 0.45)
add('l3-a3-gate2', 'click-soft.mp3', b(33.5) - 0.3, 0.5)
add('l3-a3-deny', 'click-soft.mp3', b(33.5), 0.9)
add('l3-a3-thud', 'impact-bass-2.mp3', b(33.5), 0.5, 1.0, **{'data-fade-out': '0.5'})
# L4: three ways to stop it.
add('l4-wipe', 'whoosh.mp3', b(38), 0.7)
add('l4-t', 'key-press.mp3', b(38.5) + 0.1, 0.5)
for i, k in enumerate([39, 41, 43]):
    add(f'l4-row-{i+1}', 'pop.mp3', b(k) + 0.1, 0.55)
    add(f'l4-cut-{i+1}', 'click-soft.mp3', b(k + 1), 0.95)
    add(f'l4-thud-{i+1}', 'impact-bass-2.mp3', b(k + 1), 0.3, 0.8, **{'data-fade-out': '0.4'})
# L5: the end.
add('l5-flood', 'whoosh.mp3', b(47) + 0.15, 0.7)
add('l5-t1', 'key-press.mp3', b(47.3) + 0.1, 0.5)
add('l5-t2', 'key-press.mp3', b(49.3) + 0.1, 0.5)
add('l5-mark', 'impact-bass-1.mp3', b(54), 0.7, 1.6, **{'data-fade-out': '0.7'})
add('l5-word', 'key-press.mp3', b(54) + 0.55, 0.45)

DEFAULT_DUR = {'click-soft.mp3': 0.37, 'pop.mp3': 0.72, 'key-press.mp3': 0.4, 'whoosh.mp3': 0.575, 'whoosh-short.mp3': 0.575, 'ping.mp3': 1.0}
clips = []
for name, f, hit, vol, dur, kw in sfx:
    kw = dict(kw)
    start = round(max(hit + F - peaks[f]['peak'], 0), 3)
    clips.append(dict(name=name, f=f, start=start, dur=round(dur or DEFAULT_DUR[f], 3), vol=vol, extra=kw))
clips.sort(key=lambda c: c['start'])
ends = {}
for c in clips:
    t = 4
    while ends.get(t, -1) > c['start'] + 1e-6: t += 1
    c['track'] = t
    ends[t] = c['start'] + c['dur']

host_html = '\n'.join(
    f'      <div id="{hid}" data-composition-id="{hid}" data-composition-src="compositions/{f}.html" data-start="{start}" data-duration="{dur}" data-track-index="{1 + i % 2}" data-track-kind="graphics" data-width="1920" data-height="1080"></div>'
    for i, (hid, f, start, dur) in enumerate(hosts))
z = ' '.join(f'#{h[0]} {{ z-index: {i+1}; }}' for i, h in enumerate(hosts))
aud_html = '\n'.join(
    '      <audio id="sfx-{n}" class="clip" src="assets/sfx/{f}" data-start="{s}" data-duration="{d}"{ex} data-volume="{v}" data-track-index="{t}" data-audio-group="sfx"></audio>'.format(
        n=c['name'], f=c['f'], s=c['start'], d=c['dur'], ex=''.join(f' {k}="{v}"' for k, v in c['extra'].items()), v=c['vol'], t=c['track'])
    for c in clips)

html = f'''<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      * {{ margin: 0; padding: 0; box-sizing: border-box; }}
      html, body {{ margin: 0; width: 1920px; height: 1080px; overflow: hidden; background: #0a0b0d; }}
      #root {{ position: relative; width: 100%; height: 100%; background: #0a0b0d; }}
      {z}
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="{TOTAL}" data-width="1920" data-height="1080">
{host_html}

      <!-- Music: catalog dark minimal techno, 124.0 BPM, beat = 0.48387 s, phase 0.06 s. Flat energy, ends ~29 s. Played once at rate 1. -->
      <audio id="bed" class="clip" src="assets/audio/bed-leash.mp3" data-start="0" data-media-start="0" data-duration="{TOTAL}" data-volume="1" data-fade-in="0.03" data-fade-out="0.6" data-track-index="3" data-audio-group="music"></audio>

      <!-- Effects, peak-aligned one frame after their picture (generated by build_index.py). -->
{aud_html}
    </div>
    <script>
      window.__timelines = window.__timelines || {{}};
      const tl = gsap.timeline({{ paused: true }});
      window.__timelines["main"] = tl;
      tl.seek(0);
    </script>
  </body>
</html>
'''
open('index.html', 'w').write(html)
print(len(clips), 'sfx clips; tracks:', sorted(set(c['track'] for c in clips)))

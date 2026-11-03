# Generates index.html from the beat grid. beat(k) = 0.06 + k * 0.48387 s (124.0 BPM). Run: python3 build_index.py
import json
B = 0.48387
O = 0.06
F = 1 / 30
def b(k): return round(O + k * B, 4)
peaks = json.load(open('assets/sfx/peaks.json'))
TOTAL = 28.6

hosts = [  # id, file, start, duration
    ('c1', 'c1-job', 0, round(b(12) + 0.5, 3)),
    ('c2', 'c2-chain', b(12), round(b(22) - b(12) + 0.5, 3)),
    ('c3', 'c3-check', b(22), round(b(36) - b(22) + 0.5, 3)),
    ('c4', 'c4-edits', b(36), round(b(45) - b(36) + 0.5, 3)),
    ('c5', 'c5-end', b(45), round(TOTAL - b(45), 3)),
]

sfx = []  # (name, file, picture hit s, volume, duration, extras)
def add(name, f, hit, vol, dur=None, **kw): sfx.append((name, f, hit, vol, dur, kw))

# C1: pick the job, one value comes out of it.
for i in range(5): add(f'c1-row-{i+1}', 'pop.mp3', b(1 + i) + 0.1, 0.5)
add('c1-k', 'key-press.mp3', b(6.2) + 0.1, 0.4)
add('c1-type', 'key-press.mp3', b(7) + 0.1, 0.4)
add('c1-hash', 'impact-bass-2.mp3', b(7) + 0.5, 0.5, 1.0, **{'data-fade-out': '0.4'})
add('c1-cap', 'key-press.mp3', b(8.5) + 0.1, 0.45)
# C2: the hash goes on-chain.
add('c2-flood', 'whoosh.mp3', b(12) + 0.15, 0.6)
add('c2-t', 'key-press.mp3', b(12.5) + 0.1, 0.5)
for i in range(3):
    add(f'c2-row-{i+1}', 'pop.mp3', b(13 + 1.5 * i) + 0.1, 0.5)
    add(f'c2-chip-{i+1}', 'click-soft.mp3', b(13 + 1.5 * i) + 0.35, 0.4)
add('c2-note', 'key-press.mp3', b(17.5) + 0.1, 0.45)
# C3: the check. Equal hash passes (ping b26), the edited card fails (b31.5).
add('c3-wipe', 'whoosh.mp3', b(22) + 0.1, 0.7)
add('c3-t', 'key-press.mp3', b(22.5) + 0.1, 0.5)
add('c3-cardL', 'pop.mp3', b(23) + 0.1, 0.5)
for i, k in enumerate([23.5, 24.3, 25]): add(f'c3-l{i+1}', 'click-soft.mp3', b(k) + 0.1, 0.35)
add('c3-ok', 'ping.mp3', b(26) + 0.1, 0.65)
add('c3-cardR', 'pop.mp3', b(28) + 0.1, 0.5)
for i, k in enumerate([28.5, 29.3, 30]): add(f'c3-r{i+1}', 'click-soft.mp3', b(k) + 0.1, 0.35)
add('c3-bad', 'click-soft.mp3', b(31.5), 0.9)
add('c3-thud', 'impact-bass-2.mp3', b(31.5), 0.5, 1.0, **{'data-fade-out': '0.5'})
add('c3-sub', 'key-press.mp3', b(33) + 0.1, 0.45)
# C4: edits stay visible.
add('c4-flood', 'whoosh.mp3', b(36) + 0.15, 0.6)
add('c4-t', 'key-press.mp3', b(36.5) + 0.1, 0.5)
for i in range(3):
    add(f'c4-row-{i+1}', 'pop.mp3', b(37 + 1.3 * i) + 0.1, 0.5)
    add(f'c4-cnt-{i+1}', 'click-soft.mp3', b(37 + 1.3 * i) + 0.35, 0.4)
add('c4-note', 'key-press.mp3', b(40.5) + 0.1, 0.45)
# C5: the end.
add('c5-flood', 'whoosh.mp3', b(45) + 0.15, 0.7)
add('c5-t1', 'key-press.mp3', b(45.3) + 0.1, 0.5)
add('c5-t2', 'key-press.mp3', b(47) + 0.1, 0.5)
add('c5-mark', 'impact-bass-1.mp3', b(53), 0.7, 1.6, **{'data-fade-out': '0.7'})
add('c5-word', 'key-press.mp3', b(53) + 0.55, 0.45)

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

      <!-- Music (reused from the leash film): catalog dark minimal techno, 124.0 BPM, beat = 0.48387 s, phase 0.06 s. Flat energy, ends ~29 s. Played once at rate 1. -->
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

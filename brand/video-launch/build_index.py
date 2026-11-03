# Generates index.html from the beat grid. beat(k) = k * 0.46985 s (127.7 BPM). Run: python3 build_index.py
import json
B = 0.46985
F = 1 / 30
def b(k): return round(k * B, 4)
peaks = json.load(open('assets/sfx/peaks.json'))
TOTAL = 32.9

hosts = [  # id, file, start, duration
    ('p1', 'p1-agent', 0, round(b(12) + 0.5, 3)),
    ('p2', 'p2-form', b(12), round(b(28) - b(12) + 0.5, 3)),
    ('p3', 'p3-fee', b(28), round(b(48) - b(28) + 0.5, 3)),
    ('p4', 'p4-control', b(48), round(b(60) - b(48) + 0.5, 3)),
    ('p5', 'p5-end', b(60), round(TOTAL - b(60), 3)),
]

sfx = []  # (name, file, picture hit s or None, volume, duration, extras)
def add(name, f, hit, vol, dur=None, **kw): sfx.append((name, f, hit, vol, dur, kw))
def raw(name, f, start, vol, dur, **kw): sfx.append((name, f, None, vol, dur, dict(kw, _start=start)))

# P1: the drop on beat 4 lands "an agent."
raw('riser', 'riser.mp3', 0, 0.4, 1.85, **{'data-media-start': '1.6', 'data-fade-in': '0.2', 'data-fade-out': '0.1'})
add('drop-1', 'impact-bass-1.mp3', b(4), 0.6, 1.2, **{'data-fade-out': '0.5'})
add('p1-t2', 'key-press.mp3', b(4) + 0.05, 0.5)
for i, k in enumerate([5.5, 6.8, 8.1]): add(f'p1-row-{i+1}', 'pop.mp3', b(k) + 0.1, 0.6)
# P2: the form, the click.
add('p2-flood', 'whoosh-short.mp3', b(12), 0.6)
add('p2-t', 'key-press.mp3', b(12.5), 0.5)
for i in range(6): add(f'p2-row-{i+1}', 'pop.mp3', b(13 + i) + 0.1, 0.5)
add('p2-btn', 'pop.mp3', b(20) + 0.1, 0.8)
add('p2-cur', 'whoosh-short.mp3', b(21), 0.3)
add('p2-click', 'click-soft.mp3', b(23), 0.9)
add('p2-one', 'key-press.mp3', b(24) + 0.05, 0.5)
# P3: the fee bar (the break holds b30-32), the fuel readout.
add('p3-wipe', 'whoosh.mp3', b(28), 0.7)
add('p3-t', 'key-press.mp3', b(29), 0.5)
add('p3-drop', 'impact-bass-1.mp3', b(32), 0.5, 1.0, **{'data-fade-out': '0.4'})
for i in range(4): add(f'p3-seg-{i+1}', 'pop.mp3', b(32 + i) + 0.2, 0.7)
add('p3-cap', 'key-press.mp3', b(36), 0.5)
add('p3-out', 'whoosh-short.mp3', b(40), 0.5)
add('p3-t2', 'key-press.mp3', b(40.5), 0.5)
add('p3-num', 'pop.mp3', b(41) + 0.1, 0.5)
add('p3-tick', 'click-soft.mp3', b(42.5), 0.7)
add('p3-sleep', 'key-press.mp3', b(44.5) + 0.05, 0.5)
# P4: control.
add('p4-flood', 'whoosh.mp3', b(48), 0.7)
add('p4-t', 'key-press.mp3', b(48.5), 0.5)
for i in range(3): add(f'p4-row-{i+1}', 'pop.mp3', b(49.5 + 3 * i) + 0.1, 0.6)
# P5: the mark.
add('p5-flood', 'whoosh.mp3', b(60), 0.7)
add('p5-mark', 'impact-bass-1.mp3', b(62), 0.7, 1.6, **{'data-fade-out': '0.7'})
add('p5-word', 'key-press.mp3', b(62) + 0.55, 0.45)

DEFAULT_DUR = {'click-soft.mp3': 0.37, 'pop.mp3': 0.72, 'key-press.mp3': 0.4, 'whoosh.mp3': 0.575, 'whoosh-short.mp3': 0.575}
clips = []
for name, f, hit, vol, dur, kw in sfx:
    kw = dict(kw)
    start = kw.pop('_start') if '_start' in kw else hit + F - peaks[f]['peak']
    start = round(max(start, 0), 3)
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

      <!-- Music: catalog future-bass trailer, 127.7 BPM, beat = 0.46985 s. Intro beats 0-4, drop on beat 4, a break on beats 30-32,
           outro fades by itself. Played once at rate 1. -->
      <audio id="bed" class="clip" src="assets/audio/bed-sky.mp3" data-start="0" data-media-start="0" data-duration="{TOTAL}" data-volume="1" data-fade-in="0.03" data-fade-out="0.4" data-track-index="3" data-audio-group="music"></audio>

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

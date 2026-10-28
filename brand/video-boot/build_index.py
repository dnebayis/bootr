# Generates index.html from the beat grid. beat(k) = k * 0.3455 s. Run: python3 build_index.py
import json
B = 0.3455
F = 1 / 30
def b(k): return round(k * B, 4)
peaks = json.load(open('assets/sfx/peaks.json'))
TOTAL = 29.7

hosts = [  # id, file, start, duration, track
    ('k1', 'k1-boot', 0, 5.95),
    ('k2', 'k2-drop', b(16), 4.6),
    ('k3', 'k3-fees', b(28), 4.6),
    ('k4', 'k4-post', b(40), 5.29),
    ('k5', 'k5-lines', b(54), 5.25),
    ('k6', 'k6-lockup', b(69), round(TOTAL - b(69), 3)),
]

# (name, file, picture-hit time in s, volume, duration-or-None, extra attrs)
sfx = []
def add(name, f, hit, vol, dur=None, **kw): sfx.append((name, f, hit, vol, dur, kw))

for n in range(5): add(f'ok-{n+1}', 'click-soft.mp3', b(n) + B / 2, 0.6)
add('sum', 'pop.mp3', b(5), 0.8)
for i, k in enumerate([8, 10, 12, 14]): add(f'count-{3-i}', 'pop.mp3', b(k), 0.9)
add('drop', 'impact-bass-1.mp3', b(16), 0.6, 1.2, **{'data-fade-out': '0.5'})
for j in range(6): add(f'tick-key-{j+1}', 'key-press.mp3', b(16) + B + 0.075 + 0.15 * j, 0.5)
add('sub-key-1', 'key-press.mp3', b(20), 0.5)
add('sub-key-2', 'key-press.mp3', b(21.5), 0.5)
add('hair', 'whoosh-short.mp3', b(24), 0.4)
add('wipe-3', 'whoosh.mp3', b(28), 0.7)
for i, k in enumerate([30, 31, 32, 33]): add(f'row-{i+1}', 'pop.mp3', b(k), 0.85)
add('note-key', 'key-press.mp3', b(34), 0.5)
add('flood-4', 'whoosh-short.mp3', b(40), 0.7)
for i, k in enumerate([42, 44, 48]): add(f'post-key-{i+1}', 'key-press.mp3', b(k), 0.5)
add('posted', 'pop.mp3', b(51), 0.85)
add('wipe-5', 'whoosh.mp3', b(54), 0.7)
for i, k in enumerate([55, 58, 61, 64]): add(f'line-{i+1}', 'pop.mp3', b(k), 0.85)
# lockup, placed as in brand/logo-motion (local 0 = beat 69)
L0 = b(69)
sfx.append(('lock-tick', 'click-soft.mp3', None, 0.7, 0.19, {'_start': L0 + 0.46}))
sfx.append(('lock-impact', 'impact-bass-2.mp3', None, 0.7, 1.39, {'_start': L0 + 0.28, 'data-media-start': '1.2'}))
sfx.append(('lock-whoosh', 'whoosh.mp3', None, 0.6, 0.57, {'_start': L0 + 1.371}))
for i, t in enumerate([1.557, 1.707, 1.857, 2.007, 2.157]):
    sfx.append((f'lock-key-{i+1}', 'key-press.mp3', None, 0.5, 0.17, {'_start': L0 + t}))
sfx.append(('riser', 'riser.mp3', None, 0.45, 4.5, {'_start': 1.0}))
add('final', 'impact-bass-1.mp3', b(80), 0.55, 1.5, **{'data-fade-out': '1.0'})

DEFAULT_DUR = {'click-soft.mp3': 0.37, 'pop.mp3': 0.72, 'key-press.mp3': 0.4, 'whoosh.mp3': 0.575, 'whoosh-short.mp3': 0.575}

clips = []
for name, f, hit, vol, dur, kw in sfx:
    kw = dict(kw)
    if '_start' in kw:
        start = kw.pop('_start')
    else:
        start = hit + F - peaks[f]['peak']
    start = round(max(start, 0), 3)
    d = dur or DEFAULT_DUR[f]
    clips.append(dict(name=name, f=f, start=start, dur=round(d, 3), vol=vol, extra=kw))
clips.sort(key=lambda c: c['start'])
# lowest free track index (from 4 up)
ends = {}
for c in clips:
    t = 4
    while ends.get(t, -1) > c['start'] + 1e-6: t += 1
    c['track'] = t
    ends[t] = c['start'] + c['dur']

lines = []
for i, (hid, f, start, dur) in enumerate(hosts):
    lines.append(f'      <div id="{hid}" data-composition-id="{hid}" data-composition-src="compositions/{f}.html" data-start="{start}" data-duration="{dur}" data-track-index="{1 + i % 2}" data-track-kind="graphics" data-width="1920" data-height="1080"></div>')
host_html = '\n'.join(lines)
z = ' '.join(f'#{h[0]} {{ z-index: {i+1}; }}' for i, h in enumerate(hosts))
aud = []
for c in clips:
    ex = ''.join(f' {k}="{v}"' for k, v in c['extra'].items())
    aud.append(f'      <audio id="sfx-{c["name"]}" class="clip" src="assets/sfx/{c["f"]}" data-start="{c["start"]}" data-duration="{c["dur"]}"{ex} data-volume="{c["vol"]}" data-track-index="{c["track"]}" data-audio-group="sfx"></audio>')
aud_html = '\n'.join(aud)

html = f'''<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      * {{ margin: 0; padding: 0; box-sizing: border-box; }}
      html, body {{ margin: 0; width: 1920px; height: 1080px; overflow: hidden; background: #000000; }}
      #root {{ position: relative; width: 100%; height: 100%; background: #000000; }}
      {z}
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="{TOTAL}" data-width="1920" data-height="1080">
{host_html}

      <!-- Music: catalog drum and bass, 173.66 BPM, beat = 0.3455 s. A plays the track from its start (build, drop at beat 16);
           B loops the drop section (media beats 16 to 48) on bar lines. The music stops dead on beat 80. -->
      <audio id="bed-a" class="clip" src="assets/audio/bed-dnb.mp3" data-start="0" data-media-start="0" data-duration="{b(48)}" data-volume="1" data-fade-in="0.03" data-track-index="3" data-audio-group="music"></audio>
      <audio id="bed-b" class="clip" src="assets/audio/bed-dnb.mp3" data-start="{b(48)}" data-media-start="{b(16)}" data-duration="{round(b(80) - b(48), 4)}" data-volume="1" data-fade-out="0.04" data-track-index="3" data-audio-group="music"></audio>

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
print(len(clips), 'sfx clips; tracks used:', sorted(set(c['track'] for c in clips)))

# Generates compositions/n1-receipt.html, compositions/n2-end.html and index.html from data.json. Run: python3 build.py
import json, datetime as D

data = json.load(open('data.json'))
B = 0.6  # 100 BPM
F = 1 / 30
TOTAL = 29.7
SLOT = 932
PITCH = 60
b = lambda k: round(k * B, 3)
hms = lambda t: D.datetime.fromtimestamp(t, D.timezone.utc).strftime('%H:%M:%S')
FONTS = """
    @font-face { font-family: 'Geist'; font-weight: 500; src: url('assets/fonts/Geist-500.woff2') format('woff2'); }
    @font-face { font-family: 'Geist'; font-weight: 600; src: url('assets/fonts/Geist-600.woff2') format('woff2'); }
    @font-face { font-family: 'Geist Mono'; font-weight: 500; src: url('assets/fonts/GeistMono-500.woff2') format('woff2'); }"""

# ---- the receipt, top to bottom. Each entry is (html, height).
HEAD_H = 372
items = []
y = HEAD_H
marks = {}
events = sorted([('pay', p['at'], p) for p in data['payments']] + [('post', data['lastPostAt'], None)], key=lambda e: e[1])
stops = []  # [bottom of the line on the paper, clock, cumulative paid]
cum = 0.0
html = []
for kind, at, p in events:
    if kind == 'pay':
        cum += p['usdc']
        html.append(f'<div class="r"><span>{hms(at)}</span><span>thought</span><span>${p["usdc"]:.4f}</span></div>')
    else:
        html.append(f'<div class="r k"><span>{hms(at)}</span><span>posted on x</span></div>')
        marks['post'] = y + PITCH
    y += PITCH
    stops.append([y, hms(at)[:5], round(cum, 2)])
marks['last'] = y
html.append('<div class="dash"></div>'); y += 30
html.append(f'<div class="t"><span>thoughts</span><span>{data["count"]}</span></div>'); y += 72; marks['t1'] = y
html.append(f'<div class="t"><span>paid</span><span>${data["totalUsdc"]:.2f}</span></div>'); y += 72; marks['t2'] = y
html.append('<div class="dash"></div>'); y += 30; marks['t3'] = y
html.append('<div class="gap"></div>'); y += 60
claim = data['claim']
html.append(f'<div class="fee"><span>{hms(claim["at"])}</span><span>fees in</span><span>+${claim["usd"]:.2f}</span></div>'); y += 110
marks['fee'] = y
stops.append([y, hms(claim['at'])[:5], round(cum, 2)])
html.append('<div class="gap"></div>'); y += 60
html.append('<div class="dash"></div>'); y += 30
html.append('<div class="bye">see you tonight.</div>'); y += 96
bits = bin(int(data['payments'][0]['tx'], 16))[2:]
x, bars = 0, []
for i in range(0, 200, 2):  # the barcode is the first payment's tx hash, two bits a bar
    w = 4 + 4 * int(bits[i:i + 2], 2) % 16
    if i % 4 == 0:
        bars.append(f'<rect x="{x}" y="0" width="{w}" height="96" fill="#0a0b0d"></rect>')
    x += w
html.append(f'<svg class="bar" viewBox="0 0 {x} 96" preserveAspectRatio="none">{"".join(bars)}</svg>'); y += 96 + 34
marks['end'] = y
PAPER_H = y + 260  # the part still inside the printer until the tear


def zig(top, up=True):
    n = 43
    w = 860 / n
    return [(round(i * w, 1), top + (0 if i % 2 == 0 else (10 if up else -10))) for i in range(n + 1)]


def poly(bottom):
    pts = zig(0) + [(860, bottom)] if bottom == PAPER_H else zig(0) + list(reversed(zig(bottom, False)))
    if bottom == PAPER_H:
        pts = zig(0) + [(860, bottom), (0, bottom)]
    return 'polygon(' + ', '.join(f'{a}px {c}px' for a, c in pts) + ')'


# ---- the feed: piecewise, a pure function of time.
keys = [(0, HEAD_H, 'none')]
for i, k in enumerate([1, 2, 3, 4]):
    keys.append((b(k), HEAD_H + PITCH * i, 'none'))
    keys.append((b(k) + 0.18, HEAD_H + PITCH * (i + 1), 'power2.out'))
keys += [
    (b(5), HEAD_H + PITCH * 4, 'none'),
    (b(16), marks['post'], 'power2.inOut'),
    (b(19), marks['post'] + PITCH * 3, 'sine.inOut'),
    (b(27), marks['last'], 'power2.inOut'),
    (b(28), marks['last'], 'none'), (b(28) + 0.18, marks['t1'], 'power2.out'),
    (b(29), marks['t1'], 'none'), (b(29) + 0.18, marks['t2'], 'power2.out'),
    (b(30), marks['t2'], 'none'), (b(30) + 0.18, marks['t3'], 'power2.out'),
    (b(32), marks['t3'], 'none'), (b(32) + 0.22, marks['fee'], 'expo.out'),
    (b(37), marks['fee'], 'none'), (b(39), marks['end'], 'power2.inOut'),
]
lines = [  # id, html, in, out
    ('l1', 'one night.<br>one agent.', 0, 2.8),
    ('l2', 'it pays for<br>every thought.', 3.0, 5.5),
    ('l3', 'from its<br>own wallet.', 5.7, 8.4),
    ('l4', 'it posts on x.', b(16), b(19) - 0.1),
    ('l5', 'it keeps going.', b(19) + 0.2, b(27) - 0.2),
    ('l6', f'{data["count"]} thoughts.<br>${data["totalUsdc"]:.2f}.', b(27) + 0.2, b(32) - 0.15),
    ('l7', 'then its fees<br>came in.', b(32) + 0.2, b(37) - 0.15),
    ('l8', 'under $1 of fuel,<br>it sleeps.', b(37) + 0.2, b(42) - 0.05),
]
ids = ', '.join(f'"#{l[0]}"' for l in lines[1:])
line_html = '\n      '.join(f'<div class="l" id="{l[0]}">{l[1]}</div>' for l in lines)
line_js = '\n    '.join(
    (f'tl.to("#{i}", {{ opacity: 0, x: -40, duration: 0.2, ease: "power3.in" }}, {o - 0.2:.3f});' if t == 0 else
     f'arrive("#{i}", {t:.3f}); tl.to("#{i}", {{ opacity: 0, x: -40, duration: 0.2, ease: "power3.in" }}, {o - 0.2:.3f});')
    for i, _, t, o in lines)
teeth = ' '.join(f'{i * 18},14 {i * 18 + 9},0' for i in range(51)) + ' 918,14'

n1 = f'''<template>
  <style>{FONTS}
    #root {{ position: absolute; inset: 0; overflow: hidden; font-family: 'Geist', sans-serif; color: #ffffff; }}
    #wrap {{ position: absolute; left: 960px; top: 0; width: 860px; height: {PAPER_H}px; transform-origin: 50% 900px; }}
    #paper {{ position: absolute; left: 0; top: 0; width: 860px; height: {PAPER_H}px; background: #ffffff; color: #0a0b0d; clip-path: {poly(PAPER_H)}; }}
    #hd {{ height: {HEAD_H}px; padding: 58px 56px 0; }}
    #hd .a {{ font-weight: 600; font-size: 64px; line-height: 72px; letter-spacing: -0.03em; white-space: nowrap; }}
    #hd .m {{ font-family: 'Geist Mono', monospace; font-weight: 500; font-size: 34px; line-height: 46px; white-space: nowrap; }}
    #hd .m1 {{ margin-top: 26px; }}
    #hd .d {{ margin-top: 26px; border-top: 4px dashed #0a0b0d; }}
    .r {{ display: flex; justify-content: space-between; align-items: center; height: {PITCH}px; padding: 0 56px; font-family: 'Geist Mono', monospace; font-weight: 500; font-size: 42px; white-space: nowrap; }}
    .r.k {{ background: #0a0b0d; color: #ffffff; }}
    .dash {{ height: 30px; margin: 0 56px; border-bottom: 4px dashed #0a0b0d; }}
    .gap {{ height: 60px; }}
    .t {{ display: flex; justify-content: space-between; align-items: center; height: 72px; padding: 0 56px; font-weight: 600; font-size: 52px; letter-spacing: -0.02em; white-space: nowrap; }}
    .fee {{ display: flex; justify-content: space-between; align-items: center; height: 110px; margin: 0 28px; padding: 0 28px; background: #0000ff; color: #ffffff; font-family: 'Geist Mono', monospace; font-weight: 500; font-size: 42px; white-space: nowrap; }}
    .fee span:last-child {{ font-size: 56px; }}
    .bye {{ height: 96px; padding: 28px 56px 0; font-weight: 600; font-size: 52px; line-height: 64px; letter-spacing: -0.02em; white-space: nowrap; }}
    .bar {{ display: block; width: 748px; height: 96px; margin: 0 56px; }}
    #printer {{ position: absolute; left: 900px; top: {SLOT - 14}px; width: 980px; height: 300px; }}
    #teeth {{ position: absolute; left: 31px; top: 0; width: 918px; height: 14px; display: block; }}
    #body {{ position: absolute; left: 0; top: 14px; width: 980px; height: 286px; background: #0a0b0d; border-radius: 24px 24px 0 0; }}
    #slot {{ position: absolute; left: 31px; top: 22px; width: 918px; height: 6px; background: #32353d; }}
    #lamp {{ position: absolute; left: 31px; top: 76px; width: 44px; height: 12px; background: #3c8aff; }}
    #left {{ position: absolute; left: 120px; top: 0; width: 800px; height: 1080px; }}
    #clk {{ position: absolute; left: 0; top: 72px; font-family: 'Geist Mono', monospace; font-weight: 500; font-size: 190px; line-height: 210px; white-space: nowrap; letter-spacing: -0.03em; }}
    #utc {{ position: absolute; left: 580px; top: 180px; font-family: 'Geist Mono', monospace; font-weight: 500; font-size: 48px; line-height: 56px; white-space: nowrap; }}
    .cl {{ position: absolute; left: 6px; top: 306px; font-family: 'Geist Mono', monospace; font-weight: 500; font-size: 44px; line-height: 52px; white-space: nowrap; }}
    .cn {{ position: absolute; left: 0; top: 360px; font-family: 'Geist Mono', monospace; font-weight: 500; font-size: 130px; line-height: 150px; white-space: nowrap; letter-spacing: -0.03em; }}
    .l {{ position: absolute; left: 4px; top: 640px; font-weight: 600; font-size: 88px; line-height: 98px; letter-spacing: -0.03em; white-space: nowrap; }}
  </style>
  <div id="root" data-composition-id="n1" data-width="1920" data-height="1080">
    <div id="wrap" data-layout-allow-overflow>
      <div id="paper" data-layout-allow-overflow>
        <div id="hd">
          <div class="a">$BOOTR's agent</div>
          <div class="a">night shift</div>
          <div class="m m1">5 nov, 00:00 to 07:00 utc</div>
          <div class="m">paid to: bootr's ai relay</div>
          <div class="d"></div>
        </div>
        {"".join(html)}
      </div>
    </div>
    <div id="printer" data-layout-allow-overflow>
      <svg id="teeth" viewBox="0 0 918 14"><polygon points="0,14 {teeth}" fill="#a9afbb"></polygon></svg>
      <div id="body"></div>
      <div id="slot"></div>
      <div id="lamp"></div>
    </div>
    <div id="left">
      <div id="clk">00:00</div>
      <div id="utc">utc</div>
      <div class="cl" id="cl1">paid</div>
      <div class="cn" id="cn1">$0.00</div>
      <div class="cl" id="cl2">fees in</div>
      <div class="cn" id="cn2">+${claim["usd"]:.2f}</div>
      {line_html}
    </div>
  </div>
  <script>
    const tl = gsap.timeline({{ paused: true }});
    const SLOT = {SLOT};
    const KEYS = {json.dumps(keys)};
    const STOPS = {json.dumps(stops)};
    const eases = KEYS.map((k) => gsap.parseEase(k[2]));
    const feed = (t) => {{
      for (let i = 1; i < KEYS.length; i++) {{
        if (t <= KEYS[i][0]) {{
          const d = KEYS[i][0] - KEYS[i - 1][0];
          const p = d > 0 ? (t - KEYS[i - 1][0]) / d : 1;
          return KEYS[i - 1][1] + (KEYS[i][1] - KEYS[i - 1][1]) * eases[i](p);
        }}
      }}
      return KEYS[KEYS.length - 1][1];
    }};
    const P = {{ t: 0 }};
    const clk = document.getElementById("clk");
    const cn1 = document.getElementById("cn1");
    const paper = document.getElementById("paper");
    const render = () => {{
      const f = feed(P.t);
      gsap.set(paper, {{ y: SLOT - f }});
      let s = null;
      for (let i = 0; i < STOPS.length; i++) {{ if (STOPS[i][0] <= f + 0.5) s = STOPS[i]; else break; }}
      clk.textContent = s ? s[1] : "00:00";
      cn1.textContent = "$" + (s ? s[2] : 0).toFixed(2);
    }};
    render();
    tl.fromTo(P, {{ t: 0 }}, {{ t: {TOTAL}, duration: {TOTAL}, ease: "none", onUpdate: render, immediateRender: false }}, 0);
    const arrive = (s, t) => tl.fromTo(s, {{ x: -40, opacity: 0, filter: "blur(8px)" }}, {{ x: 0, opacity: 1, filter: "blur(0px)", duration: 0.4, ease: "expo.out", immediateRender: false }}, t);
    gsap.set([{ids}, "#cl2", "#cn2"], {{ opacity: 0 }});
    {line_js}
    // The release: the counter hands over to the fee.
    tl.set(["#cl1", "#cn1"], {{ opacity: 0 }}, {b(32)});
    tl.set("#cl2", {{ opacity: 1 }}, {b(32)});
    tl.set("#cn2", {{ opacity: 1 }}, {b(32)});
    tl.fromTo("#cn2", {{ scale: 1.14, transformOrigin: "0% 50%" }}, {{ scale: 1, duration: 0.5, ease: "back.out(2)", immediateRender: false }}, {b(32)});
    // The tear: the paper is cut at the slot and flies off; everything else clears.
    tl.set(paper, {{ clipPath: "{poly(marks['end'])}" }}, {b(42)});
    tl.fromTo("#wrap", {{ y: 0, rotation: 0 }}, {{ y: -1500, rotation: -3, duration: 0.7, ease: "power3.in", immediateRender: false }}, {b(42)});
    tl.to("#printer", {{ y: 240, duration: 0.5, ease: "power3.in" }}, {b(42) + 0.12});
    tl.to(["#clk", "#utc", "#cl2", "#cn2"], {{ opacity: 0, x: -40, duration: 0.25, ease: "power3.in" }}, {b(42)});
    window.__timelines["n1"] = tl;
  </script>
</template>
'''
open('compositions/n1-receipt.html', 'w').write(n1)

N2_T = b(42)
n2 = f'''<template>
  <style>{FONTS}
    #root {{ position: absolute; inset: 0; overflow: hidden; font-family: 'Geist', sans-serif; }}
    #e-shake {{ position: absolute; inset: 0; }}
    #e-box {{ position: absolute; left: 816px; top: 396px; width: 288px; height: 288px; }}
    #e-sq {{ position: relative; width: 288px; height: 288px; }}
    #e-mark {{ position: absolute; left: 0; top: 0; width: 288px; height: 288px; display: block; }}
    #e-word {{ position: absolute; left: 832px; top: 399px; font-size: 256px; font-weight: 600; letter-spacing: -0.04em; line-height: 1; color: #ffffff; white-space: nowrap; }}
    #e-cursor {{ position: absolute; left: 832px; top: 435px; width: 118px; height: 182px; background: #ffffff; }}
  </style>
  <div id="root" data-composition-id="n2" data-width="1920" data-height="1080">
    <div id="e-shake" data-layout-allow-overflow>
      <div id="e-word">bootr</div>
      <div id="e-cursor" data-layout-ignore></div>
      <div id="e-box" data-layout-ignore>
        <div id="e-sq">
          <svg id="e-mark" viewBox="0 0 24 24" fill="none" role="img" aria-label="Bootr">
            <mask id="e-m" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
              <rect width="24" height="24" fill="#fff"></rect>
              <path id="e-cup" d="M8.75 7.75H6.75V17.25H17.25V7.75H15.25" pathLength="1" stroke="#000" stroke-width="2.5" stroke-linecap="square"></path>
              <path id="e-stem" d="M12 4.75V12" pathLength="1" stroke="#000" stroke-width="2.5" stroke-linecap="square"></path>
            </mask>
            <rect width="24" height="24" rx="5" fill="#ffffff" mask="url(#e-m)"></rect>
          </svg>
        </div>
      </div>
    </div>
  </div>
  <script>
    const tl = gsap.timeline({{ paused: true }});
    const Ti = {round(b(44) - N2_T, 3)};
    gsap.set(["#e-word", "#e-cursor", "#e-box"], {{ opacity: 0 }});
    tl.set("#e-shake", {{ x: 0, y: 0 }}, 0);
    tl.set("#e-box", {{ opacity: 1 }}, Ti - 0.56);
    gsap.set(["#e-cup", "#e-stem"], {{ opacity: 0 }});
    tl.set("#e-cup", {{ opacity: 1 }}, Ti - 0.55);
    tl.fromTo("#e-cup", {{ strokeDasharray: 1, strokeDashoffset: 1 }}, {{ strokeDashoffset: 0, duration: 0.35, ease: "expo.out", immediateRender: false }}, Ti - 0.55);
    tl.set("#e-stem", {{ opacity: 1 }}, Ti - 0.183);
    tl.fromTo("#e-stem", {{ strokeDasharray: 1, strokeDashoffset: 1 }}, {{ strokeDashoffset: 0, duration: 0.183, ease: "power3.in", immediateRender: false }}, Ti - 0.183);
    tl.fromTo("#e-sq", {{ scaleX: 1, scaleY: 1, transformOrigin: "50% 100%" }}, {{ scaleX: 1.06, scaleY: 0.9, duration: 0.06, ease: "power2.out", immediateRender: false }}, Ti);
    tl.to("#e-sq", {{ scaleX: 1, scaleY: 1, duration: 0.4, ease: "back.out(2.2)" }}, Ti + 0.06);
    [[0, 7, -5], [0.033, -6, 4], [0.066, 4, -3], [0.1, -2, 2], [0.133, 0, 0]].forEach(([d, x, y]) => tl.set("#e-shake", {{ x, y }}, Ti + d));
    tl.fromTo("#e-box", {{ x: 0 }}, {{ x: -382, duration: 0.65, ease: "power3.inOut", immediateRender: false }}, Ti + 0.45);
    tl.set(["#e-word", "#e-cursor"], {{ opacity: 1 }}, Ti + 0.5);
    tl.fromTo("#e-word", {{ clipPath: "inset(-20px 100% -20px 0px)" }}, {{ clipPath: "inset(-20px 0% -20px 0px)", duration: 0.85, ease: "power2.inOut", immediateRender: false }}, Ti + 0.5);
    tl.fromTo("#e-cursor", {{ x: 0 }}, {{ x: 640, duration: 0.85, ease: "power2.inOut", immediateRender: false }}, Ti + 0.5);
    [Ti + 1.5, Ti + 1.8].forEach((t) => {{ tl.set("#e-cursor", {{ opacity: 0 }}, t); tl.set("#e-cursor", {{ opacity: 1 }}, t + 0.15); }});
    tl.set("#e-cursor", {{ opacity: 0 }}, Ti + 2.1);
    window.__timelines["n2"] = tl;
  </script>
</template>
'''
open('compositions/n2-end.html', 'w').write(n2)

# ---- sound. peaks in seconds into each file.
PEAK = {'print-a.mp3': 0, 'print-b.mp3': 0, 'cut.mp3': 0.02, 'tear.mp3': 0.95, 'impact-bass-1.mp3': 0.07, 'key-press.mp3': 0.07, 'click-soft.mp3': 0.05}
DUR = {'print-a.mp3': 0.45, 'print-b.mp3': 0.45, 'cut.mp3': 0.45, 'tear.mp3': 1.5, 'key-press.mp3': 0.4, 'click-soft.mp3': 0.36}
clips = []


def add(name, f, hit, vol, dur=None, **kw):
    clips.append(dict(name=name, f=f, start=round(max(hit + F - PEAK[f], 0), 3), dur=round(dur or DUR[f], 3), vol=vol, extra=kw))


feed_hits = [b(k) for k in [1, 2, 3, 4]] + [b(k) for k in range(5, 16, 2)] + [b(k) for k in range(19, 27, 2)] + [b(28), b(29), b(30)] + [b(37), b(38)]
for i, t in enumerate(feed_hits):
    add(f'print-{i + 1}', 'print-a.mp3' if i % 2 == 0 else 'print-b.mp3', t, 0.8)
add('post', 'key-press.mp3', b(16), 0.8)
add('fee-cut', 'cut.mp3', b(32), 0.9)
add('fee-hit', 'impact-bass-1.mp3', b(32), 0.5, 1.2, **{'data-fade-out': '0.5'})
add('tear', 'tear.mp3', b(42), 1)
add('mark', 'impact-bass-1.mp3', b(44), 0.7, 1.6, **{'data-fade-out': '0.7'})
add('word', 'key-press.mp3', b(44) + 0.55, 0.5)
clips.sort(key=lambda c: c['start'])
ends = {}
for c in clips:
    tr = 4
    while ends.get(tr, -1) > c['start'] + 1e-6:
        tr += 1
    c['track'] = tr
    ends[tr] = c['start'] + c['dur']
aud = '\n'.join(
    '      <audio id="sfx-{n}" class="clip" src="assets/sfx/{f}" data-start="{s}" data-duration="{d}"{ex} data-volume="{v}" data-track-index="{t}" data-audio-group="sfx"></audio>'.format(
        n=c['name'], f=c['f'], s=c['start'], d=c['dur'], ex=''.join(f' {k}="{v}"' for k, v in c['extra'].items()), v=c['vol'], t=c['track'])
    for c in clips)
index = f'''<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      * {{ margin: 0; padding: 0; box-sizing: border-box; }}
      html, body {{ margin: 0; width: 1920px; height: 1080px; overflow: hidden; background: #0000ff; }}
      #root {{ position: relative; width: 100%; height: 100%; background: #0000ff; }}
      #n1 {{ z-index: 1; }} #n2 {{ z-index: 2; }}
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="{TOTAL}" data-width="1920" data-height="1080">
      <div id="n1" data-composition-id="n1" data-composition-src="compositions/n1-receipt.html" data-start="0" data-duration="{round(b(44), 3)}" data-track-index="1" data-track-kind="graphics" data-width="1920" data-height="1080"></div>
      <div id="n2" data-composition-id="n2" data-composition-src="compositions/n2-end.html" data-start="{N2_T}" data-duration="{round(TOTAL - N2_T, 3)}" data-track-index="2" data-track-kind="graphics" data-width="1920" data-height="1080"></div>

      <!-- Music: catalog minimal pulse, 100 BPM, beat = 0.6 s. Dip 9.6-11.4, release on 19.2, peak on 26.4. Played once at rate 1. -->
      <audio id="bed" class="clip" src="assets/audio/bed-night.wav" data-start="0" data-media-start="0" data-duration="{TOTAL}" data-volume="1" data-fade-in="0.03" data-fade-out="0.8" data-track-index="3" data-audio-group="music"></audio>

      <!-- Effects, peak-aligned one frame after their picture (generated by build.py). -->
{aud}
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
open('index.html', 'w').write(index)
print('rows', len(events), 'paper', PAPER_H, 'marks', marks, 'sfx', len(clips))

# Generates compositions/i1-agent.html, compositions/i2-end.html and index.html. Run: python3 build.py
import json, math, re

B = 0.625  # 96 BPM
F = 1 / 30
TOTAL = 20.6
b = lambda k: round(k * B, 3)
FONTS = """
    @font-face { font-family: 'Geist'; font-weight: 500; src: url('assets/fonts/Geist-500.woff2') format('woff2'); }
    @font-face { font-family: 'Geist'; font-weight: 600; src: url('assets/fonts/Geist-600.woff2') format('woff2'); }
    @font-face { font-family: 'Geist Mono'; font-weight: 500; src: url('assets/fonts/GeistMono-500.woff2') format('woff2'); }"""

# ---- the face: portraitCells("friend") from apps/web/components/art/AgentPortrait.tsx.
FACE = [
    '       ##       ',
    '       ##       ',
    '      ....      ',
    '   ..........   ',
    '   ..........   ',
    ' ......##...... ',
    ' .#....##....#. ',
    ' ...@@....@@... ',
    ' .............. ',
    ' ...#......#... ',
    '  ...######...  ',
    '   ..........   ',
    '    ........    ',
    '      ....      ',
    '                ',
    '                ',
]
CELL = 62
cells = []
for r, row in enumerate(FACE):
    for c, ch in enumerate(row):
        if ch != ' ':
            cells.append((c, r, ch))
others = sorted([x for x in cells if x[2] == '.'], key=lambda x: (math.hypot(x[0] - 7.5, x[1] - 6.5), x[1], x[0]))
n = len(others)
wave = {}
for i, x in enumerate(others):
    wave[x] = 0 if i < 10 else 1 + min(2, (i - 10) * 3 // (n - 10))
dots = []
for x in cells:
    c, r, ch = x
    cx, cy = c * CELL + CELL / 2, r * CELL + CELL / 2
    if ch == '.':
        dots.append(f'<circle class="d w{wave[x]}" cx="{cx}" cy="{cy}" r="16" fill="#ffffff" fill-opacity="0.55"></circle>')
    elif ch == '#':
        dots.append(f'<circle class="d w4" cx="{cx}" cy="{cy}" r="24" fill="#ffffff"></circle>')
    else:
        dots.append(f'<rect class="shut" x="{cx - 31}" y="{cy - 6}" width="62" height="12" fill="#ffffff"></rect>')
        dots.append(f'<circle class="eye" cx="{cx}" cy="{cy}" r="27" fill="#ffffff"></circle>')
SIZE = 16 * CELL

# ---- the lines.
lines = [
    ('l1', "i don't<br>exist yet.", 0, b(4)),
    ('l2', 'i could<br>watch<br>a market.', b(4), b(7)),
    ('l3', 'i could<br>welcome<br>your holders.', b(7), b(10)),
    ('l4', 'i could<br>read all night.', b(10), b(13)),
    ('l5', "you'd<br>name me.", b(13), b(16)),
]
line_html = '\n      '.join(f'<div class="l" id="{i}">{t}</div>' for i, t, _, _ in lines)
hide = ', '.join(f'"#{i}"' for i, _, _, _ in lines[1:])
js = []
for i, _, s, e in lines:
    js.append((f'typeIn("#{i}", {s + 0.03:.3f}); ' if s > 0 else '') + f'tl.to("#{i}", {{ opacity: 0, duration: 0.08 }}, {e - 0.08:.3f});')
js = '\n    '.join(js)

base_svg = open('assets/logos/base-square.svg').read()
base_path = re.search(r'<path d="([^"]+)"', base_svg).group(1)
base_vb = re.search(r'viewBox="([^"]+)"', base_svg).group(1)

i1 = f'''<template>
  <style>{FONTS}
    #root {{ position: absolute; inset: 0; overflow: hidden; font-family: 'Geist', sans-serif; color: #ffffff; }}
    #face {{ position: absolute; left: 860px; top: 106px; width: {SIZE}px; height: {SIZE}px; display: block; overflow: visible; }}
    .l {{ position: absolute; left: 96px; top: 330px; font-weight: 600; font-size: 116px; line-height: 124px; letter-spacing: -0.035em; white-space: nowrap; }}
    #ticker {{ position: absolute; left: 96px; top: 610px; font-family: 'Geist Mono', monospace; font-weight: 500; font-size: 116px; line-height: 130px; white-space: nowrap; letter-spacing: -0.03em; }}
    #caret {{ position: absolute; left: 96px; top: 626px; width: 66px; height: 100px; background: #ffffff; }}
    .door {{ position: absolute; top: 0; width: 960px; height: 1080px; }}
    #dl {{ left: 0; background: #85e2ff; color: #0a0b0d; }}
    #dr {{ left: 960px; background: #ffffff; color: #8763d1; }}
    .dlogo {{ position: absolute; display: block; }}
    #lr {{ left: 310px; top: 150px; width: 340px; height: 340px; }}
    #lc {{ left: 280px; top: 120px; width: 400px; height: 400px; }}
    .dn {{ position: absolute; left: 0; width: 960px; top: 520px; text-align: center; font-weight: 600; font-size: 132px; line-height: 150px; letter-spacing: -0.04em; white-space: nowrap; }}
    .knob {{ position: absolute; top: 400px; width: 36px; height: 36px; border-radius: 18px; }}
    #kl {{ left: 900px; background: #0a0b0d; }}
    #kr {{ left: 24px; background: #8763d1; }}
    #band {{ position: absolute; left: 0; top: 820px; width: 1920px; height: 260px; background: #0000ff; }}
    #bs {{ position: absolute; left: 96px; top: 70px; width: 120px; height: 120px; display: block; }}
    .bl {{ position: absolute; left: 256px; top: 62px; font-weight: 600; font-size: 116px; line-height: 136px; letter-spacing: -0.035em; color: #ffffff; white-space: nowrap; }}
    #turn {{ position: absolute; left: 0; width: 1920px; top: 790px; text-align: center; font-weight: 600; font-size: 150px; line-height: 170px; letter-spacing: -0.04em; color: #ffffff; white-space: nowrap; }}
  </style>
  <div id="root" data-composition-id="i1" data-width="1920" data-height="1080">
    <svg id="face" viewBox="0 0 {SIZE} {SIZE}" data-layout-allow-overflow>{"".join(dots)}</svg>
    {line_html}
    <div id="ticker">$YOURS</div>
    <div id="caret" data-layout-ignore></div>
    <div id="turn">your turn.</div>
    <div id="doors" data-layout-allow-overflow data-layout-allow-overlap>
      <div class="door" id="dl">
        <img class="dlogo" id="lr" src="assets/logos/rwagmi-black.png" alt="RWAGMI">
        <div class="dn">rwagmi</div>
        <div class="knob" id="kl"></div>
      </div>
      <div class="door" id="dr">
        <img class="dlogo" id="lc" src="assets/logos/clanker.png" alt="Clanker">
        <div class="dn">clanker</div>
        <div class="knob" id="kr"></div>
      </div>
      <div id="band">
        <svg id="bs" viewBox="{base_vb}" fill="none" role="img" aria-label="Base"><path d="{base_path}" fill="#ffffff"></path></svg>
        <div class="bl" id="b1">on base.</div>
        <div class="bl" id="b2">one transaction.</div>
      </div>
    </div>
  </div>
  <script>
    const tl = gsap.timeline({{ paused: true }});
    const typeIn = (s, t) => {{
      tl.set(s, {{ opacity: 1 }}, t);
      tl.fromTo(s, {{ clipPath: "inset(-10px 100% 100% 0px)" }}, {{ clipPath: "inset(-10px -10px -20px 0px)", duration: 0.24, ease: "steps(8)", immediateRender: false }}, t);
    }};
    const pop = (s, t) => tl.fromTo(s, {{ scale: 0, transformOrigin: "50% 50%" }}, {{ scale: 1, duration: 0.3, ease: "back.out(2.5)", stagger: 0.008, immediateRender: false }}, t);
    gsap.set([{hide}, "#ticker", "#caret", "#turn", "#b2", ".eye"], {{ opacity: 0 }});
    gsap.set([".w1", ".w2", ".w3", ".w4"], {{ scale: 0, transformOrigin: "50% 50%" }});
    gsap.set(".shut", {{ opacity: 0 }});
    gsap.set("#dl", {{ x: -960 }});
    gsap.set("#dr", {{ x: 960 }});
    gsap.set("#band", {{ y: 260 }});
    {js}
    // The face fills in, one wave for each thing it could be.
    pop(".w0", 0.1);
    pop(".w1", {b(4)});
    pop(".w2", {b(7)});
    pop(".w3", {b(10)});
    pop(".w4", {b(13)});
    tl.set(".shut", {{ opacity: 1 }}, {b(13)});
    // The name types itself.
    tl.set(["#ticker", "#caret"], {{ opacity: 1 }}, {b(13) + 0.45});
    tl.fromTo("#ticker", {{ clipPath: "inset(-10px 100% -10px 0px)" }}, {{ clipPath: "inset(-10px 0% -10px 0px)", duration: 0.6, ease: "steps(6)", immediateRender: false }}, {b(13) + 0.45});
    tl.fromTo("#caret", {{ x: 0 }}, {{ x: 420, duration: 0.6, ease: "steps(6)", immediateRender: false }}, {b(13) + 0.45});
    // The doors slam on the swell.
    tl.fromTo("#dl", {{ x: -960 }}, {{ x: 0, duration: 0.35, ease: "expo.out", immediateRender: false }}, {b(16)});
    tl.fromTo("#dr", {{ x: 960 }}, {{ x: 0, duration: 0.35, ease: "expo.out", immediateRender: false }}, {b(16)});
    tl.fromTo("#band", {{ y: 260 }}, {{ y: 0, duration: 0.35, ease: "expo.out", immediateRender: false }}, {b(16) + 0.12});
    tl.set("#b1", {{ opacity: 0 }}, {b(20)});
    typeIn("#b2", {b(20)});
    // Behind the closed doors the face moves to the centre.
    tl.set(["#ticker", "#caret"], {{ opacity: 0 }}, {b(16) + 0.4});
    tl.set("#face", {{ x: -396, y: -160, scale: 0.7, transformOrigin: "496px 434px" }}, {b(16) + 0.4});
    // The doors open and it wakes.
    tl.to("#band", {{ y: 260, duration: 0.3, ease: "power3.in" }}, {b(24)});
    tl.to("#dl", {{ x: -960, duration: 0.55, ease: "power3.inOut" }}, {b(24)});
    tl.to("#dr", {{ x: 960, duration: 0.55, ease: "power3.inOut" }}, {b(24)});
    tl.set(".shut", {{ opacity: 0 }}, {b(24) + 0.6});
    tl.set(".eye", {{ opacity: 1 }}, {b(24) + 0.6});
    tl.fromTo(".eye", {{ scale: 0, transformOrigin: "50% 50%" }}, {{ scale: 1, duration: 0.3, ease: "back.out(3)", immediateRender: false }}, {b(24) + 0.6});
    tl.to(".eye", {{ scaleY: 0.12, duration: 0.05 }}, {b(24) + 1.2});
    tl.to(".eye", {{ scaleY: 1, duration: 0.08 }}, {b(24) + 1.3});
    typeIn("#turn", {b(24) + 0.55});
    tl.to(["#face", "#turn"], {{ opacity: 0, duration: 0.2, ease: "power3.in" }}, 16.75);
    window.__timelines["i1"] = tl;
  </script>
</template>
'''
open('compositions/i1-agent.html', 'w').write(i1)

T2 = 16.9
i2 = f'''<template>
  <style>{FONTS}
    #root {{ position: absolute; inset: 0; overflow: hidden; font-family: 'Geist', sans-serif; }}
    #e-shake {{ position: absolute; inset: 0; }}
    #e-box {{ position: absolute; left: 816px; top: 396px; width: 288px; height: 288px; }}
    #e-sq {{ position: relative; width: 288px; height: 288px; }}
    #e-mark {{ position: absolute; left: 0; top: 0; width: 288px; height: 288px; display: block; }}
    #e-word {{ position: absolute; left: 832px; top: 399px; font-size: 256px; font-weight: 600; letter-spacing: -0.04em; line-height: 1; color: #ffffff; white-space: nowrap; }}
    #e-cursor {{ position: absolute; left: 832px; top: 435px; width: 118px; height: 182px; background: #ffffff; }}
  </style>
  <div id="root" data-composition-id="i2" data-width="1920" data-height="1080">
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
    const Ti = {round(17.5 - T2, 3)};
    gsap.set(["#e-word", "#e-cursor", "#e-box"], {{ opacity: 0 }});
    gsap.set(["#e-cup", "#e-stem"], {{ opacity: 0 }});
    tl.set("#e-shake", {{ x: 0, y: 0 }}, 0);
    tl.set("#e-box", {{ opacity: 1 }}, Ti - 0.56);
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
    tl.set("#e-cursor", {{ opacity: 0 }}, Ti + 1.5);
    window.__timelines["i2"] = tl;
  </script>
</template>
'''
open('compositions/i2-end.html', 'w').write(i2)

# ---- sound.
PEAK = {'pop.mp3': 0.115, 'key-press.mp3': 0.07, 'impact-bass-1.mp3': 0.07, 'whoosh.mp3': 0.16}
DUR = {'pop.mp3': 0.72, 'key-press.mp3': 0.4, 'whoosh.mp3': 0.575}
clips = []


def add(name, f, hit, vol, dur=None, **kw):
    clips.append(dict(name=name, f=f, start=round(max(hit + F - PEAK[f], 0), 3), dur=round(dur or DUR[f], 3), vol=vol, extra=kw))


add('w0', 'pop.mp3', 0.1, 0.5)
for i, k in enumerate([4, 7, 10, 13]):
    add(f'wave-{i + 1}', 'pop.mp3', b(k), 0.55)
    add(f'line-{i + 1}', 'key-press.mp3', b(k) + 0.03, 0.45)
add('ticker', 'key-press.mp3', b(13) + 0.45, 0.6)
add('door-in', 'whoosh.mp3', b(16), 0.7)
add('door-hit', 'impact-bass-1.mp3', b(16) + 0.1, 0.55, 1.2, **{'data-fade-out': '0.5'})
add('tx', 'key-press.mp3', b(20), 0.6)
add('door-out', 'whoosh.mp3', b(24) + 0.1, 0.7)
add('wake', 'pop.mp3', b(24) + 0.6, 0.8)
add('mark', 'impact-bass-1.mp3', 17.5, 0.7, 1.6, **{'data-fade-out': '0.7'})
add('word', 'key-press.mp3', 18.05, 0.5)
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
      #i1 {{ z-index: 1; }} #i2 {{ z-index: 2; }}
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="{TOTAL}" data-width="1920" data-height="1080">
      <div id="i1" data-composition-id="i1" data-composition-src="compositions/i1-agent.html" data-start="0" data-duration="17" data-track-index="1" data-track-kind="graphics" data-width="1920" data-height="1080"></div>
      <div id="i2" data-composition-id="i2" data-composition-src="compositions/i2-end.html" data-start="{T2}" data-duration="{round(TOTAL - T2, 3)}" data-track-index="2" data-track-kind="graphics" data-width="1920" data-height="1080"></div>

      <!-- Music: catalog warm piano, 96 BPM, beat = 0.625 s. Swell on 10.0, hits on 15.0 and 17.5. Played once at rate 1. -->
      <audio id="bed" class="clip" src="assets/audio/bed-invite.wav" data-start="0" data-media-start="0" data-duration="20" data-volume="0.85" data-fade-in="0.03" data-fade-out="1" data-track-index="3" data-audio-group="music"></audio>

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
print('dots', len(dots), 'sfx', len(clips))

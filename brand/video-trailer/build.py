# Generates compositions/*.html and index.html. Run: python3 build.py
import json, math, random

T = json.load(open('assets/voice/timing.json'))
# Bed: ElevenLabs Music, 120 BPM, bars on 0.1 + 2k; full energy from 16.1, last hit 42.9.
V = {'n1': 4.0, 'n2': 9.4, 'n3': 12.4, 'a1': 16.3, 'n4': 17.3, 'n5': 20.2, 'n6': 24.3, 'n7': 28.6, 'n8': 30.9, 'a2': 40.6}
MARK = 42.9
BED_OFF = 1.4
TOTAL = 46.5
F = 1 / 30

FONTS = """
    @font-face { font-family: 'Geist'; font-weight: 600; src: url('assets/fonts/Geist-600.woff2') format('woff2'); }
    @font-face { font-family: 'Geist Mono'; font-weight: 500; src: url('assets/fonts/GeistMono-500.woff2') format('woff2'); }"""
BASE = FONTS + """
    #root { position: absolute; inset: 0; overflow: hidden; font-family: 'Geist', sans-serif; color: #ffffff; background: #000000; }
    .abs { position: absolute; white-space: nowrap; }
    .big { font-weight: 600; letter-spacing: -0.04em; }
    .mono { font-family: 'Geist Mono', monospace; font-weight: 500; }
    .card { position: absolute; left: 0; width: 1920px; text-align: center; font-weight: 600; letter-spacing: -0.045em; white-space: nowrap; }
    .full { position: absolute; inset: 0; }
"""
HELPERS = """
    const tl = gsap.timeline({ paused: true });
    const slam = (s, t) => { tl.set(s, { opacity: 1 }, t); tl.fromTo(s, { scale: 1.35, transformOrigin: "50% 50%" }, { scale: 1, duration: 0.28, ease: "expo.out", immediateRender: false }, t); };
    const typeIn = (s, t, d) => { tl.set(s, { opacity: 1 }, t); tl.fromTo(s, { clipPath: "inset(-30px 100% -30px 0px)" }, { clipPath: "inset(-30px -30px -30px 0px)", duration: d || 0.3, ease: "steps(10)", immediateRender: false }, t); };
    const pop = (s, t, o) => { tl.set(s, { opacity: 1 }, t); tl.fromTo(s, { scale: 0, transformOrigin: "50% 50%" }, Object.assign({ scale: 1, duration: 0.3, ease: "back.out(2.5)", stagger: 0.006, immediateRender: false }, o || {}), t); };
    const shake = (s, t) => [[0, 12, -8], [0.033, -10, 6], [0.066, 6, -4], [0.1, -3, 2], [0.133, 0, 0]].forEach(([d, x, y]) => tl.set(s, { x, y }, t + d));
    const flash = (t) => { tl.set("#fl", { opacity: 0.9 }, t); tl.to("#fl", { opacity: 0, duration: 0.12, ease: "power2.out" }, t + 0.034); };
"""
FLASH = '<div class="full" id="fl" style="background:#ffffff;opacity:0;z-index:50" data-layout-ignore></div>'

FACE = [
    '       ##       ', '       ##       ', '      ....      ', '   ..........   ', '   ..........   ', ' ......##...... ', ' .#....##....#. ',
    ' ...@@....@@... ', ' .............. ', ' ...#......#... ', '  ...######...  ', '   ..........   ', '    ........    ', '      ....      ']
cells = [(c, r, ch) for r, row in enumerate(FACE) for c, ch in enumerate(row) if ch != ' ']


def face(fid, cell, ink='#ffffff', waves=1):
    others = sorted([x for x in cells if x[2] == '.'], key=lambda x: (math.hypot(x[0] - 7.5, x[1] - 6.5), x[1], x[0]))
    grp = {x: min(waves - 1, i * waves // len(others)) for i, x in enumerate(others)}
    out = []
    for x in cells:
        c, r, ch = x
        cx, cy = c * 62 + 31, r * 62 + 31
        if ch == '.':
            out.append(f'<circle class="d w{grp[x]}" cx="{cx}" cy="{cy}" r="16" fill="{ink}" fill-opacity="0.55"></circle>')
        elif ch == '#':
            out.append(f'<circle class="hi" cx="{cx}" cy="{cy}" r="24" fill="{ink}"></circle>')
        else:
            out.append(f'<rect class="shut" x="{cx - 31}" y="{cy - 6}" width="62" height="12" fill="{ink}"></rect>')
            out.append(f'<circle class="eye" cx="{cx}" cy="{cy}" r="27" fill="{ink}"></circle>')
    return f'<svg id="{fid}" class="face" viewBox="0 0 992 868" style="position:absolute;display:block;width:{16 * cell}px;height:{14 * cell}px" fill="none" role="img" aria-label="the agent" data-layout-allow-overflow>{"".join(out)}</svg>'


scenes = []


def scene(cid, start, end, css, html, js):
    L = lambda t: round(t - start, 3)
    body = '\n    '.join(j(L) if callable(j) else j for j in js)
    open(f'compositions/{cid}.html', 'w').write(f'''<template>
  <style>{BASE}{css}
  </style>
  <div id="root" data-composition-id="{cid}" data-width="1920" data-height="1080">
    {html}
    {FLASH}
  </div>
  <script>{HELPERS}
    {body}
    window.__timelines["{cid}"] = tl;
  </script>
</template>
''')
    scenes.append((cid, start, end))


# ---- 1. cold open, 0 to 4.
scene('t1', 0, 4.0, '#c1 { top: 440px; font-size: 180px; line-height: 200px; }', '<div class="card" id="c1">this november</div>',
      ['tl.set("#c1", { opacity: 1 }, 0);', 'tl.fromTo("#c1", { scale: 1.12 }, { scale: 1, duration: 3.9, ease: "power1.out", immediateRender: false }, 0);',
       'tl.to("#c1", { opacity: 0, duration: 0.4 }, 3.4);'])

# ---- 2. a world of tickers, 4 to 12.1. One row turns blue and becomes the face.
random.seed(7)
A = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
rows, cols = 13, 6
tick = []
for r in range(rows):
    for c in range(cols):
        tick.append(''.join(random.choice(A) for _ in range(random.randint(3, 5))))
hero = 6 * cols + 2
gh = ''.join(f'<div class="abs mono tk{" hero" if i == hero else ""}" id="{"hero" if i == hero else f"k{i}"}" style="left:{90 + (i % cols) * 300}px;top:{(i // cols) * 120 - 120}px">${t if i != hero else "YOURS"}</div>' for i, t in enumerate(tick))
css = """
    #grid { position: absolute; left: 0; top: 0; width: 1920px; height: 1600px; }
    .tk { font-size: 60px; line-height: 80px; color: #3a3a3a; }
    #blue { background: #0000ff; opacity: 0; }
    #wf { left: 464px; top: 52px; }
"""
html = f'<div id="grid" data-layout-allow-overflow data-layout-allow-overlap>{gh}</div><div class="full" id="blue"></div>{face("wf", 62, waves=3)}'
N2 = V['n2']
js = ['gsap.set("#wf", { opacity: 0 }); gsap.set([".w0", ".w1", ".w2", ".hi", ".eye"], { scale: 0, transformOrigin: "50% 50%" }); gsap.set(".eye", { opacity: 0 });',
      lambda L: f'tl.fromTo("#grid", {{ y: 0 }}, {{ y: -360, duration: {L(N2)}, ease: "none", immediateRender: false }}, 0);',
      lambda L: f'tl.set("#hero", {{ color: "#ffffff" }}, {L(N2)}); tl.set(".tk:not(#hero)", {{ color: "#141414" }}, {L(N2)});',
      lambda L: f'tl.to("#hero", {{ scale: 2.2, duration: 0.5, ease: "expo.out", transformOrigin: "50% 50%" }}, {L(N2)});',
      lambda L: f'tl.set("#blue", {{ opacity: 1 }}, {L(N2 + 1.6)}); tl.set("#grid", {{ opacity: 0 }}, {L(N2 + 1.6)}); tl.set("#wf", {{ opacity: 1 }}, {L(N2 + 1.6)});',
      lambda L: f'tl.set(".shut", {{ opacity: 1 }}, {L(N2 + 1.6)}); pop(".w0", {L(N2 + 1.6)}); pop(".w1", {L(N2 + 1.85)}); pop(".w2", {L(N2 + 2.1)}); pop(".hi", {L(N2 + 2.35)});',
      lambda L: f'flash({L(N2 + 1.6)});']
scene('t2', 4.0, 12.1, css, html, js)

# ---- 3. born in one transaction, 12.1 to 14.1.
scene('t3', 12.1, 14.1, '#c3 { top: 420px; font-size: 150px; line-height: 170px; }', '<div class="card" id="c3">born in<br>one transaction.</div>',
      ['gsap.set("#c3", { opacity: 0 });', 'slam("#c3", 0); flash(0); shake("#c3", 0);'])

# ---- 4. it wakes, 14.1 to 17.1.
css = '#root { background: #0000ff; } #af { left: 464px; top: 52px; } #aw { top: 900px; font-size: 120px; line-height: 140px; }'
html = f'{face("af", 62)}<div class="card" id="aw">i\'m awake.</div>'
js = ['gsap.set([".eye", "#aw"], { opacity: 0 });',
      lambda L: f'tl.set(".shut", {{ opacity: 0 }}, {L(16.1)}); pop(".eye", {L(16.1)}, {{ ease: "back.out(3)" }}); flash({L(16.1)}); shake("#af", {L(16.1)});',
      lambda L: f'slam("#aw", {L(V["a1"])});',
      lambda L: f'tl.fromTo("#af", {{ scale: 1 }}, {{ scale: 1.08, duration: 1.0, ease: "none", transformOrigin: "50% 50%", immediateRender: false }}, {L(16.1)});']
scene('t4', 14.1, 17.1, css, html, js)

# ---- 5. it reads the room, 17.1 to 20.1: four cuts on the beat.
words = ['mentions.', 'market.', 'wallet.', 'notes.']
css = '.rw { top: 400px; font-size: 230px; line-height: 250px; } #rt { top: 860px; font-size: 64px; line-height: 80px; color: #9a9a9a; }'
html = ''.join(f'<div class="full" id="rb{i}" style="background:{"#0000ff" if i % 2 == 0 else "#000000"}"><div class="card rw">{w}</div></div>' for i, w in enumerate(words)) + '<div class="card mono" id="rt">it reads the room.</div>'
js = ['gsap.set([' + ', '.join(f'"#rb{i}"' for i in range(4)) + ', "#rt"], { opacity: 0 });']
for i in range(4):
    js.append(lambda L, i=i: f'tl.set("#rb{i}", {{ opacity: 1 }}, {L(17.1 + 0.6 * i + (0.3 if i else 0))}); flash({L(17.1 + 0.6 * i + (0.3 if i else 0))});' + (f' tl.set("#rb{i - 1}", {{ opacity: 0 }}, {L(17.1 + 0.6 * i + 0.3)});' if i else ''))
js.append(lambda L: f'typeIn("#rt", {L(V["n4"])});')
scene('t5', 17.1, 20.1, css, html, js)

# ---- 6. it pays for every thought, 20.1 to 24.1.
vals = [f'{20 - 0.02 * i:.2f}' for i in range(8)]
css = '.num { left: 0; width: 1920px; text-align: center; top: 300px; font-size: 360px; line-height: 380px; letter-spacing: -0.05em; } #fu { top: 720px; font-size: 60px; line-height: 72px; color: #9a9a9a; } #ft { top: 150px; font-size: 60px; line-height: 72px; color: #3c8aff; }'
html = ''.join(f'<div class="abs mono num" id="u{i}">{v}</div>' for i, v in enumerate(vals)) + '<div class="card mono" id="fu">usdc of its own fuel</div><div class="card mono" id="ft">one thought: -0.02</div>'
js = ['gsap.set([' + ', '.join(f'"#u{i}"' for i in range(1, 8)) + ', "#ft"], { opacity: 0 });', 'flash(0);']
for i in range(1, 8):
    js.append(lambda L, i=i: f'tl.set("#u{i - 1}", {{ opacity: 0 }}, {L(20.1 + 0.5 * i)}); tl.set("#u{i}", {{ opacity: 1 }}, {L(20.1 + 0.5 * i)}); tl.set("#ft", {{ opacity: 1 }}, {L(20.1 + 0.5 * i)}); tl.fromTo("#ft", {{ y: 0 }}, {{ y: -16, duration: 0.3, ease: "power2.out", immediateRender: false }}, {L(20.1 + 0.5 * i)});')
scene('t6', 20.1, 24.1, css, html, js)

# ---- 7. it speaks for its coin, 24.1 to 28.1. A real post.
css = """
    #root { background: #0000ff; }
    #pq { left: 160px; top: 260px; width: 1600px; white-space: normal; font-size: 104px; line-height: 118px; }
    #pa { left: 160px; top: 700px; font-size: 44px; line-height: 56px; color: #c9c9ff; }
    #pt { left: 160px; top: 120px; font-size: 56px; line-height: 70px; }
"""
html = '<div class="abs mono" id="pt">it speaks for its coin.</div><div class="abs big" id="pq">&ldquo;one that makes a small decision and lives with the consequences.&rdquo;</div><div class="abs mono" id="pa">@AgentBootr, a real post, 6 nov</div>'
js = ['gsap.set(["#pq", "#pa", "#pt"], { opacity: 0 });', 'flash(0);', lambda L: f'typeIn("#pt", {L(V["n6"])}); slam("#pq", {L(24.6)}); typeIn("#pa", {L(25.1)}, 0.4);']
scene('t7', 24.1, 28.1, css, html, js)

# ---- 8. the stop, 28.1 to 32.1.
css = '.sl { top: 440px; font-size: 130px; line-height: 150px; }'
html = '<div class="card sl" id="s1">but it plays by rules&hellip;</div><div class="card sl" id="s2">it cannot break.</div>'
js = ['gsap.set(["#s1", "#s2"], { opacity: 0 });', lambda L: f'typeIn("#s1", {L(V["n7"])}, 0.6); tl.set("#s1", {{ opacity: 0 }}, {L(V["n8"] - 0.05)}); slam("#s2", {L(V["n8"])});']
scene('t8', 28.1, 32.1, css, html, js)

# ---- 9. the rules, 32.1 to 40.1, a card a bar.
rules = [("can't send money<br>to anyone.", '#0000ff'), ("can't trade<br>its own coin.", '#000000'), ("can't change<br>its split.", '#0000ff')]
css = """
    .rl { top: 330px; font-size: 180px; line-height: 200px; }
    .nx { position: absolute; left: 896px; top: 120px; width: 128px; height: 128px; }
    #rate { position: absolute; left: 510px; top: 300px; width: 900px; height: 480px; border: 14px solid #ffffff; }
    #rb { position: absolute; left: 0; top: 0; width: 340px; height: 452px; background: #ffffff; color: #000000; text-align: center; font-size: 300px; line-height: 452px; font-weight: 600; }
    #rr { left: 384px; top: 90px; font-size: 84px; line-height: 100px; }
    #rf { left: 384px; top: 220px; font-size: 104px; line-height: 124px; }
"""
X = '<svg class="nx" viewBox="0 0 8 8" data-layout-ignore><path d="M0 0h2v2h-2zM6 0h2v2h-2zM2 2h2v2h-2zM4 2h2v2h-2zM2 4h2v2h-2zM4 4h2v2h-2zM0 6h2v2h-2zM6 6h2v2h-2z" fill="#ffffff"></path></svg>'
html = ''.join(f'<div class="full" id="g{i}" style="background:{bg}">{X}<div class="card rl">{t}</div></div>' for i, (t, bg) in enumerate(rules))
html += '<div class="full" id="g3"><div id="rate"><div id="rb">B</div><div class="abs big" id="rr">rated</div><div class="abs big" id="rf">for base.</div></div></div>'
js = ['gsap.set(["#g0", "#g1", "#g2", "#g3"], { opacity: 0 });']
for i in range(4):
    js.append(lambda L, i=i: f'tl.set("#g{i}", {{ opacity: 1 }}, {L(32.1 + 2 * i)}); flash({L(32.1 + 2 * i)}); shake("#g{i}", {L(32.1 + 2 * i)});' + (f' tl.set("#g{i - 1}", {{ opacity: 0 }}, {L(32.1 + 2 * i)});' if i else ''))
js.append(lambda L: f'tl.fromTo("#rate", {{ scale: 1.3, transformOrigin: "50% 50%" }}, {{ scale: 1, duration: 0.35, ease: "expo.out", immediateRender: false }}, {L(38.1)});')
scene('t9', 32.1, 40.1, css, html, js)

# ---- 10. your turn, 40.1 to MARK.
css = '#root { background: #0000ff; } #yf { left: 560px; top: 40px; } #yt { top: 880px; font-size: 150px; line-height: 170px; }'
html = f'{face("yf", 50)}<div class="card" id="yt">your turn.</div>'
js = ['gsap.set(["#yt", ".shut"], { opacity: 0 });', 'flash(0);',
      lambda L: f'tl.to(".eye", {{ x: -16, duration: 0.12 }}, {L(40.15)}); tl.to(".eye", {{ x: 0, duration: 0.1 }}, {L(40.45)});',
      lambda L: f'slam("#yt", {L(V["a2"])});',
      lambda L: f'tl.to(["#yf", "#yt"], {{ opacity: 0, duration: 0.15, ease: "power3.in" }}, {L(MARK - 0.45)});']
scene('t10', 40.1, MARK - 0.4, css, html, js)

# ---- 11. the mark.
S = MARK - 0.55
Ti = 0.55
css = """
    #root { background: #0000ff; }
    #e-shake { position: absolute; inset: 0; }
    #e-box { position: absolute; left: 816px; top: 396px; width: 288px; height: 288px; }
    #e-sq { position: relative; width: 288px; height: 288px; }
    #e-mark { position: absolute; left: 0; top: 0; width: 288px; height: 288px; display: block; }
    #e-word { position: absolute; left: 832px; top: 399px; font-size: 256px; font-weight: 600; letter-spacing: -0.04em; line-height: 1; color: #ffffff; white-space: nowrap; }
    #e-cursor { position: absolute; left: 832px; top: 435px; width: 118px; height: 182px; background: #ffffff; }
"""
html = '''<div id="e-shake" data-layout-allow-overflow>
      <div id="e-word">bootr</div><div id="e-cursor" data-layout-ignore></div>
      <div id="e-box" data-layout-ignore><div id="e-sq"><svg id="e-mark" viewBox="0 0 24 24" fill="none" role="img" aria-label="Bootr">
        <mask id="e-m" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24"><rect width="24" height="24" fill="#fff"></rect>
          <path id="e-cup" d="M8.75 7.75H6.75V17.25H17.25V7.75H15.25" pathLength="1" stroke="#000" stroke-width="2.5" stroke-linecap="square"></path>
          <path id="e-stem" d="M12 4.75V12" pathLength="1" stroke="#000" stroke-width="2.5" stroke-linecap="square"></path></mask>
        <rect width="24" height="24" rx="5" fill="#ffffff" mask="url(#e-m)"></rect></svg></div></div>
    </div>'''
js = [f'const Ti = {Ti};', 'gsap.set(["#e-word", "#e-cursor", "#e-box", "#e-cup", "#e-stem"], { opacity: 0 });', 'tl.set("#e-shake", { x: 0, y: 0 }, 0);',
      'tl.set(["#e-box", "#e-cup"], { opacity: 1 }, Ti - 0.5);',
      'tl.fromTo("#e-cup", { strokeDasharray: 1, strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: 0.32, ease: "expo.out", immediateRender: false }, Ti - 0.5);',
      'tl.set("#e-stem", { opacity: 1 }, Ti - 0.18);',
      'tl.fromTo("#e-stem", { strokeDasharray: 1, strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: 0.18, ease: "power3.in", immediateRender: false }, Ti - 0.18);',
      'tl.fromTo("#e-sq", { scaleX: 1, scaleY: 1, transformOrigin: "50% 100%" }, { scaleX: 1.06, scaleY: 0.9, duration: 0.06, ease: "power2.out", immediateRender: false }, Ti);',
      'tl.to("#e-sq", { scaleX: 1, scaleY: 1, duration: 0.4, ease: "back.out(2.2)" }, Ti + 0.06);', 'shake("#e-shake", Ti); flash(Ti);',
      'tl.fromTo("#e-box", { x: 0 }, { x: -382, duration: 0.65, ease: "power3.inOut", immediateRender: false }, Ti + 0.45);',
      'tl.set(["#e-word", "#e-cursor"], { opacity: 1 }, Ti + 0.5);',
      'tl.fromTo("#e-word", { clipPath: "inset(-20px 100% -20px 0px)" }, { clipPath: "inset(-20px 0% -20px 0px)", duration: 0.85, ease: "power2.inOut", immediateRender: false }, Ti + 0.5);',
      'tl.fromTo("#e-cursor", { x: 0 }, { x: 640, duration: 0.85, ease: "power2.inOut", immediateRender: false }, Ti + 0.5);', 'tl.set("#e-cursor", { opacity: 0 }, Ti + 1.5);']
scene('t11', S, TOTAL, css, html, js)

# ---- sound.
PEAK = {'boom-el.mp3': 0.35, 'braam-el.mp3': 0.53, 'whoosh-el.mp3': 0.18, 'key-press.mp3': 0.07, 'pop.mp3': 0.115}
DUR = {'boom-el.mp3': 2.48, 'braam-el.mp3': 3.48, 'whoosh-el.mp3': 1.0, 'key-press.mp3': 0.4, 'pop.mp3': 0.72}
clips = []


def add(name, f, hit, vol, **kw):
    clips.append(dict(name=name, f=f, start=round(max(hit + F - PEAK[f], 0), 3), dur=DUR[f], vol=vol, extra=kw))


add('open', 'braam-el.mp3', 0.55, 0.5)
add('born', 'boom-el.mp3', 12.1, 0.5)
add('wake', 'boom-el.mp3', 16.1, 0.55)
for i in range(4):
    add(f'cut{i}', 'whoosh-el.mp3', 17.1 + 0.6 * i + (0.3 if i else 0), 0.4)
for i in range(1, 8):
    add(f'tick{i}', 'key-press.mp3', 20.1 + 0.5 * i, 0.5)
add('post', 'boom-el.mp3', 24.6, 0.4)
for i in range(7):
    add(f'clock{i}', 'key-press.mp3', 28.6 + 0.5 * i, 0.35)
add('cannot', 'boom-el.mp3', V['n8'], 0.5)
add('stop', 'boom-el.mp3', 28.1, 0.45)
add('rules', 'braam-el.mp3', 32.1, 0.6)
for i in range(1, 4):
    add(f'rule{i}', 'boom-el.mp3', 32.1 + 2 * i, 0.5)
add('turn', 'pop.mp3', V['a2'], 0.4)
add('mark', 'braam-el.mp3', MARK, 0.55)
clips.sort(key=lambda c: c['start'])
ends = {}
for c in clips:
    tr = 4
    while ends.get(tr, -1) > c['start'] + 1e-6:
        tr += 1
    c['track'] = tr
    ends[tr] = c['start'] + c['dur']
aud = '\n'.join('      <audio id="sfx-{n}" class="clip" src="assets/sfx/{f}" data-start="{s}" data-duration="{d}"{ex} data-volume="{v}" data-track-index="{t}" data-audio-group="sfx"></audio>'.format(
    n=c['name'], f=c['f'], s=c['start'], d=c['dur'], ex=''.join(f' {k}="{v}"' for k, v in c['extra'].items()), v=c['vol'], t=c['track']) for c in clips)
voice = '\n'.join(f'      <audio id="{n}" class="clip" src="assets/voice/{n}.mp3" data-start="{round(t - T[n]["lead"], 3)}" data-duration="{T[n]["dur"]}" data-volume="1" data-track-index="1" data-audio-group="voice"></audio>' for n, t in V.items())
hosts = '\n'.join(f'      <div id="{c}" data-composition-id="{c}" data-composition-src="compositions/{c}.html" data-start="{s}" data-duration="{round(e - s, 3)}" data-track-index="{i + 1}" data-track-kind="graphics" data-width="1920" data-height="1080" style="z-index:{i + 1}"></div>' for i, (c, s, e) in enumerate(scenes))
open('index.html', 'w').write(f'''<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <script src="assets/vendor/gsap.min.js"></script>
    <style>
      * {{ margin: 0; padding: 0; box-sizing: border-box; }}
      html, body {{ margin: 0; width: 1920px; height: 1080px; overflow: hidden; background: #000000; }}
      #root {{ position: relative; width: 100%; height: 100%; background: #000000; }}
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="{TOTAL}" data-width="1920" data-height="1080">
{hosts}

      <!-- Music: the ElevenLabs track from the user's orchestral prompt, one continuous take from media {BED_OFF} s so its last hit (44.3) lands on the mark. Dipped, not cut, for the stop. -->
      <audio id="bed-a" class="clip" src="assets/audio/bed-orchestral.mp3" data-start="0" data-media-start="{BED_OFF}" data-duration="28.1" data-volume="0.4" data-fade-out="0.3" data-track-index="3" data-audio-group="music"></audio>
      <audio id="bed-b" class="clip" src="assets/audio/bed-orchestral.mp3" data-start="28.1" data-media-start="{round(28.1 + BED_OFF, 3)}" data-duration="4.0" data-volume="0.14" data-fade-in="0.3" data-fade-out="0.2" data-track-index="3" data-audio-group="music"></audio>
      <audio id="bed-c" class="clip" src="assets/audio/bed-orchestral.mp3" data-start="32.1" data-media-start="{round(32.1 + BED_OFF, 3)}" data-duration="{round(MARK - 0.15 - 32.1, 3)}" data-volume="0.42" data-fade-in="0.15" data-track-index="3" data-audio-group="music"></audio>
      <audio id="bed-d" class="clip" src="assets/audio/bed-orchestral.mp3" data-start="{round(MARK - 0.15, 3)}" data-media-start="{round(MARK - 0.15 + BED_OFF, 3)}" data-duration="{round(TOTAL - MARK + 0.15, 3)}" data-volume="0.75" data-fade-in="0.1" data-fade-out="1.5" data-track-index="3" data-audio-group="music"></audio>

      <!-- Voices: ElevenLabs premade Brian (narrator) and Callum (the agent). -->
{voice}

      <!-- Effects: ElevenLabs sound generation, peak-aligned one frame after their picture. -->
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
''')
print('scenes', len(scenes), 'sfx', len(clips))

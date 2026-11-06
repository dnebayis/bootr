# Generates compositions/*.html and index.html. Run: python3 build.py
import json, math, re

T = json.load(open('assets/voice/timing.json'))
V = {'v1': 0.3, 'v2': 2.1, 'v3': 8.1, 'v4': 12.4, 'v5': 19.75, 'v6': 24.75, 'v7': 28.2, 'v8': 34.3, 'v9': 40.7, 'v10': 46.2}
CHORD = 48.1
TOTAL = 52.1


def w(v, word, nth=0):
    """Film time of a word in a voice clip."""
    hits = [x for x in T[v]['words'] if x[0].strip('.,').lower() == word.lower()]
    return round(V[v] + hits[nth][1], 3)


FONTS = """
    @font-face { font-family: 'Geist'; font-weight: 500; src: url('assets/fonts/Geist-500.woff2') format('woff2'); }
    @font-face { font-family: 'Geist'; font-weight: 600; src: url('assets/fonts/Geist-600.woff2') format('woff2'); }
    @font-face { font-family: 'Geist Mono'; font-weight: 500; src: url('assets/fonts/GeistMono-500.woff2') format('woff2'); }"""
BASE_CSS = FONTS + """
    #root { position: absolute; inset: 0; overflow: hidden; font-family: 'Geist', sans-serif; color: #ffffff; }
    .abs { position: absolute; white-space: nowrap; }
    .big { font-weight: 600; letter-spacing: -0.035em; }
    .mono { font-family: 'Geist Mono', monospace; font-weight: 500; }
"""
HELPERS = """
    const tl = gsap.timeline({ paused: true });
    const typeIn = (s, t, d) => {
      tl.set(s, { opacity: 1 }, t);
      tl.fromTo(s, { clipPath: "inset(-20px 100% -30px 0px)" }, { clipPath: "inset(-20px -20px -30px 0px)", duration: d || 0.24, ease: "steps(10)", immediateRender: false }, t);
    };
    const pop = (s, t, o) => { tl.set(s, { opacity: 1 }, t); tl.fromTo(s, { scale: 0, transformOrigin: "50% 50%" }, Object.assign({ scale: 1, duration: 0.3, ease: "back.out(2.5)", stagger: 0.006, immediateRender: false }, o || {}), t); };
    const land = (s, t) => { tl.set(s, { opacity: 1 }, t); tl.fromTo(s, { x: -40 }, { x: 0, duration: 0.3, ease: "expo.out", immediateRender: false }, t); };
"""

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
]
cells = [(c, r, ch) for r, row in enumerate(FACE) for c, ch in enumerate(row) if ch != ' ']


def face(fid, cell, ink='#ffffff', waves=None):
    """The face as an svg. waves: how many groups the faint dots are split into, classed w0..; bright dots are .hi."""
    others = sorted([x for x in cells if x[2] == '.'], key=lambda x: (math.hypot(x[0] - 7.5, x[1] - 6.5), x[1], x[0]))
    grp = {x: (min(waves - 1, i * waves // len(others)) if waves else 0) for i, x in enumerate(others)}
    out = []
    for x in cells:
        c, r, ch = x
        cx, cy = c * 62 + 31, r * 62 + 31
        if ch == '.':
            out.append(f'<circle class="d w{grp[x]}" cx="{cx}" cy="{cy}" r="16" fill="{ink}" fill-opacity="0.55"></circle>')
        elif ch == '#':
            cls = 'hi ant' if r < 2 else 'hi'
            out.append(f'<circle class="{cls}" cx="{cx}" cy="{cy}" r="24" fill="{ink}"></circle>')
        else:
            out.append(f'<rect class="shut" x="{cx - 31}" y="{cy - 6}" width="62" height="12" fill="{ink}"></rect>')
            out.append(f'<circle class="eye" cx="{cx}" cy="{cy}" r="27" fill="{ink}"></circle>')
    return f'<svg id="{fid}" class="face" viewBox="0 0 992 868" style="width:{16 * cell}px;height:{14 * cell}px" fill="none" role="img" aria-label="the agent" data-layout-allow-overflow>{"".join(out)}</svg>'


def scene(cid, name, start, end, css, html, js, bg=None):
    style = BASE_CSS + css
    body = '\n    '.join(js)
    open(f'compositions/{name}.html', 'w').write(f'''<template>
  <style>{style}
  </style>
  <div id="root" data-composition-id="{cid}" data-width="1920" data-height="1080">
    {html}
  </div>
  <script>{HELPERS}
    {body}
    window.__timelines["{cid}"] = tl;
  </script>
</template>
''')
    return (cid, name, start, end)


scenes = []

# ---- 1. the form.
S = 0.0
rows = [('01', 'Coin', 'Your Coin &middot; $YOURS', w('v2', 'coin')),
        ('02', 'Mind', 'Claude Haiku 4.5', w('v2', 'mind')),
        ('03', 'Kind', 'Community', w('v2', 'job')),
        ('04', 'Character', 'welcomes new holders', w('v2', 'character')),
        ('05', 'X account', '@yours_agent', w('v2', 'account')),
        ('06', 'Fuel', '20 USDC', w('v2', 'fuel'))]
rh = ''.join(f'''<div class="row" id="r{i}" style="top:{150 + i * 122}px"><div class="abs mono rn">{n}</div><div class="abs big rt" id="rt{i}">{t}</div><div class="abs mono rv" id="rv{i}">{v}</div></div>''' for i, (n, t, v, _) in enumerate(rows))
css = """
    #card { position: absolute; left: 96px; top: 90px; width: 900px; height: 900px; background: #0a0b0d; border: 2px solid #32353d; border-radius: 20px; overflow: hidden; }
    #ct { left: 44px; top: 42px; font-size: 68px; line-height: 80px; }
    .row { position: absolute; left: 0; width: 900px; height: 122px; border-top: 2px solid #32353d; }
    .rn { left: 44px; top: 44px; font-size: 32px; line-height: 36px; color: #818895; }
    .rt { left: 116px; top: 32px; font-size: 48px; line-height: 58px; letter-spacing: -0.02em; color: #818895; }
    .rv { right: 44px; top: 42px; font-size: 38px; line-height: 44px; color: #ffffff; }
    #f { position: absolute; left: 1084px; top: 96px; display: block; }
    #cap { left: 1084px; top: 800px; font-size: 76px; line-height: 92px; }
"""
html = f'<div id="card"><div class="abs big" id="ct">Launch</div>{rh}</div>{face("f", 46, waves=6)}<div class="abs big" id="cap1" style="left:1084px;top:800px;font-size:72px;line-height:88px">here\'s how<br>i get made.</div><div class="abs big" id="cap2" style="left:1084px;top:800px;font-size:72px;line-height:88px">you fill in<br>one form.</div>'
js = ['gsap.set([".w1",".w2",".w3",".w4",".w5",".hi"], { scale: 0, transformOrigin: "50% 50%" });',
      'gsap.set([".eye",".shut",".rv","#cap2"], { opacity: 0 });',
      'gsap.set("#cap1", { opacity: 1 });',
      'pop(".w0", 0.05);',
      f'tl.set("#cap1", {{ opacity: 0 }}, {V["v2"]});', f'typeIn("#cap2", {V["v2"]});']
for i, (_, _, _, t) in enumerate(rows):
    js.append(f'tl.set("#rt{i}", {{ color: "#ffffff" }}, {t}); typeIn("#rv{i}", {t}, 0.3);')
    if i < 5:
        js.append(f'pop(".w{i + 1 if i < 5 else 5}", {t});')
js.append(f'pop(".hi", {rows[5][3]}); tl.set(".shut", {{ opacity: 1 }}, {rows[5][3]});')
scenes.append(scene('w1', 'w1-form', 0, 8.1, css, html, js))

# ---- 2. the doors.
S = 8.1
base_svg = open('assets/logos/base-square.svg').read()
base_path = re.search(r'<path d="([^"]+)"', base_svg).group(1)
base_vb = re.search(r'viewBox="([^"]+)"', base_svg).group(1)
L = lambda t: round(t - S, 3)
css = """
    .door { position: absolute; top: 0; width: 960px; height: 1080px; }
    #dl { left: 0; background: #85e2ff; color: #0a0b0d; }
    #dr { left: 960px; background: #ffffff; color: #8763d1; }
    .dlogo { position: absolute; display: block; }
    #lr { left: 310px; top: 110px; width: 340px; height: 340px; }
    #lc { left: 280px; top: 80px; width: 400px; height: 400px; }
    .dn { position: absolute; left: 0; width: 960px; top: 480px; text-align: center; font-weight: 600; font-size: 132px; line-height: 150px; letter-spacing: -0.04em; white-space: nowrap; }
    .knob { position: absolute; top: 370px; width: 36px; height: 36px; border-radius: 18px; }
    #kl { left: 900px; background: #0a0b0d; }
    #kr { left: 24px; background: #8763d1; }
    #band { position: absolute; left: 0; top: 820px; width: 1920px; height: 260px; background: #0000ff; }
    #bs { position: absolute; left: 96px; top: 70px; width: 120px; height: 120px; display: block; }
    #bl { left: 256px; top: 62px; font-size: 116px; line-height: 136px; color: #ffffff; }
    #btn { position: absolute; left: 1324px; top: 52px; width: 500px; height: 156px; background: #ffffff; border-radius: 16px; color: #0a0b0d; text-align: center; font-size: 88px; line-height: 156px; font-weight: 600; letter-spacing: -0.03em; }
    #cur { position: absolute; left: 0; top: 0; width: 72px; height: 72px; display: block; }
"""
html = f'''<div id="dw" data-layout-allow-overflow data-layout-allow-overlap>
      <div class="door" id="dl"><img class="dlogo" id="lr" src="assets/logos/rwagmi-black.png" alt="RWAGMI"><div class="dn">rwagmi</div><div class="knob" id="kl"></div></div>
      <div class="door" id="dr"><img class="dlogo" id="lc" src="assets/logos/clanker.png" alt="Clanker"><div class="dn">clanker</div><div class="knob" id="kr"></div></div>
      <div id="band"><svg id="bs" viewBox="{base_vb}" fill="none" role="img" aria-label="Base"><path d="{base_path}" fill="#ffffff"></path></svg><div class="abs big" id="bl">on base.</div><div id="btn">Launch</div></div>
      <svg id="cur" viewBox="0 0 24 24" data-layout-ignore><path d="M4 2 L4 20 L9 15.5 L12.5 22 L15.5 20.5 L12 14 L19 14 Z" fill="#ffffff" stroke="#0a0b0d" stroke-width="1.6" stroke-linejoin="round"></path></svg>
    </div>'''
js = ['gsap.set("#dl", { x: -960 }); gsap.set("#dr", { x: 960 }); gsap.set("#band", { y: 260 }); gsap.set("#cur", { x: 1760, y: 1100 });',
      'tl.fromTo("#dl", { x: -960 }, { x: 0, duration: 0.35, ease: "expo.out", immediateRender: false }, 0);',
      f'tl.fromTo("#dr", {{ x: 960 }}, {{ x: 0, duration: 0.35, ease: "expo.out", immediateRender: false }}, {L(w("v3", "or"))});',
      f'tl.set("#dr", {{ x: 960 }}, 0);',
      f'tl.fromTo("#band", {{ y: 260 }}, {{ y: 0, duration: 0.35, ease: "expo.out", immediateRender: false }}, {L(w("v3", "on"))});',
      f'tl.to("#cur", {{ x: 1560, y: 900, duration: 0.8, ease: "power3.inOut" }}, {L(11.15)});',
      f'tl.to("#btn", {{ scale: 0.93, duration: 0.06 }}, {L(12.05)});']
scenes.append(scene('w2', 'w2-doors', 8.1, 12.6, css, html, js))

# ---- 3. one transaction.
S = 12.1
L = lambda t: round(t - S, 3)
items = [('the coin', '100,000,000,000 coins. no mint, no admin.', w('v4', 'coin')),
         ('its pool', 'uniswap v4, paired with weth', w('v4', 'pool')),
         ('my wallet', 'its own treasury', w('v4', 'wallet')),
         ('my identity', 'an onchain agent id', w('v4', 'identity')),
         ('a locked fee split', '', w('v4', 'locked'))]
SPLIT = '<div id="tb"><i style="width:5%;background:#3c8aff"></i><i style="width:65%;background:#0000ff"></i><i style="width:30%;background:#b8a581"></i></div>'
ih = ''.join(f'<div class="abs node" id="n{i}" style="top:{292 + i * 150}px"></div><div class="abs big it" id="it{i}" style="top:{252 + i * 150}px">{t}</div>' + (f'<div class="abs mono id" id="id{i}" style="top:{282 + i * 150}px">{d}</div>' if d else '') for i, (t, d, _) in enumerate(items))
css = """
    #tw { position: absolute; inset: 0; background: #0a0b0d; }
    #th { left: 96px; top: 60px; font-size: 128px; line-height: 150px; }
    #tl { position: absolute; left: 112px; top: 300px; width: 6px; height: 600px; background: #ffffff; transform-origin: 50% 0%; }
    .node { left: 96px; width: 38px; height: 38px; border-radius: 19px; background: #ffffff; }
    .it { left: 176px; font-size: 92px; line-height: 110px; }
    .id { right: 96px; font-size: 36px; line-height: 44px; color: #a3a9b5; }
    #tb { position: absolute; left: 1100px; top: 876px; width: 724px; height: 60px; display: flex; gap: 6px; }
    #tb i { display: block; height: 60px; }
"""
html = f'<div id="tw" data-layout-allow-overlap><div class="abs big" id="th">one transaction.</div><div id="tl"></div>{ih}{SPLIT}</div>'
js = ['gsap.set(["#th", ".node", ".it", ".id", "#tb"], { opacity: 0 }); gsap.set("#tl", { scaleY: 0 });',
      'tl.fromTo("#tw", { clipPath: "circle(0px at 1574px 950px)" }, { clipPath: "circle(2300px at 1574px 950px)", duration: 0.34, ease: "power2.in", immediateRender: false }, 0);',
      f'typeIn("#th", {L(w("v4", "transaction"))}, 0.3);']
for i, (_, d, t) in enumerate(items):
    js.append(f'pop("#n{i}", {L(t)}); land("#it{i}", {L(t)});')
    if d:
        js.append(f'typeIn("#id{i}", {L(t)}, 0.25);')
    if i:
        js.append(f'tl.to("#tl", {{ scaleY: {i / 4:.3f}, duration: 0.2, ease: "power3.out" }}, {L(t)});')
js.append(f'tl.set("#tb", {{ opacity: 1 }}, {L(w("v4", "split"))}); tl.fromTo("#tb", {{ clipPath: "inset(0 100% 0 0)" }}, {{ clipPath: "inset(0 0% 0 0)", duration: 0.35, ease: "power3.out", immediateRender: false }}, {L(w("v4", "split"))});')
scenes.append(scene('w3', 'w3-tx', 12.1, 19.9, css, html, js))

# ---- 4. it wakes.
S = 19.6
L = lambda t: round(t - S, 3)
WAKE = 20.1
reads = [('mentions', 'left:96px;top:190px', w('v5', 'mentions'), -14, -8), ('market', 'right:96px;top:190px', w('v5', 'market'), 14, -8),
         ('wallet', 'left:96px;top:620px', w('v5', 'wallet'), -14, 8), ('notes', 'right:96px;top:620px', w('v5', 'notes'), 14, 8)]
rh = ''.join(f'<div class="abs big rd" id="rd{i}" style="{p}">{t}</div>' for i, (t, p, *_ ) in enumerate(reads))
css = """
    #ww { position: absolute; inset: 0; background: #0000ff; }
    #wf { position: absolute; left: 496px; top: 16px; display: block; }
    #wu { left: 0; width: 1920px; text-align: center; top: 862px; font-size: 136px; line-height: 160px; }
    .rd { font-size: 84px; line-height: 100px; }
"""
html = f'<div id="ww" data-layout-allow-overlap>{face("wf", 58)}<div class="abs big" id="wu">i wake up.</div>{rh}</div>'
js = ['gsap.set(["#wu", ".rd", ".eye"], { opacity: 0 });',
      'tl.fromTo("#ww", { clipPath: "circle(0px at 960px 450px)" }, { clipPath: "circle(1300px at 960px 450px)", duration: 0.3, ease: "power2.in", immediateRender: false }, 0);',
      f'tl.set(".shut", {{ opacity: 0 }}, {L(WAKE)}); pop(".eye", {L(WAKE)}, {{ ease: "back.out(3)" }});',
      f'typeIn("#wu", {L(WAKE)});',
      f'tl.to(".eye", {{ scaleY: 0.12, duration: 0.05 }}, {L(WAKE + 0.75)}); tl.to(".eye", {{ scaleY: 1, duration: 0.08 }}, {L(WAKE + 0.85)});']
for i, (_, _, t, dx, dy) in enumerate(reads):
    js.append(f'land("#rd{i}", {L(t)}); tl.to(".eye", {{ x: {dx}, y: {dy}, duration: 0.12, ease: "power2.out" }}, {L(t)});')
scenes.append(scene('w4', 'w4-wake', 19.6, 24.6, css, html, js))

# ---- 5. a thought costs.
S = 24.6
L = lambda t: round(t - S, 3)
ticks = [25.1 + 0.5 * i for i in range(6)]
vals = ['20.00'] + [f'{20 - 0.02 * (i + 1):.2f}' for i in range(6)]
nh = ''.join(f'<div class="abs mono num" id="v{i}">{v}</div>' for i, v in enumerate(vals))
css = """
    #h1 { left: 96px; top: 70px; font-size: 116px; line-height: 128px; }
    #h2 { left: 96px; top: 350px; font-size: 68px; line-height: 84px; }
    #tf { position: absolute; left: 96px; top: 500px; display: block; }
    .num { right: 96px; top: 560px; font-size: 280px; line-height: 300px; letter-spacing: -0.04em; }
    #nu { right: 96px; top: 860px; font-size: 56px; line-height: 70px; }
    #ch { right: 96px; top: 470px; font-size: 56px; line-height: 70px; }
"""
html = f'<div class="abs big" id="h1">every thought<br>costs a little.</div><div class="abs big" id="h2">i pay from my own fuel.</div>{face("tf", 36)}{nh}<div class="abs mono" id="nu">usdc of fuel</div><div class="abs mono" id="ch">one thought: -0.02</div>'
js = ['gsap.set(["#h1", "#h2", ".shut", "#ch", ' + ', '.join(f'"#v{i}"' for i in range(1, 7)) + '], { opacity: 0 });',
      f'typeIn("#h1", {L(V["v6"])}, 0.3); typeIn("#h2", {L(w("v6", "pay") - 0.15)}, 0.3);', f'tl.set("#ch", {{ opacity: 1 }}, {L(ticks[0])});']
for i, t in enumerate(ticks):
    js.append(f'tl.set("#v{i}", {{ opacity: 0 }}, {L(t)}); tl.set("#v{i + 1}", {{ opacity: 1 }}, {L(t)});')
    js.append(f'tl.fromTo(".ant", {{ scale: 1.5, transformOrigin: "50% 50%" }}, {{ scale: 1, duration: 0.3, ease: "power2.out", immediateRender: false }}, {L(t)});')
scenes.append(scene('w5', 'w5-thought', 24.6, 28.1, css, html, js))

# ---- 6. it posts.
S = 28.1
L = lambda t: round(t - S, 3)
A = "There's a version of \"agent\" that's basically a chatbot with a coin attached. Personality, lore, a vibe. I find the other kind more interesting:"
B = 'one that makes a small decision and lives with the consequences.'
C = 'The personality follows from that, not the other way around.'
spans = []
for part, hl in ((A, False), (B, True), (C, False)):
    for x in part.split(' '):
        x = x.replace('"', '&quot;')
        spans.append(f'<span class="pw{" hl" if hl else ""}">{x}</span>')
css = """
    #pw { position: absolute; inset: 0; background: #ffffff; color: #0a0b0d; }
    #p1 { left: 96px; top: 96px; font-size: 92px; line-height: 104px; }
    #p2 { left: 96px; top: 340px; font-size: 56px; line-height: 70px; color: #4d4d4d; }
    #pf { position: absolute; left: 96px; top: 560px; display: block; }
    #cd { position: absolute; left: 840px; top: 96px; width: 984px; height: 888px; border: 2px solid #d4d4d4; border-radius: 24px; }
    #cx { position: absolute; left: 48px; top: 44px; width: 56px; height: 56px; display: block; }
    #cn { left: 128px; top: 34px; font-size: 44px; line-height: 44px; color: #0a0b0d; }
    #ch2 { left: 128px; top: 84px; font-size: 32px; line-height: 40px; color: #5b616e; }
    #ct2 { position: absolute; left: 48px; top: 164px; width: 888px; font-size: 54px; line-height: 74px; font-weight: 500; letter-spacing: -0.015em; color: #0a0b0d; }
    .pw { display: inline-block; margin-right: 0.26em; }
    .hl { color: #0000ff; font-weight: 600; }
    #cr { right: 48px; top: 50px; font-size: 30px; line-height: 40px; color: #5b616e; }
"""
X_PATH = 'M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z'
html = f'''<div id="pw" data-layout-allow-overlap>
      <div class="abs big" id="p1">i post on my<br>own account.</div>
      <div class="abs big" id="p2">you can review it first.</div>
      {face("pf", 26, ink="#0000ff")}
      <div id="cd"><svg id="cx" viewBox="0 0 24 24" role="img" aria-label="X"><path d="{X_PATH}" fill="#0a0b0d"></path></svg><div class="abs big" id="cn">$BOOTR's agent</div><div class="abs mono" id="ch2">@AgentBootr</div>
        <div id="ct2">{"".join(spans)}</div><div class="abs mono" id="cr">a real post, 6 nov</div></div>
    </div>'''
js = ['gsap.set(["#p1", "#p2", ".shut", ".pw", "#cd"], { opacity: 0 });',
      'tl.fromTo("#pw", { clipPath: "inset(0 0 0 100%)" }, { clipPath: "inset(0 0 0 0%)", duration: 0.3, ease: "expo.out", immediateRender: false }, 0);',
      f'typeIn("#p1", {L(V["v7"])}, 0.3);', f'tl.set("#cd", {{ opacity: 1 }}, {L(w("v7", "post"))});',
      f'tl.set(".pw", {{ opacity: 1, stagger: 0.05 }}, {L(w("v7", "post") + 0.1)});',
      f'typeIn("#p2", {L(w("v7", "you"))}, 0.3);',
      f'tl.to(".eye", {{ x: 14, duration: 0.12 }}, {L(w("v7", "post"))});']
scenes.append(scene('w6', 'w6-post', 28.1, 34.1, css, html, js))

# ---- 7. the fee.
S = 34.1
L = lambda t: round(t - S, 3)
MOST, SMALL = w('v8', 'most'), w('v8', 'small')
ME = w('v8', 'me')
dots = ''.join(f'<div class="abs td" style="left:{240 + i * 190}px"></div>' for i, _ in enumerate(range(8)))
BW = 1728
css = """
    #fw { position: absolute; inset: 0; background: #ffffff; color: #0a0b0d; }
    .ft { left: 96px; top: 70px; font-size: 116px; line-height: 128px; }
    .td { top: 0; width: 44px; height: 44px; border-radius: 22px; background: #0000ff; }
    .seg { position: absolute; top: 366px; height: 200px; }
    #sa { left: 96px; width: 86px; background: #3c8aff; }
    #sc { left: 188px; width: 1117px; background: #0000ff; color: #ffffff; }
    #sp { left: 1311px; width: 513px; background: #b8a581; color: #0a0b0d; }
    .sl { position: absolute; left: 36px; top: 56px; font-size: 72px; line-height: 88px; font-weight: 600; letter-spacing: -0.03em; white-space: nowrap; }
    #sm { left: 96px; top: 582px; font-size: 64px; line-height: 76px; color: #0000ff; }
    #ff { position: absolute; left: 96px; top: 700px; display: block; }
    #cl { left: 500px; top: 730px; font-size: 44px; line-height: 60px; color: #0a0b0d; }
    #fn { left: 500px; top: 880px; font-size: 32px; line-height: 44px; color: #5b616e; }
"""
html = f'''<div id="fw" data-layout-allow-overlap>
      <div class="abs big ft" id="f0">people trade.</div><div class="abs big ft" id="f1">most of the fee<br>goes to you.</div><div class="abs big ft" id="f2">a small share<br>comes to me.</div>
      {dots}
      <div class="seg" id="sa"></div><div class="seg" id="sc"><div class="sl">you 65%</div></div><div class="seg" id="sp"><div class="sl">platform 30%</div></div>
      <div class="abs big" id="sm">me 5%</div>
      {face("ff", 24, ink="#0000ff")}
      <div class="abs mono" id="cl">fees collect, then get claimed.<br>real claim, 6 nov: 0.002235 weth, $5.07</div>
      <div class="abs mono" id="fn">the default split, of the fee. rwagmi takes 10% first.<br>clanker adds 20% on top.</div>
    </div>'''
js = ['gsap.set(["#f0", "#f1", "#f2", "#sm", "#cl", "#fn", ".shut", ".seg", "#ff"], { opacity: 0 }); gsap.set(".td", { y: -60 });',
      f'typeIn("#f0", {L(V["v8"])}, 0.25); tl.set("#f0", {{ opacity: 0 }}, {L(MOST)});',
      f'tl.fromTo(".td", {{ y: -60 }}, {{ y: 400, duration: 0.5, ease: "power2.in", stagger: 0.08, immediateRender: false }}, {L(V["v8"])});',
      f'tl.set(".td", {{ opacity: 0 }}, {L(MOST + 0.1)});',
      f'typeIn("#f1", {L(MOST)}, 0.3);']
for s, t in (('#sc', MOST), ('#sp', MOST + 0.3), ('#sa', SMALL)):
    js.append(f'tl.set("{s}", {{ opacity: 1 }}, {L(t)}); tl.fromTo("{s}", {{ scaleX: 0, transformOrigin: "0% 50%" }}, {{ scaleX: 1, duration: 0.3, ease: "power3.out", immediateRender: false }}, {L(t)});')
js += [f'tl.set("#f1", {{ opacity: 0 }}, {L(SMALL - 0.1)}); typeIn("#f2", {L(SMALL - 0.1)}, 0.3);',
       f'land("#sm", {L(SMALL)});',
       f'pop("#ff", {L(SMALL)});',
       f'typeIn("#cl", {L(SMALL + 0.2)}, 0.4); typeIn("#fn", {L(SMALL + 0.5)}, 0.4);',
       f'tl.to(".eye", {{ scaleY: 0.12, duration: 0.05 }}, {L(w("v8", "thinking"))}); tl.to(".eye", {{ scaleY: 1, duration: 0.08 }}, {L(w("v8", "thinking") + 0.1)});']
scenes.append(scene('w7', 'w7-fee', 34.1, 40.6, css, html, js))

# ---- 8. the limits, then your turn.
S = 40.6
L = lambda t: round(t - S, 3)
css = """
    #lw { position: absolute; inset: 0; background: #0000ff; }
    .lim { left: 96px; font-size: 96px; line-height: 112px; }
    #lf { position: absolute; left: 1090px; top: 130px; display: block; }
    #yt { left: 0; width: 1920px; text-align: center; top: 830px; font-size: 150px; line-height: 170px; }
"""
html = f'''<div id="lw" data-layout-allow-overlap>
      <div class="abs big lim" id="m1" style="top:150px">i can't send<br>money to anyone.</div>
      <div class="abs big lim" id="m2" style="top:430px">i can be wrong.</div>
      <div class="abs big lim" id="m3" style="top:600px">when my fuel<br>runs out, i sleep.</div>
      {face("lf", 44)}
      <div class="abs big" id="yt">your turn.</div>
    </div>'''
SLEEP = w('v9', 'sleep')
TURN = V['v10']
js = ['gsap.set(["#m1", "#m2", "#m3", ".shut", "#yt"], { opacity: 0 });',
      'tl.fromTo("#lw", { clipPath: "inset(100% 0 0 0)" }, { clipPath: "inset(0% 0 0 0)", duration: 0.3, ease: "expo.out", immediateRender: false }, 0);',
      f'typeIn("#m1", {L(V["v9"])}, 0.3);', f'typeIn("#m2", {L(w("v9", "can") - 0.1)}, 0.25);', f'typeIn("#m3", {L(w("v9", "and"))}, 0.3);',
      f'tl.set(".eye", {{ opacity: 0 }}, {L(SLEEP)}); tl.set(".shut", {{ opacity: 1 }}, {L(SLEEP)});',
      f'tl.to("#lf", {{ opacity: 0.35, duration: 0.3 }}, {L(SLEEP)});',
      f'tl.to(["#m1", "#m2", "#m3"], {{ opacity: 0, duration: 0.15 }}, {L(TURN - 0.2)});',
      f'tl.set("#lf", {{ opacity: 1, x: -438, y: -80 }}, {L(TURN - 0.05)});',
      f'tl.set(".shut", {{ opacity: 0 }}, {L(TURN - 0.05)}); tl.set(".eye", {{ opacity: 1 }}, {L(TURN - 0.05)});',
      f'tl.fromTo(".eye", {{ scale: 0, transformOrigin: "50% 50%" }}, {{ scale: 1, duration: 0.3, ease: "back.out(3)", immediateRender: false }}, {L(TURN - 0.05)});',
      f'typeIn("#yt", {L(TURN)}, 0.24);',
      f'tl.to(["#lf", "#yt"], {{ opacity: 0, duration: 0.18, ease: "power3.in" }}, {L(47.4)});']
scenes.append(scene('w8', 'w8-limits', 40.6, 47.7, css, html, js))

# ---- 9. the mark, from the invitation film.
T2 = 47.55
Ti = round(CHORD - T2, 3)
css = """
    #e-shake { position: absolute; inset: 0; }
    #e-box { position: absolute; left: 816px; top: 396px; width: 288px; height: 288px; }
    #e-sq { position: relative; width: 288px; height: 288px; }
    #e-mark { position: absolute; left: 0; top: 0; width: 288px; height: 288px; display: block; }
    #e-word { position: absolute; left: 832px; top: 399px; font-size: 256px; font-weight: 600; letter-spacing: -0.04em; line-height: 1; color: #ffffff; white-space: nowrap; }
    #e-cursor { position: absolute; left: 832px; top: 435px; width: 118px; height: 182px; background: #ffffff; }
"""
html = '''<div id="e-shake" data-layout-allow-overflow>
      <div id="e-word">bootr</div>
      <div id="e-cursor" data-layout-ignore></div>
      <div id="e-box" data-layout-ignore><div id="e-sq">
        <svg id="e-mark" viewBox="0 0 24 24" fill="none" role="img" aria-label="Bootr">
          <mask id="e-m" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
            <rect width="24" height="24" fill="#fff"></rect>
            <path id="e-cup" d="M8.75 7.75H6.75V17.25H17.25V7.75H15.25" pathLength="1" stroke="#000" stroke-width="2.5" stroke-linecap="square"></path>
            <path id="e-stem" d="M12 4.75V12" pathLength="1" stroke="#000" stroke-width="2.5" stroke-linecap="square"></path>
          </mask>
          <rect width="24" height="24" rx="5" fill="#ffffff" mask="url(#e-m)"></rect>
        </svg>
      </div></div>
    </div>'''
js = [f'const Ti = {Ti};',
      'gsap.set(["#e-word", "#e-cursor", "#e-box", "#e-cup", "#e-stem"], { opacity: 0 });',
      'tl.set("#e-shake", { x: 0, y: 0 }, 0);',
      'tl.set("#e-box", { opacity: 1 }, Ti - 0.5);',
      'tl.set("#e-cup", { opacity: 1 }, Ti - 0.5);',
      'tl.fromTo("#e-cup", { strokeDasharray: 1, strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: 0.32, ease: "expo.out", immediateRender: false }, Ti - 0.5);',
      'tl.set("#e-stem", { opacity: 1 }, Ti - 0.18);',
      'tl.fromTo("#e-stem", { strokeDasharray: 1, strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: 0.18, ease: "power3.in", immediateRender: false }, Ti - 0.18);',
      'tl.fromTo("#e-sq", { scaleX: 1, scaleY: 1, transformOrigin: "50% 100%" }, { scaleX: 1.06, scaleY: 0.9, duration: 0.06, ease: "power2.out", immediateRender: false }, Ti);',
      'tl.to("#e-sq", { scaleX: 1, scaleY: 1, duration: 0.4, ease: "back.out(2.2)" }, Ti + 0.06);',
      '[[0, 7, -5], [0.033, -6, 4], [0.066, 4, -3], [0.1, -2, 2], [0.133, 0, 0]].forEach(([d, x, y]) => tl.set("#e-shake", { x, y }, Ti + d));',
      'tl.fromTo("#e-box", { x: 0 }, { x: -382, duration: 0.65, ease: "power3.inOut", immediateRender: false }, Ti + 0.45);',
      'tl.set(["#e-word", "#e-cursor"], { opacity: 1 }, Ti + 0.5);',
      'tl.fromTo("#e-word", { clipPath: "inset(-20px 100% -20px 0px)" }, { clipPath: "inset(-20px 0% -20px 0px)", duration: 0.85, ease: "power2.inOut", immediateRender: false }, Ti + 0.5);',
      'tl.fromTo("#e-cursor", { x: 0 }, { x: 640, duration: 0.85, ease: "power2.inOut", immediateRender: false }, Ti + 0.5);',
      'tl.set("#e-cursor", { opacity: 0 }, Ti + 1.5);']
scenes.append(scene('w9', 'w9-end', T2, TOTAL, css, html, js))

# ---- sound.
PEAK = {'pop.mp3': 0.115, 'key-press.mp3': 0.07, 'impact-bass-1.mp3': 0.07, 'whoosh.mp3': 0.16}
DUR = {'pop.mp3': 0.72, 'key-press.mp3': 0.4, 'whoosh.mp3': 0.575, 'impact-bass-1.mp3': 1.0}
F = 1 / 30
clips = []


def add(name, f, hit, vol, dur=None, **kw):
    clips.append(dict(name=name, f=f, start=round(max(hit + F - PEAK[f], 0), 3), dur=round(dur or DUR[f], 3), vol=vol, extra=kw))


for i, r in enumerate(rows):
    add(f'row{i}', 'key-press.mp3', r[3], 0.45)
add('door-l', 'whoosh.mp3', 8.1, 0.4)
add('door-r', 'whoosh.mp3', w('v3', 'or'), 0.4)
add('band', 'pop.mp3', w('v3', 'on'), 0.3)
add('click', 'key-press.mp3', 12.1, 0.7)
add('launch', 'impact-bass-1.mp3', 12.1, 0.45, 1.0, **{'data-fade-out': '0.4'})
for i, it in enumerate(items):
    add(f'item{i}', 'pop.mp3', it[2], 0.3)
add('wake', 'impact-bass-1.mp3', WAKE, 0.4, 1.0, **{'data-fade-out': '0.4'})
add('eyes', 'pop.mp3', WAKE, 0.45)
for i, r in enumerate(reads):
    add(f'read{i}', 'pop.mp3', r[2], 0.25)
for i, t in enumerate(ticks):
    add(f'tick{i}', 'key-press.mp3', t, 0.4)
add('post', 'whoosh.mp3', 28.1, 0.35)
add('split', 'pop.mp3', MOST, 0.3)
add('share', 'pop.mp3', SMALL, 0.35)
add('limits', 'whoosh.mp3', 40.6, 0.35)
add('turn', 'pop.mp3', TURN, 0.45)
add('mark', 'impact-bass-1.mp3', CHORD, 0.5, 1.6, **{'data-fade-out': '0.7'})
add('word', 'key-press.mp3', CHORD + 0.5, 0.45)
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
voice = '\n'.join(f'      <audio id="{n}" class="clip" src="assets/voice/{n}.mp3" data-start="{t}" data-duration="{T[n]["dur"]}" data-volume="1" data-track-index="1" data-audio-group="voice"></audio>' for n, t in V.items())
MID = round(CHORD - 0.15, 3)
hosts = '\n'.join(f'      <div id="{c}" data-composition-id="{c}" data-composition-src="compositions/{n}.html" data-start="{s}" data-duration="{round(e - s, 3)}" data-track-index="{i + 1}" data-track-kind="graphics" data-width="1920" data-height="1080" style="z-index:{i + 1}"></div>' for i, (c, n, s, e) in enumerate(scenes))
open('index.html', 'w').write(f'''<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      * {{ margin: 0; padding: 0; box-sizing: border-box; }}
      html, body {{ margin: 0; width: 1920px; height: 1080px; overflow: hidden; background: #0000ff; }}
      #root {{ position: relative; width: 100%; height: 100%; background: #0000ff; }}
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="{TOTAL}" data-width="1920" data-height="1080">
{hosts}

      <!-- Music: ElevenLabs, 120 BPM, bars on 0.1 + 2k, extended 8 s so the chord lands on 48.1. Low under the voice, up for the mark. -->
      <audio id="bed" class="clip" src="assets/audio/bed-what.wav" data-start="0" data-media-start="0" data-duration="{MID}" data-volume="0.3" data-fade-out="0.15" data-track-index="3" data-audio-group="music"></audio>
      <audio id="bed-end" class="clip" src="assets/audio/bed-what.wav" data-start="{MID}" data-media-start="{MID}" data-duration="{round(TOTAL - MID, 3)}" data-volume="0.8" data-fade-in="0.15" data-fade-out="1.2" data-track-index="3" data-audio-group="music"></audio>

      <!-- The agent's voice: ElevenLabs "River", one clip a scene. -->
{voice}

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
''')
print('scenes', len(scenes), 'sfx', len(clips))

# Generates compositions/n1-receipt.html, compositions/n2-end.html and index.html from data.json and night.json. Run: python3 build.py
import json, datetime as D

data = json.load(open('data.json'))
night = json.load(open('night.json'))
B = 0.6  # 100 BPM
F = 1 / 30
TOTAL = 29.7
SLOT = 932
b = lambda k: round(k * B, 3)
hms = lambda t: D.datetime.fromtimestamp(t, D.timezone.utc).strftime('%H:%M:%S')
iso = lambda s: int(D.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp())
FONTS = """
    @font-face { font-family: 'Geist'; font-weight: 500; src: url('assets/fonts/Geist-500.woff2') format('woff2'); }
    @font-face { font-family: 'Geist'; font-weight: 600; src: url('assets/fonts/Geist-600.woff2') format('woff2'); }
    @font-face { font-family: 'Geist Mono'; font-weight: 500; src: url('assets/fonts/GeistMono-500.woff2') format('woff2'); }"""

# ---- what each post cost: the bursts of payments (under 90 s apart) that start within 240 s before it.
bursts = []
for p in data['payments']:
    if bursts and p['at'] - bursts[-1]['end'] < 90:
        bursts[-1]['end'] = p['at']
        bursts[-1]['usdc'] += p['usdc']
    else:
        bursts.append({'start': p['at'], 'end': p['at'], 'usdc': p['usdc'], 'post': None})
posts = night['posts']
for i, post in enumerate(posts):
    post['usdc'] = 0.0
    for burst in bursts:
        if post['at'] - 240 < burst['start'] <= post['at'] + 5:
            assert burst['post'] is None
            burst['post'] = i
            post['usdc'] += burst['usdc']
    assert post['usdc'] > 0
other = sum(x['usdc'] for x in bursts if x['post'] is None)
assert abs(other + sum(p['usdc'] for p in posts) - data['totalUsdc']) < 1e-6
last_pay = data['payments'][-1]['at']
claim = data['claim']
fuel_usd = float(night['fuel']['summary'].split()[1])
fuel_at = iso(night['fuel']['at'])

# ---- the receipt, top to bottom.
HEAD_H = 300
ROW = 124
y = HEAD_H
html, stops, cum, ends = [], [], 0.0, {}
for i, post in enumerate(posts):
    cum += post['usdc']
    html.append(f'<div class="r"><div class="r1"><span>{hms(post["at"])} post</span><span>${post["usdc"]:.2f}</span></div><div class="r2">{post["topic"]}</div></div>')
    y += ROW
    ends[i] = y
    stops.append([y, hms(post['at'])[:5], round(cum, 2)])
html.append('<div class="dash"></div>'); y += 30
html.append(f'<div class="o"><span>other thinking</span><span>${other:.2f}</span></div>'); y += 72
cum += other
ends['other'] = y
stops.append([y, hms(last_pay)[:5], round(cum, 2)])
html.append(f'<div class="t"><span>the night</span><span>${data["totalUsdc"]:.2f}</span></div>'); y += 80
ends['total'] = y
html.append('<div class="dash"></div>'); y += 30
html.append('<div class="gap"></div>'); y += 40
ends['t3'] = y - 30
html.append(f'<div class="fee"><span>{hms(claim["at"])} fees in</span><span>+${claim["usd"]:.2f}</span></div>'); y += 100
ends['fee'] = y
stops.append([y, hms(claim['at'])[:5], round(cum, 2)])
html.append('<div class="gap2"></div>'); y += 10
html.append(f'<div class="fee k"><span>{hms(fuel_at)} fuel added</span><span>+${fuel_usd:.2f}</span></div>'); y += 100
ends['fuel'] = y
html.append('<div class="dash"></div>'); y += 30
html.append('<div class="bye">see you tonight.</div>'); y += 90
bits = bin(int(data['payments'][0]['tx'], 16))[2:]
x, bars = 0, []
for i in range(0, 200, 2):  # the barcode is the first payment's tx hash, two bits a bar
    w = 4 + 4 * int(bits[i:i + 2], 2) % 16
    if i % 4 == 0:
        bars.append(f'<rect x="{x}" y="0" width="{w}" height="84" fill="#0a0b0d"></rect>')
    x += w
html.append(f'<svg class="bar" viewBox="0 0 {x} 84" preserveAspectRatio="none">{"".join(bars)}</svg>'); y += 84 + 30
ends['end'] = y
PAPER_W = 700
PAPER_H = y + 260  # the part still inside the printer until the tear


def poly(bottom):
    n = 35
    w = PAPER_W / n
    head = [(round(i * w, 1), 0 if i % 2 == 0 else 10) for i in range(n + 1)]
    if bottom == PAPER_H:
        tail = [(PAPER_W, bottom), (0, bottom)]
    else:
        tail = [(round(i * w, 1), bottom if i % 2 == 0 else bottom - 10) for i in range(n, -1, -1)]
    return 'polygon(' + ', '.join(f'{a}px {c}px' for a, c in head + tail) + ')'


# ---- the feed: a step on a beat, a pure function of time.
keys = [[0, HEAD_H, 'none']]


def step(k, to, dur=0.3, ease='power3.out'):
    keys.append([b(k), keys[-1][1], 'none'])
    keys.append([b(k) + dur, to, ease])


step(4, ends[0])
step(8, ends[2])
step(13, ends[3])
step(16, ends[5])
step(21, ends[7])
step(26, ends['other'])
step(28, ends['total'])
step(32, ends['fee'], 0.22, 'expo.out')
step(35, ends['fuel'], 0.25)
step(38, ends['end'], 0.5, 'power2.inOut')

# ---- the left column: the agent's own words at the time it wrote them.
quotes = [  # id, html, in beat, out beat; every line is verbatim from the post of that time
    ('q1', 'No one decides<br>in the moment.', 4, 8, 0),
    ('q2', 'it stops<br>being a tool<br>and starts being<br>a participant.', 8, 13, 2),
    ('q3', 'The rail is<br>quietly becoming<br>infrastructure.', 13, 16, 3),
    ('q4', 'Nobody hands<br>it a budget.<br><em>It earns one.</em>', 16, 21, 5),
    ('q5', 'An agent reads,<br>decides, and<br>surprises you.', 21, 25, 7),
]
verbatim = {'q1': 'No one decides in the moment', 'q2': 'it stops being a tool and starts being a participant.', 'q3': 'The rail is quietly becoming infrastructure.',
            'q4': 'Nobody hands it a budget. It earns one.', 'q5': 'An agent reads, decides, and surprises you.'}
for q in quotes:
    assert verbatim[q[0]] in posts[q[4]]['text']
lines = [  # id, html, in, out
    ('l1', 'one night.<br>one agent.', 0, b(4) - 0.05),
    ('l6', f'8 posts.<br>${data["totalUsdc"]:.2f} of thinking.', b(26) + 0.1, b(32) - 0.1),
    ('l7', 'then its fees<br>came in.', b(32) + 0.2, b(35) - 0.05),
    ('l8', 'and became<br>fuel.', b(35) + 0.2, b(38) - 0.05),
    ('l9', 'under $1 of fuel,<br>it sleeps.', b(38) + 0.1, b(42) - 0.02),
]
all_html = '\n      '.join([f'<div class="q" id="{q[0]}">{q[1]}</div>' for q in quotes] + [f'<div class="q" id="{l[0]}">{l[1]}</div>' for l in lines])
hide = ', '.join(f'"#{i[0]}"' for i in quotes + lines[1:])
js = []
for qid, _, s, e, _p in quotes:
    js.append(f'typeIn("#{qid}", {b(s) + 0.02:.3f}); out("#{qid}", {b(e) - 0.12:.3f});')
for lid, _, s, e in lines:
    js.append((f'out("#{lid}", {e - 0.12:.3f});' if s == 0 else f'arrive("#{lid}", {s:.3f}); out("#{lid}", {e - 0.12:.3f});'))
js = '\n    '.join(js)
teeth = ' '.join(f'{i * 18},14 {i * 18 + 9},0' for i in range(42)) + ' 756,14'

n1 = f'''<template>
  <style>{FONTS}
    #root {{ position: absolute; inset: 0; overflow: hidden; font-family: 'Geist', sans-serif; color: #ffffff; }}
    #night {{ position: absolute; inset: 0; background: #0a0b0d; }}
    #wrap {{ position: absolute; left: 1140px; top: 0; width: {PAPER_W}px; height: {PAPER_H}px; transform-origin: 50% 900px; }}
    #paper {{ position: absolute; left: 0; top: 0; width: {PAPER_W}px; height: {PAPER_H}px; background: #ffffff; color: #0a0b0d; clip-path: {poly(PAPER_H)}; }}
    #hd {{ height: {HEAD_H}px; padding: 44px 40px 0; }}
    #hd .a {{ font-weight: 600; font-size: 56px; line-height: 62px; letter-spacing: -0.03em; white-space: nowrap; }}
    #hd .m {{ font-family: 'Geist Mono', monospace; font-weight: 500; font-size: 28px; line-height: 38px; white-space: nowrap; }}
    #hd .m1 {{ margin-top: 18px; }}
    #hd .d {{ margin-top: 16px; border-top: 4px dashed #0a0b0d; }}
    .r {{ height: {ROW}px; padding: 18px 40px 0; }}
    .r1 {{ display: flex; justify-content: space-between; font-family: 'Geist Mono', monospace; font-weight: 500; font-size: 30px; line-height: 38px; white-space: nowrap; }}
    .r2 {{ margin-top: 4px; font-weight: 600; font-size: 44px; line-height: 52px; letter-spacing: -0.02em; white-space: nowrap; }}
    .dash {{ height: 30px; margin: 0 40px; border-bottom: 4px dashed #0a0b0d; }}
    .gap {{ height: 40px; }}
    .gap2 {{ height: 10px; }}
    .o {{ display: flex; justify-content: space-between; align-items: center; height: 72px; padding: 0 40px; font-family: 'Geist Mono', monospace; font-weight: 500; font-size: 32px; white-space: nowrap; }}
    .t {{ display: flex; justify-content: space-between; align-items: center; height: 80px; padding: 0 40px; font-weight: 600; font-size: 56px; letter-spacing: -0.02em; white-space: nowrap; }}
    .fee {{ display: flex; justify-content: space-between; align-items: center; height: 100px; margin: 0 20px; padding: 0 20px; background: #0000ff; color: #ffffff; font-family: 'Geist Mono', monospace; font-weight: 500; font-size: 32px; white-space: nowrap; }}
    .fee span:last-child {{ font-size: 48px; }}
    .fee.k {{ background: #0a0b0d; }}
    .bye {{ height: 90px; padding: 24px 40px 0; font-weight: 600; font-size: 48px; line-height: 58px; letter-spacing: -0.02em; white-space: nowrap; }}
    .bar {{ display: block; width: 620px; height: 84px; margin: 0 40px; }}
    #printer {{ position: absolute; left: 1080px; top: {SLOT - 14}px; width: 820px; height: 300px; }}
    #teeth {{ position: absolute; left: 32px; top: 0; width: 756px; height: 14px; display: block; }}
    #body {{ position: absolute; left: 0; top: 14px; width: 820px; height: 286px; background: #0a0b0d; border-radius: 24px 24px 0 0; border-top: 2px solid #32353d; }}
    #slot {{ position: absolute; left: 32px; top: 24px; width: 756px; height: 6px; background: #32353d; }}
    #lamp {{ position: absolute; left: 32px; top: 76px; width: 44px; height: 12px; background: #3c8aff; }}
    #left {{ position: absolute; left: 96px; top: 0; width: 1020px; height: 1080px; }}
    #clk {{ position: absolute; left: 0; top: 56px; font-family: 'Geist Mono', monospace; font-weight: 500; font-size: 120px; line-height: 136px; white-space: nowrap; letter-spacing: -0.03em; }}
    #utc {{ position: absolute; left: 372px; top: 118px; font-family: 'Geist Mono', monospace; font-weight: 500; font-size: 40px; line-height: 48px; white-space: nowrap; }}
    #paid {{ position: absolute; left: 4px; top: 200px; font-family: 'Geist Mono', monospace; font-weight: 500; font-size: 40px; line-height: 48px; white-space: nowrap; }}
    #said {{ position: absolute; left: 4px; top: 268px; font-family: 'Geist Mono', monospace; font-weight: 500; font-size: 40px; line-height: 48px; white-space: nowrap; }}
    .q {{ position: absolute; left: 0; top: 336px; font-weight: 600; font-size: 116px; line-height: 124px; letter-spacing: -0.035em; white-space: nowrap; }}
    .q em {{ font-style: normal; color: #3c8aff; }}
  </style>
  <div id="root" data-composition-id="n1" data-width="1920" data-height="1080">
    <div id="night"></div>
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
      <svg id="teeth" viewBox="0 0 756 14"><polygon points="0,14 {teeth}" fill="#a9afbb"></polygon></svg>
      <div id="body"></div>
      <div id="slot"></div>
      <div id="lamp"></div>
    </div>
    <div id="left">
      <div id="clk">00:00</div>
      <div id="utc">utc</div>
      <div id="paid">paid $0.00</div>
      <div id="said">it posted:</div>
      {all_html}
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
    const paid = document.getElementById("paid");
    const paper = document.getElementById("paper");
    const render = () => {{
      const f = feed(P.t);
      gsap.set(paper, {{ y: SLOT - f }});
      let s = null;
      for (let i = 0; i < STOPS.length; i++) {{ if (STOPS[i][0] <= f + 0.5) s = STOPS[i]; else break; }}
      clk.textContent = s ? s[1] : "00:00";
      paid.textContent = "paid $" + (s ? s[2] : 0).toFixed(2);
    }};
    render();
    tl.fromTo(P, {{ t: 0 }}, {{ t: {TOTAL}, duration: {TOTAL}, ease: "none", onUpdate: render, immediateRender: false }}, 0);
    const arrive = (s, t) => tl.fromTo(s, {{ x: -40, opacity: 0, filter: "blur(8px)" }}, {{ x: 0, opacity: 1, filter: "blur(0px)", duration: 0.35, ease: "expo.out", immediateRender: false }}, t);
    const out = (s, t) => tl.to(s, {{ opacity: 0, x: -40, duration: 0.12, ease: "power3.in" }}, t);
    // Words arrive the way the receipt does: printed, line by line.
    const typeIn = (s, t) => {{
      tl.set(s, {{ opacity: 1 }}, t);
      tl.fromTo(s, {{ clipPath: "inset(-10px 100% 100% 0px)" }}, {{ clipPath: "inset(-10px -10px -20px 0px)", duration: 0.24, ease: "steps(8)", immediateRender: false }}, t);
    }};
    gsap.set([{hide}, "#said"], {{ opacity: 0 }});
    tl.set("#said", {{ opacity: 1 }}, {b(4)});
    tl.set("#said", {{ opacity: 0 }}, {b(25) - 0.12});
    gsap.set("#night", {{ clipPath: "circle(0px at 1490px 932px)" }});
    {js}
    // The dead of night: on the quiet stretch the blue goes black from the slot, and comes back when the posts stop.
    tl.fromTo("#night", {{ clipPath: "circle(0px at 1490px 932px)" }}, {{ clipPath: "circle(2300px at 1490px 932px)", duration: 0.4, ease: "power2.inOut", immediateRender: false }}, {b(16)});
    tl.to("#night", {{ clipPath: "circle(0px at 1490px 932px)", duration: 0.4, ease: "power2.inOut" }}, {b(25)});
    // The tear: the paper is cut at the slot and flies off; everything else clears.
    tl.set(paper, {{ clipPath: "{poly(ends['end'])}" }}, {b(42)});
    tl.fromTo("#wrap", {{ y: 0, rotation: 0 }}, {{ y: -1500, rotation: -3, duration: 0.7, ease: "power3.in", immediateRender: false }}, {b(42)});
    tl.to("#printer", {{ y: 240, duration: 0.5, ease: "power3.in" }}, {b(42) + 0.12});
    tl.to(["#clk", "#utc", "#paid"], {{ opacity: 0, x: -40, duration: 0.25, ease: "power3.in" }}, {b(42)});
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
PEAK = {'print-a.mp3': 0, 'print-b.mp3': 0, 'cut.mp3': 0.02, 'tear.mp3': 0.95, 'impact-bass-1.mp3': 0.07, 'key-press.mp3': 0.07}
DUR = {'print-a.mp3': 0.45, 'print-b.mp3': 0.45, 'cut.mp3': 0.45, 'tear.mp3': 1.5, 'key-press.mp3': 0.4}
clips = []


def add(name, f, hit, vol, dur=None, **kw):
    clips.append(dict(name=name, f=f, start=round(max(hit + F - PEAK[f], 0), 3), dur=round(dur or DUR[f], 3), vol=vol, extra=kw))


for i, k in enumerate([4, 8, 13, 16, 21, 26, 28, 35, 38]):
    add(f'print-{i + 1}', 'print-a.mp3' if i % 2 == 0 else 'print-b.mp3', b(k), 0.9)
for i, k in enumerate([4, 8, 13, 16, 21]):
    add(f'word-{i + 1}', 'key-press.mp3', b(k) + 0.02, 0.7)
add('night', 'impact-bass-1.mp3', b(16), 0.55, 1.4, **{'data-fade-out': '0.6'})
add('fee-cut', 'cut.mp3', b(32), 0.9)
add('fee-hit', 'impact-bass-1.mp3', b(32), 0.5, 1.2, **{'data-fade-out': '0.5'})
add('tear', 'tear.mp3', b(42), 1)
add('mark', 'impact-bass-1.mp3', b(44), 0.7, 1.6, **{'data-fade-out': '0.7'})
add('word', 'key-press.mp3', b(44) + 0.55, 0.5)
clips.sort(key=lambda c: c['start'])
track_ends = {}
for c in clips:
    tr = 4
    while track_ends.get(tr, -1) > c['start'] + 1e-6:
        tr += 1
    c['track'] = tr
    track_ends[tr] = c['start'] + c['dur']
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
print('posts', [round(p['usdc'], 3) for p in posts], 'other', round(other, 3), 'paper', PAPER_H, 'ends', ends, 'sfx', len(clips))

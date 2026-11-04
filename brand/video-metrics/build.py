# Generates compositions/*.html and index.html from data.json and the beat grid.
# beat(k) = k * 0.46985 s (127.7 BPM, the music of the launch film). Run: python3 build.py
import json
D = json.load(open('data.json'))
B = 0.46985
F = 1 / 30
TOTAL = 32.9
def b(k): return round(k * B, 4)

# ---------------------------------------------------------------- figures (one data module drives every number)
def n(v): return f'{round(v):,}'
def usd(v): return '$' + n(v)
obs = D['observedAt']                                   # 2026-11-04T20:13:05Z
MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
def dm(date): return f'{int(date[8:10])} {MONTHS[int(date[5:7]) - 1]}'
asof = f'{dm(obs[:10])}, {obs[11:16]} utc'
today = dm(D['today'])
S = D['slots']
slot_rows = [('creator', S['creator'], '#ffffff'), ('platform', S['platform'], '#818895'), ('launchers', S['launchers'], '#4a4f5a'),
             ('burn', S['burn'], '#a9afbb'), ('agent', S['agent'], '#3c8aff')]
BAR_W = 1632
widths = []
acc = 0
for i, (_, v, _c) in enumerate(slot_rows):
    w = round(v / D['feesTotalUsd'] * BAR_W) if i < len(slot_rows) - 1 else BAR_W - acc
    widths.append(w); acc += w
lefts = [sum(widths[:i]) for i in range(len(widths))]
top = D['top24h']
TOPMAX = top[0]['volume24hUsd']
BAR_MAX = 720

def wrap(cid, style, body, script):
    return f'''<template>
  <style>
    @font-face {{ font-family: 'Geist'; font-weight: 500; src: url('assets/fonts/Geist-500.woff2') format('woff2'); }}
    @font-face {{ font-family: 'Geist'; font-weight: 600; src: url('assets/fonts/Geist-600.woff2') format('woff2'); }}
    @font-face {{ font-family: 'Geist Mono'; font-weight: 500; src: url('assets/fonts/GeistMono-500.woff2') format('woff2'); }}
    #root {{ position: absolute; inset: 0; overflow: hidden; font-family: 'Geist', sans-serif; }}
{style}
  </style>
  <div id="root" data-composition-id="{cid}" data-width="1920" data-height="1080">
{body}
  </div>
  <script>
    const B = 0.46985;
    const tl = gsap.timeline({{ paused: true }});
    const arrive = (s, t) => tl.fromTo(s, {{ x: -40, opacity: 0, filter: "blur(8px)" }}, {{ x: 0, opacity: 1, filter: "blur(0px)", duration: 0.45, ease: "expo.out" }}, t);
    const type = (s, t, d, c) => {{
      tl.set(s, {{ opacity: 1 }}, t);
      tl.fromTo(s, {{ clipPath: "inset(-10px 100% -10px 0px)" }}, {{ clipPath: "inset(-10px 0% -10px 0px)", duration: d, ease: "steps(" + c + ")" }}, t);
    }};
    const group = (v) => String(Math.round(v)).replace(/\\B(?=(\\d{{3}})+(?!\\d))/g, ",");
    const count = (s, t, d, to, fmt) => {{
      const o = {{ v: 0 }};
      tl.fromTo(o, {{ v: 0 }}, {{ v: to, duration: d, ease: "power2.out", onUpdate: () => {{ document.querySelector(s).textContent = fmt(o.v); }} }}, t);
    }};
{script}
    window.__timelines["{cid}"] = tl;
  </script>
</template>
'''

comps = {}

# ---------------------------------------------------------------- m1: dark, beats 0-12
comps['m1-open'] = wrap('m1', '''    #m1-panel { position: absolute; inset: 0; background: #0a0b0d; color: #ffffff; }
    #m1-shake { position: absolute; inset: 0; }
    .m1-h { position: absolute; left: 144px; font-size: 144px; line-height: 1; font-weight: 600; letter-spacing: -0.04em; white-space: nowrap; }
    .m1-r { position: absolute; left: 144px; font-size: 72px; line-height: 80px; font-weight: 500; color: #dee1e7; letter-spacing: -0.02em; white-space: nowrap; }''',
f'''    <div id="m1-panel">
      <div id="m1-shake" data-layout-allow-overflow>
        <div class="m1-h" id="m1-t1" style="top: 130px">bootr, by</div>
        <div class="m1-h" id="m1-t2" style="top: 290px">the numbers.</div>
        <div class="m1-r" id="m1-r1" style="top: 580px">launches, volume, fees, burn.</div>
        <div class="m1-r" id="m1-r2" style="top: 680px">all time, unless it says otherwise.</div>
        <div class="m1-r" id="m1-r3" style="top: 780px">as of {asof}.</div>
      </div>
    </div>''',
f'''    const L = (k) => Math.round(k * B * 1000) / 1000;
    gsap.set(["#m1-t2", "#m1-r1", "#m1-r2", "#m1-r3"], {{ opacity: 0 }});
    tl.set("#m1-shake", {{ x: 0, y: 0 }}, 0);
    // Beat 4 (the drop): the word lands with an impact.
    tl.set("#m1-t2", {{ opacity: 1 }}, L(4));
    tl.fromTo("#m1-t2", {{ clipPath: "inset(-10px 100% -10px 0px)" }}, {{ clipPath: "inset(-10px 0% -10px 0px)", duration: 0.45, ease: "steps(12)" }}, L(4));
    [[0, 10, -6], [0.033, -8, 5], [0.066, 6, -4], [0.1, -3, 2], [0.133, 0, 0]].forEach(([d, x, y]) => tl.set("#m1-shake", {{ x, y }}, L(4) + d));
    arrive("#m1-r1", L(5.5));
    arrive("#m1-r2", L(6.8));
    arrive("#m1-r3", L(8.1));''')

# ---------------------------------------------------------------- m2: white, beats 12-28 (what was launched)
by = D['bySource']
rows2 = [
    (D['coins'], 'coins launched.', f"rwagmi {by.get('bootr', 0)}, clanker {by.get('clanker', 0)}"),
    (D['agents'], 'agents, one per coin.', 'each with its own wallet'),
    (len(by), 'ways to launch.', 'rwagmi or clanker, one transaction'),
]
body2 = '      <div class="m2-t" id="m2-t1">launched.</div>\n'
for i, (v, lab, sub) in enumerate(rows2):
    y = 190 + 250 * i
    body2 += f'''      <div class="m2-n" id="m2-n{i+1}" style="top: {y}px">0</div>
      <div class="m2-l" id="m2-l{i+1}" style="top: {y + 44}px">{lab}</div>
      <div class="m2-d" id="m2-d{i+1}" style="top: {y + 128}px">{sub}</div>
      <div class="m2-h" id="m2-h{i+1}" style="top: {y + 226}px" data-layout-ignore></div>
'''
comps['m2-launched'] = wrap('m2', '''    #m2-panel { position: absolute; inset: 0; background: #ffffff; color: #0a0b0d; }
    .m2-t { position: absolute; left: 144px; top: 60px; font-size: 84px; line-height: 1; font-weight: 600; letter-spacing: -0.04em; white-space: nowrap; }
    .m2-n { position: absolute; left: 144px; width: 300px; font-size: 200px; line-height: 200px; font-weight: 600; letter-spacing: -0.05em; color: #0000ff; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .m2-l { position: absolute; left: 520px; font-size: 80px; line-height: 88px; font-weight: 600; letter-spacing: -0.04em; white-space: nowrap; }
    .m2-d { position: absolute; left: 520px; font-family: 'Geist Mono', monospace; font-size: 44px; line-height: 56px; font-weight: 500; color: #5b616e; white-space: nowrap; }
    .m2-h { position: absolute; left: 144px; width: 1632px; height: 2px; background: #dee1e7; transform-origin: 0% 50%; }''',
f'''    <div id="m2-panel">
{body2}    </div>''',
f'''    const L = (k) => Math.round((k - 12) * B * 1000) / 1000;
    const rows = [1, 2, 3];
    gsap.set(["#m2-t1"].concat(rows.flatMap((i) => ["#m2-n" + i, "#m2-l" + i, "#m2-d" + i])), {{ opacity: 0 }});
    gsap.set(rows.map((i) => "#m2-h" + i), {{ scaleX: 0 }});
    // Beat 12: the white world floods out of the headline (800, 290).
    tl.fromTo("#m2-panel", {{ clipPath: "circle(0px at 800px 330px)" }}, {{ clipPath: "circle(2400px at 800px 330px)", duration: 0.42, ease: "power2.inOut" }}, 0);
    type("#m2-t1", L(12.5), 0.45, 9);
    const targets = [{rows2[0][0]}, {rows2[1][0]}, {rows2[2][0]}];
    rows.forEach((i) => {{
      const t = L(13.5 + 4 * (i - 1));
      arrive("#m2-n" + i, t);
      count("#m2-n" + i, t, 1.0, targets[i - 1], (v) => String(Math.round(v)));
      arrive("#m2-l" + i, t + 0.25);
      arrive("#m2-d" + i, t + 0.45);
      tl.fromTo("#m2-h" + i, {{ scaleX: 0 }}, {{ scaleX: 1, duration: 0.4, ease: "power3.out" }}, t + 0.1);
    }});''')

# ---------------------------------------------------------------- m3: dark, beats 28-48 (traded, fees by slot)
seg = ''
for i, ((name, v, col), w, l) in enumerate(zip(slot_rows, widths, lefts), start=1):
    bord = 'border-right: 4px solid #0a0b0d;' if i < len(slot_rows) else 'border-right: 0;'
    seg += f'          <div class="m3-s" id="m3-s{i}" style="left: {l}px; width: {w}px; background: {col}; {bord}"></div>\n'
lab = ''
for i, ((name, v, col), w, l) in enumerate(zip(slot_rows, widths, lefts), start=1):
    if name == 'agent':
        lab += f'      <div class="m3-n" id="m3-n{i}" style="left: {144 + l + w - 400}px; top: 292px; width: 400px; text-align: right; color: #3c8aff">{name}</div>\n'
        lab += f'      <div class="m3-v" id="m3-v{i}" style="left: {144 + l + w - 400}px; top: 340px; width: 400px; text-align: right; color: #3c8aff">{usd(v)}</div>\n'
    else:
        lab += f'      <div class="m3-n" id="m3-n{i}" style="left: {144 + l}px; top: 600px">{name}</div>\n'
        lab += f'      <div class="m3-v" id="m3-v{i}" style="left: {144 + l}px; top: 648px">{usd(v)}</div>\n'
comps['m3-traded'] = wrap('m3', '''    #m3-panel { position: absolute; inset: 0; background: #0a0b0d; color: #ffffff; }
    .m3-t { position: absolute; left: 144px; top: 60px; font-size: 84px; line-height: 1; font-weight: 600; letter-spacing: -0.04em; white-space: nowrap; }
    #m3-num { position: absolute; left: 144px; top: 340px; font-family: 'Geist Mono', monospace; font-size: 260px; line-height: 280px; font-weight: 500; color: #ffffff; white-space: nowrap; }
    .m3-m { position: absolute; left: 144px; font-family: 'Geist Mono', monospace; font-size: 52px; line-height: 64px; font-weight: 500; color: #818895; white-space: nowrap; }
    #m3-bar { position: absolute; left: 144px; top: 420px; width: 1632px; height: 140px; border: 2px solid #32353d; }
    .m3-s { position: absolute; top: 0; height: 136px; transform-origin: 0% 50%; }
    .m3-n { position: absolute; font-family: 'Geist Mono', monospace; font-size: 40px; line-height: 48px; font-weight: 500; color: #818895; white-space: nowrap; }
    .m3-v { position: absolute; font-family: 'Geist Mono', monospace; font-size: 48px; line-height: 56px; font-weight: 500; color: #ffffff; white-space: nowrap; }
    #m3-cap { position: absolute; left: 144px; top: 790px; font-size: 72px; line-height: 80px; font-weight: 600; letter-spacing: -0.03em; white-space: nowrap; }
    #m3-cap2 { position: absolute; left: 144px; top: 890px; font-family: 'Geist Mono', monospace; font-size: 40px; line-height: 48px; font-weight: 500; color: #818895; white-space: nowrap; }''',
f'''    <div id="m3-panel">
      <div class="m3-t" id="m3-t1">traded.</div>
      <div class="m3-t" id="m3-t2">{usd(D['feesTotalUsd'])} in trading fees.</div>
      <div id="m3-num">$0</div>
      <div class="m3-m" id="m3-m1" style="top: 640px">across every coin.</div>
      <div class="m3-m" id="m3-m2" style="top: 720px">{usd(D['volumeTodayUsd'])} of it on {today}.</div>
      <div id="m3-fee" data-layout-allow-overflow>
        <div id="m3-bar">
{seg}        </div>
{lab}        <div id="m3-cap">all time. by slot.</div>
        <div id="m3-cap2">locked at launch.</div>
      </div>
    </div>''',
f'''    const L = (k) => Math.round((k - 28) * B * 1000) / 1000;
    const idx = [1, 2, 3, 4, 5];
    gsap.set(["#m3-t1", "#m3-t2", "#m3-num", "#m3-m1", "#m3-m2", "#m3-cap", "#m3-cap2"].concat(idx.flatMap((i) => ["#m3-n" + i, "#m3-v" + i])), {{ opacity: 0 }});
    gsap.set(idx.map((i) => "#m3-s" + i), {{ scaleX: 0 }});
    gsap.set("#m3-bar", {{ opacity: 0 }});
    // Beat 28: the dark world wipes in from the right.
    tl.fromTo("#m3-panel", {{ clipPath: "inset(0px 0px 0px 100%)" }}, {{ clipPath: "inset(0px 0px 0px 0%)", duration: 0.34, ease: "power3.inOut" }}, 0);
    type("#m3-t1", L(29), 0.45, 7);
    // Beat 32 (the music comes back): the number counts up, then holds.
    arrive("#m3-num", L(32));
    count("#m3-num", L(32), 1.4, {round(D['volumeTotalUsd'])}, (v) => "$" + group(v));
    arrive("#m3-m1", L(33.5));
    arrive("#m3-m2", L(35.5));
    // Beat 40: the number leaves, the fees take its place, one slot a beat.
    tl.to(["#m3-num", "#m3-m1", "#m3-m2", "#m3-t1"], {{ opacity: 0, x: -40, duration: 0.22, ease: "power3.in" }}, L(40));
    type("#m3-t2", L(40.5), 0.7, 24);
    tl.set("#m3-bar", {{ opacity: 1 }}, L(41.5));
    idx.forEach((i) => {{
      const t = L(41.2 + 0.6 * i);
      tl.fromTo("#m3-s" + i, {{ scaleX: 0 }}, {{ scaleX: 1, duration: 0.3, ease: "power3.out" }}, t);
      arrive("#m3-n" + i, t + 0.1);
      arrive("#m3-v" + i, t + 0.18);
    }});
    arrive("#m3-cap", L(44.3));
    arrive("#m3-cap2", L(44.9));''')

# ---------------------------------------------------------------- m4: white, beats 48-60 (busiest coins, the burn)
rows4 = ''
for i, t in enumerate(top, start=1):
    y = 230 + 200 * (i - 1)
    w = max(6, round(t['volume24hUsd'] / TOPMAX * BAR_MAX))
    col = '#0000ff' if i == 1 else '#818895'
    rows4 += f'''      <div class="m4-n" id="m4-n{i}" style="top: {y}px">{t['name'].lower()}</div>
      <div class="m4-d" id="m4-d{i}" style="top: {y + 92}px">{n(t['holders'])} holders</div>
      <div class="m4-b" id="m4-b{i}" style="top: {y + 12}px; width: {w}px; background: {col}"></div>
      <div class="m4-v" id="m4-v{i}" style="top: {y + 12}px">{usd(t['volume24hUsd'])}</div>
'''
burn_tokens = n(D['bootrBurned'])
burn_pct = f"{D['bootrBurnedPct']:.2f}"
comps['m4-coins'] = wrap('m4', '''    #m4-panel { position: absolute; inset: 0; background: #ffffff; color: #0a0b0d; }
    .m4-t { position: absolute; left: 144px; top: 60px; font-size: 84px; line-height: 1; font-weight: 600; letter-spacing: -0.04em; white-space: nowrap; }
    .m4-n { position: absolute; left: 144px; font-size: 80px; line-height: 88px; font-weight: 600; letter-spacing: -0.03em; white-space: nowrap; }
    .m4-d { position: absolute; left: 144px; font-family: 'Geist Mono', monospace; font-size: 40px; line-height: 48px; font-weight: 500; color: #5b616e; white-space: nowrap; }
    .m4-b { position: absolute; left: 720px; height: 80px; transform-origin: 0% 50%; }
    .m4-v { position: absolute; right: 144px; font-family: 'Geist Mono', monospace; font-size: 60px; line-height: 72px; font-weight: 500; white-space: nowrap; }
    #m4-pct { position: absolute; left: 144px; top: 250px; font-size: 300px; line-height: 320px; font-weight: 600; letter-spacing: -0.05em; color: #0000ff; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .m4-m { position: absolute; left: 144px; font-size: 72px; line-height: 80px; font-weight: 600; letter-spacing: -0.03em; white-space: nowrap; }
    .m4-s { position: absolute; left: 144px; font-family: 'Geist Mono', monospace; font-size: 40px; line-height: 48px; font-weight: 500; color: #5b616e; white-space: nowrap; }''',
f'''    <div id="m4-panel">
      <div class="m4-t" id="m4-t1">busiest coins, last 24 h.</div>
      <div class="m4-t" id="m4-t2">burned, on chain.</div>
      <div id="m4-coins" data-layout-allow-overflow>
{rows4}      </div>
      <div id="m4-pct">0.00%</div>
      <div class="m4-m" id="m4-m1" style="top: 600px">of $BOOTR's supply, burned.</div>
      <div class="m4-s" id="m4-s1" style="top: 710px">{burn_tokens} tokens.</div>
    </div>''',
f'''    const L = (k) => Math.round((k - 48) * B * 1000) / 1000;
    const rows = [1, 2, 3, 4];
    gsap.set(["#m4-t1", "#m4-t2", "#m4-pct", "#m4-m1", "#m4-s1"].concat(rows.flatMap((i) => ["#m4-n" + i, "#m4-d" + i, "#m4-v" + i])), {{ opacity: 0 }});
    gsap.set(rows.map((i) => "#m4-b" + i), {{ scaleX: 0 }});
    // Beat 48: the white world floods out of the number (760, 500).
    tl.fromTo("#m4-panel", {{ clipPath: "circle(0px at 760px 500px)" }}, {{ clipPath: "circle(2400px at 760px 500px)", duration: 0.42, ease: "power2.inOut" }}, 0);
    type("#m4-t1", L(48.5), 0.6, 25);
    rows.forEach((i) => {{
      const t = L(49.3 + 0.6 * (i - 1));
      arrive("#m4-n" + i, t);
      arrive("#m4-d" + i, t + 0.12);
      tl.fromTo("#m4-b" + i, {{ scaleX: 0 }}, {{ scaleX: 1, duration: 0.5, ease: "power3.out" }}, t + 0.05);
      arrive("#m4-v" + i, t + 0.3);
    }});
    // Beat 53.5: the list leaves, the burn takes its place.
    tl.to(["#m4-coins", "#m4-t1"], {{ opacity: 0, x: -40, duration: 0.22, ease: "power3.in" }}, L(52.8));
    type("#m4-t2", L(53.3), 0.5, 17);
    arrive("#m4-pct", L(53.9));
    count("#m4-pct", L(53.9), 1.1, {D['bootrBurnedPct']:.4f}, (v) => v.toFixed(2) + "%");
    arrive("#m4-m1", L(54.6));
    arrive("#m4-s1", L(55.4));''')

# ---------------------------------------------------------------- m5: dark, beats 60-70 (the mark)
comps['m5-end'] = wrap('m5', '''    #m5-ground { position: absolute; inset: 0; background: #0a0b0d; }
    #m5-shake { position: absolute; inset: 0; }
    #m5-mark-box { position: absolute; left: 816px; top: 396px; width: 288px; height: 288px; }
    #m5-mark-sq { position: relative; width: 288px; height: 288px; }
    #m5-mark-bg { position: absolute; left: 0; top: 0; width: 288px; height: 288px; border-radius: 60px; background: #0a0b0d; }
    #m5-mark { position: absolute; left: 0; top: 0; width: 288px; height: 288px; display: block; }
    #m5-word { position: absolute; left: 832px; top: 399px; font-size: 256px; font-weight: 600; letter-spacing: -0.04em; line-height: 1; color: #ffffff; white-space: nowrap; }
    #m5-cursor { position: absolute; left: 832px; top: 435px; width: 118px; height: 182px; background: #ffffff; }
    #m5-src { position: absolute; left: 144px; top: 930px; font-family: 'Geist Mono', monospace; font-size: 36px; line-height: 44px; font-weight: 500; color: #818895; white-space: nowrap; }''',
f'''    <div id="m5-ground"></div>
    <div id="m5-shake" data-layout-allow-overflow>
      <div id="m5-word">bootr</div>
      <div id="m5-cursor" data-layout-ignore></div>
      <div id="m5-mark-box" data-layout-ignore>
        <div id="m5-mark-sq">
          <div id="m5-mark-bg"></div>
          <svg id="m5-mark" viewBox="0 0 24 24" fill="none" role="img" aria-label="Bootr">
            <mask id="m5-m" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
              <rect width="24" height="24" fill="#fff"></rect>
              <path id="m5-cup" d="M8.75 7.75H6.75V17.25H17.25V7.75H15.25" pathLength="1" stroke="#000" stroke-width="2.5" stroke-linecap="square"></path>
              <path id="m5-stem" d="M12 4.75V12" pathLength="1" stroke="#000" stroke-width="2.5" stroke-linecap="square"></path>
            </mask>
            <rect width="24" height="24" rx="5" fill="#ffffff" mask="url(#m5-m)"></rect>
          </svg>
        </div>
      </div>
    </div>
    <div id="m5-src">figures as of {asof}.</div>''',
'''    const T0 = 60 * B;
    const L = (k) => Math.round((k * B - T0) * 1000) / 1000;
    gsap.set(["#m5-word", "#m5-cursor", "#m5-mark-box", "#m5-src"], { opacity: 0 });
    tl.set("#m5-shake", { x: 0, y: 0 }, 0);
    // Beat 60: the dark world floods out of the middle of the frame.
    tl.fromTo("#m5-ground", { clipPath: "circle(0px at 960px 540px)" }, { clipPath: "circle(1400px at 960px 540px)", duration: 0.4, ease: "power2.inOut" }, 0);
    const Ti = L(62);
    // The mark: the cup is cut out, the stem falls into it, the square lands on beat 62.
    tl.set("#m5-mark-box", { opacity: 1 }, Ti - 0.56);
    tl.set(["#m5-cup", "#m5-stem"], { opacity: 0 }, 0);
    tl.set("#m5-cup", { opacity: 1 }, Ti - 0.55);
    tl.fromTo("#m5-cup", { strokeDasharray: 1, strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: 0.35, ease: "expo.out" }, Ti - 0.55);
    tl.set("#m5-stem", { opacity: 1 }, Ti - 0.183);
    tl.fromTo("#m5-stem", { strokeDasharray: 1, strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: 0.183, ease: "power3.in" }, Ti - 0.183);
    tl.fromTo("#m5-mark-sq", { scaleX: 1, scaleY: 1, transformOrigin: "50% 100%" }, { scaleX: 1.06, scaleY: 0.9, duration: 0.06, ease: "power2.out" }, Ti);
    tl.to("#m5-mark-sq", { scaleX: 1, scaleY: 1, duration: 0.4, ease: "back.out(2.2)" }, Ti + 0.06);
    [[0, 7, -5], [0.033, -6, 4], [0.066, 4, -3], [0.1, -2, 2], [0.133, 0, 0]].forEach(([d, x, y]) => tl.set("#m5-shake", { x, y }, Ti + d));
    // The mark slides left into the lockup; "bootr" is typed behind it, led by a block cursor.
    tl.fromTo("#m5-mark-box", { x: 0 }, { x: -382, duration: 0.65, ease: "power3.inOut" }, Ti + 0.45);
    tl.set(["#m5-word", "#m5-cursor"], { opacity: 1 }, Ti + 0.5);
    tl.fromTo("#m5-word", { clipPath: "inset(-20px 100% -20px 0px)" }, { clipPath: "inset(-20px 0% -20px 0px)", duration: 0.85, ease: "power2.inOut" }, Ti + 0.5);
    tl.fromTo("#m5-cursor", { x: 0 }, { x: 640, duration: 0.85, ease: "power2.inOut" }, Ti + 0.5);
    [Ti + 1.5, Ti + 1.8].forEach((t) => { tl.set("#m5-cursor", { opacity: 0 }, t); tl.set("#m5-cursor", { opacity: 1 }, t + 0.15); });
    tl.set("#m5-cursor", { opacity: 0 }, Ti + 2.1);
    arrive("#m5-src", Ti + 1.2);''')

for name, html in comps.items():
    open(f'compositions/{name}.html', 'w').write(html)

# ---------------------------------------------------------------- index.html: hosts, music, peak-aligned effects
peaks = json.load(open('assets/sfx/peaks.json'))
hosts = [('m1', 'm1-open', 0, round(b(12) + 0.5, 3)),
         ('m2', 'm2-launched', b(12), round(b(28) - b(12) + 0.5, 3)),
         ('m3', 'm3-traded', b(28), round(b(48) - b(28) + 0.5, 3)),
         ('m4', 'm4-coins', b(48), round(b(60) - b(48) + 0.5, 3)),
         ('m5', 'm5-end', b(60), round(TOTAL - b(60), 3))]
sfx = []
def add(name, f, hit, vol, dur=None, **kw): sfx.append((name, f, hit, vol, dur, kw))
def raw(name, f, start, vol, dur, **kw): sfx.append((name, f, None, vol, dur, dict(kw, _start=start)))
raw('riser', 'riser.mp3', 0, 0.4, 1.85, **{'data-media-start': '1.6', 'data-fade-in': '0.2', 'data-fade-out': '0.1'})
add('drop-1', 'impact-bass-1.mp3', b(4), 0.6, 1.2, **{'data-fade-out': '0.5'})
add('m1-t2', 'key-press.mp3', b(4) + 0.05, 0.5)
for i, k in enumerate([5.5, 6.8, 8.1]): add(f'm1-row-{i+1}', 'pop.mp3', b(k) + 0.1, 0.6)
add('m2-flood', 'whoosh-short.mp3', b(12), 0.6)
add('m2-t', 'key-press.mp3', b(12.5), 0.5)
for i in range(3): add(f'm2-row-{i+1}', 'pop.mp3', b(13.5 + 4 * i) + 0.1, 0.6)
add('m3-wipe', 'whoosh.mp3', b(28), 0.7)
add('m3-t', 'key-press.mp3', b(29), 0.5)
add('m3-drop', 'impact-bass-1.mp3', b(32), 0.55, 1.0, **{'data-fade-out': '0.4'})
add('m3-lab1', 'pop.mp3', b(33.5) + 0.1, 0.5)
add('m3-lab2', 'pop.mp3', b(35.5) + 0.1, 0.5)
add('m3-out', 'whoosh-short.mp3', b(40), 0.5)
add('m3-t2', 'key-press.mp3', b(40.5), 0.5)
for i in range(5): add(f'm3-seg-{i+1}', 'pop.mp3', b(41.8 + 0.6 * i) + 0.2, 0.6)
add('m3-cap', 'key-press.mp3', b(44.3), 0.5)
add('m4-flood', 'whoosh.mp3', b(48), 0.7)
add('m4-t', 'key-press.mp3', b(48.5), 0.5)
for i in range(4): add(f'm4-row-{i+1}', 'pop.mp3', b(49.3 + 0.6 * i) + 0.1, 0.5)
add('m4-out', 'whoosh-short.mp3', b(52.8), 0.5)
add('m4-t2', 'key-press.mp3', b(53.3), 0.5)
add('m4-pct', 'pop.mp3', b(53.9) + 0.1, 0.6)
add('m4-m', 'key-press.mp3', b(54.6), 0.45)
add('m5-flood', 'whoosh.mp3', b(60), 0.7)
add('m5-mark', 'impact-bass-1.mp3', b(62), 0.7, 1.6, **{'data-fade-out': '0.7'})
add('m5-word', 'key-press.mp3', b(62) + 0.55, 0.45)

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

      <!-- Music: the launch film's bed (127.7 BPM, beat = 0.46985 s). Drop on beat 4, break on beats 30-32, outro from beat 60. -->
      <audio id="bed" class="clip" src="assets/audio/bed-sky.mp3" data-start="0" data-media-start="0" data-duration="{TOTAL}" data-volume="1" data-fade-in="0.03" data-fade-out="0.4" data-track-index="3" data-audio-group="music"></audio>

      <!-- Effects, peak-aligned one frame after their picture (generated by build.py). -->
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
print(len(clips), 'sfx clips;', 'widths', widths, 'asof', asof)

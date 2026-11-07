# Generates index.html: one still for the $1m all-time volume post. Run: python3 build.py
# Figures: https://indexer.bootr.fun/platform/fees, read 2026-11-07: volumeTotalUsd 1,061,262; feesTotalUsd 23,684;
# byKind creator 9,163, burn 2,883; tokens 8. Faces: portraitCells(kernel) from apps/web/components/art/AgentPortrait.tsx.
import json

faces = json.load(open('faces.json'))


def face(cells, size):
    c = size / 16
    out = []
    for i, t in enumerate(cells):
        if not t:
            continue
        x, y = (i % 16) * c + c / 2, (i // 16) * c + c / 2
        r = {1: 0.26, 2: 0.38, 3: 0.44}[t] * c
        op = '0.5' if t == 1 else '1'
        out.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r:.1f}" fill="#ffffff" fill-opacity="{op}"></circle>')
    return f'<svg viewBox="0 0 {size} {size}" width="{size}" height="{size}" style="display:block">{"".join(out)}</svg>'


S = 196
grid = ''.join(f'<div class="cell" style="left:{1012 + (i % 4) * 206}px;top:{150 + (i // 4) * 262}px">{face(f["cells"], S)}<div class="tk">${f["symbol"]}</div></div>' for i, f in enumerate(faces))
stats = [('8', 'coins, each with<br>its own agent'), ('$23.6k', 'in fees'), ('$9.1k', 'to creators'), ('$2.8k', 'burned')]
st = ''.join(f'<div class="st" style="left:{96 + i * 444}px"><div class="sn">{n}</div><div class="sl">{l}</div></div>' for i, (n, l) in enumerate(stats))
html = f'''<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <script src="assets/gsap.min.js"></script>
    <style>
      @font-face {{ font-family: 'Geist'; font-weight: 600; src: url('assets/fonts/Geist-600.woff2') format('woff2'); }}
      @font-face {{ font-family: 'Geist Mono'; font-weight: 500; src: url('assets/fonts/GeistMono-500.woff2') format('woff2'); }}
      * {{ margin: 0; padding: 0; box-sizing: border-box; }}
      html, body {{ width: 1920px; height: 1080px; overflow: hidden; background: #0000ff; }}
      #root {{ position: relative; width: 1920px; height: 1080px; background: #0000ff; color: #ffffff; font-family: 'Geist', sans-serif; overflow: hidden; }}
      .abs {{ position: absolute; white-space: nowrap; }}
      #logo {{ left: 96px; top: 72px; display: flex; align-items: center; gap: 22px; }}
      #logo svg {{ width: 72px; height: 72px; display: block; }}
      #logo span {{ font-size: 64px; font-weight: 600; letter-spacing: -0.04em; line-height: 72px; }}
      #big {{ left: 84px; top: 250px; font-size: 380px; line-height: 380px; font-weight: 600; letter-spacing: -0.06em; }}
      #sub {{ left: 96px; top: 640px; font-size: 64px; line-height: 76px; font-weight: 600; letter-spacing: -0.03em; }}
      .cell {{ position: absolute; width: {S}px; }}
      .tk {{ font-family: 'Geist Mono', monospace; font-weight: 500; font-size: 28px; line-height: 36px; text-align: center; margin-top: 8px; color: #ffffff; }}
      #rule {{ left: 96px; top: 800px; width: 1728px; height: 3px; background: rgba(255,255,255,0.35); }}
      .st {{ position: absolute; top: 836px; width: 420px; }}
      .sn {{ font-size: 96px; line-height: 104px; font-weight: 600; letter-spacing: -0.04em; }}
      .sl {{ font-family: 'Geist Mono', monospace; font-weight: 500; font-size: 30px; line-height: 38px; margin-top: 10px; color: #d6d6ff; }}
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="1" data-width="1920" data-height="1080">
      <div class="abs" id="logo"><svg viewBox="0 0 24 24" fill="none" role="img" aria-label="Bootr"><mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24"><rect width="24" height="24" fill="#fff"></rect><path d="M8.75 7.75H6.75V17.25H17.25V7.75H15.25" stroke="#000" stroke-width="2.5" stroke-linecap="square"></path><path d="M12 4.75V12" stroke="#000" stroke-width="2.5" stroke-linecap="square"></path></mask><rect width="24" height="24" rx="5" fill="#ffffff" mask="url(#m)"></rect></svg><span>bootr</span></div>
      <div class="abs" id="big">$1m</div>
      <div class="abs" id="sub">in all-time volume.</div>
      {grid}
      <div class="abs" id="rule"></div>
      {st}
    </div>
    <script>
      window.__timelines = window.__timelines || {{}};
      window.__timelines["main"] = gsap.timeline({{ paused: true }});
    </script>
  </body>
</html>
'''
open('index.html', 'w').write(html)

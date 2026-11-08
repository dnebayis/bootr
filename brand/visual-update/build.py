# Generates index.html: one still for the 8 nov update post (BlockRun direct, paid services, posts-per-day slider, small fixes).
# Run: python3 build.py. Face: $BOOTR's real portrait, portraitCells(kernel) from apps/web/components/art/AgentPortrait.tsx (faces.json).
import json

face_cells = next(f['cells'] for f in json.load(open('faces.json')) if f['symbol'] == 'BOOTR')


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


BOOTR = '<svg viewBox="0 0 24 24" fill="none" role="img" aria-label="Bootr"><mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24"><rect width="24" height="24" fill="#fff"></rect><path d="M8.75 7.75H6.75V17.25H17.25V7.75H15.25" stroke="#000" stroke-width="2.5" stroke-linecap="square"></path><path d="M12 4.75V12" stroke="#000" stroke-width="2.5" stroke-linecap="square"></path></mask><rect width="24" height="24" rx="5" fill="#ffffff" mask="url(#m)"></rect></svg>'

items = [
    ('paid services', 'buys data per call, inside<br>your daily budget. 1 usdc default.'),
    ('2 to 48 posts a day', 'one slider in the creator console.<br>mentions still get answers.'),
    ('small things', 'wallet connect on phones.<br>agents know where they live.'),
]
rows = ''.join(f'<div class="it" style="left:{96 + i * 592}px"><div class="ih">{h}</div><div class="ib">{b}</div></div>' for i, (h, b) in enumerate(items))

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
      #logo {{ left: 96px; top: 80px; display: flex; align-items: center; gap: 20px; }}
      #logo svg {{ width: 60px; height: 60px; display: block; }}
      #logo span {{ font-size: 54px; font-weight: 600; letter-spacing: -0.04em; line-height: 60px; }}
      #live {{ left: 96px; top: 238px; font-family: 'Geist Mono', monospace; font-weight: 500; font-size: 32px; line-height: 40px; padding: 10px 22px; border: 3px solid rgba(255,255,255,0.6); border-radius: 999px; }}
      #head {{ left: 96px; top: 290px; font-size: 128px; line-height: 132px; font-weight: 600; letter-spacing: -0.05em; white-space: normal; width: 1100px; }}
      #via {{ left: 100px; top: 576px; font-family: 'Geist Mono', monospace; font-weight: 500; font-size: 34px; line-height: 42px; color: #d6d6ff; }}
      #face {{ left: 1300px; top: 150px; }}
      #rule {{ left: 96px; top: 760px; width: 1728px; height: 3px; background: rgba(255,255,255,0.35); }}
      .it {{ position: absolute; top: 806px; width: 580px; white-space: nowrap; }}
      .ih {{ font-size: 50px; line-height: 58px; font-weight: 600; letter-spacing: -0.035em; }}
      .ib {{ font-family: 'Geist Mono', monospace; font-weight: 500; font-size: 27px; line-height: 37px; margin-top: 14px; color: #d6d6ff; }}
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="1" data-width="1920" data-height="1080">
      <div class="abs" id="logo">{BOOTR}<span>bootr</span></div>
      <div class="abs" id="head">agents now pay for their own thinking.</div>
      <div class="abs" id="via">from their own wallet, straight to BlockRunAI.</div>
      <div class="abs" id="face">{face(face_cells, 520)}</div>
      <div class="abs" id="rule"></div>
      {rows}
    </div>
    <script>
      window.__timelines = window.__timelines || {{}};
      window.__timelines["main"] = gsap.timeline({{ paused: true }});
    </script>
  </body>
</html>
'''
open('index.html', 'w').write(html)

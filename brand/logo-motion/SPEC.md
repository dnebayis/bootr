Motion logo — "boot sequence", 4.4 s, 1920x1080, 30 fps

Idea: the mark is a solid square with a glyph knocked out of it. The glyph is a stem dropping into an
open-topped cup, so the animation builds it that way: cup first, then the stem falls in.

0.00  solid square, centred, frame 0 is the thumbnail. Two hairlines (x=96, y=82.5%) draw in, as on the OG image.
0.50  the cup is cut out of the square in one stroke (expo.out, 0.35 s). Tick.
0.85  the stem drops into the cup, accelerating (power3.in, 0.18 s).
1.033 impact: square squashes from its base (1.06 x 0.9), rebounds back.out(2.2), frame jolts 4 frames. Bass hit.
1.50  mark slides left 382 px (power3.inOut, 0.65 s) uncovering the wordmark, which is wiped in behind it
      by a block cursor (power2.inOut, 0.85 s), five key ticks.
2.55  cursor blinks twice and is gone. Lockup holds to 4.4 s.

Rules kept: flat, no glow, no gradient, hairlines only; mark height = cap height x 1.6; wordmark lowercase Geist 600.
Variables: color-ground, color-ink, color-hair. Light render: #ffffff / #171717 / #ebebeb.

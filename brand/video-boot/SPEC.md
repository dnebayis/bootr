GOAL:    After 30 s a viewer knows $BOOTR is Bootr's own coin, that it launches with its own agent, and that
         every swap feeds that agent. The feeling: a machine powering on, counting down, then the drop.
OUTPUT:  HyperFrames, 1920 x 1080, 30 fps, 29.7 s = 891 frames. Silent-safe: every line also reads on a phone.
TIME:    Music: catalog track "fast aggressive drum and bass, 174 BPM, heavy bass hits, oldskool jump up"
         (19 s). Measured 173.66 BPM: beat = 0.3455 s (10.365 frames), bar = 1.382 s. Grid: beat(k) = k x 0.3455,
         no offset. The drop sits on beat 16 = 5.528 s. Build (riser) = beats 0-16.
         Music clips: A film 0 -> beat 48 (media 0 -> 16.584 s), B film beat 48 -> 80 (media beat 16 -> 48,
         the drop section looped on bar lines, 11.056 s). Music stops dead on beat 80 = 27.64 s.
         Effects are peak-aligned one frame after their picture.
LOOK:    Bootr's own: black #000 (chain world) and white #fff (agent world), hairlines #262626 / #3d3d3d on black and
         #ebebeb / #d4d4d4 on white, ink #fff / #171717, body #4d4d4d on white, mute #8f8f8f on black.
         One accent #0070f3: the summary line in the boot log, the cursor that types $BOOTR, the burned row, the agent
         row at the end of the fees shot, the ticker on the end card. Never two accents in one frame except the ticker.
         Display: Geist 600, tracking -0.04em, line-height 1.0, 100-250 px. Body: Geist 500, 56-88 px.
         Mono: Geist Mono 500 for the boot log (56 px) and numbers (104-760 px). Minimum text 40 px.
         Medium: the product's own terminal. Hairline boxes, 16 px radii on the post card, no shadows, no grain,
         no vignette, no gradients. Hairlines: a vertical at x=96 on every scene, as on the OG image.
OBJECTS: the boot log (seven checks, each ending in "ok"), a countdown numeral 3-2-1-0 at 760 px (Geist 600; Geist Mono's zero is slashed and read as an empty set), a progress rule,
         the Bootr mark (24-unit rounded square, rx 5, power glyph knocked out of it), the ticker "$BOOTR" typed with
         a block cursor, four proportional fee rows (agent 5 / creator 50 / burned 15 / platform 30) each with a bar
         drawn on a hairline rail, a post card (square avatar = mark, "bootr", "@bootrfun", three typed lines,
         "posted"), four statement lines, the lockup (mark + wordmark, as in brand/logo-motion).
MOTION:  arrivals expo.out 0.45 s (x -40 -> 0, blur 8 -> 0 px); hits are tl.set on the beat, plus a 5-step jolt
         (+-7 px, 1 frame each) on the drop and the lockup impact; exits power3.in 0.22 s; floods are clip-path
         circle or inset, power2.inOut 0.3-0.38 s, started on the beat; typing = steps() clip reveal; numbers tick
         0.7 s power2.out. A landed title never moves. Something new every bar. No breathing, no floating.
SHOTS:   (b = beat, 1 beat = 0.3455 s; frames at 30 fps)
         b0-16   00.00-05.53  S1 boot, black. Frame 0 already shows two checks done and the third typing.
                              Checks land on beats 0-4 (label types, "ok" lands a half beat later, click each);
                              b5 "7 / 7 ok" in accent (pop); b6 "agent standby" + cursor; b8 the log wipes out
                              left and the countdown starts: 3 (b8) 2 (b10) 1 (b12) 0 (b14), 760 px numerals at the
                              left, state words at the right (standby, arming, armed, booting), a progress rule along
                              the bottom fills b8-b15.5. b15.5 total black: one half beat of silence in the picture.
         b16-28  05.53-09.67  S2 drop, white. White circle floods from the mark's centre on b16. The mark (560 px)
                              slams in with squash and a 5-step jolt; impact + music drop. b17 "$BOOTR" (250 px) types
                              behind an accent block cursor; b20 the two-line sub text types; b24 hairlines draw.
         b28-40  09.67-13.82  S3 fees, black. Wipe from the right. "1% of every swap" at b29. Rows land on four
                              consecutive beats: b30 agent 5%, b31 creator 50%, b32 burned 15% (accent), b33 platform 30%;
                              each number ticks, each bar draws. b34 note "the agent's share pays for its thinking."
                              and the accent moves to the agent row.
         b40-54  13.82-18.66  S4 the post, white. Circle flood. Card lands b41. Three lines type on b42, b44, b48
                              (steps), "posted" at b51 with a pop.
         b54-69  18.66-23.84  S5 statements, black. Wipe from below. Four lines land on b55, b58, b61, b64 with a pop
                              each; b66 the first three dim, the last stays white; b68.9 all exit.
         b69-86  23.84-29.70  S6 end card, black. The logo-motion lockup: cup draws b70.4, stem drops and hits b72
                              (impact), mark slides left b73.3 and "bootr" types behind a cursor to b76. Music stops
                              dead at b80 = 27.64 s; at that frame "$BOOTR" (112 px, accent) lands under the lockup
                              with one bass hit. Hold 2 s of silence under the picture. No fade-out of the picture.
SOUND:   bed A/B (1.0 rate, 0.9), clicks on ok, pops on rows and statements, keys while typing, whooshes on wipes,
         impact-bass on the drop (b16), the lockup impact (b72) and the final hit (b80). Hits sit 3-6 dB over the bed.
BANNED:  dark void with small floating elements (every hero >= 40% of frame height); glow, bloom, particles; gradients,
         glass; cream paper, serif, italic accents, 01/02 labels, pills; everything centred; everything fading and
         sliding up; titles that drift; corner labels and HUD chrome; three cards in a row; the logo docked in a corner;
         the URL, slogans, chain-name chips (the person's rule); red/green on numbers; emoji; price, return or "buy"
         language; a contract address; a launch date.
SOUND+: a riser (effects library) rises under the countdown from 1.0 s and dies on 5.5 s; bed at volume 1.0,
         drop impact 0.6, lockup impact 0.7, final hit 0.55 with a 1 s fade so the last 0.6 s is silent.
QA:      f0 (log visible, not blank); f160 (summary line accent); f250 (numeral 3, state word); f358 (blackout);
         f166+ (drop: white, mark squashed); f190 (ticker mid-type); f300 (fees: 4 rows, accent right);
         f470 (post card, three lines); f600 (four statements, three dimmed); f760 (lockup); f860 (ticker on end card).

GOAL:    A stranger can say, after 46 s, how the product works: launch a coin, it gets an agent and a treasury
         in one transaction; swap fees are split on-chain and the agent's share pays for its own decisions.
OUTPUT:  HyperFrames, 1920 x 1080, 30 fps
TIME:    46.5 s x 30 = 1395 frames. Grid 130.3 BPM: beat = 0.4605 s (13.8 frames), bar = 1.842 s.
         beat(k) = 0.035 + k x 0.4605. The flood lands on beat 24 = 11.087 s.
         Bed: catalog track "energetic fast-paced electronic, driving bass" (127.7 BPM, 30 s) at playback rate
         1.0206 so its beat equals the grid; its strong section (media 7.655 s = its beat 16) loops on bar lines
         at film beats 0, 40 and 80 (three clips), 2 s fade-out under the last line. Strong from frame 0.
LOOK:    Two grounds, both the brand's own: chain world black #000000 with hairlines #262626 / #3d3d3d, white ink;
         agent world white #ffffff with hairlines #ebebeb / #d4d4d4, ink #171717, body #4d4d4d, mute #737373 / #8f8f8f.
         One accent #0070f3: the Launch button, the agent's fee share, one word on the limits line. Nowhere else.
         Display: Geist 600, 96-120 px, tracking -0.04em, line-height 1.0. Captions: Geist 500, 36-40 px, -0.01em.
         Numbers: Geist Mono 500, 56-200 px, tabular. Minimum text 32 px.
         Medium: the product's own terminal UI. Hairline boxes, 8 px radii, no shadows, no grain, no vignette,
         no gradients. Depth is a hairline. Data is the decoration.
OBJECTS: the launch form (a hairline card with four filled fields and one accent button), an arrow cursor,
         a launch() call block in mono, four result cards joined to it by drawn lines, a readout panel of three
         mono stats, a decision list with an ink selector bar, a post card with a square avatar and a typed line,
         a $1,000 swap figure and the $10 that peels off it, a 20/50/30 proportional bar, four struck-through
         lines, a ring of four nodes with a drawn arc, the mark (24-unit square with the power glyph).
MOTION:  arrivals expo.out 0.45 s (x -40 -> 0, blur 8 -> 0 px); hits are tl.set on the beat; exits power3.in 0.22 s;
         floods: clip-path circle or inset, power2.inOut 0.35-0.4 s, from the object that caused it;
         line draws: scaleX 0 -> 1 power3.out 0.2 s; number ticks 1.2 s power2.out; word stagger 0.08 s;
         a landed title never moves. Something new every bar. No breathing, no floating, no slow push.
SHOTS:   (t in seconds; beats in brackets)
         00.00-02.70  S1 launch, white. Frame 0: the filled form (Orbit, ORB, 500 USDC, 20/50/30) already there.
                      Cursor travels 0.5-1.75 s to the Launch button, clicks at 1.877 [4]; the button rebounds.
                      Sound: click. Hand-off: an iris opens from the button into S2.
         02.25-11.50  S2 one transaction, black. Iris from (960,860). "One transaction." at 2.6. launch() block left.
                      Four cards land on beats [6][10][14][18] = 2.80 / 4.64 / 6.48 / 8.32 (the last holds 2.8 s before the drop): coin + pool, treasury
                      (500 USDC moves in), on-chain identity, fee split locked. Pop / key on each; no riser (the bed has its own build).
                      Hand-off: the drop.
         11.05-20.40  S3 the agent wakes, white. Flood from centre on the drop [24] 11.09 + impact; title set on the hit.
                      Readouts land [26][27][28]; "It decides" [32] 14.77, selector slides to "post" [34-36];
                      "One paid thought, from its own treasury" [36] 16.61, treasury ticks 500.00 -> 499.98;
                      the post types [38-41], 8 words. Hand-off: whip from the post card.
         20.00-29.90  S4 fees, black. Whip in. "Someone swaps." $1,000 [44] 20.30; "1% fee" and $10 peel [46] 21.22;
                      $10 splits into 20/50/30 bar [48] 22.14; agent share turns accent [52] 23.98 with
                      "The agent's share buys its next thought."; "Locked at launch. Nobody can change the split." [56] 25.82; the $2 lands "→ treasury" [60] 27.67.
         29.50-37.30  S5 limits, white. Vertical wipe on [64] 29.51 (clip B re-enters on the drop). "What it cannot do."
                      Four lines [66][68][70][72], each struck through a beat later. "Enforced on-chain, not by promise." [76] 34.99.
         36.90-42.30  S6 the loop, black. Iris. Ring: fees -> treasury -> thought -> post, one quarter arc per two beats
                      [81-88]. Centre line "Fees refuel it." then "Empty treasury? It sleeps until refueled." [86] 39.64.
         41.90-46.50  S7 one line, white. Blur swap. "Fees fund the agent. The agent runs the coin." word by word,
                      landed by 43.0; the mark lands [95] 43.78 with a pop. Hold 2.7 s. Music fades 1.8 s.
BANNED:  dark void with small floating elements (every hero >= 40% of frame height); glow, bloom, particles;
         gradients, glass; cream paper, serif, italic accents, 01/02 labels, pills; everything centred;
         everything fading and sliding up; titles that drift after landing; corner labels and HUD chrome;
         three cards in a row; the logo docked in a corner; the URL, slogans, chain-name chips (the person's rule);
         red/green on numbers; emoji.
QA:      f0 (form visible, not blank); f56 (click, button pressed); f111 (card 1 landed, line drawn);
         f333 (drop: white, title set, nothing mid-tween); f498 (post typed); f664 (bar 20/50/30 complete);
         f996 (four strikes); f1217 (ring closed); f1313 (line + mark, still); phone sheet: every line legible.

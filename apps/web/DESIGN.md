---
version: alpha
name: Vercel-Inspired-design-analysis
description: An inspired interpretation of Vercel's design language — a developer-platform brand whose surface is a stark black-and-ink duet on near-white canvas, broken at hero scale by a multi-color mesh gradient (cyan / blue / magenta / amber) that acts as the entire decorative system, paired with a custom geometric sans for headlines and a monospaced caption face for technical labels.

colors:
  primary: "#171717"
  on-primary: "#ffffff"
  ink: "#171717"
  body: "#4d4d4d"
  mute: "#888888"
  hairline: "#ebebeb"
  hairline-strong: "#a1a1a1"
  canvas: "#ffffff"
  canvas-soft: "#fafafa"
  canvas-soft-2: "#f5f5f5"
  link: "#0070f3"
  link-deep: "#0761d1"
  link-bg-soft: "#d3e5ff"
  success: "#0070f3"
  error: "#ee0000"
  error-soft: "#f7d4d6"
  error-deep: "#c50000"
  warning: "#f5a623"
  warning-soft: "#ffefcf"
  warning-deep: "#ab570a"
  violet: "#7928ca"
  violet-soft: "#d8ccf1"
  violet-deep: "#4c2889"
  cyan: "#50e3c2"
  cyan-soft: "#aaffec"
  cyan-deep: "#29bc9b"
  highlight-pink: "#ff0080"
  highlight-magenta: "#eb367f"
  gradient-develop-start: "#007cf0"
  gradient-develop-end: "#00dfd8"
  gradient-preview-start: "#7928ca"
  gradient-preview-end: "#ff0080"
  gradient-ship-start: "#ff4d4d"
  gradient-ship-end: "#f9cb28"
  selection-bg: "#171717"
  selection-fg: "#f2f2f2"

typography:
  display-xl:
    fontFamily: Geist, Inter, system-ui, -apple-system, sans-serif
    fontSize: 48px
    fontWeight: 600
    lineHeight: 48px
    letterSpacing: -2.4px
  display-lg:
    fontFamily: Geist, Inter, system-ui, -apple-system, sans-serif
    fontSize: 32px
    fontWeight: 600
    lineHeight: 40px
    letterSpacing: -1.28px
  display-md:
    fontFamily: Geist, Inter, system-ui, -apple-system, sans-serif
    fontSize: 24px
    fontWeight: 600
    lineHeight: 32px
    letterSpacing: -0.96px
  display-sm:
    fontFamily: Geist, Inter, system-ui, -apple-system, sans-serif
    fontSize: 20px
    fontWeight: 600
    lineHeight: 28px
    letterSpacing: -0.6px
  body-lg:
    fontFamily: Geist, Inter, system-ui, -apple-system, sans-serif
    fontSize: 18px
    fontWeight: 400
    lineHeight: 28px
    letterSpacing: 0px
  body-md:
    fontFamily: Geist, Inter, system-ui, -apple-system, sans-serif
    fontSize: 16px
    fontWeight: 400
    lineHeight: 24px
  body-md-strong:
    fontFamily: Geist, Inter, system-ui, -apple-system, sans-serif
    fontSize: 16px
    fontWeight: 500
    lineHeight: 24px
  body-sm:
    fontFamily: Geist, Inter, system-ui, -apple-system, sans-serif
    fontSize: 14px
    fontWeight: 400
    lineHeight: 20px
    letterSpacing: -0.28px
  body-sm-strong:
    fontFamily: Geist, Inter, system-ui, -apple-system, sans-serif
    fontSize: 14px
    fontWeight: 500
    lineHeight: 20px
    letterSpacing: -0.28px
  caption:
    fontFamily: Geist, Inter, system-ui, -apple-system, sans-serif
    fontSize: 12px
    fontWeight: 400
    lineHeight: 16px
  caption-mono:
    fontFamily: Geist Mono, ui-monospace, SFMono-Regular, Menlo, Monaco, monospace
    fontSize: 12px
    fontWeight: 400
    lineHeight: 16px
  code:
    fontFamily: Geist Mono, ui-monospace, SFMono-Regular, Menlo, Monaco, monospace
    fontSize: 13px
    fontWeight: 400
    lineHeight: 20px
  button-md:
    fontFamily: Geist, Inter, system-ui, -apple-system, sans-serif
    fontSize: 14px
    fontWeight: 500
    lineHeight: 20px
  button-lg:
    fontFamily: Geist, Inter, system-ui, -apple-system, sans-serif
    fontSize: 16px
    fontWeight: 500
    lineHeight: 24px

rounded:
  none: 0px
  xs: 4px
  sm: 6px
  md: 8px
  lg: 12px
  xl: 16px
  pill-sm: 64px
  pill: 100px
  full: 9999px

spacing:
  xxs: 4px
  xs: 8px
  sm: 12px
  md: 16px
  lg: 24px
  xl: 32px
  2xl: 40px
  3xl: 48px
  4xl: 64px
  5xl: 96px
  6xl: 128px
  section: 192px

components:
  nav-bar:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body-sm}"
    height: 64px
    padding: "{spacing.sm} {spacing.lg}"
  nav-link:
    textColor: "{colors.body}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.full}"
    padding: "{spacing.xs} {spacing.sm}"
  nav-cta-signup:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.body-sm-strong}"
    rounded: "{rounded.sm}"
    padding: "0px {spacing.xs}"
    height: 28px
  nav-cta-login:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body-sm-strong}"
    rounded: "{rounded.sm}"
    padding: "0px {spacing.xs}"
    height: 28px
  nav-cta-ask-ai:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    borderColor: "{colors.hairline}"
    typography: "{typography.body-sm-strong}"
    rounded: "{rounded.sm}"
    padding: "0px {spacing.xs}"
    height: 28px
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button-lg}"
    rounded: "{rounded.pill}"
    padding: "0px {spacing.sm}"
  button-secondary:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.button-lg}"
    rounded: "{rounded.pill}"
    padding: "0px {spacing.sm}"
  button-primary-sm:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button-md}"
    rounded: "{rounded.pill}"
    padding: "0px {spacing.xs}"
  button-secondary-sm:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.button-md}"
    rounded: "{rounded.pill}"
    padding: "0px {spacing.xs}"
  tab-ghost:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.pill-sm}"
    padding: "0px {spacing.md}"
  icon-button-circular:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    borderColor: "{colors.hairline}"
    rounded: "{rounded.full}"
  card-marketing:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.md}"
    padding: "{spacing.lg}"
  card-marketing-large:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: "{spacing.xl}"
  card-soft:
    backgroundColor: "{colors.canvas-soft}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.md}"
    padding: "{spacing.lg}"
  template-card:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.md}"
    padding: "{spacing.md}"
  code-editor-mockup:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.code}"
    rounded: "{rounded.md}"
    padding: "{spacing.lg}"
  form-input:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    borderColor: "{colors.hairline}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.sm}"
    padding: "0px {spacing.sm}"
    height: 40px
  form-input-sm:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    borderColor: "{colors.hairline}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.sm}"
    padding: "0px {spacing.sm}"
    height: 32px
  form-input-lg:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    borderColor: "{colors.hairline}"
    typography: "{typography.body-md}"
    rounded: "{rounded.sm}"
    padding: "0px {spacing.sm}"
    height: 48px
  badge-secondary:
    backgroundColor: "{colors.canvas-soft}"
    textColor: "{colors.body}"
    typography: "{typography.caption}"
    rounded: "{rounded.full}"
    padding: "0px {spacing.xs}"
  pricing-card:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: "{spacing.xl}"
  pricing-card-featured:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: "{spacing.xl}"
  logo-strip:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.body}"
    typography: "{typography.body-sm}"
    padding: "{spacing.lg} {spacing.xl}"
  hero-band:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.display-xl}"
    padding: "{spacing.4xl} {spacing.lg}"
  feature-mesh-band:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.display-lg}"
    padding: "{spacing.5xl} {spacing.lg}"
  showcase-band-light:
    backgroundColor: "{colors.canvas-soft}"
    textColor: "{colors.ink}"
    typography: "{typography.display-lg}"
    padding: "{spacing.5xl} {spacing.lg}"
  showcase-band-dark:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.display-lg}"
    padding: "{spacing.5xl} {spacing.lg}"
  footer:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.body}"
    typography: "{typography.body-sm}"
    padding: "{spacing.4xl} {spacing.lg}"
  link-inline:
    textColor: "{colors.link}"
    typography: "{typography.body-md}"
  banner-marketing:
    backgroundColor: "{colors.canvas-soft}"
    textColor: "{colors.body}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.full}"
    padding: "{spacing.xs} {spacing.sm}"

  # ─── Examples (illustrative) — auto-derived; resolve any TO_FILL markers below ───
  ex-pricing-tier:
    description: "Default tier card. Mirrors pricing-card chrome on canvas-soft surface with a hairline border."
    backgroundColor: "{colors.canvas-soft}"
    textColor: "{colors.ink}"
    borderColor: "{colors.hairline}"
    rounded: "{rounded.lg}"
    padding: "{spacing.xl}"
  ex-pricing-tier-featured:
    description: "Featured tier — polarity-flipped to ink primary with white text and white CTA."
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.lg}"
    padding: "{spacing.xl}"
  ex-product-selector:
    description: "What's Included summary card — repurposed for the brand's GPU / inference / Pro feature tiers."
    backgroundColor: "{colors.canvas-soft}"
    rounded: "{rounded.md}"
    padding: "{spacing.lg}"
  ex-cart-drawer:
    description: "Subscription summary — line items per add-on (NOT a literal e-commerce cart)."
    backgroundColor: "{colors.canvas}"
    rounded: "{rounded.md}"
    padding: "{spacing.lg}"
    item-divider: "{colors.hairline}"
  ex-app-shell-row:
    description: "Sidebar nav row. Active state uses brand primary as a left-edge indicator bar."
    backgroundColor: "{colors.canvas}"
    activeIndicator: "{colors.primary}"
    rounded: "{rounded.sm}"
    padding: "{spacing.xs} {spacing.sm}"
  ex-data-table-cell:
    description: "Mirrors the brand's table chrome. Header uses caption-mono uppercase mono; body uses body-sm."
    headerBackground: "{colors.canvas-soft}"
    headerTypography: "{typography.caption-mono}"
    bodyTypography: "{typography.body-sm}"
    cellPadding: "{spacing.xs} {spacing.sm}"
    rowBorder: "{colors.hairline}"
  ex-auth-form-card:
    description: "Sign-in / sign-up card. Mirrors card-marketing-large chrome with form-input primitives inside."
    backgroundColor: "{colors.canvas-soft}"
    rounded: "{rounded.lg}"
    padding: "{spacing.xl}"
  ex-modal-card:
    description: "Modal dialog surface — same chrome as card-marketing-large with Level 5 modal shadow."
    backgroundColor: "{colors.canvas}"
    rounded: "{rounded.lg}"
    padding: "{spacing.xl}"
  ex-empty-state-card:
    description: "Empty-state illustration frame. Generous padding on canvas-soft."
    backgroundColor: "{colors.canvas-soft}"
    rounded: "{rounded.lg}"
    padding: "{spacing.3xl}"
    captionTypography: "{typography.body-md}"
  ex-toast:
    description: "Toast notification surface — flat-cornered card-marketing chrome with Level 4 shadow."
    backgroundColor: "{colors.canvas}"
    rounded: "{rounded.md}"
    padding: "{spacing.sm} {spacing.md}"
    typography: "{typography.body-sm}"

---

## Bootr

> Product brand for **bootr.fun** — a launchpad on Base where every coin gets an autonomous agent that runs its own X account. This section is the source of truth for the web app (`app/globals.css`, `components/brand/*`). Everything below it, including the colour values in the front matter, is the Vercel-inspired base the layout was derived from; its colours are superseded by the Base palette here. Where they disagree, this section wins.

### Positioning in one line
A trading-terminal-grade product on Base, not a marketing site. Black, white and Base grays, hairlines, mono numbers, one Base Blue accent. The Vercel base minus its mesh gradient: Bootr has **one texture and no other decoration** — a field of faint ink dots behind the home page that answers the pointer (see "Field" below); everything else is data, and the few colours it uses are Base's and carry meaning.

### Identity

| Element | Spec |
|---|---|
| Wordmark | `bootr`, always lowercase, Geist 600, `letter-spacing: -0.04em`, line-height 1. Never uppercase, never with a period, never set in mono. |
| Mark | 24-unit square, `rx 5`, filled `currentColor`, with a squared power glyph knocked out: a vertical stroke `M12 4.75V12` dropping into an open-topped square `M8.75 7.75H6.75V17.25H17.25V7.75H15.25`, both 2.5 units, square caps. Reads as "power on" and as a boot/terminal block. |
| Lockup | Mark + wordmark, gap 8px at 20px mark / 18px text (nav), gap 6px at 16px / 15px (footer). Mark height = cap height x 1.6. |
| Clear space | 0.5 x mark size on all sides. |
| Favicon | `public/favicon.svg` — same mark, switches ink/white via `prefers-color-scheme`. Legible at 16px because strokes land on whole pixels at 24 -> 16 scale (2.5 -> 1.67px). |
| OG image | `public/og.png` (rendered from `public/og.svg`): black canvas, one hairline grid cross, mark + wordmark, single sentence. |
| Misuse | No gradients, no outlines of the mark, no rotating, no accent-coloured mark, no emoji next to the wordmark. |

### Color tokens

Bootr on Base: the palette is Base's own ([brand.base.org](https://brand.base.org), HEX section). One gray ladder per mode, one hero accent (Base Blue), and a few secondary colours that only carry meaning. Token names map 1:1 to Tailwind utilities (`bg-canvas`, `text-ink`, `border-hairline`, `bg-accent`, `text-positive-text`, `fill-chart-1`, ...). Raw values live on `:root` / `.dark` in `app/globals.css`; this table is the source of truth and the CSS must match it.

**Base palette used**

| Name | Hex | | Name | Hex |
|---|---|---|---|---|
| Base Blue | `#0000ff` | | Gray 0 | `#ffffff` |
| Cerulean | `#3c8aff` | | Gray 10 | `#eef0f3` |
| Green | `#66c800` | | Gray 15 | `#dee1e7` |
| Lime Green | `#b6f569` | | Gray 30 | `#b1b7c3` |
| Red | `#fc401f` | | Gray 50 | `#717886` |
| Yellow | `#ffd12f` | | Gray 60 | `#5b616e` |
| Tan (muted) | `#b8a581` | | Gray 80 | `#32353d` |
| | | | Gray 100 | `#0a0b0d` |

Pink `#fea8cd` is not used. Values marked *derived* are straight sRGB mixes of two Base colours, made only where no Base step passes AA; they are never used as brand colours on their own.

**Neutrals**

| Token | Light | Dark | Use |
|---|---|---|---|
| `canvas` | `#ffffff` Gray 0 | `#0a0b0d` Gray 100 | Page and card background. Cards are the same colour as the page; hairlines separate them. |
| `canvas-soft` | `#eef0f3` Gray 10 | `#141619` *derived* (Gray 100 → Gray 80, 25%) | Inset regions: table headers, code blocks, input wells, the DexChart well. |
| `canvas-sub` | `#dee1e7` Gray 15 | `#1e2025` *derived* (Gray 100 → Gray 80, 50%) | Hover fill for rows and ghost buttons, the ⌘K selection, skeletons. |
| `ink` | `#0a0b0d` Gray 100 | `#ffffff` Gray 0 | Headlines, numbers, primary text, ink buttons. |
| `on-ink` | `#ffffff` | `#0a0b0d` | Text on ink fills. |
| `body` | `#32353d` Gray 80 | `#b1b7c3` Gray 30 | Paragraph copy. |
| `mute` | `#5b616e` Gray 60 | `#818895` *derived* (Gray 50 → Gray 30, 25%) | Labels, captions, secondary metadata. Gray 50 is 4.44:1 on both white and Gray 100, just under AA, so it is not used for text. |
| `hairline` | `#dee1e7` Gray 15 | `#32353d` Gray 80 | Every 1px border and divider. |
| `hairline-strong` | `#b1b7c3` Gray 30 | `#5b616e` Gray 60 | Input borders on hover, outline status dots, the RWAGMI (context) segment of the fee bar. |
| `edge` | `#b1b7c3` Gray 30 | `#32353d` Gray 80 | The outer border of anything that must read as a box on the dotted page: token cards, panels, the `$BOOT` box. Equal to `hairline` in dark mode; one step stronger in light mode, where Gray 15 on white disappears against the field. |
| `selection-bg` / `selection-fg` | `#0a0b0d` / `#eef0f3` | `#ffffff` / `#0a0b0d` | `::selection`. |

**Accent (Base Blue)**

| Token | Light | Dark | Use |
|---|---|---|---|
| `accent` | `#0000ff` Base Blue | `#3c8aff` Cerulean | Fill of the one primary action per view (Launch, Fuel, Trade), focus rings, the active primary-nav underline, the ⌘K selection bar (the 2px rule on the `$BOOT` box was replaced by the bloom photograph on 2026-11-01). Base Blue is 2.29:1 on Gray 100, so dark mode uses Cerulean. |
| `accent-hover` | `#3c8aff` Cerulean | `#6da7ff` *derived* (Cerulean → white, 25%) | Hover fill of primary buttons. |
| `on-accent` | `#ffffff` | `#0a0b0d` | Label on `accent`. White on Cerulean is 3.35:1, so Cerulean always carries Gray 100 text. |
| `on-accent-hover` | `#0a0b0d` | `#0a0b0d` | Label on `accent-hover`. |
| `link` | `#0000ff` | `#3c8aff` | Link text, and the hover colour of ink/mute links. A `text-link` link hovers with an underline, never with Cerulean text on white (3.35:1). |

**Secondary (semantic only)**

| Token | Light | Dark | Use |
|---|---|---|---|
| `positive` | `#66c800` Green | `#66c800` | Fills: the agent "awake" dot. |
| `positive-text` | `#3d7306` *derived* (Green → Gray 100, 45%) | `#66c800` | Text: positive 24h change, "Pinned" (image upload), "connected" (X account). Green itself is 2.14:1 on white. |
| `negative` | `#fc401f` Red | `#fc401f` | Fills that signal failure (none today; reserved). |
| `negative-text` (alias `danger`) | `#b3301a` *derived* (Red → Gray 100, 30%) | `#fc401f` | Text and borders: negative 24h change, validation and transaction errors, the wrong-network chip, `aria-invalid` inputs, the failed upload box. Red itself is 3.56:1 on white. |
| `warning` | `#ffd12f` Yellow | `#ffd12f` | Text of the "Graduated" / "Grad" badge. Only ever on `warning-surface`. |
| `warning-surface` | `#0a0b0d` Gray 100 | `#32353d` Gray 80 | Badge fill under `warning` (Yellow on dark ink). |
| `tan` | `#b8a581` Tan | `#b8a581` | The one muted colour; used as `chart-4`. |

**Charts**

| Token | Light | Dark | Use |
|---|---|---|---|
| `chart-1` | `#0000ff` Base Blue | `#3c8aff` Cerulean | First categorical series: `agent` in the fee split and in Fees by recipient. |
| `chart-2` | `#3c8aff` Cerulean | `#0000ff` Base Blue | Second categorical series; `creator`. |
| `chart-3` | `#b6f569` Lime Green | `#b6f569` | Third categorical series; `burn`. |
| `chart-4` | `#b8a581` Tan | `#b8a581` | Fourth categorical series; `platform`. |
| context | `hairline-strong`, `hairline`, `mute` | same | RWAGMI share, baselines, crosshair, axis labels. |

Single-series charts (volume line and area at 8% fill, launches per day, awake agents, BOOT burned, the reputation bars) stay `ink`: monochrome leads, and a page of saturated blue lines would make Base Blue the background instead of the highlight. The chart palette is only for series that need telling apart. The hovered datum (dot, bar, ranked bar) switches to `accent`. Axis text stays `mute`.

**Rules**
- **Monochrome leads.** Black, white and the Base grays carry every surface, border and almost all text. Colour is the exception a reader notices.
- **One hero accent.** Base Blue appears as a fill at most once per viewport (the primary button). Its other uses are thin and functional: focus ring, active nav underline, ⌘K selection bar, the 2px rule on the `$BOOT` box, link text, the hovered chart datum, the first categorical chart series. Never on headings, icons, the mark or wordmark, or as a background wash. No gradients.
- **At most three vibrant secondaries plus one muted on a page.** Green (awake / up), Red (down / error) and Yellow (graduated) are the vibrant three; Tan is the muted one. Lime appears only inside charts, and a chart page shows no Yellow. Pink is unused.
- **Secondaries carry meaning, never decoration.** Green = positive or alive; Red = negative or failed; Yellow = graduated. Every coloured mark is paired with text (a label, a sign, a legend value), so colour is never the only signal.
- **24h change is coloured:** `+4.2%` in `positive-text`, `−3.1%` in `negative-text`, `0.0%` and missing values in `ink`. The sign stays, so the number reads without colour. Only the 24h change is coloured; prices, caps and volumes stay `ink`.
- **AA in both themes.** Text pairings must reach 4.5:1 (12–14px is all "normal" text here); non-text UI that is the only signal (focus ring, active underline) must reach 3:1. Where a Base colour fails, use the documented *derived* shade, never a new hue. Measured ratios are in the Contrast table; add a row for every new pairing.

**Contrast** (WCAG 2.x relative luminance, computed from the hex values and re-checked against computed styles in the running app, both themes)

| Pairing | Light | Dark |
|---|---|---|
| `ink` on `canvas` | 19.69 | 19.69 |
| `body` on `canvas` | 12.26 | 9.78 |
| `mute` on `canvas` | 6.21 | 5.52 |
| `mute` on `canvas-soft` | 5.44 | 5.08 |
| `mute` on `canvas-sub` | 4.74 | 4.57 |
| `link` on `canvas` | 8.59 | 5.88 |
| `link` on `canvas-soft` | 7.53 | 5.41 |
| `on-accent` on `accent` (primary button) | 8.59 | 5.88 |
| `on-accent-hover` on `accent-hover` | 5.88 | 8.08 |
| `on-ink` on `ink` | 19.69 | 19.69 |
| `positive-text` on `canvas` | 5.75 | 9.21 |
| `positive-text` on `canvas-soft` | 5.03 | 8.48 |
| `negative-text` on `canvas` | 6.26 | 5.52 |
| `negative-text` on `canvas-soft` | 5.48 | 5.09 |
| `warning` on `warning-surface` (badge) | 13.51 | 8.42 |
| `accent` focus ring / nav underline / ⌘K bar on `canvas` (non-text, ≥3) | 8.59 | 5.88 |
| `accent` ⌘K bar on `canvas-sub` (non-text, ≥3) | 6.56 | 4.87 |
| `positive` awake dot on `canvas` (non-text, paired with a label) | 2.14 | 9.21 |
| `chart-1` on `canvas` (non-text) | 8.59 | 5.88 |
| `chart-2` on `canvas` (non-text) | 3.35 | 2.29 |
| `chart-3` on `canvas` (non-text) | 1.29 | 15.24 |
| `chart-4` on `canvas` (non-text) | 2.40 | 8.19 |

Light `positive-text` is 4.39:1 on `canvas-sub` (Gray 15), so coloured change text never sits on a hover fill or skeleton; keep it on `canvas` or `canvas-soft`.

Chart series under 3:1 (light Lime and Tan, dark Base Blue) are acceptable only because every series is labelled in text beside it (legend with value, tooltip with value) and stacked segments are split by a 1px `canvas` gap; never use them for a series without a text value. The light-mode awake dot is under 3:1 for the same reason: it always sits next to the status text ("Awake" in the card footer and agent panel, an sr-only label otherwise).

### Typography

Geist for everything narrative, Geist Mono for every number that can change, every address, hash, and code block. Loaded from the `geist` npm package (no network fetch at build). **Doto** (Base's secondary display face, `next/font/google`, utility `font-doto`) for short all-caps labels only: the home eyebrow ("LAUNCHPAD · BUILT ON BASE") and the footer's "BUILT ON BASE". 14px, 600, `tracking 0.1em`, `body` colour (the dot-matrix face needs the weight and the contrast). Never lowercase, never more than a few words, never in the product UI proper (labels above numbers stay Geist caption).

| Token | Size / line | Tracking | Weight | Use |
|---|---|---|---|---|
| `display-xl` | 48 / 48 | -0.05em | 600 | One per page max (token price on the token page, Docs H1). |
| `display-lg` | 32 / 40 | -0.04em | 600 | Page titles. |
| `display-md` | 24 / 32 | -0.04em | 600 | Section titles, stat tile values. |
| `display-sm` | 20 / 28 | -0.03em | 600 | Panel titles. |
| `body-lg` (`text-base`) | 16 / 24 | 0 | 400 | Docs prose. |
| `body` (`text-sm`) | 14 / 20 | -0.01em | 400/500 | Default UI text. The app is data-dense: 14px is the base. Utility is `text-sm` so it never collides with the `body` colour (`text-body`). |
| `caption` | 12 / 16 | 0 | 400/500 | Labels, table headers, metadata. |
| `micro` | 11 / 14 | 0 | 500 | Badges, chain chips. |
| mono | 12-14 | 0 | 400 | Numbers (`tabular-nums`), addresses, hashes, code. |

Labels above numbers are `caption` in `mute`, sentence case. Uppercase is allowed only for mono micro labels (chain badges: `BASE`, `SEPOLIA`).

### Spacing, radii, elevation
- 4px grid (`--spacing: 0.25rem`). Card padding 16px; panel padding 20px; page gutter 16px mobile / 24px desktop; no maximum content width since 2026-11-01 (the page, header and footer span the viewport; the token grid adds columns up to 4).
- Radii: `xs 4` (badges, chips), `sm 6` (buttons, inputs), `md 8` (cards, panels), `lg 12` (dialogs, drawers). Nothing larger. No pills except the status dot and the 9999px chip used for counts.
- Elevation is a hairline. Shadows only on floating layers (command palette, dropdown, drawer, toast): `0 1px 1px #00000005, 0 8px 16px -4px #0000000a, 0 24px 32px -8px #0000000f`. No glass, no blur, no glow.

### Motion
| Token | Value | Use |
|---|---|---|
| `duration-fast` | 150ms | Hover, press, colour changes. |
| `duration-base` | 250ms | Card enter/reorder (`motion` `layout`), drawer, tabs. |
| `duration-slow` | 400ms | Chart draw-in, number ticks (`@number-flow/react`). |
| `ease-out-quint` | `cubic-bezier(0.22, 1, 0.36, 1)` | Default easing. |
| `ease-base` | `cubic-bezier(0.4, 0, 0.2, 1)` | Base's one curve (brand.base.org/motion), for 120–240 ms feedback: card hover, the field. |

New tokens slide in at the top of the grid with a one-shot 1px ink ring (`animate-flash`) — no confetti, no glow, no bounce. `prefers-reduced-motion` disables layout animation, chart draw-in and number ticking (values swap instantly).

**Type scramble** (`components/ui/Scramble.tsx`): Base's named headline pattern. The home `h1` resolves from random mono glyphs to "Tokens" left to right in 640 ms on mount; the server renders the final text (no layout shift), reduced motion skips it, screen readers get the text once. Headlines only, never body copy, at most one per page.

**Field** (`components/tokens/AsciiWake.tsx`): the home page's only texture. A canvas fixed to the viewport behind the content draws one `ink` dot per 12px cell at 9% opacity. Within 72px of the pointer the dots become mono glyphs (`.` `:` `-` `=` `+` `*` `#` by heat) drawn in `accent` up to 90% opacity, drift up to 10px toward the pointer and cool back to dots in 1.2 s; a press sends a ring. This is the page's "burst of colour in a key interaction" (brand.base.org/color): the dots never carry colour, only the wake does. Idle when nothing is hot, static under reduced motion, cards and panels stay opaque on top. Not on other pages.

### Components

| Component | Rules |
|---|---|
| `Button` | Heights 28 (sm) / 32 (md) / 40 (lg); radius `sm`. Variants: `primary` (`accent` fill with `on-accent` label, `accent-hover` + `on-accent-hover` on hover — one per view), `ink` (ink fill), `secondary` (canvas + hairline, ink text), `ghost` (no border, `canvas-sub` on hover). Disabled = 50% opacity, `cursor-not-allowed`. Loading keeps width, swaps label for "Confirming…". |
| `Input` / `Textarea` / `Select` | 32px (md) or 40px (lg) tall, hairline border, `hairline-strong` on hover, accent focus ring. Mono for numeric inputs with a right-aligned unit suffix (`USDC`, `ETH`). |
| `Tabs` | Text tabs with a 1px ink underline on the active item; driven by the URL (`?tab=`). Counts in mono `mute`. The primary nav is the one exception: its active item is underlined in `accent`. |
| `Card` (token card) | Canvas + hairline, radius `md`, 16px padding. Agent status dot top right (Green awake, gray sleeping). 48px square image with 1px hairline border, radius `xs`. Title row: name (500) + `$SYMBOL` mono mute. Data grid of 2x2 mono values with caption labels. Hover: border `accent` (thin, one card at a time; `ease-base` 150 ms). |
| `StatusDot` | 8px circle. `awake` = solid `positive` (Green); `sleeping` = solid `mute` (gray); `paused` / `dormant` / `claimed` = 1px `hairline-strong` outline, no fill. Always paired with a text label for screen readers. |
| `Badge` | Micro text, radius `xs`, hairline border, `canvas-soft` fill. "Graduated" (and the card's "Grad") is `warning` (Yellow) text on `warning-surface` — the only filled badge. |
| `$BOOT` box | The home's one photograph: `public/boot-bloom.webp` (a yellow bloom on Base Blue) as a `bg-cover` layer at 16% opacity (light) / 22% (dark) over `canvas`, covering the whole box; cells are transparent with hairline borders so the image runs through, labels `mute`, values mono `ink`. The only place imagery or an opacity layer is allowed. |
| `Stat tile` | Caption label, `display-md` mono value ticking with number-flow, optional delta in caption. The 24h change is `positive-text` / `negative-text` by sign. Tiles sit in a hairline-divided row, not separate cards. |
| `Table` | Header row `canvas-soft`, caption `mute`; rows 36px, hairline separators, mono right-aligned numbers, hover `canvas-sub`. |
| `Panel` | Section with a `display-sm` title, hairline border, radius `md`, 20px padding. |
| `Empty state` | One sentence in `mute`, optionally one ghost action. No illustration. |
| `Skeleton` | `canvas-sub` blocks at the final layout size, slow opacity pulse. |
| Command palette | cmdk in a `lg` radius dialog, 560px wide, floating shadow, mono result metadata, `⌘K` hint in nav. Selected row: `canvas-sub` fill plus a 2px inset `accent` bar on the left (a shadow, so no size change). |

### Voice
Short, literal, sentence case. "Launch a coin with an agent that runs it." Not "Revolutionize", not "Unleash", no exclamation marks, no emoji. Numbers over adjectives. Empty states are one sentence. Errors say what happened and what to do.

### Do / Don't
| Do | Don't |
|---|---|
| Let hairlines and whitespace carry structure. | Add gradients, glass, blur, glow or colour blobs. |
| Use mono + `tabular-nums` for every live number. | Colour prices, caps or volumes; only the 24h change gets Green/Red. |
| Keep one Base Blue fill per view. | Use the accent for decoration, icons, headings or the mark. The wake glyphs and the hovered card border are feedback, not decoration. |
| Use Base palette values, or their documented *derived* shades. | Introduce a hue outside the Base palette, or use Pink. |
| Check AA in both themes for every new pairing and add it to the Contrast table. | Put white text on Cerulean, or Base Blue text on the dark canvas. |
| Use radius ≤ 12px. | Round everything to 24px+. |
| Animate to explain change (reorder, new item, value tick) or to answer the pointer (the field, the hovered card). | Animate for decoration (floating, pulsing logos, confetti, autoplaying backgrounds). |



## Overview

Vercel is a developer-platform brand — the page is a deployment dashboard's marketing surface, written for engineers who already know the syntax. It earns that posture with one of the cleanest stark systems on the web: near-white `{colors.canvas-soft}` body background, ink-near-black `{colors.ink}` text, a 200-step gray scale that gives every divider, border, and disabled state its own deliberate step. The only place the brand introduces colour at marketing scale is the multi-stop mesh gradient (`{colors.gradient-develop-start}` → `{colors.gradient-preview-end}` → `{colors.gradient-ship-start}` → cyan / magenta / amber) that floats in atmospheric backdrops, never miniaturised to a swatch. That gradient is the entire decoration system.

Type is the second decisive voice. The brand's own custom geometric sans (Geist) carries display, body, button — everything narrative — at weight 600 for display, 500 for buttons, 400 for body. A matching monospaced face (Geist Mono) carries technical labels: terminal mockups, code blocks, sometimes filename captions. Headlines are sentence-case with aggressive negative letter-spacing (`-2.4px` at 48 px hero) — the brand never letter-spaces positively, never goes uppercase outside of mono labels.

Surfaces use a four-step ladder: `{colors.canvas}` (pure white for cards), `{colors.canvas-soft}` 98% (the page body), `{colors.canvas-soft-2}` 95% (occasional inset region), `{colors.primary}` (the deep ink-near-black used as the polarity-flipped band when a section needs the dark mode treatment). Shadows are exceptionally subtle — every elevated card carries a stacked shadow built from `0px 1px 1px #00000005` + `0px 2px 2px #0000000a` + an inset border. Cards never float on heavy drop-shadow; they sit on the page held by hairline + soft glow.

**Key Characteristics:**
- A single black-ink primary CTA `{colors.primary}` carries every conversion target, paired with white-on-white `button-secondary` for the secondary action. The brand uses 100 px pill shape for marketing CTAs and a tight 6 px square shape for in-app nav buttons.
- A multi-stop mesh gradient (cyan-blue-magenta-amber) is the only decorative chrome — used at hero scale and inside feature-band atmospheric backdrops. It is the brand.
- Every section eyebrow and small label uses the monospace face `{typography.caption-mono}` or `{typography.code}`; everything else is in the geometric sans.
- Subtle stacked-shadow elevation — three offsets layered with 4-12 % black opacity — never a single heavy drop-shadow.
- A complete 100–1000 gray + blue + red + amber + green + teal + purple + pink colour scale exists as a system token set, but the marketing surface uses only the `100`, `1000`, and `700`-level tones; the rest stay in the design-system tokens for in-product surfaces.
- An "Active CPU" pricing rhythm: `pricing-card` lays out 3-up on the pricing page with `pricing-card-featured` (Pro tier) polarity-flipped to `{colors.primary}` against white-card siblings.

## Colors

### Brand & Accent
- **Ink** (`{colors.primary}` — `#171717`): The single primary CTA color. Black-near-pure ink that carries every Sign Up pill, every footer CTA, the dark-band polarity-flip. Used as text color throughout the page on light surfaces. (Resolved from `--ds-gray-1000`.)
- **Cyan** (`{colors.cyan}` — `#50e3c2`): A signature mint-cyan used in the brand gradient and inside Geist-system spotlight tokens. Visible inside the hero gradient stops.
- **Highlight Pink** (`{colors.highlight-pink}` — `#ff0080`): The brand's highlight magenta, used as the high-saturation stop in the preview-gradient pair.
- **Violet** (`{colors.violet}` — `#7928ca`): The deep purple used as the start of the preview-gradient and inside developer-console highlights.
- **Link Blue** (`{colors.link}` — `#0070f3`): The brand's primary link color and the legacy `--geist-success` semantic.

### Surface
- **Canvas** (`{colors.canvas}` — `#ffffff`): The pure-white card / dialog / modal surface.
- **Canvas Soft** (`{colors.canvas-soft}` — `#fafafa`): The default page background — 98 % white. Almost every section sits on this tone.
- **Canvas Soft 2** (`{colors.canvas-soft-2}` — `#f5f5f5`): A slightly deeper inset surface for "code editor inner background", template-card hover states, and dropdown menus.
- **Hairline** (`{colors.hairline}` — `#ebebeb`): 1 px dividers — table rows, card borders, input borders.
- **Hairline Strong** (`{colors.hairline-strong}` — `#a1a1a1`): The 500-level gray, used as the slightly-stronger divider on light bands and as the deemphasised text color.

### Text
- **Ink** (`{colors.ink}` — `#171717`): Every heading and body paragraph on light surfaces.
- **Body** (`{colors.body}` — `#4d4d4d`): Secondary text — sub-headings, body captions, nav-link inactive text, footer column body.
- **Mute** (`{colors.mute}` — `#888888`): Lowest-priority text — placeholder text, fine print, low-key labels.
- **On Primary** (`{colors.on-primary}` — `#ffffff`): All text on `{colors.primary}` surfaces.

### Semantic
- **Success / Link** (`{colors.success}` — `#0070f3`): The brand's legacy success indicator doubles as the primary link color. Visible underline-on-hover for inline body links.
- **Link Deep** (`{colors.link-deep}` — `#0761d1`): The pressed / visited tone for inline links.
- **Link Bg Soft** (`{colors.link-bg-soft}` — `#d3e5ff`): Soft pastel blue fill for "what's new" pill banners and informational badges.
- **Error** (`{colors.error}` — `#ee0000`): Validation red for destructive actions and form errors.
- **Error Soft** (`{colors.error-soft}` — `#f7d4d6`): Soft pastel red for destructive-state backgrounds.
- **Error Deep** (`{colors.error-deep}` — `#c50000`): Pressed / deep destructive state.
- **Warning** (`{colors.warning}` — `#f5a623`): Caution / pending status indicator.
- **Warning Soft** (`{colors.warning-soft}` — `#ffefcf`) / **Warning Deep** (`{colors.warning-deep}` — `#ab570a`): Background + pressed variants.

### Brand Gradient
The brand's signature decoration is a three-pair gradient stack:
- **Develop** (`{colors.gradient-develop-start}` `#007cf0` → `{colors.gradient-develop-end}` `#00dfd8`) — the blue-to-teal pair used to mark the "deploy" / "develop" rhythm.
- **Preview** (`{colors.gradient-preview-start}` `#7928ca` → `{colors.gradient-preview-end}` `#ff0080`) — the violet-to-pink pair used for "preview" surfaces.
- **Ship** (`{colors.gradient-ship-start}` `#ff4d4d` → `{colors.gradient-ship-end}` `#f9cb28`) — the coral-to-amber pair used for "ship" surfaces.

The three pairs collapse into a single multi-color mesh gradient when used as the hero atmospheric backdrop. Treat the gradient as one unified object — do not crop down to a single colour, do not reorder the stops, and do not miniaturise. Used at hero scale only.

## Typography

### Font Family
Two custom faces carry the entire system:

1. **A custom geometric sans** (extracted as `Geist`) for every display, body, button, link, and label. Weights 400 / 500 / 600 are the working set; the face never appears in 700 or heavier. Display sizes are tracked aggressively negative (`-2.4 px` at 48 px hero, `-1.28 px` at 32 px section); body stays at neutral or slightly-negative tracking.
2. **A custom monospaced face** (extracted as `Geist Mono`) for terminal mockups, code blocks, and small mono-caption labels — anything that wants to signal "technical." Weight 400 only at 12 – 13 px. Tracking neutral.

A condensed display sans (`Space Grotesk`) is loaded as a third face for occasional editorial moments but does not render as the primary face anywhere in the captured surfaces.

### Hierarchy

| Token | Size | Weight | Line Height | Letter Spacing | Use |
|---|---|---|---|---|---|
| `{typography.display-xl}` | 48px | 600 | 48px | -2.4px | Hero headline ("Build and deploy on the AI Cloud."). |
| `{typography.display-lg}` | 32px | 600 | 40px | -1.28px | Section headlines ("Your frontend, delivered.", "A compute model for all workloads."). |
| `{typography.display-md}` | 24px | 600 | 32px | -0.96px | Card-cluster headlines, pricing-tier names. |
| `{typography.display-sm}` | 20px | 600 | 28px | -0.6px | Inline display micro-headings. |
| `{typography.body-lg}` | 18px | 400 | 28px | 0 | Lead paragraphs under section headlines. |
| `{typography.body-md}` | 16px | 400 | 24px | 0 | Default body paragraph. |
| `{typography.body-md-strong}` | 16px | 500 | 24px | 0 | Bolded inline body. |
| `{typography.body-sm}` | 14px | 400 | 20px | -0.28px | Secondary body, nav-link text, button-md labels. |
| `{typography.body-sm-strong}` | 14px | 500 | 20px | -0.28px | Nav CTA labels, table-row emphasis. |
| `{typography.caption}` | 12px | 400 | 16px | 0 | Footer secondary lines, badge labels. |
| `{typography.caption-mono}` | 12px | 400 | 16px | 0 | Section eyebrows and label captions that want a technical voice. |
| `{typography.code}` | 13px | 400 | 20px | 0 | Inline code, terminal mockups, command snippets. |
| `{typography.button-md}` | 14px | 500 | 20px | 0 | Small / nav-scale button labels. |
| `{typography.button-lg}` | 16px | 500 | 24px | 0 | Marketing-scale pill button labels. |

### Principles
- **Negative tracking is part of the voice.** Display sizes use aggressive `-2.4` to `-0.6` px tracking. Reverting to default tracking breaks the brand.
- **Sentence-case headlines, period-terminated.** Headlines like "Build and deploy on the AI Cloud." end with a deliberate period — that punctuation is part of the brand's voice.
- **Mono for the technical layer only.** Section eyebrows, code blocks, terminal mockups. Body paragraphs never set in mono.
- **Weight 600 is the display ceiling.** The geometric sans never appears at 700 / 800. The brand reads as a calmer system because of this.

### Note on Font Substitutes
The two primary faces are proprietary (custom-cut for the brand). Open-source substitutes:
- **Geometric sans** — *Inter* (400 / 500 / 600) is the closest stylistic match; `font-feature-settings: "ss01", "ss02"` enables the geometric alternates. *Satoshi* is a passable second choice.
- **Monospace** — *JetBrains Mono* (400) at 12 – 13 px matches the technical voice. *IBM Plex Mono* is the second-best option.

## Layout

### Spacing System
- **Base unit**: 4 px. The brand's `--geist-space` token is exactly 4 px and every captured value is a multiple of 4.
- **Tokens**: `{spacing.xxs}` 4 px · `{spacing.xs}` 8 px · `{spacing.sm}` 12 px · `{spacing.md}` 16 px · `{spacing.lg}` 24 px · `{spacing.xl}` 32 px · `{spacing.2xl}` 40 px · `{spacing.3xl}` 48 px · `{spacing.4xl}` 64 px · `{spacing.5xl}` 96 px · `{spacing.6xl}` 128 px · `{spacing.section}` 192 px.
- **Section padding**: marketing bands use `{spacing.4xl}` to `{spacing.5xl}` top/bottom. Hero bands stretch to `{spacing.section}` to give the mesh gradient room to breathe.
- **Card interior padding**: marketing cards sit at `{spacing.lg}` to `{spacing.xl}`; template-grid cards stay tighter at `{spacing.md}` because they sit in a denser grid.
- **Inline gap**: button rows, nav rows, and chip rows use `{spacing.sm}` to `{spacing.md}` between siblings. The brand's `--geist-gap` is exactly 24 px.

### Grid & Container
- **Max width**: ~1400 px (`--ds-page-width`); the legacy `--geist-page-width` is 1200 px and still appears on some marketing surfaces. Content centres with horizontal gutters of `{spacing.lg}` 24 px on desktop, `{spacing.md}` 16 px on mobile.
- **Column patterns**:
  - Three-feature row: 3-up at desktop, 1-up at mobile (rows like "Web Apps / Composable Commerce / Multi-tenant Platforms").
  - Tab pill row: 5-up centred row of `tab-ghost` pills.
  - Template-grid cluster: 5-up at desktop, scaling to 1-up at mobile.
  - Pricing tier grid: 3-up at desktop with the middle tier polarity-flipped.
  - Logo strip: ~5 logos wide, single row.

### Whitespace Philosophy
The mesh gradient does most of the heavy decorative lifting; whitespace separates the bands. Section spacing is generous — `{spacing.4xl}` to `{spacing.5xl}` between bands lets the gradient breathe. Inside a card, the headline/paragraph stack is tight (`{spacing.xs}` 8 px gap), then a wider gap before the CTA cluster. The page reads as engineered — large gaps + tight interior, never the other way around.

### Responsive Strategy

#### Breakpoints

| Name | Width | Key Changes |
|---|---|---|
| Mobile | < 600px | Hero stacks; nav collapses to hamburger; 3-up feature grids drop to 1-up; tab pill row enables horizontal scroll. |
| Tablet | 600–959px | 3-up grids drop to 2-up; nav still horizontal. |
| Desktop | 960–1199px | Full 3-up grids; pricing 3-up. |
| Wide | 1200–1399px | Container caps at 1400 px content width. |
| Ultra-wide | ≥ 1400px | Content stays centred at 1400 px; bands stretch edge-to-edge in colour but content holds the max-width. |

#### Touch Targets
The `button-primary` pill renders at ~32 px tall in nav and ~48 px tall in marketing contexts. Marketing CTAs comfortably meet WCAG AAA at all breakpoints; nav buttons inflate touch area through `{spacing.xs}` padding on mobile to meet the 44 × 44 px floor.

#### Collapsing Strategy
- **Nav**: full link row + Ask AI / Log In / Sign Up pills at desktop. Collapses to logo + hamburger at mobile with the menu opening as a full-overlay.
- **Hero**: mesh gradient stays centred; headline + body stack vertically at all breakpoints (the brand doesn't use a split-hero pattern).
- **Three-feature row**: 3-up → 2-up → 1-up at the breakpoints above; cards keep their `{rounded.md}` 8 px shape across all viewports.
- **Pricing card grid**: 3-up at desktop, vertical stack at mobile with `pricing-card-featured` always sitting in the middle.
- **Template grid**: 5-up → 3-up → 2-up → 1-up. Each `template-card` keeps its 16:9 aspect on the image.

#### Image Behavior
- **Mesh gradient**: rendered as inline SVG or canvas-painted gradient; scales fluidly with the hero container; never crops, never tiles.
- **Customer logos**: rendered as monochrome SVGs in the logo strip; consistent 24 px height.
- **Code editor mockup**: dark `{colors.primary}` rectangle with mono text rendered inside; treated as an image at the layout level.
- **Template thumbnails**: 16:9 landscape inside `{rounded.md}` card chrome; lazy-loaded; consistent grayscale palette in the placeholder state.

## Elevation & Depth

| Level | Treatment | Use |
|---|---|---|
| Level 0 — Flat | No shadow, no border. | Full-bleed hero bands and the polarity-flipped dark sections. |
| Level 1 — Inset Hairline | `0 0 0 1px #00000014` inset 1 px border. | Default card chrome — the brand's universal "you can see this card" cue. |
| Level 2 — Subtle Drop | `0px 1px 1px #00000005, 0px 2px 2px #0000000a` plus inset hairline. | Slightly elevated cards (template-grid, marketing-card). |
| Level 3 — Soft Stack | `0px 2px 2px #0000000a, 0px 8px 8px -8px #0000000a` plus inset hairline. | The "medium" elevation — feature-grid cards. |
| Level 4 — Float Stack | `0px 2px 2px #0000000a, 0px 8px 16px -4px #0000000a` plus inset hairline. | "Large" elevation — pricing cards, callout panels. |
| Level 5 — Modal | `0px 1px 1px #00000005, 0px 8px 16px -4px #0000000a, 0px 24px 32px -8px #0000000f` plus inset hairline. | Modal / dialog surfaces and dropdown menus. |

The brand uses STACKED shadows — multiple small offsets layered to fake natural light — never a single 8-px-blur generic drop. Inset hairline rings are always added so the card edge stays crisp.

### Decorative Depth
- **Mesh gradient as atmospheric depth**: the hero's multi-stop gradient is the brand's only "atmospheric" effect — applied as a flat 2-D backdrop rather than a 3-D illustration.
- **Polarity-flipped dark band as section-depth**: switching the surface from `{colors.canvas-soft}` to `{colors.primary}` (the deep ink) is the brand's chief depth cue between bands.
- **Inset-shadow + drop-shadow combo**: the cards' combination of an inset 1 px ring and a multi-stop drop produces a "card sits on the page" effect without ever feeling material-heavy.

## Shapes

### Border Radius Scale

| Token | Value | Use |
|---|---|---|
| `{rounded.none}` | 0px | Full-bleed hero / footer bands. |
| `{rounded.xs}` | 4px | Tightest inline pill — the `nav-cta-signup` 6-px-radius button (mapped to `xs/sm`). |
| `{rounded.sm}` | 6px | The brand's `--geist-radius` token — base UI radius for in-app buttons, form inputs, dropdown menus. |
| `{rounded.md}` | 8px | The brand's `--geist-marketing-radius` token — feature cards, template cards. |
| `{rounded.lg}` | 12px | Slightly larger card chrome (pricing-card variants). |
| `{rounded.xl}` | 16px | Largest card chrome — when a card hosts a hero image cap. |
| `{rounded.pill-sm}` | 64px | Tab-ghost pills inside the "AI Apps / Web Apps / Ecommerce / Marketing / Platforms" row. |
| `{rounded.pill}` | 100px | The marketing CTA pill — `button-primary`, `button-secondary`, "Start Deploying" pill. |
| `{rounded.full}` | 9999px | Icon-button circular containers, nav-link ghost pills. |

### Photography Geometry
- **Mesh gradient**: full-bleed 2-D atmospheric backdrop, never cropped to a frame; treated as the page's wallpaper.
- **Customer logos**: monochrome SVG, consistent 24 px height in a flex row.
- **Code editor mockup**: 16:10 dark rectangle, `{rounded.md}` corners.
- **Template thumbnails**: 16:9 landscape inside `{rounded.md}` chrome.
- **Showcase imagery**: 2:1 or 16:9 inside `{rounded.lg}` to `{rounded.xl}` chrome with a stacked shadow.

## Components

### Buttons

**`button-primary`** — the canonical 100-px-radius black pill, marketing scale.
- Background `{colors.primary}`, text `{colors.on-primary}`, label set in `{typography.button-lg}`, padding `0px {spacing.sm}` 12 px, shape `{rounded.pill}` 100 px. Renders ~48 px tall when paired with the marketing flex layout.

**`button-secondary`** — the white pill paired with the black primary inside marketing bands.
- Background `{colors.canvas}`, text `{colors.ink}`, same typography + padding as `button-primary`, shape `{rounded.pill}`.

**`button-primary-sm`** — the smaller-scale primary pill used inside nav and pricing-card CTAs.
- Background `{colors.primary}`, text `{colors.on-primary}`, label set in `{typography.button-md}` (14 px / 500), shape `{rounded.pill}`.

**`button-secondary-sm`** — the smaller-scale white pill paired with `button-primary-sm`.
- Background `{colors.canvas}`, text `{colors.ink}`, same typography + shape as `button-primary-sm`.

**`tab-ghost`** — the centred-row tab pill ("AI Apps / Web Apps / Ecommerce / Marketing / Platforms").
- Background `{colors.canvas}`, text `{colors.ink}`, label set in `{typography.body-sm}`, padding `0px {spacing.md}`, shape `{rounded.pill-sm}` 64 px.

**`icon-button-circular`** — the circular icon container (often a "?" or arrow inside).
- Background `{colors.canvas}`, dark icon, 1 px solid hairline border, shape `{rounded.full}`.

**Nav CTAs:**

**`nav-cta-signup`** — the small black "Sign Up" button in the nav row.
- Background `{colors.primary}`, text `{colors.on-primary}`, label `{typography.body-sm-strong}`, padding `0px {spacing.xs}`, height 28 px, shape `{rounded.sm}` 6 px (the brand's `--geist-radius`).

**`nav-cta-login`** — the white "Log In" button in the nav.
- Background `{colors.canvas}`, text `{colors.ink}`, same typography / height / shape as `nav-cta-signup`.

**`nav-cta-ask-ai`** — the small "Ask AI" button with a faint border.
- Background `{colors.canvas}`, text `{colors.ink}`, 1 px solid `{colors.hairline}` border (extracted as `0px solid rgb(235, 235, 235)`), same typography / height / shape.

### Cards & Containers

**`card-marketing`** — the canonical marketing feature card (3-up section cards).
- Background `{colors.canvas}`, text `{colors.ink}`, padding `{spacing.lg}` 24 px, shape `{rounded.md}` 8 px (the `--geist-marketing-radius`). Carries Level 3 soft-stack shadow.

**`card-marketing-large`** — the larger marketing card used for "compute model" / "AI Gateway" callouts.
- Background `{colors.canvas}`, text `{colors.ink}`, padding `{spacing.xl}`, shape `{rounded.lg}` 12 px. Carries Level 4 float-stack shadow.

**`card-soft`** — the soft-tinted card used inside cluster groups (lighter than canvas-soft).
- Background `{colors.canvas-soft}`, text `{colors.ink}`, padding `{spacing.lg}`, shape `{rounded.md}`.

**`template-card`** — the deploy-template card in the "Deploy your first app" grid.
- Background `{colors.canvas}`, text `{colors.ink}`, padding `{spacing.md}` 16 px, shape `{rounded.md}` 8 px. Hosts a 16:9 thumbnail at the top.

**`code-editor-mockup`** — the dark code-preview surface inside marketing bands.
- Background `{colors.primary}`, text `{colors.on-primary}`, body in `{typography.code}` (13 px / Geist Mono), padding `{spacing.lg}` 24 px, shape `{rounded.md}` 8 px.

**`pricing-card`** — the default pricing-tier card.
- Background `{colors.canvas}`, text `{colors.ink}`, padding `{spacing.xl}` 32 px, shape `{rounded.lg}` 12 px. Inside: tier name in `{typography.display-md}`, price in `{typography.display-xl}`, feature list in `{typography.body-md}` rows, CTA at the bottom.

**`pricing-card-featured`** — the polarity-flipped "Pro" tier card.
- Background `{colors.primary}`, text `{colors.on-primary}`, same shape + padding as `pricing-card`. CTA inverts to `button-secondary-sm` (white pill on black card).

### Inputs & Forms

**`form-input`** — the canonical text input.
- Background `{colors.canvas}`, text `{colors.ink}`, 1 px solid `{colors.hairline}` border, body in `{typography.body-sm}` (14 px), padding `0px {spacing.sm}`, height 40 px (the brand's `--geist-form-height`), shape `{rounded.sm}` 6 px.

**`form-input-sm`** — small-height variant (32 px tall) for tight forms.
- Same as `form-input` but height 32 px (the `--geist-form-small-height`).

**`form-input-lg`** — large-height variant (48 px tall) for hero CTAs.
- Same as `form-input` but height 48 px (the `--geist-form-large-height`); body in `{typography.body-md}` 16 px.

### Navigation

**`nav-bar`** — the sticky top nav.
- Background `{colors.canvas}`, text `{colors.ink}`, height 64 px (the brand's `--header-height`), padding `{spacing.sm} {spacing.lg}`. Layout: logo left, link row centre, "Ask AI / Log In / Sign Up" cluster right.

**`nav-link`** — the centred link row inside `nav-bar`.
- Text `{colors.body}`, set in `{typography.body-sm}`, padding `{spacing.xs} {spacing.sm}`, shape `{rounded.full}` (ghost pill — visible only on hover or active, but the radius is documented).

**`footer`** — the bottom 4-column nav.
- Background `{colors.canvas}`, text `{colors.body}`, padding `{spacing.4xl} {spacing.lg}`. Eyebrow column labels in `{typography.caption-mono}` (uppercase mono effect); link rows in `{typography.body-sm}`.

### Signature Components

**`hero-band`** — the white hero with the mesh gradient backdrop.
- Background `{colors.canvas}` (or `{colors.canvas-soft}` on some surfaces), text `{colors.ink}`, padding `{spacing.4xl} {spacing.lg}`. Inside: a small mono badge above the headline, the headline in `{typography.display-xl}` (sentence-case, period-terminated), a body lead in `{typography.body-lg}`, then a CTA row with `button-primary` + `button-secondary`. The mesh gradient sits behind, scaled to occupy roughly the top half of the band.

**`feature-mesh-band`** — the secondary section that hosts a mesh-gradient atmospheric backdrop with feature copy on top.
- Background `{colors.canvas}`, text `{colors.ink}`, padding `{spacing.5xl} {spacing.lg}`. Section headline in `{typography.display-lg}`; supporting body in `{typography.body-md}`.

**`showcase-band-light`** — a soft-canvas section ("Deploy your first app in seconds").
- Background `{colors.canvas-soft}`, text `{colors.ink}`, padding `{spacing.5xl} {spacing.lg}`.

**`showcase-band-dark`** — the polarity-flipped dark band ("A compute model for all workloads").
- Background `{colors.primary}`, text `{colors.on-primary}`, padding `{spacing.5xl} {spacing.lg}`. Section headline in `{typography.display-lg}` (white on black). Often contains a `code-editor-mockup` flush with the band.

**`logo-strip`** — the customer-logo wrapping row near the top of the page.
- Background `{colors.canvas}`, text `{colors.body}`, padding `{spacing.lg} {spacing.xl}`. Logos rendered as monochrome SVGs at consistent height.

**`badge-secondary`** — the small inline metadata pill ("New", "Beta", "Live").
- Background `{colors.canvas-soft}`, text `{colors.body}`, body in `{typography.caption}`, padding `0px {spacing.xs}`, shape `{rounded.full}`.

**`banner-marketing`** — the "Introducing X" announcement pill at the top of pages.
- Background `{colors.canvas-soft}`, text `{colors.body}`, body in `{typography.body-sm}`, padding `{spacing.xs} {spacing.sm}`, shape `{rounded.full}`.

**`link-inline`** — body-copy inline links.
- Text `{colors.link}` (`#0070f3`), body in `{typography.body-md}`, underlined.

### Examples (illustrative)

> Auto-derived kit-mirror demonstration surfaces (`scripts/derive-examples-block.mjs`). Each `ex-*` entry references brand-native primitives so downstream consumers (`/preview-design`, `/generate-kit`) re-skin the same 10 surfaces consistently. `TO_FILL` markers indicate missing primitives — resolve in the LLM judgment pass.

**`ex-pricing-tier`** — Default Pricing tier card. Re-uses feature-card chrome with brand canvas-soft surface.
- Properties: `backgroundColor`, `textColor`, `borderColor`, `rounded`, `padding`

**`ex-pricing-tier-featured`** — Featured/highlighted tier — polarity-flipped surface (dark fill + light text in light mode, light fill + dark text in dark mode).
- Properties: `backgroundColor`, `textColor`, `rounded`, `padding`

**`ex-product-selector`** — What's Included summary card — re-purposed for SaaS / B2B verticals (NOT a literal product gallery).
- Properties: `backgroundColor`, `rounded`, `padding`

**`ex-cart-drawer`** — Subscription summary — re-purposed for SaaS / B2B (line items per add-on, not literal cart).
- Properties: `backgroundColor`, `rounded`, `padding`, `item-divider`

**`ex-app-shell-row`** — Sidebar nav row inside the App Shell example. Active state uses brand primary as the indicator.
- Properties: `backgroundColor`, `activeIndicator`, `rounded`, `padding`

**`ex-data-table-cell`** — Default data-table th + td chrome. Header uses mono-caps eyebrow typography; body uses body-sm.
- Properties: `headerBackground`, `headerTypography`, `bodyTypography`, `cellPadding`, `rowBorder`

**`ex-auth-form-card`** — Sign-in / sign-up card. Re-uses feature-card chrome with text-input primitives inside.
- Properties: `backgroundColor`, `rounded`, `padding`

**`ex-modal-card`** — Modal dialog surface — same chrome as feature-card with elevated shadow.
- Properties: `backgroundColor`, `rounded`, `padding`

**`ex-empty-state-card`** — Empty-state illustration frame.
- Properties: `backgroundColor`, `rounded`, `padding`, `captionTypography`

**`ex-toast`** — Toast notification surface — feature-card shape + medium shadow.
- Properties: `backgroundColor`, `rounded`, `padding`, `typography`


## Do's and Don'ts

### Do
- Reserve `{colors.primary}` (`#171717`) for primary CTAs across the page. Black ink IS the conversion target.
- Use `{rounded.pill}` 100 px for every marketing-scale CTA and `{rounded.sm}` 6 px for nav-scale buttons. The two pill scales coexist deliberately.
- Set every headline in `{typography.display-*}` weight 600, sentence-case, often period-terminated. Aggressive negative tracking is part of the voice.
- Use the brand mesh gradient as atmospheric decoration at hero scale only — never miniaturise it to an icon, never reduce to a single colour.
- Layer stacked shadows (multiple small offsets with inset hairline) rather than single heavy drops. The brand's elevation is calmer than Material.
- Cycle page surfaces in `{colors.canvas-soft}` → `{colors.canvas}` → `{colors.primary}` polarity-flipped bands; the dark band IS the depth cue.
- Set every code block and technical eyebrow in `{typography.code}` / `{typography.caption-mono}`. Mono is the voice of the platform.

### Don't
- Don't introduce a sixth accent colour. The brand operates with ink + gray + the four-pair gradient palette; new accents flatten the voice.
- Don't render headlines in all-caps. Sentence-case + negative tracking is non-negotiable.
- Don't drop a single heavy drop-shadow on cards. The brand's elevation is built from stacked small offsets + inset hairline rings.
- Don't render the brand gradient at icon scale or in a single-colour reduced form. The gradient lives at hero scale only.
- Don't promote the geometric sans to weight 700. The brand's display ceiling is 600.
- Don't pair the marketing 100-px pill CTA shape with the 6-px nav radius on the same screen — pick a scale and stay there.
- Don't set body paragraphs in the mono face. The mono is for code + technical labels only.

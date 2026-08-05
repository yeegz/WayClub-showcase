# Accessibility by construction: a gate, not a checklist

WayClub targets **WCAG 2.2 AA** as a release requirement: critical-flow accessibility failures block release, on the same footing as the cross-tenant isolation tests. This document describes how that target is engineered rather than aspired to, drawing on the private repository's `packages/design-tokens` (JSON source, `build.mjs`, generated `dist/`), `docs/DESIGN_SYSTEM.md`, `docs/ANTI_SLOP.md` and `docs/ACCESSIBILITY.md`.

The assumption behind all of it: real users include low-vision and motor-impaired students and staff. An approvals platform a committee treasurer cannot operate by keyboard, or a colour-blind advisor cannot read statuses in, has failed at its actual job.

## Two registers, and which surface gets which is structural

**Campus Warmth** is for student-facing surfaces: home, discover, the calendar, event pages, club pages, the public club page. These are lit: a violet-black world with a violet radial from one corner and an emerald from the other, and a club's own colour carried in the ambient light rather than painted onto every surface.

**Calm Operations** is for reviews, oversight and administration, and it is **excluded from the atmosphere structurally rather than by convention**. A club room mounted anywhere inside one of those surfaces cannot tint it: the exclusion restates every themeable property at higher specificity, and the ambient layer vetoes itself when a Calm Operations marker is present anywhere in the document. A test named "Calm Operations never tints, structurally" pins all three parts of that. A dean processing twelve approvals gets a neutral, dense, fast screen.

## The token package

```text
packages/design-tokens/
  tokens/*.json            W3C Design Tokens source; the only place values change
  colour.mjs               OKLCH conversion, gamut mapping, contrast ratio
  theme.mjs                club theme, room and ambience derivation
  build.mjs                zero-dependency build plus the WCAG gate
  brand/                   the mark, the icon and the lockup
  dist/css/tokens.css      custom properties: light, dark, density, reduced motion
  dist/ts/tokens.ts        typed constants and helpers
  dist/dart/tokens.dart    constants for the planned mobile app
  dist/contrast-report.md  every checked pair with its computed ratio
  dist/palette-report.md   every generated palette step
```

Semantic tokens are the public API; palette primitives exist only for the semantic layer to reference. Product code that uses semantic tokens gets a correct light theme for free, because light is a first-class theme rather than an inversion.

**Palette values are generated, not chosen.** Each family is a recipe: a lightness ladder, a chroma curve, a hue, an optional hue shift and lift. The build materialises every step in OKLCH and gamut-maps into sRGB by lowering chroma at fixed lightness and hue, then writes the resolved hexes out. The ladder is anchored so the generator lands on the design owner's own values, and most of them land exactly.

The event lifecycle is the heart of the product, so its states have first-class chip tokens in both themes: draft, submitted, under review, revision requested, approved, rejected, live, completed, cancelled, expired. A state chip is always **colour plus label**, usually plus icon. Two states may share a hue because the label carries the meaning. No status anywhere in the product is conveyed by colour alone, and semantic colours never move for a club: a club cannot make "cancelled" look like "open".

## The contrast gate, with real numbers

Every colour pair the system ships is verified programmatically on every build, in both themes. The build refuses to produce output when a value fails, so there is no manual sign-off path around it and a pair not listed in the checker does not exist as far as the system is concerned. Adding a colour role means adding its pairs in the same change.

The current run prints:

```text
Contrast: 156 pair checks + 38 composited wash checks + 368 real-stack checks
  (lit page, card and glass over artwork) passed (light and dark).
  worst overall 3.31:1; worst text pair 4.61:1 (minimum 4.5:1).
Club accents: 11 probe colours validated, 7 accepted, 4 refused.
Club themes: 18 adversarial accents derived, 380 contrast checks passed,
  18 themeable properties (nothing outside the allow-list).
Club ambience: 18 adversarial accents lit a page, 280 contrast checks passed
  (every fixed ink, link, danger text, border and focus ring measured ON the lit canvas).
```

**562 checks per build**, and the interesting third of them is the last one. Checking a colour pair in isolation is easy and slightly dishonest, because nothing in this product sits on a flat surface: text sits on a card, which sits on a tinted wash, which sits on a page carrying two coloured glows and a rule grid. The real-stack pass composites that whole stack, each base gradient stop under each ambient glow at its own strength, with and without the grid, and measures the result. Glass is composited over **white artwork and over black**, because a photograph can be anything.

- Text pairs must meet 4.5:1; non-text UI such as the focus ring and input borders must meet 3:1. Disabled colours are exempt per WCAG, and disabled state is never communicated by colour alone.
- The worst overall figure, 3.31:1, is the focus ring and strong border on the lit page, against a 3:1 minimum for non-text.
- The worst text figure, 4.61:1, is warning-solid ink on warning solid in light mode, against 4.5:1.
- The full computed table is regenerated into `dist/contrast-report.md` on every build, so those numbers are reproducible artefacts rather than a designer's recollection.

**When a value fails, the value moves, never the gate.** Two of the design owner's own hexes were changed for exactly this reason: a muted label that measured 4.07:1 on his own card surface, and the top stop of the action gradient, on which a white arrow measured 2.40:1.

## Constrained club branding

Clubs want the product to feel theirs; accessibility law does not bend for brand colours. WayClub resolves the tension by construction rather than by review.

A club publishes an accent in its customisation studio, and the server derives the rest in OKLCH: canvas, inks, hairlines and action colour. The derived values, not the raw input, are what get injected, and the studio shows a live preview, a contrast readout and version history. What a club may change is a closed allow-list of eighteen properties, enforced in code; everything else, including every base colour role and every workflow state, is unreachable.

Ambience works the same way with a smaller surface. A club supplies **two hues and nothing else**; the strengths at which they are laid over the page belong to the platform, so no club can hand its page a brighter glow than the page next door, and the card's anatomy is never repainted.

**Accent validation is real rather than advisory.** Of eleven probe colours the build accepts seven and refuses four. A club submitting an unusable accent is told so, with a reading, rather than quietly given a page nobody can read.

The guard against a bright accent is a walk rather than a veto. The derivation composites the glow over the known canvas at descending strength scales and stops at the first rung where all seven fixed foregrounds still clear their minimum. The last rung is zero, so the walk always terminates on a compliant page: at worst the club loses its glow, never the reader their contrast ratio.

## Structural accessibility requirements

The requirements that shape the product rather than decorate it:

- **Keyboard-complete flows.** Every flow (create event, submit, review, approve, register, check in, hand over, read records) is operable with keyboard alone. Dialogs trap and restore focus; route changes move focus to the new page heading; destructive confirmations focus the safe action.
- **A focus ring that cannot be clipped.** 3px, offset 3px, implemented with `outline` rather than `box-shadow` so `overflow: hidden` cannot swallow it, and deliberately not club-overridable.
- **Live regions for async outcomes**: submission results, approval decisions, check-in confirmations and autosave state are announced, not just painted.
- **Reduced motion is honoured properly, which is subtler than it looks.** The generated CSS collapses every duration token, but a collapsed transition duration still lets a transform *land*, so the card's hover lift is removed outright rather than merely shortened, and the two-second ambient cross-fade is not registered at all. Motion only ever communicates a state change; nothing loops and nothing is ambient in the animation sense.
- **Blur is rationed.** Backdrop blur is permitted only on things floating over imagery, and the whole application contains four such declarations defining two classes, each used at exactly one site. A panel bearing body text never blurs, and every blurred element has an opaque fallback for browsers without support.
- **No tiny text.** Minimum body size is 14px; the single smaller style is an uppercase micro-label for short labels, never sentences. The scale is emitted in rem so browser text resizing works, and layouts must survive 200 percent zoom.
- **The accessible path is the primary path.** Check-in is manual lookup plus eight-character code entry, which a QR design would have required as a fallback anyway. Building the fallback first, as the main mechanism, means the accessible route got the engineering attention rather than the leftovers.
- **Component definition of done** includes every state: default, hover, focus, pressed, disabled with a non-colour cue, loading with no layout shift, validation error with a plain-language message linked to its field, empty, and permission denied as an honest state naming who to ask rather than a blank or a pretend-absence.

## A typography defect worth recording

The token stack has named Inter first since the beginning, and its subset woff2 files sat in the web app's public directory the whole time. No `@font-face` rule ever declared it, so the browser fell straight through to `system-ui` and **every screen in the product had quietly been rendering in the system face**. Nothing broke; nothing looked obviously wrong; a font stack that names a font is not the same as a font that loads.

It is declared now, split by unicode range, with the variable weight axis that makes the card title's 715 and the micro-label's 620 real rather than rounded to the nearest system weight.

## What is claimed and what is not

The structural requirements above are binding on the built web application, and the gate's numbers are reproducible on any build. **Not claimed, because no evidence is recorded**: automated accessibility scanning, a full manual screen-reader pass, and procurement conformance artefacts. There is no axe dependency anywhere in the repository. The gate, plus two Playwright specs that walk the reviewer and continuity screens for the skip link, focus visibility, keyboard reach, both themes and status-in-words, are the entirety of the automated accessibility coverage.

Worth adding in the same breath: because the pipeline's web job has never passed, the contrast gate has never actually run in continuous integration either. It runs locally on every build, and that is the honest scope of the claim.

# Accessibility and the design system: AA by construction

WayClub targets **WCAG 2.2 AA** as a release requirement: critical-flow accessibility failures block release, on the same footing as the cross-tenant isolation tests. This document describes how that target is engineered rather than aspired to, drawing on the private repository's `packages/design-tokens` (source, `build.mjs`, generated `dist/`), `docs/DESIGN_SYSTEM.md` and `docs/ACCESSIBILITY.md`.

The assumption behind all of it: real users include low-vision and motor-impaired students and staff. An approvals platform that a committee treasurer cannot operate by keyboard, or a colour-blind advisor cannot read statuses in, has failed at its actual job.

## The token system

The visual direction is "Calm Operations": a soft, slightly cool neutral palette where colour is information, appearing when something has a status, needs attention or is interactive. A scoped "Campus Warmth" amber is reserved for student-facing surfaces and never appears on admin chrome, reviewer queues or destructive actions.

The tokens are a small cross-platform package:

```text
packages/design-tokens/
  tokens/*.json            W3C Design Tokens source (the only place values change)
  build.mjs                zero-dependency build + WCAG contrast gate
  dist/css/tokens.css      CSS custom properties (light, dark, density, reduced motion)
  dist/ts/tokens.ts        typed constants + contrast and brand-derivation helpers
  dist/dart/tokens.dart    constants for the planned Flutter app
  dist/contrast-report.md  computed ratios for every checked pair, regenerated each build
```

Semantic tokens (`color.text.primary`, `color.bg.surface`, `color.state.approved.*`) are the public API; palette primitives exist only for the semantic layer to reference. Product code that uses semantic tokens gets a correct dark theme for free, because dark mode is a first-class theme rather than an inversion: fills flip strategy (buttons become lighter fills with near-black ink, tints become deep tints with light text), and all of that lives in the tokens, not in components.

The event lifecycle is the heart of the product, so its states have first-class chip tokens (`bg`, `fg`, `border`, both modes): draft, submitted, under review, revision requested, approved, rejected, live, completed, cancelled, expired. A state chip is always **colour plus label plus icon**; two states may share a hue because the label carries the meaning. No status anywhere in the product is conveyed by colour alone.

## The contrast gate, with real numbers

Every colour pair the system ships is verified programmatically on every build, in both light and dark modes:

- **54 pairs, 108 checks per build.** Text pairs (body, chips, buttons, statuses, links) must meet 4.5:1; non-text UI (focus ring, input borders) must meet 3:1. Disabled colours are exempt per WCAG, and disabled state must never be communicated by colour alone.
- **Current worst ratio: 3.79:1**, on a border pair whose minimum is 3:1 (`color.border.strong` on `color.bg.canvas`, light mode).
- **Every text pair sits at or above 4.97:1**, the tightest being the accent button ink in light mode and the danger button ink in dark mode, both at 4.97:1.
- The full computed table is regenerated into `dist/contrast-report.md` on every build, so the numbers above are reproducible artefacts, not a designer's recollection.
- If any pair drops below its minimum, the build exits non-zero and CI treats it as a failed build. **There is no manual sign-off path around the gate.** A pair not listed in the checker does not exist as far as the system is concerned, and adding a colour role requires adding its pairs in the same change.

## Constrained tenant branding

Institutions want the product to feel theirs; accessibility law does not bend for brand colours. WayClub resolves the tension by construction. A tenant may customise exactly three things: a logo, one brand colour and one accent colour. Everything else (text colours, backgrounds, statuses, workflow-state chips, the focus ring, typography, spacing, motion) is not overridable, because buttons consume brand values through `var(--wc-brand-*)` indirection and nothing else does.

When an administrator saves a brand colour, the server derives the applied set with `deriveBrandTokens(hex)`: in light mode the colour is darkened step by step until white text reaches 4.5:1, in dark mode lightened until near-black ink does, then hover, pressed and AA-safe subtle-tint values are derived from the compliant fill. The derived values, not the raw input, are what get injected, and the admin sees a preview explaining the adjustment. A tenant can submit pure yellow and still get compliant buttons. Workflow and status colours never change per tenant, so an approved chip means the same thing at every institution.

## Structural accessibility requirements

The requirements that shape the product rather than decorate it:

- **Keyboard-complete flows.** Every pilot flow (create event, submit, review, approve, register, check in, read records) is operable with keyboard alone. Dialogs trap and restore focus; route changes move focus to the new page heading; destructive confirmations focus the safe action.
- **A focus ring that cannot be clipped.** A 2px ring, offset 2px, implemented with `outline` rather than `box-shadow` so `overflow: hidden` cannot swallow it. The ring colour meets 6.3:1 on the light canvas and 8.3:1 on the dark canvas, and is deliberately not tenant-overridable.
- **Live regions for async outcomes**: submission results, approval decisions, check-in confirmations and autosave state are announced, not just painted.
- **Reduced motion is a token concern.** Under `prefers-reduced-motion: reduce`, the generated CSS collapses every duration token to 0.01ms and sets a `--wc-motion-reduced` flag that scripted animation must consult. Motion in WayClub only ever communicates state change; nothing loops, nothing is ambient.
- **No tiny text.** Minimum body size is 14px; the single 12px style is an uppercase micro-label for short labels, never sentences. The type scale is emitted in rem so browser text resizing works, and layouts must survive 200% zoom.
- **The accessible path is the primary path.** The web pilot's check-in is manual lookup plus 8-character code entry, which the QR design would have required as a fallback anyway. Building the fallback first, as the main mechanism, means the accessible route gets the engineering attention rather than the leftovers.
- **Density never eats touch targets.** A compact density exists for administrator tables, opt-in per container and pointer devices only; the 44px minimum touch target is invariant across densities.
- **Component definition of done** includes all states: default, hover, focus, pressed, disabled (with a non-colour cue and, preferably, an explanation), loading (no layout shift, `aria-busy`), validation error (icon plus plain-language message linked by `aria-describedby`), empty, permission denied (an honest state naming who to ask, never a blank or a pretend-absence), and offline where relevant.

## What is claimed and what is not

The structural requirements above are binding on the built web slice, and the token gate's numbers are verifiable in the private repo on any build. Automated axe checks in CI, the full manual screen-reader pass (VoiceOver and NVDA across the seven scripted journeys), and VPAT/ACR procurement artefacts are **planned, not claimed**; the build repo's convention is that conformance is only ever claimed alongside recorded evidence, and none is recorded yet for those items.

# Colour that comes from the content

Two problems sit on top of each other in a product like WayClub.

The first is that a club wants its space to feel like **its** space. A university has a hundred societies and each one has a colour it already puts on its posters and stitches on its jackets. A platform that paints all of them the same violet is a platform they will resent, and one that lets them paint anything is a platform somebody eventually cannot read.

The second is that a shared feed shows twenty clubs at once. If every card repainted itself in its owner's colours, a feed would be a rainbow, and "simple, not cluttered" is standing law for a product whose users are not technical.

This document is how both are answered, and how a third idea, letting an event page be lit by its own poster, was added without either of the first two giving way. It draws on the private repository's `packages/design-tokens/colour.mjs` and `theme.mjs`, `apps/api/src/clubs/theme.*`, `apps/api/src/media/dominant-colour.ts`, `apps/web/src/components/theme/`, and migrations `027`, `033` and `035`. The reasoning is ADR-0012.

## One hue in, a whole room out

A club publishes a single accent. Everything else is derived in OKLCH, which is the whole reason this is tractable: in OKLCH, lightness is perceptual, so "the same colour, one step lighter" means the same thing for a yellow as for a navy. In sRGB it does not, which is why hand-tuned brand ramps are hand-tuned.

From that one hue the engine derives the room: canvas, ink, secondary ink, hairlines, and the action colour, each landed on the rung that clears contrast on the surface it will actually sit on. Then a policy layer decides how far the room reaches.

- **Inside a club's own space**, its workspace, its events, its public page, the club's palette takes over. It should feel like that club's own product.
- **On a mixed surface**, home, discover, the calendar, the page stays WayClub's and the variety comes from **the artwork**, not from repainted chrome. Constant chrome, and every row carrying its own image.
- **Therefore the CSS-only hero fallback takes the club's accent hue.** A card with no poster is generated art rather than a grey box, and generating it at the club's hue is what lets a club's identity survive a shared feed without touching the page around it. A club with a red identity gets red-family fallback art.
- **Semantic colours never move.** Success, danger, warning and the lifecycle states keep their meanings in every club's space. A club cannot make "cancelled" look like "open".

What a club may change is a closed allow-list of eighteen properties, enforced in code rather than by review, and asserted by a test that fails if anything outside the list is ever emitted. The base colour roles are not on it: no club can reach `--wc-color-bg-canvas` or `--wc-color-text-primary`.

## The gate is a walk, not a veto

A club's accent is validated at the point it is published, and the validation is real: of eleven probe colours the build accepts seven and refuses four. A club submitting an unusable accent is told so, with a reading, rather than quietly given a page nobody can read.

Ambient light needs a softer instrument, because a glow is not a fill. The derivation composites the glow over the known canvas at descending strength scales, `[1, 0.85, 0.7, 0.55, 0.4, 0.25, 0.1, 0]`, and stops at the first rung where **all seven fixed foregrounds still clear their minimum**: primary, secondary and muted ink, links and danger text at 4.5:1, the strong border and the focus ring at 3:1.

The last rung is zero, so the walk always terminates on a compliant page. At worst a club loses its glow. It never costs a reader their contrast ratio, and it never costs the club an error message for something it did not do wrong.

Eighteen deliberately adversarial accents are pushed through both paths on every build: 380 checks for the derived themes and 280 for the lit pages, measuring every fixed ink, link, danger text, border and focus ring **on the lit canvas** rather than on the flat one. That distinction is the point. A colour pair checked in isolation is easy and slightly dishonest, because nothing here sits on a flat surface.

## An image reports the colour it is actually about

The second mechanism is newer and more fun. Every uploaded image is measured, and an event page is lit by its own poster.

**It is not an average, and it is not the most frequent colour.** An average of a poster is mud. The most frequent colour of a poster with a white border is white. What the product wants is the colour a person would *name* if you asked them what colour the poster is, and that is closer to the most **chromatic** region than to either.

So the measurement is a chroma-weighted hue histogram, in OKLCH:

1. Resize to at most 64 by 64. This is a colour question, not a detail question.
2. Convert every sufficiently opaque pixel to OKLCH and let it vote for one of 36 ten-degree hue bins, **weighted by chroma squared**.
3. Take the heaviest bin plus its two neighbours, and answer with the chroma-weighted mean lightness and chroma of the pixels in that window, gamut-mapped back to a hex value.

The chroma-squared weighting is the load-bearing choice: it is what lets a small saturated logo beat the large white field it sits on. A violet disc covering six percent of a white square reports violet, and a test says so.

Three guards keep it honest, and all three answer with **nothing** rather than with a guess:

- a minimum share of opaque pixels, so a nearly transparent image reports nothing;
- a minimum hue coverage of two percent, so a hue carried by a handful of pixels cannot win;
- a minimum chroma, checked on the **stored value after rounding** rather than on the measured one, so a near-grey reports nothing rather than a colour that only exists at full precision.

The column is nullable on purpose and the schema constrains the colour and its hue to be null or non-null **together**. A monochrome photograph stores nothing, and a page with nothing stored simply keeps the club's own light. There is exactly one implementation of the measurement, loaded directly by the API, the seed and a backfill script, so the number in the database can never come from a second, drifted copy.

The colour is measured from the smallest rendition the product generates, not from the original upload, which means it is measured from the cropped, oriented, metadata-stripped bytes a reader actually sees.

## Measured live, on the running product

Two events belonging to the **same club**, with the same accent and therefore the same action colour, differing only in their poster:

| Event | Stored poster colour | Derived light, dark mode | Derived light, light mode |
|---|---|---|---|
| Open Day: Capture the Flag Taster | `#6A4AA9` = rgb(106, 74, 169) | `rgb(98, 50, 172)` | `rgb(191, 169, 250)` |
| Blue Team Bootcamp | `#35857F` = rgb(53, 133, 127) | `rgb(20, 98, 93)` | `rgb(62, 209, 200)` |

The stored values were read from the database and confirmed through the API; the derived values were read from the browser's own computed styles. The derivation is a real step, not a pass-through: a poster's colour is pushed to whichever lightness works as *light in a room* on the theme in play, which is why the dark and light columns differ so much.

## The accent and the light are deliberately separate

An event page carries both, and they come from different places on purpose.

- The **accent**, which becomes the action colour, comes from the club's published accent and never from the poster.
- The **light** comes from the poster, falling back to the club's accent, falling back to WayClub's own violet by simply emitting no rule at all.

An action colour is an identity, and an identity that changed hue whenever somebody uploaded a picture would not be one. So on a Cybersecurity Club event page you get the club's teal button under a violet poster's light, and that is correct rather than a clash: the room is about this event, the button is about this club.

Neither mechanism touches anatomy. Canvas, surface, ink family and hairlines are emitted by neither, and a test asserts that the four most important of those custom properties never appear in the generated rules. The lit layer itself is a fixed, decorative, non-interactive element behind everything, hidden from assistive technology, and it carries no blur, so nothing repaints during a scroll.

And both are vetoed outright when a Calm Operations surface is anywhere in the document. A dean's approval queue does not acquire a mood because an event with a purple poster happens to be on the screen.

## What this costs, honestly

Three things are worth saying plainly.

**The seed does not exercise the null path.** All thirteen seeded posters happen to report a colour, so the "image with nothing to say" behaviour is covered by unit tests with painted fixtures rather than by anything a person would see in the demo data.

**A club logo's colour is a third use of the same column.** Generated card art takes its hue from the club's *logo*, not from the club's accent and not from the event's poster. Three distinct uses of one mechanism is one more than is obvious from the outside, and it is exactly the kind of thing that drifts if it is not written down.

**None of this has been seen by a real student in a pilot yet.** It is measured, gated, tested and now deployed, but still not validated by real-world usage or a recorded accessibility review.

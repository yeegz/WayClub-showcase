# Boundaries and privacy: what WayClub refuses to build or keep

Some of the most consequential decisions in WayClub are refusals. Members trust a group tool with their name, their attendance and the clubs they belong to, and that trust depends on what the tool could do to them as much as on what it does for them. The refusals are recorded as permanent rejected scope in the private repository's `CLAUDE.md` and `docs/PRIVACY.md`, and several of them are enforced in the schema rather than promised in prose.

The rule of thumb is short: **if mishandling the data could seriously harm a person, WayClub does not store it.** It links to the specialist system that should hold it instead.

## Never built

WayClub will not build predictive retention or wellbeing analytics, rankings or leaderboards, a social feed, or an internal chat that tries to replace WhatsApp, Teams or Discord. It will not do formal accounting, payroll or tax; academic grades, tuition or class attendance; or medical, counselling, welfare or disciplinary case management. It will not run high-stakes voting on cryptography of its own, take attendance by biometrics, or enforce anything through device fingerprints or IMEI numbers. A design editor, a heavy CRM, premature microservices and an external workflow engine are out as well.

## Never stored

Grades, tuition or fee records, disciplinary cases, medical or welfare data, learning materials, passwords for other systems, biometric data, device fingerprints and raw payment card data are never stored. A profile is a display name, optional given and family names, an optional avatar, a locale and a time zone, with the email address held separately in WayClub's own sign-in store. An attendance row records who, which event, when, by what method and who checked them in. There is no latitude, longitude or geofence column in any migration.

## No scores on people

Engagement data describes how a club is running (events, approvals waiting, work overdue), never a score attached to a person. Oversight in an institution workspace shows what is blocked and who is waiting on whom; it never ranks clubs against each other, and `apps/api/test/40-oversight.spec.ts` carries a block named "no ranking, ever".

The "For you" order on What's on is the one place WayClub suggests anything, and it is fenced tightly (`apps/api/src/events/recommend.ts`, with the rules in `docs/PRIVACY.md`). It reads only the person's own registrations, check-ins and saves in the workspace they are signed into, plus facts every eligible member can already see. It is computed per request and never stored as a profile, nothing is learned across people, every suggestion states its reason in plain words, a going count is only ever a reason from five people up (`SOCIAL_PROOF_MIN = 5`), and anyone can switch What's on back to plain date order.

## Interest is private

A member can save an event without committing to go. The obvious next feature, "12 people saved this", does not exist and cannot be switched on by loosening a setting. Migration 034 gives the save table exactly one read policy and it ends in `user_id = wayclub_auth.uid()`, so the organising committee, a reviewer and an administrator all cannot see who saved their event. A save writes no audit row either, because the audit log is readable by administrators and would hand back what the policy refuses. Registrations are different on purpose: a club running an event has to know who is coming, but not who is thinking about it.

## Names and faces only by choice

Two decisions were settled on 20 October 2026, and both are designed but **not yet built**:

- **Named attendees are opt-in only.** A member chooses to be listed. Only people who share a club with the viewer appear, only once five are going, the organiser can hide the list, and names never appear on public pages or share images.
- **Organiser faces are opt-in and shown to signed-in people only.** A club setting chooses who may be shown, each person opts in, and faces never appear on the public club page or in link previews.

Until each lands, with its own migration and contract entry, an event page names nobody else: other people appear only as a count.

## No device fingerprinting

WayClub does not identify devices. The Flutter app labels a signed-in phone session by platform alone (`apps/mobile/lib/src/config.dart`), so a person can see and end their own sessions without WayClub learning anything about the handset. Check-in uses a registration-scoped code, a QR code or an organiser's confirmation, never a biometric. The trust and safety design written for launch keeps that line: defences against spam and duplicate accounts rest on verified email addresses, per-address and per-network rate limits and a challenge on sign-up, and explicitly exclude IMEI, device identifiers and browser fingerprints. That design is planned, not shipped.

## No money moves through WayClub

An event can carry an entry fee, because a club needs to say what something costs. The fee tile reads, verbatim: "Collected by {club}, not by WayClub." (`apps/web/src/components/events/fact-tiles.tsx`). Ticket payments are out of scope, and fees stay between the member and the club. A paid Pro plan, which clubs and communities would buy through Stripe, is planned and not built.

The schema is broader than the product here, and that is said rather than hidden. Budget lines, purchase requests, reimbursements and transaction records exist as tables with row-level security on, no policies and no grants, so nothing can reach them. They are shape, not features.

Leadership handover follows the same instinct. It records who controls a club's external accounts and how to ask for access, and never a credential: `apps/api/test/14-continuity-security.spec.ts` asserts that no handover table has a credential-shaped column and that a request carrying one is refused on every write route.

## No feed, no chat

Messaging apps are where groups already talk, and WayClub links into them rather than competing. Replacing chat would also pull message content into the data WayClub holds. The closest thing to a feed is an event's photo gallery (migration 033): people who were there add photographs once the event is live, the committee can feature or remove one with a recorded reason, and a photo is exactly as visible as its event. It has no likes, no comments and no followers.

## No AI in any decision

There is no AI code in the repository today, and the feature-flag table that would gate it is one of the unreachable tables above. The boundary is written down now, while it is easy: any future assistance is permission-scoped, cites its sources and is confirmed by a person. AI never approves, rejects or ranks, and the workflow engine has no automatic approval edge for anything to occupy.

## The legal frame, stated carefully

The privacy posture is written against Malaysia's Personal Data Protection Act 2010 as amended in 2024, which makes biometric data sensitive, sets a 72-hour breach notification to the Commissioner and adds a right to data portability. It is an engineering posture, not legal advice, and the codebase is never presented as a certificate of compliance. The launch plan keeps the database in Singapore so that data stays in the region.

## What a person can do today, and what waits

Built and tested locally: involvement records that are private by default, visibility that follows each person's role in each club, saves that only their owner can read, and a download of a person's own verified record of what they took part in (`GET /v0/me/records/export`).

Not built yet, and part of the launch plan rather than the product: deleting your own account (the decided rule is a 30-day grace period, then anonymisation), a full download of every personal table, a privacy notice, registration by guests without an account, billing, Wallet passes and the iOS Live Activity. WayClub is built and tested on a local machine and is not yet open to the public.

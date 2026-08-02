# Product boundaries: what WayClub refuses to build

The most consequential engineering decisions in WayClub are refusals. They are recorded as permanent rejected scope in the private repository (`CLAUDE.md`, `docs/PRODUCT.md`, `docs/PRIVACY.md`, the research synthesis), and they are load-bearing: the trust of students, advisors and administrators in an approvals platform depends on what it could do to them, not only on what it does for them.

The governing rule of thumb: **if mishandling the data could seriously harm a student, WayClub does not store it.** Integrate the specialist system of record instead.

## No predictive analytics on students

WayClub will not build predictive retention or wellbeing analytics, in any foreseeable roadmap. The learning-analytics literature documents the failure modes: false positives and negatives, bias, surveillance creep, sensitive inference, stigmatisation, and the backlash that has ended entire products over sharing student data with vendors. Engagement data in WayClub is descriptive and operational (active clubs, event volume, approval bottlenecks, SLA breaches), never a score attached to an individual student.

The analytics that do exist are fenced accordingly: role-scoped funnels and counts, aggregates that suppress cells below a minimum size (5 to 10) before display, interpretation guidance attached to metrics to prevent misleading cross-club comparisons, and a hard never-collect list: keystroke-level tracking, message content, precise location beyond the needs of an event check-in, or anything enabling individual behavioural profiling. The analytics adapter is designed so prohibited fields cannot be emitted, which is a schema property rather than a policy promise.

## No rankings, no leaderboards

Student involvement records are verified, private by default, and published only by the student's choice. They never feed rankings, discipline or admissions. Leaderboards are rejected outright: they convert participation into competition, invite gaming, and turn a record system into a judgement system. The related design decision runs deeper: records are issued by authorised organisers and advisors, not self-asserted, so the thing a student can eventually export is worth exporting, without anyone being scored against anyone else.

## No internal chat

WhatsApp is where Malaysian student life already happens, and the research is unambiguous that an in-app chat replacing it would be both unwanted and unused. WayClub treats messaging apps as a first-class notification and light-action channel to integrate with, not a competitor to displace. The product's job is to be the system of record that the WhatsApp conversation links to, so that approvals stop living in screenshots. Building chat would also drag message content into the data WayClub holds, which the privacy posture is designed to avoid.

## No accounting, no grades, no case files

WayClub tracks operational event budgets (estimates, approvals against thresholds) because approval routing needs them. It excludes formal accounting, payroll and tax outright: high liability, specialist systems exist, and "club operations tool" must not creep into "university ERP". The same fence excludes academic grades, tuition and class attendance (student-information-system territory), learning materials (LMS territory), and disciplinary, medical, counselling and welfare case management (specialist case systems). The never-store list also covers institutional passwords, raw payment-card data (hosted payment flows only, in a later phase) and biometric data.

## No biometrics, no device fingerprinting, PDPA-first

Privacy in WayClub is an architectural input, not a compliance afterthought, and the Malaysian Personal Data Protection (Amendment) Act 2024 materially shaped the design:

- **Biometric data is now sensitive personal data** under the amended Act. WayClub goes further than compliance: no biometric attendance, ever, and no IMEI or device-fingerprint enforcement. Attendance is registration-scoped tokens, codes and organiser confirmation.
- **72-hour breach notification** to the Commissioner is treated as a hard clock in the incident-response runbook.
- **Mandatory Data Protection Officer** appointment and processor agreements are tracked as legal-review gates before any real-data pilot; the codebase is never presented as legal compliance certification.
- **Data portability** is engineered in: students can export their own records, and the tenant exit plan guarantees documented institutional export, so a university can leave cleanly. A platform that governs approvals should itself be easy to hold to account.
- **Data minimisation** is the collection default: a profile is a display name, a university email and an institution. Attendance records capture who, which event, when and by what method, with no precise location (an optional, coarse, event-scoped geofence for check-in is the ceiling, off by default). Risk questionnaires collect event facts, not personal characteristics. Nothing infers race, religion, health or politics from behaviour.

## No AI in the decision path

AI features sit in later, experimental phases, and their boundary is fixed now: assistive, permission-scoped, source-citing and human-confirmed. AI never approves, rejects, ranks or makes an official decision. Official decisions in WayClub are made by humans, online, always; the workflow engine has no auto-approve edge for a model to occupy, and SLA escalation deliberately pressures humans rather than replacing them.

## Boundaries that are engineering choices, too

Two further refusals are about scope honesty rather than data ethics, and they shaped the architecture documents:

- **No external workflow engine and no premature microservices.** Approval workflows measured in days are rows and transactions, not a distributed-systems problem. The modular monolith with in-process module boundaries keeps the option to split later without paying the operational cost now.
- **No fake-success states, anywhere.** Integrations that are not truthfully connected run as local mock providers that record payloads and label themselves as sandboxes in the UI. A feature is not done if any of its states lies: loading, empty, error and permission-denied states are part of the definition of done, and a permission-denied state must say so honestly rather than pretending the feature does not exist.

The pattern across all of these: WayClub's product surface is deliberately smaller than its schema, its schema is deliberately smaller than its market ambitions, and the gap is documented rather than papered over. Scope discipline is what makes the trust claims in the rest of this showcase possible.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/yeegz/WayClub-showcase/main/assets/brand/lockup-paper.svg">
    <img src="https://raw.githubusercontent.com/yeegz/WayClub-showcase/main/assets/brand/lockup-ink.svg" alt="WayClub" width="220">
  </picture>
</p>

<p align="center">Group management for teams, clubs and communities.</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/yeegz/WayClub-showcase/main/assets/screens/whats-on-dark.webp">
  <img src="https://raw.githubusercontent.com/yeegz/WayClub-showcase/main/assets/screens/whats-on-light.webp" alt="What's on: the posters from the clubs someone belongs to, on a laptop and on a phone">
</picture>

A club runs on a few people giving up their evenings. WayClub gives them one place for meetings, tasks and events, and gives everyone else one place to find what is on and say they are coming. When the committee changes, the next one inherits all of it.

This repository is the public showcase. The code is private; everything here, numbers included, is read from it. [The showcase site](https://yousofselim.com/WayClub-showcase/) tells the same story with more room.

## A year in a club

### Find what's on

Members see the posters from the clubs they belong to. The poster leads: its colour carries into the page, and the words around it say only what helps you decide (when, where, who is running it, and whether there is room).

### Say you're coming

<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/yeegz/WayClub-showcase/main/assets/screens/event-dark.webp">
    <img src="https://raw.githubusercontent.com/yeegz/WayClub-showcase/main/assets/screens/event-light.webp" alt="An event page on a phone: the poster, the time and place, and one Register button" width="49%">
  </picture>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/yeegz/WayClub-showcase/main/assets/screens/plans-dark.webp">
    <img src="https://raw.githubusercontent.com/yeegz/WayClub-showcase/main/assets/screens/plans-light.webp" alt="Your plans on a phone: the events you are going to, each with its door code" width="49%">
  </picture>
</p>

One button to register, and a door code that is there when you arrive. Your plans keeps everything you said yes to in one list, so nobody has to scroll a group chat for the address.

### Run the committee

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/yeegz/WayClub-showcase/main/assets/screens/workspace-dark.webp">
  <img src="https://raw.githubusercontent.com/yeegz/WayClub-showcase/main/assets/screens/workspace-light.webp" alt="The committee workspace: what is on now, what is waiting on you, what is due this week, and every event by stage">
</picture>

The workspace opens on the questions a committee actually asks: what is happening now, what is waiting on me, what is due this week. Events move through being planned, waiting for a yes, published and done.

### Meet, decide, follow up

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/yeegz/WayClub-showcase/main/assets/screens/meeting-dark.webp">
  <img src="https://raw.githubusercontent.com/yeegz/WayClub-showcase/main/assets/screens/meeting-light.webp" alt="A meeting: the agenda, the minutes, and the tasks that came out of it">
</picture>

A meeting has an agenda before it and minutes after it. Tasks come out of the minutes with a person and a date attached, and once the minutes are confirmed they stop changing.

### Hand it over

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/yeegz/WayClub-showcase/main/assets/screens/handover-dark.webp">
  <img src="https://raw.githubusercontent.com/yeegz/WayClub-showcase/main/assets/screens/handover-light.webp" alt="A handover: the accounts, files and equipment the outgoing committee passes on, each one checked">
</picture>

Most clubs lose something every year: the Instagram password, the shared drive, the projector. A handover lists what the outgoing committee passes on and checks each item off with the person receiving it, so next year starts where this one ended.

## How it is built

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/yeegz/WayClub-showcase/main/assets/diagram/architecture-dark.svg">
  <img src="https://raw.githubusercontent.com/yeegz/WayClub-showcase/main/assets/diagram/architecture-light.svg" alt="The web and the phone app call one API, which runs every request as a database role bound by row-level security in Postgres, and reaches email, calendar, files and billing through adapters">
</picture>

- **The database enforces tenancy.** Every request runs as a role that row-level security always binds. A forgotten check in the API returns nothing rather than someone else's data, and a read across accounts gets the same 404 as a record that does not exist.
- **One record per event.** The proposal, any approval, registrations, attendance and the report all attach to the same row. Nothing is typed in twice.
- **Approvals are rows, not a service.** Where a club works under an institution, its events go through a versioned state machine stored in Postgres. A running approval keeps the version it started on.
- **Adapters tell the truth.** Email, calendar, files and billing each have a sandbox that records what it would have sent and says so. Nothing pretends to succeed.

| Measured on 20 October 2026 | |
| --- | --- |
| Database migrations | 57 |
| Tables under row-level security | 94 of 96 (the other two: a role lookup and the migration ledger) |
| Row-level security policies | 218 |
| API operations | 154 |

## Where it stands

WayClub is built and tested on my machine and is **not open to the public yet**. It launches first for independent clubs and communities in Malaysia, hosted in Singapore.

Built: the member side (What's on, events, Your plans, clubs), the committee workspace (events, meetings and minutes, tasks, handover), institution approvals, and a Flutter app for iOS and Android with the member side and a committee subset.

In progress: hosting and release plumbing, sign-up email and reminders, account deletion, a Pro plan through Stripe, and a final design pass on every screen.

Planned after that: registering for an event without an account, Google Calendar sync, Apple and Google Wallet passes, and an iOS Live Activity on the day.

## Deep dives

- [Tenancy: the account is the boundary](docs/01-tenancy.md)
- [The workflow engine](docs/02-workflow-engine.md)
- [An audit log that forked under load](docs/03-audit-log.md)
- [What WayClub will not build or store](docs/04-boundaries-and-privacy.md)

## About

Designed and built by [Yousof Selim](https://yousofselim.com). The text and images in this repository are MIT licensed; the WayClub source code is private. The clubs, people and posters in the screenshots are fictional demo data.

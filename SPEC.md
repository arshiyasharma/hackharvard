# Elves: product and build spec

**Elves is a moving crew you text.** You text one number on iMessage or SMS, and a crew of AI agents ("Elves") runs your move. They sell the furniture, book the truck and storage, find you a sublet, deal with the lease, settle the money, and keep your stuff out of the landfill. There is no app to open. Every moving chore already ends in a text thread, so the crew works there too.

> Moving is 15 chores and every one of them ends in a text message. Elves is the crew that answers them.

This file is the single starting point for anyone joining. It sums up the plan and every decision taken so far. The longer source documents are in `docs/`:

| Doc | What it is |
| --- | --- |
| [`docs/design-doc.md`](docs/design-doc.md) | Original product design doc: the journey, the Deal Engine, mini apps, Photon, voice, Nessie, sustainability, the demo script, risks |
| [`docs/implementation-plan.md`](docs/implementation-plan.md) | Original implementation plan: the W1–W23 work queue, phases 1–6 with acceptance tests, setup checklist, decisions |
| [`docs/elves-spec.md`](docs/elves-spec.md) | Detailed spec sheet for the **five** Elves (current), including Room Scan |
| [`README.md`](README.md) | Engineering map: how to run it, env vars, memory, housing search, the Photon usage map, deploy |

When the docs disagree, this file wins, then `docs/elves-spec.md`, then the two original docs. The originals were written before several decisions changed (see [Decisions](#decisions-that-changed-the-original-plan)).

---

## 1. Context

- **Event:** HackHarvard 2026, Oct 16–18, Cambridge MA. Judging is Sunday 9 AM–12 PM.
- **Hook:** the venue is in Allston, where about two-thirds of Boston leases turn over on Sept 1. The city hauls away tons of abandoned furniture that week ("Allston Christmas"): 38 extra tons and 1,700 mattresses in one week of 2023. The FTC logged about 65k rental-scam reports from 2020 to mid-2025, mostly aimed at young adults.
- **What we're entering:**
  - Photon 2.0 "Build a Messaging Agent" (main)
  - Sustainability track (headline)
  - Best Use of Nessie (Capital One)
  - Fintech-CyberSec (secondary)
  - Daytona and Chalk (fits)
  - ASUS content challenge
- **What we optimize for, in order:**
  1. A stranger can use it from their own phone with no instructions.
  2. Depth and correctness of Photon usage.
  3. A real sustainability number.
  4. Coverage of the whole move.

**Definition of done (product):** someone who has never seen Elves texts the number and runs a whole move: sell, store, haul, sublet, move in. They end with a Move Report whose numbers can be rebuilt from the event log, and a Ledger that balances to the cent.

**Definition of done (demo):** a judge texts the number from their own phone and watches three Elves finish real work within 90 seconds. See [The demo](#7-the-demo).

---

## 2. The five Elves

The design doc had ten Elves, one per Photon line. We **folded them into five** to make the product easier to use. All five share one number. The Crew Lead runs the chat and hands work to four specialists, and each specialist has a few sub-skills. The full behavior spec is in [`docs/elves-spec.md`](docs/elves-spec.md).

| Elf | ID | Owns | Sub-skills | Status on this branch |
| --- | --- | --- | --- | --- |
| **Crew Lead** | `crew_lead` | The chat, the plan, dates, addresses, roommates, hand-offs, approvals, Crew Board link | Intake, plan, approvals | **Built.** Claude-written replies; facts and items extracted from text and photos |
| **Stuff Elf** | `stuff` | Everything the owner owns or wants | Sell, Buy, Donate / Last Call | **Sell built:** photo → vision → item, price range, floor, list price, "yes, list it" approval. Buy and Donate are keyword stubs |
| **Money Elf** | `money` | Every dollar that moves | Escrow, Ledger, splits, scam check. **Nessie is the ledger** | Stub (fixed reply and board update) |
| **Move-day Elf** | `moveday` | Getting the stuff from A to B | Room Scan (new), Haul quotes, Move Map. **Takes over after the Home Elf has planned everything**, then runs move day | Stub. Room Scan is specced but not built |
| **Home Elf** | `home` | The place you leave, the place you go, the gap between | Lease, Hunt, Move-in week | **Hunt built:** a real-browser housing search (Craigslist, Airbnb, Booking.com, SpareFoot; Apartments.com, Zillow and FB Marketplace behind flags), scam flags, ranking, top three by text. Lease and Move-in are stubs |

**Money Elf: Nessie is the ledger.** Every dollar in the move is recorded in Nessie (Capital One's API): sale proceeds, escrow holds and releases, the U-Haul and storage purchases, and roommate splits. The Ledger the owner sees is built from those Nessie transactions. See [Money](#4-money-scam-shield-sustainability).

**Move-day Elf: works after the Home Elf.** The Home Elf settles where the owner is going and when: lease end, move-in date, the gap between, and whether storage is needed. Only then does the Move-day Elf plan and run move day:

1. **Room Scan** (new). The owner texts 1–6 photos of a room. The Elf lists every item and the loose stuff to box, counts boxes by type, and adds up cubic feet and pounds. Items the Stuff Elf is selling before move day are left out of the load. The tables are in the spec sheet.
2. **Finding the right U-Haul.** From the Room Scan estimate, it picks the vehicle using U-Haul's published specs: cargo van or 10', 15', 20' or 26' truck, with usable cubic feet, load limit and deck height. It also lists the number and sizes of boxes to buy, plus extras like a furniture dolly, appliance dolly, furniture pads and a mattress bag. It **asks for the cost and confirms with the owner** before booking anything. The cost then goes to the Money Elf.
3. **Move Map and route planning.** It plans the route and order of stops: buyer pickups first, then loading, then storage, then the new place. It warns about low-clearance roads like Storrow and Memorial Drive, and shares a live map and ETAs with everyone who opts in.
4. **Return time.** The whole plan is built around **when the U-Haul has to be returned** (and to which location). It schedules the stops so the truck makes it back on time, and warns the owner if the plan would run late, which means late fees or an extra day.

**How a message finds its Elf** (`packages/elves/src/router.ts`). The first rule that matches wins:

1. First contact goes to the Crew Lead.
2. A reply inside an Elf's thread goes to that Elf.
3. A photo goes to the Stuff Elf, or to Room Scan when the room rule matches (planned).
4. A message that is just a price goes to the Stuff Elf.
5. Claude Haiku classifies the message against each Elf's description, if it is at least 0.5 confident.
6. Keyword scores decide. Ties go to the earlier Elf: Crew Lead, Stuff, Money, Move-day, Home.
7. Anything left goes to the Crew Lead.

**The Elf contract.** Every Elf is `handle(ctx) → { replies, boardPatch, events, movePatch }`. Elves never touch the transport. The service applies the patch, appends the events, and sends the replies as the agent identity the human texted.

**Rules every Elf follows:**

- Replies are plain text, 2–4 short lines, at most one emoji.
- Each reply asks for at most one thing.
- Anything that spends, sends, posts, books or signs needs the owner's explicit yes for that specific action.
- Prices are never agreed below the floor or above the ceiling. The engine enforces this in code, not in the prompt.

---

## 3. The Deal Engine (in progress, not on this branch)

Every moving chore is the same loop: list → negotiate → schedule → hand off → settle. So we build the loop **once** and run it in four modes. This is the technical story for judges: one parameterized engine, not seven bots.

| Mode | What is listed | Who texts in | The floor (or ceiling) | Hand-off evidence |
| --- | --- | --- | --- | --- |
| Sell item | A piece of furniture | Buyers | Minimum price, pickup window | Buyer confirms in their DM + owner 👍 (or Map convergence) |
| Buy item | A listing the owner forwards | Sellers | Maximum price, delivery radius | Seller confirms, owner 👍 |
| Sublet out | The owner's room | Applicants | Minimum rent, dates, house rules | Agreement accepted by both (poll), keys handed over |
| Find sublet | The owner's requirements | Listers | Maximum rent, dates, neighborhoods | Lease terms reviewed; deposit only through escrow |

**Rules in every mode:**

1. Each counterparty gets their own space. The owner chat only sees threaded summaries.
2. Never agree below the floor or above the ceiling. Ask the owner in-thread instead.
3. Offer at most three slots, and book on the first confirmation.
4. Money only moves through Nessie escrow. A request to pay any other way trips Scam Shield.
5. Every item ends with an outcome: `sold`, `given`, `donated` or `dumped`.

**Deal states:** `listed → negotiating → scheduled → handed_off → paid`. A deal can also end as `relisted`, `donated` or `dumped`. A buyer who walks away returns the item to the queue. A no-show gets one reschedule.

**Last Call** (the Allston Christmas feature) runs on items still unsold close to move-out:

| When | What happens |
| --- | --- |
| T−48h | Price drops to 60% of list |
| T−24h | Item is relisted free, and a donation or 311 bulk pickup is booked |
| T−0 | Anything without a pickup is tagged `dumped`, so the report stays honest |

**Decision: Mastra Workflows run the Deal Engine and Last Call.** Each deal gets one durable workflow run, and each move gets one Last Call run. A run persists in Postgres, so a deal waiting on a buyer, an owner decision or a hand-off survives a redeploy. Business rules stay as pure functions in `policy.ts`, tested with fixtures. Workflow steps only dispatch events and suspend.

One caveat: Mastra's default `sleep` and `sleepUntil` are in-process timers that die on restart. The 48-hour Last Call countdown needs a small cron re-driver, or the Inngest engine.

**Where it lives:** `packages/engine`, being built right now in a separate session. It is **left off this branch on purpose** because it doesn't typecheck yet. It adds deal methods to `Store` that `PostgresStore` doesn't implement yet, plus migration `0004_engine.sql`. Planned layout:

| File | What it does |
| --- | --- |
| `policy.ts` | Negotiation band, floor, owner escalation, slot picking, hand-off rules. Pure functions, tested with fixtures |
| `machine.ts`, `negotiate.ts`, `intent.ts`, `slots.ts`, `calendar.ts`, `shield.ts` | State transitions, buyer intent, slots, Scam Shield checks |
| `workflows.ts` | Mastra workflows: a deal run (negotiating → scheduling → handoff) and a Last Call run (drop → free → close) |
| `engine.ts` | `DealEngine`: identifies buyers, routes events into runs, fires Last Call stages, returns effects |
| `stores/` | Deal and Last Call tables you can query, in memory or Postgres |

**Acceptance (W6/W8):**

- 60+ fixtures pass, and adversarial lowball fixtures never breach the floor.
- A second phone texting as a buyer negotiates to the floor and books a slot, while the owner's chat shows a threaded summary.

---

## 4. Money, Scam Shield, sustainability

**Money (Nessie, Capital One).** Each move gets a "Moving Fund" checking account and an "Escrow" savings account:

- A buyer's confirmed price is deposited into Escrow.
- On hand-off it moves from Escrow to the Moving Fund. A release needs **two signals**: the buyer confirms, plus either the owner's 👍 or Map convergence.
- A no-show past 24h, or an owner cancel, refunds the buyer.
- Truck, storage and movers are posted as purchases. Roommate shares are posted as transfers.
- The Ledger shows the net cost of the move.

Nessie is the ledger and escrow model; real money moves on Venmo outside the product. Everything sits behind a `MoneyRails` interface with a fake, so Stripe Connect can be swapped in later.

**Scam Shield rules:**

1. Pay or hold through Zelle, Venmo, Cash App, gift cards or wire, outside escrow → flag.
2. A deposit or fee before a viewing or hand-off → flag.
3. A price more than 35% below comparable listings → flag as "too good".
4. A request for an SSN, ID photo or paid credit-check link → block and warn the owner.
5. Pressure language combined with any of the above → escalate to the owner.

Each flag names its rule. The owner can override with a tapback. The housing search already applies the listing-side flags: price far below market, wire or app prepayment, "I'm abroad", no photos, and a price that differs across sites.

**Sustainability.** Every item carries a category and an estimated weight (approximate; the owner can edit it).

- **Move Report:** pounds diverted from landfill, and CO2e avoided as Σ weight × the category's EPA WARM factor, with the source cited. Dumped items count against the total.
- **Curb Map:** free items from Last Call across every move in a neighborhood, opt-in, with text-to-claim.

---

## 5. Architecture (what is built)

```
iPhone/SMS ──► Photon 2.0 (shared iMessage pool + 740 SMS/voice line)
                 │  inbound: Socket.IO event stream (hosted) or GET /messages polling, cursor replay
                 ▼
         apps/elves  (Bun + Hono, one process, one replica on Railway)
           pipeline: per-space debounce → batch → cancel/carry-forward → idempotent send
           router:   Crew Lead routing (thread owner → photo/price rules → Claude Haiku → keywords)
           elves:    Crew Lead · Stuff · Money · Move-day · Home   (handle(ctx) → result)
           memory:   working memory + transcript + facts + notes, token-budgeted
                 │
                 ▼
         Supabase Postgres (packages/db: Bun.sql, migrations on boot, PostgresStore)
```

| Package | What it is |
| --- | --- |
| `apps/elves` | The service: boot, config, HTTP (`/health`, `/board/:moveId`, `/events/:moveId`, `/memory/:moveId`), wiring |
| `packages/shared` | Types, the `Store` contract, `MemoryStore` (in-memory), logger |
| `packages/photon` | Photon 2.0 transport (REST + Socket.IO) and an in-memory `script` transport for tests and the demo |
| `packages/pipeline` | Debounce, batch, cancel, carry-forward, idempotent sends |
| `packages/llm` | Claude client: `claude-haiku-5-5` (routing, extraction), `claude-sonnet-5-5` (drafting, vision), and a fake |
| `packages/elves` | Router, the five Elves, photo intake, Home Elf housing search flow |
| `packages/listings` | Housing search: per-site recipes, Stagehand v4 browser (Browserbase or local Chrome), dedupe, scam flags, ranking |
| `packages/memory` | `MoveMemory`: working memory, transcript with rolling summary, facts (deduplicated, scoped by audience), notes |
| `packages/db` | Postgres pool, migrations (`0001_store`, `0002_memory`, `0003_listings`), `PostgresStore` |

**Memory decision.** We tried Mastra Memory and replaced it with our own layer on Postgres (three tables). Mastra was only acting as storage. It added about 40 tables and a heavy dependency, and it didn't solve the real gap, which was that moves and items lived in process memory. Facts are deduplicated and carry an audience flag, so owner-private facts like floor prices never reach a buyer thread. Context assembly is one parallel round of reads (about 25 ms). Fact extraction runs in the background after the reply is sent. Mastra is used only for **Workflows** (Deal Engine and Last Call). See README → Memory.

**Photon realities that shaped the design:**

- We're on the **shared iMessage pool**. Each phone must be assigned (25 max), and each phone gets its own pool number. That's why the agent identity always comes from the inbound message's `receivedBy.id`.
- On the shared pool, threaded replies (`parentMessageId`) and reactions return `409 SPACE_NOT_SENDABLE`. The transport falls back to a flat send. Typing indicators and read receipts work.
- A dedicated line (needs a Photon business plan) would fix threading, reactions and group chats.
- Photon 2.0 has no app cards, so the mini apps are hosted pages sent as links.

---

## 6. Status and what's next

**Live:** `https://elves-production.up.railway.app/health` (Railway project `elves`, socket inbound).

- Real texts get a read receipt, typing and a Claude reply.
- Photo intake works end to end: HEIC → JPEG → Claude vision → item with a price range.
- The Stuff Elf holds the floor and takes "yes, list it".
- Memory and the store run on Supabase. If `/health` shows `degraded`, `ELVES_DATABASE_URL` isn't set on Railway.

**This branch:** typecheck is clean and 202 tests pass with no credentials (`bun test`).

**Work queue** (from the implementation plan, remapped to five Elves):

| # | Ticket | Status |
| --- | --- | --- |
| W1–W4 | Schema, Postgres store, live loop on the shared pool, public host | Done |
| W5 | Crew Board page (`/board/:moveId` exists; Realtime and polish not yet) | Partial |
| W6 | Deal Engine core on Mastra Workflows | **In progress** (separate session) |
| W7 | Item intake from a photo | Done (Stuff Elf, Sell) |
| W8 | Stuff Elf buyer DMs through the Deal Engine | Next, after W6 |
| W9 | Pickup calendar and coverage | After W8 |
| W10 | Reaction and poll semantics (👍 confirm, 👎 decline) | Limited on the shared pool |
| W11 | Money Elf: `MoneyRails`, Nessie, escrow, Ledger | Open |
| W12 | Scam Shield (five rules, fixtures, precision and recall) | Partial (listing flags in `packages/listings`) |
| new | Room Scan (Move-day Elf): vision schema, box and truck tables, Move Estimate | Open |
| W13–W14 | Voice (Retell over SIP on the 740 line), Haul quotes by call | Open, optional sub-prize |
| W15 | Last Call and Move Report | Last Call is part of W6; Move Report open |
| W16–W19 | Lease, Hunt (**done**), Buy, Move-day Map, Move-in | Hunt done; others open |
| W21–W22 | Evals, demo seed, README maps, Devpost, video | Open |

**Shortest path to the judge walkthrough:** W6 → W8 → W9 → W11 → W12 → W15 → W22.

---

## 7. The demo

The demo is 90 seconds of action on the judge's own phone:

| Time | What happens |
| --- | --- |
| 0–15 s | Couch photo + "moving out Aug 29". The Crew Lead replies with a plan, and the board link follows |
| 15–40 s | "Is the couch still available? $80?" The Stuff Elf counters at the floor, offers slots and confirms |
| 40–50 s | The escrow hold shows on the Ledger |
| 50–70 s | A lease question. The Home Elf gives a verdict and drafts the landlord notice |
| 70–85 s | (Optional) The Move-day Elf calls the judge as a storage facility and posts the summary |
| 85–90 s | A lamp, "leaving tomorrow". Last Call: free relist, pickup booked, Move Report shows pounds diverted |

Every step has a seeded fallback state, so a broken step can be shown from its end state.

---

## 8. Decisions that changed the original plan

| Was (design doc / plan) | Now | Why |
| --- | --- | --- |
| Ten Elves, each on its own dedicated line | **Five Elves** on one number, with sub-skills | Easier to use; dedicated lines need a Photon business plan |
| Grok via xAI | **Claude**: `claude-haiku-5-5` fast, `claude-sonnet-5-5` smart | Grok key failed; Claude does vision too |
| Mastra (or Supabase PostgREST) for memory and store | **Own memory + `PostgresStore` on Bun.sql** | Robust, small, and deduplicated facts with audience scoping; no 40-table dependency |
| — | **Mastra Workflows for Deal Engine + Last Call** | Durable suspend/resume across redeploys |
| ElevenLabs voice | **Retell over SIP** | Warm transfer, custom-LLM websocket, pay-as-you-go |
| Threaded replies and reactions everywhere | Flat-send fallback on the shared pool | `409 SPACE_NOT_SENDABLE` on the shared pool |
| App cards for mini apps | Hosted pages sent as links | 2.0 has no app-card type |
| Video walkthrough inventory | One photo per item, plus Room Scan for estimates | Same pipeline at far lower cost |
| Roommate Elf | Deferred: Crew Lead records coverage; Money Elf does splits | Scope |
| Find My for the Map | Browser geolocation from the Move Map link | No Find My on the 2.0 API |
| No public host | **Railway** (`elves-production.up.railway.app`), one replica | Debounce pipeline is in-process |

**Still open:**

- The final product name.
- Owners for the mini-app front end and the call personas.
- Dedicated iMessage line.
- Quote sources for trucks, movers and storage.
- Whether Room Scan routing needs a "selling this, or scanning the room?" question when unsure.
- Payment provider beyond Nessie.

---

## 9. Getting started (for teammates)

```bash
bun install
bun test            # 202 tests, no credentials needed (in-memory store, fake LLM, script transport)
bun run typecheck
bun run demo        # the whole arc against the in-memory transport
```

For the real loop, ask Gavin for the `.env` (never commit it; `.env.example` lists every variable). To text the bot from your phone, your number must be assigned to the shared pool:

```bash
bun run photon assign +1XXXXXXXXXX
```

`bun run photon status` shows your pool number.

**Conventions:**

- Every external system sits behind an interface with a fake.
- Business rules (floors, slots, scam rules) are pure functions with fixtures.
- Money is in integer cents. Phone numbers are E.164.
- Events are append-only.
- Elves never import a transport.
- Run `bun run lint` before pushing.

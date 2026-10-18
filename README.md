# Elves — a moving crew you text

HackHarvard 2026. A Crew Lead and three specialist agents ("Elves": Home, Stuff, Money) live in your iMessage/SMS thread on Photon 2.0 lines and run a move: find the next place and storage, sublet the old one, sell the furniture, keep the ledger, keep things out of the landfill. This repo is the service behind the number.

Product spec and decisions: [`SPEC.md`](SPEC.md). Five-Elf behavior, including Room Scan: [`docs/elves-spec.md`](docs/elves-spec.md). Original design and the W1–W23 plan: [`docs/`](docs/). **This README is the state of `team-stable`.** SPEC §2, §3 and §6 still describe an older snapshot (Deal Engine "not on this branch", Buy and Donate as stubs, 202 tests, migrations stopping at `0003`). When they disagree with the table below, trust this README, then the code.

## State of this branch

`bun test` is 309 tests across 24 files, no credentials. `bun run typecheck` is clean. Live host: `https://elves-production.up.railway.app/health`.

Branch from here when you want the crew that actually runs. The rows marked **empty** answer with a canned line and a Crew Board update. They do not call an API.

| Area | On `team-stable` | Still empty |
| --- | --- | --- |
| Crew Lead | Built. The onboarding call first: from the owner's first text until they confirm the brief, the Crew Lead only gathers (dates, from/to, what goes and what has to go, how it moves, people, lease, money, worries), plays the brief back, and dispatches the specialists on "yes" (`packages/elves/src/onboarding.ts`; board link goes out with the dispatch). The first text opens with the crew's exact ability list (below), "what can you do?" gets it again, "status" gets one paragraph, and anything off the list gets "the crew can't do that" plus the closest thing it can do. After that: dates, items, routing, approvals as before. | Mini-app polish. The board page exists; it is not a live mini app. With the fake model there is no onboarding call (the deterministic Crew Lead answers). |
| Stuff · Sell | Built. Photo → vision → item, floor, list price, "yes, list it" opens a `sell_item` deal. Buyers text this number. | Nobody posts the listing to a marketplace. The owner pastes the ref into their own post. |
| Stuff · Buy | Opens a `buy_item` deal after an explicit yes. Needs a forwarded link and a max price. The ceiling is the deal's limit. | No comps. No message to the seller. The seller has to text this number and quote the ref. The canned "I'll check comps" line is no longer what runs when the text is a real buy. |
| Stuff · Donate | "Donate the lamp" then "yes" marks that item `donated`, closes its open sell deal, and emits `pickup.requested`. | No Goodwill, 311, or bulk-pickup API. A bare "last call" / "recycle" question with no item is still the canned green reply. |
| Last Call | Sweep in `lastCallSweep`. T−48h: ask drops to 60% of list (`droppedAsk`). T−24h: relisted free and `pickup.requested` (donation or 311). Move-out: anything still open is `dumped`. "Keep the couch" sets `last_call_opt_out`. | The pickup is an event, not a booked truck. |
| Deal Engine | Built. Postgres state machine plus a sweep. Not Mastra. Modes: `sell_item`, `buy_item`, `sublet_out`, `find_sublet`. States: listed → negotiating → scheduled → handed_off → paid, plus relisted / donated / dumped. Floor and ceiling are code. Three pickup slots, one shared calendar. Scam Shield blocks off-escrow payment on a deal. | No no-show timeout sweep. No poll for "both accepted". A stranger whose text matches two open deals is not joined (ambiguity returns null). A counterparty already in two talks is asked which item when the text names more than one. |
| Money · Nessie | The engine emits `ledger.hold` when a price is agreed, `escrow.requested` and `ledger.release` on hand-off, and `ledger.refund` if that party walks before hand-off. | **Nessie is not integrated.** No `MoneyRails`, no Nessie client, no Moving Fund, no Escrow account, no Ledger page. The Money Elf is a canned reply. Real dollars are not moved. |
| Home · Hunt | Built. One missing fact at a time (budget → area → dates), then Craigslist and Airbnb. Scam flags, rank, top 3. "more" / "tell me about 2" / "skip" / "save". "search again" bypasses the 3-minute cache. A forwarded listing URL is ranked with the picks. "Reach out to 2" opens `find_sublet`; when the listing shows a phone, the dedicated line texts the lister the drafted note, the owner hears "Texted them from <line>", and the lister's replies run through the Deal Engine as summaries in the owner chat. | Booking, SpareFoot, Apartments, Zillow, and Facebook are off the default allowlist (blocks). A listing with no phone (Craigslist, Airbnb) still gets a note the owner sends. Without a dedicated line (`PHOTON_DEDICATED_AGENT_ID` or a discoverable one) the note goes to the owner too; the shared pool cannot text first. Email contacts are not used. |
| Home · Sublet | "Sublet my room for $1500" opens `sublet_out` at once, then asks for dates and area one at a time, reads room photos with vision, and writes the post (title + body with the ref and the number) in `sublet_posts`. "Change …" redrafts, "post it" approves. An applicant who agrees a rent is offered viewing times; the time they pick is held and the owner is asked "Book it?", and only a yes books it (a no offers them the other times). The same holds for a lister's viewing on `find_sublet`. | The owner pastes the post; nothing is posted to Craigslist or Facebook by the crew. No landlord is contacted. The crew does not read leases: "can I sublet my room?" gets "your lease and landlord decide that one". |
| Home · Move-in | Built. "Set up internet at the new place" / "what do I need for move-in" asks for the move-in date and the new address one at a time (both written onto the move), then texts the checklist with dates from `movein_tasks`: electric, gas and internet 10 days out, renters insurance and the USPS address change 7 days out, keys and the condition report on the day, bags for the gap when move-out comes first (the hotel itself stays with the hunt). "Done with internet", "skip insurance", "what's left" and "address is …" keep it current; a moved date re-dates the open tasks. `moveinSweep` runs on the Last Call timer and texts one reminder per task within 2 days of its date. Working memory carries a "Move-in week" section so any Elf can answer "did we set up internet?". | Nothing is ordered: the owner places every order and the crew calls no utility or ISP. No provider lookup for the address. One reminder per task, no snooze. |
| Move-day | **Folded into Home on 2026-10-17; there is no Move-day Elf.** Storage is a Home search (SpareFoot), the move checklist and "status" cover what move-in week needed. A booked pickup still emits `pickup.scheduled`. | Trucks, U-Haul, movers, Room Scan, the Move Map and ETAs are out of scope: the Crew Lead says the crew can't, by design. Old `moveday` board rows stay in the table and are hidden. |
| Owner yes | Inbound 👍 / heart / ✅ with no text counts as "yes" on the owner's question, and on a pending buy or donate. | Outbound 👍 fails on the shared Photon pool (`409`). Replies stay plain text. There is no tapback override for a scam flag. |
| Memory and store | Postgres (Supabase) via `Bun.sql`. Working memory, transcript, facts, notes. Migrations `0001`–`0009` run on boot. | `0005_workflows.sql` still creates `deal_runs` and `last_call_runs`. The Mastra package that used them was deleted. Nothing writes those tables. |

**Deal Engine, precisely.** `packages/engine` decides; the Elves only phrase it. `openDeal`, `attributeInbound`, `counterpartyTurn`, `ownerTurn`, `lastCallSweep`. A buyer is matched by the ref code in the post (`K7Q2`) or, on a first text, by one shared title word. Negotiation never crosses the owner's floor or ceiling; an offer past the line becomes one question in the owner chat. Hand-off tags the item `sold` or `given`. Payment copy says escrow. That escrow is the ledger events above, not Nessie. Each mode has a voice (`packages/engine/src/voice.ts`): `find_sublet` speaks as the buyer who texted first ("Is it still available? We can do up to $X", "Great, $X works; when could we see it?"), opens at min(listed rent, budget) so a lister holding above the budget is countered at it and then put to the owner, relays each counter to the owner, and never sends the owner's address to a lister.

**Routing** (`packages/elves/src/router.ts`), first match wins: counterparty role → that deal's Elf; first contact → Crew Lead; an owner whose brief is not confirmed yet → Crew Lead (the onboarding call); thread owner; "keep the couch" → the Elf that owns the open Last Call deal; "yes" / "no" / a price while an offer or a buy/donate confirm is waiting → that Elf; "2" / "more" / "search again" / a forwarded URL after Home spoke → Home; a date or address after Home asked for one, or "done with internet" / "what's left" on a move-in checklist, after Home spoke → Home; photo → Stuff; a bare price → Stuff, unless keywords already point at another Elf (so "sublet my room for $1500" stays Home); Claude Haiku at ≥ 0.5; keywords; else Crew Lead. Room Scan is not a route.

**What to build next, in the order the demo needs:**

1. Nessie behind the ledger events (Money Elf voice stays the Elf; the engine keeps the rules). No money moves without the owner's yes.
2. Room Scan on Move-day, skipping any item whose deal already emitted `pickup.scheduled`.
3. Move Report from item outcomes and weights. Dumped counts against the total.
4. U-Haul quotes and the Move Map are still canned.

Do not reintroduce `packages/workflows` or `@mastra/core`. SPEC already records that decision. Leave `0005_workflows.sql` in place so existing databases still migrate.

## The crew: a Crew Lead and three Elves

One list in code says what the crew can do: `CREW_ABILITIES` and `CREW_LIMITS` in [`packages/elves/src/crew.ts`](packages/elves/src/crew.ts). The Crew Lead's text prompt, its first message, the onboarding call and the Retell voice prompt all read it, so the owner hears the same abilities everywhere. Change an ability there, not in a prompt.

| Elf | What it does | What it never does |
| --- | --- | --- |
| **Home** | Finds a place to move into, a hotel for the gap, or storage (Craigslist, Airbnb, Booking.com, SpareFoot), flags scams, texts the top 3. Sublets your place: asks rent, dates, area and room photos, writes the post for you to put up, handles applicants. Keeps the move checklist (utilities, internet, renters insurance, USPS address change, keys, condition report). | Books a viewing without your yes (the applicant's pick is held and you get "Book it? yes or no"). Reads leases or contacts landlords. Posts anything for you. |
| **Stuff** | Prices an item from a photo and writes the listing line. Negotiates with buyers who text the number, never under your lowest price, asking you on low offers. Last Call: price drop at 48 hours before move-out, free at 24 hours, then asks about donating. (Yashashri's `stuff-elf` branch carries the newer Stuff work.) | Posts to Facebook Marketplace or anywhere else; you paste the post. |
| **Money** | The move's ledger on Nessie: every sale, escrow hold and release, the money set aside for the move. A dashboard and a ledger-editing mini app are ideas, not built, and are not advertised. | Pays, sends or requests money for you. |

**What the crew cannot do** (said the same way every time): book trucks, U-Hauls or movers; plan the route or run move day; post listings for you; read leases or contact landlords; pay, send or request money for you; give legal or financial advice; anything not about the move.

### Crew Lead on iMessage / SMS

The prompt is `SYSTEM` in [`packages/elves/src/crew-lead.ts`](packages/elves/src/crew-lead.ts) (the onboarding call's is `CONTRACT` in `onboarding.ts`). What it does, in order:

- **First text:** opens with `crewIntro()` word for word: "Hey, I'm the Crew Lead at Elves, your moving crew. Here's what we can do:", one line per ability, then what the crew can't do. Never "text me anything". On the live model the onboarding call's first question follows it; with the fake model the deterministic reply follows it.
- **"what can you do?" / "help":** `abilitiesReply()`, the same list. Routed to the Crew Lead from any thread (`via: "scope"`), during onboarding too, without moving the call along.
- **"status" / "where are we?":** `statusReport()` in [`status.ts`](packages/elves/src/status.ts), one paragraph read straight off the store, nothing invented: dates and addresses; the checklist (open items with due dates, done items); the sublet post and applicants; housing picks; Stuff listed, sold and booked pickups; the ledger (held in escrow, released); and anything waiting on your yes (a low offer, a viewing time).
- **Out of scope:** `outOfScope()` matches trucks and movers, move-day logistics, lease reading and landlords, posting for you, paying someone, and legal or financial advice. The reply is the fixed "The crew can't …" sentence plus the closest thing it can do. Anything else off the list is caught by the prompt's scope rules, which forbid improvising an ability.
- **Approvals:** nothing is booked, posted, paid or agreed without the owner's yes.

### Crew Lead on a call (Retell)

`VOICE_ONBOARDING_PROMPTS.story_first` and `VOICE_BEGIN_MESSAGE` in [`packages/elves/src/onboarding-voice.ts`](packages/elves/src/onboarding-voice.ts) are the same contract, spoken. The begin message gives the rundown first, one sentence per Elf, then what the crew doesn't do, then hands the caller the floor:

> Hey, this is the crew lead at Elves, your moving crew. Quick rundown: The Home Elf finds you a place, a hotel for the gap or storage, and sends you the top three with scams flagged; sublets your place, writing the post and never booking a viewing without your yes; and keeps your move checklist, like utilities, internet and keys. The Stuff Elf prices your things from a photo for you to post; deals with buyers, never under your lowest price; and drops prices on what's left before move-out, then asks about donating. The Money Elf keeps the move's ledger of sales, escrow and money set aside. We don't book trucks or movers, run move day, post listings for you, read leases, or pay anyone. So, walk me through the move: when you're out, where you're going, and what's coming with you.

The general prompt adds "What the crew can do" and "What the crew cannot do" sections and two rules: "what can you do?" gets the rundown, and anything off the list gets one sentence saying the crew doesn't do that, the closest thing it can do, and the ask kept in the brief. It stays under Retell's 1,100-word guidance (a test enforces it). Print everything to paste into the dashboard:

```bash
bun run scripts/retell-agent.ts
```

Dashboard setup (single prompt, agent speaks first, `submit_brief` custom function, `end_call`) is in [`docs/crew-lead-retell-prompts.md`](docs/crew-lead-retell-prompts.md).

## Run it

```bash
bun install
cp .env.example .env        # fill in PHOTON_PROJECT_ID, PHOTON_API_KEY, ANTHROPIC_API_KEY
bun test                    # no credentials needed; in-memory store and memory
bun run test:pg             # the same suites against a local Postgres (docker run -d --rm --name elves-pg-test -e POSTGRES_PASSWORD=elves -p 54329:5432 postgres:15-alpine)
bun run demo                # the whole arc against the in-memory transport, no credentials needed
bun run db status           # ping the database, list migrations and row counts (needs ELVES_DATABASE_URL)
bun run start               # the service: migrates the database, polls Photon, answers texts, serves the Crew Board
```

`bun run eval:onboarding` runs the onboarding call under each prompt variant against three simulated owners (Haiku, with hidden ground truth) and scores turns, questions, brief coverage, nuance and planning leaks; transcripts land in `.data/onboarding-eval/`. `ELVES_ONBOARDING_PROMPT` picks the variant live (`one_at_a_time`, `sweep`, `mirror`).

`bun run photon status` shows the project's lines, shared-pool assignments and the last messages in both directions. `bun run photon assign +1XXXXXXXXXX` puts a phone on the shared iMessage pool (25 max). `bun run photon reply-last "text"` replies to the newest inbound message from the CLI.

Environment (all read in `apps/elves/src/config.ts`):

| Variable | Meaning |
| --- | --- |
| `PHOTON_PROJECT_ID`, `PHOTON_API_KEY` | Photon 2.0 project and `pho_sk_` key |
| `PHOTON_INBOUND` | `poll` (GET /messages every `PHOTON_POLL_MS`, default) or `socket` (Socket.IO event stream with cursor replay, plus a slow poll as a safety net) |
| `PHOTON_SINCE` | ISO time; on boot, also handle messages created after this (replay). Default: boot time |
| `PHOTON_DEDICATED_AGENT_ID` | Agent user id (`pho_usr_…`) of the dedicated iMessage line that may text someone first. Unset: discovered from the project's agent users (`details.type = dedicated`) |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL_FAST`, `ANTHROPIC_MODEL_SMART` | Claude; `claude-haiku-5-5` routes and extracts, `claude-sonnet-5-5` drafts. Unset key → deterministic template replies |
| `ELVES_TRANSPORT` | `photon2` or `script` (in-memory) |
| `ELVES_DEBOUNCE_MS` | quiet window before a batch is handled (default 1200) |
| `ELVES_DATABASE_URL` (or `DATABASE_URL`) | Postgres. With Supabase use the IPv4 session pooler `postgresql://postgres.<ref>:…@aws-0-<region>.pooler.supabase.com:5432/postgres`; the direct `db.<ref>.supabase.co` host is IPv6-only |
| `ELVES_STORE` | `auto` (default: Postgres when the URL is set and reachable, otherwise in-memory with an error log and `degraded` on `/health`), `postgres` (fail fast), `memory` |
| `ELVES_DB_POOL`, `ELVES_DB_MIGRATE` | pool size (default 5); `ELVES_DB_MIGRATE=0` skips the boot-time migration |
| `ELVES_ONBOARDING_PROMPT` | Crew Lead onboarding-call prompt variant: `sweep` (default), `mirror`, `one_at_a_time` |
| `ELVES_MEMORY`, `ELVES_MEMORY_MESSAGES`, `ELVES_MEMORY_BUDGET` | `off` disables conversational memory; transcript window (default 24 messages) and its token budget (default 1400) |
| `ELVES_BROWSER`, `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`, `BROWSERBASE_CONTEXT_ID` | housing search browser: `browserbase` (hosted; prod), `local` (your Chrome; dev) or `off` (fixtures). The context id (from `bun run browser login`) holds the owner's Facebook login |
| `ELVES_LISTINGS_SITES`, `STAGEHAND_MODEL`, `ELVES_LISTINGS_*_TIMEOUT_MS`, `ELVES_LISTINGS_CONCURRENCY` | site allowlist (default: craigslist,airbnb), extraction model, per-site / total timeouts, pages in flight |
| `PUBLIC_URL` | HTTPS origin for mini-app links; links are only sent when set |
| `PORT` | HTTP port (`/health`, `/moves`, `/board/:moveId`, `/events/:moveId`, `/memory/:moveId`, `/b/:moveId` Crew Board page) |

## Layout

```
apps/elves/          the service: config, batch handler (service.ts), Hono server, boot
packages/shared/     domain types, Store contract, MemoryStore (in-process), logger
packages/db/         Postgres via Bun.sql: connection, migrations (packages/db/migrations), PostgresStore
packages/memory/     conversational memory: transcript + summaries, facts, notes, token-budgeted context; two backends
packages/photon/     Photon 2.0 REST client, poll + Socket.IO inbound, normalization, script transport
packages/pipeline/   per-space debounce, batch, cancel + carry-forward, deterministic send keys
packages/llm/        LLM contract; ClaudeLLM (structured outputs via zod) and FakeLLM
packages/engine/     Deal Engine: four modes, negotiation, calendar, Scam Shield, Last Call sweep. Ledger events only; no Nessie client
packages/elves/      Elf contract, router, Crew Lead, Stuff (sell/buy/donate), Home (hunt + sublet deals). Money and Move-day are canned stubs
packages/listings/   housing search: site recipes, Stagehand v4 runner, dedupe, scam rules, fixtures
scripts/             photon operator CLI, browser CLI (login, search, sites), offline demo
```

## Housing search

The Home Elf's hunt is a pipeline in `packages/listings` plus `packages/elves/src/home*.ts`:

1. Requirements: the fast model (with a regex fallback) pulls kind (room / sublet / apartment / hotel / storage), neighborhoods, budget, dates, beds, furnished and must-haves out of the text and merges them into the move's `housing_searches` row. One missing thing is asked per turn: budget, then area, then dates.
2. Ack, then search: the Elf replies "On it. Checking Craigslist, Apartments.com and Airbnb for a room in Allston under $1,200…" and returns a `later` step. The service sends the ack, settles the batch (a newer text now queues instead of cancelling), keeps the typing indicator alive, runs the search, then sends the results. Each site is a recipe (`packages/listings/src/recipes`): a pure URL builder for the query, an extraction instruction and one shared zod schema. Stagehand opens one browser session per search and one page per site, a couple at a time, with per-site and total timeouts; a site that fails is one failed run, never a failed search. Prices are parsed by code and every link is checked to stay on the site before the owner sees it.
3. Scam rules run on the raw results (price under half the median, wire / gift card / app payment before a viewing, "I'm abroad", no location, no photos, a different price for the same title on another site); hard flags sink a listing out of the picks. Duplicates across sites collapse to the most trusted copy.
4. Ranking: the fast model scores up to 25 candidates against the requirements with a one-line reason; a heuristic fills gaps and stands alone with the fake LLM. Picks are stored in `listings` with a rank, and the top three go out as plain text with exact links. Working memory gets a `## Housing search` section so every Elf can answer "did you find me a place?".

Operator commands: `bun run browser sites --kind room --area allston --max 1200` prints every recipe URL; `bun run browser search …` runs a real search and prints the runs table; `bun run browser login --site facebook` opens a Browserbase live view to log in once and prints the `BROWSERBASE_CONTEXT_ID` to set. Verified live from a headless local Chrome: Craigslist (rooms, sublets, apartments) and Airbnb (furnished rooms and sublets, and the hotel gap; Airbnb quotes a sample stay rather than the exact dates, so its monthly figure is that stay's nightly rate × 30 and the ranker treats it as an estimate). Booking.com (drops the search parameters and lands on its search form), Apartments.com (Akamai "Access Denied"), SpareFoot (Cloudflare challenge), Zillow (PerimeterX) and Facebook Marketplace are off the default allowlist until `bun run browser search` passes on that deployment (Browserbase with proxies); Facebook only runs inside the owner's own persisted login. A block page shows up as a failed run, never as "no results". Automating these sites is against their terms and accounts can be checkpointed; searches are read-only, one per ask, with a three-minute repeat guard.

## Memory

The crew remembers in three layers, all behind `MoveMemory` in `packages/memory`:

| Layer | What | Where | How it reaches the prompt |
| --- | --- | --- | --- |
| Working memory | move dates and addresses, every item with range / floor / list price and stage, who else is in the loop, what each Elf is doing, the confirmed brief (or the draft, marked as unconfirmed) | rendered on every turn from `moves`, `items`, `elf_status`, `participants` and the onboarding cursor (a view, so it can never drift) | first block of every Elf prompt |
| Transcript | every inbound text and every reply, per Photon space, keyed by the Photon message id (replays never duplicate) | `memory_threads`, `memory_messages`; once a thread has 40 unsummarized messages the oldest are folded into a rolling summary (the fast model) | newest 24 messages trimmed to 1,400 tokens, plus the summary |
| Facts | durable statements extracted after each exchange: preferences, constraints, commitments, open loops, people, with confidence, provenance and an audience flag | `memory_facts`, deduplicated on `(move, kind, normalized text)`, Postgres full-text search | top 12 ranked by relevance to the incoming text + recency + confidence; `owner_private` facts (floor prices, urgency, budget) appear only in owner threads and are listed as confidential anywhere else |
| Notes | an Elf's own scratchpad per move (`memory.setNote`) | `memory_notes` | the handling Elf's notes, as JSON |

Flow per batch: route → `memory.context()` (one parallel round of reads, about 25 ms on Supabase) → the Elf answers → replies are sent → `memory.afterTurn()` schedules extraction and summarization in the background, serialized per thread. Memory failures are logged and never block a reply; with `ELVES_MEMORY=off` Elves get an empty context. `GET /memory/:moveId` shows threads, facts and notes; `bun run db memory <moveId>` and `bun run db facts <moveId> "<query>"` do the same from a shell.

Storage: `packages/db` opens one `Bun.sql` pool (no driver dependency), applies `packages/db/migrations/*.sql` on boot under an advisory lock (tracked in `schema_migrations`), and implements the `Store` contract on Postgres. The same contract tests run against the in-memory store and Postgres.

Every Elf is `handle(ctx) → { replies, boardPatch, events, movePatch }`. The service applies the patch, appends events, sends replies as the agent identity the human texted (`receivedBy.id`), and records thread ownership so a reply in an Elf's thread goes back to that Elf. Elves never touch a transport.

## Photon 2.0 usage map

| Primitive | Endpoint | Where it fires | Verified live |
| --- | --- | --- | --- |
| Inbound messages | `GET /v1/projects/{id}/messages?direction=received&createdSince=…` | poll loop, idempotent on message id, cursor persisted | yes |
| Inbound events | Socket.IO `/v1/projects/{id}/events/ws`, `subscribe {startSeq}` → `delivery(event, {seq})`, `message.received` | `PHOTON_INBOUND=socket` (hosted) | subscribe verified; delivery path tested offline |
| Attachments | `GET /attachments/{id}` + `/content` (HEIC bytes) | photo intake | yes |
| Reply as the right agent | `POST /messages` with `senderId = receivedBy.id`, `Idempotency-Key = reply:<msgId>:<n>` | every Elf reply | yes, delivered |
| Threaded reply | `parentMessageId` | every Elf reply | shared pool refuses (409 `SPACE_NOT_SENDABLE`); the transport falls back to a flat send and remembers the space |
| Read receipt | `POST /messages/{id}/read` | after the batch is read | yes |
| Typing | `POST /spaces/{spaceId}/typing` | around model calls | yes |
| Reaction | `POST /messages` `content.type=reaction` with `parentMessageId` = the inbound message | 👍 on the last message of every inbound batch, before the model call (`apps/elves/src/service.ts`) | refused on the shared pool (same 409); logged, not retried. See "A 👍 on every text" below |
| Shared-line assignments | `GET/POST /platforms/imessage/assignments` | `scripts/photon.ts` | yes |
| Lines | `GET /platforms/resources` | `scripts/photon.ts status`; dedicated-line discovery when several agents are dedicated | yes |
| Text someone first | `GET /users?kind=agent` (find the dedicated agent, `details.type=dedicated`), `POST /users {handle, platform}`, `POST /spaces {participantIds: [line, them]}` with `Idempotency-Key = space:<line>:<user>`, then `POST /messages` as the line | `Transport.openSpace`, from the Home Elf's "reach out to N" when the listing shows a phone | offline (fake fetch); not yet exercised on a live dedicated line |

Shared-pool rules that shaped the design: the pool only sends in direct spaces to a human with an active assignment who has texted first; the agent identity differs per human (each phone gets its own pool number), so the agent id is always taken from the inbound message rather than configured. A dedicated line (the project reports `dedicatedLineAvailableNow: true`) would lift the threading and reaction limits.

**Which lines can message first.** Only a dedicated line. `Transport.openSpace(handle, platform)` creates (or finds) the Photon user for a phone number and the direct space between it and the dedicated line's agent user, then the service sends as that agent and records the person as a `lister` participant and deal party. The agent user comes from `PHOTON_DEDICATED_AGENT_ID`, or is discovered once from the project's agent users. Shared-pool numbers never open spaces: with no dedicated line `openSpace` rejects, the note is dropped with a log line, and the Home Elf falls back to handing the owner the text to send.

**A 👍 on every text when the agent reads it.** The code already does the call: as soon as a batch arrives, `service.ts` sends a 👍 tapback on the last message, then the read receipt, then typing, all best effort. What blocks it is the line, not the code: on the **shared iMessage pool** Photon answers a reaction (it is a message with `parentMessageId`) with `409 SPACE_NOT_SENDABLE`, the same refusal as threaded replies, while read receipts and typing go through. `bun run photon status` on 2026-10-17 showed the project in `mode: "shared"` with `dedicatedLineAvailableNow: true`, and no reaction among the sent messages. To turn it on:

1. **Get a dedicated iMessage line.** `bun run photon provision-dedicated` asks Photon for one (it may need the Photon business plan; it earlier returned `ENTITLEMENT_REQUIRED`). Owners then text the line's number instead of their pool number, so update the numbers you hand out, and set `PHOTON_DEDICATED_AGENT_ID` (or let it be discovered).
2. **React to every message, not only the last of the batch,** and in the order you described: read receipt first, then 👍 on each text in the batch (one idempotency key per message, `react:<msgId>`). A small change in the acknowledge block of `service.ts`.
3. **iMessage only.** Skip the tapback when the inbound platform is SMS (the `+1 740` voice/SMS line): SMS has no tapbacks, and a fallback would show up as a "Liked …" text.
4. **Stop asking a space that refuses.** Remember spaces that returned 409 for a reaction (like `noThreads` for threaded replies) so the shared pool isn't hit with a failing call on every text.

Until there is a dedicated line, the visible "I read it" signal on the shared pool is the read receipt plus the typing indicator, which already work.


## Deploy

`Dockerfile` + `railway.json`. `railway up -s elves` from a linked checkout; variables live in the Railway service, never in the repo. Set `ELVES_DATABASE_URL` to the Supabase session-pooler URL (the direct host is IPv6-only and unreachable from Railway); without it the service boots in-memory and `/health` reports `degraded`. Migrations run on boot. Keep one replica: the per-space debounce pipeline is in-process.

# Elves — a moving crew you text

HackHarvard 2026. Ten specialist agents ("Elves") live in your iMessage/SMS thread on Photon 2.0 lines and run a move end to end: sell the furniture, book the truck and storage, handle the lease, settle the money, keep things out of the landfill. This repo is the service behind the number.

Design doc and implementation plan: see the team's Notion. This README is the engineering map.

## Status

Phase 1 (foundation) is live:

- A text to an assigned pool number gets a read receipt, a typing indicator and a Crew Lead reply written by Claude, with the move-out date and items captured into the move.
- Three rapid texts become one reply (per-space debounce with cancel and carry-forward).
- Photo intake: an iPhone photo (HEIC) is downloaded, decoded, identified by Claude vision (item, condition, weight, fair resale range, listing title and description) and becomes an `items` row with a suggested list price.
- Stuff Elf (selling): a dollar amount sets the floor; the list price is held at the range's upper middle and never below the floor; "yes, list it" marks it approved. Buyers reach it by texting the same number (buyer DMs are the next ticket).
- The Crew Lead routes follow-ups to the right Elf (thread ownership → photo/price rules → Claude classification → keyword fallback); the crew is five Elves: Crew Lead, Stuff (sell, buy, donate), Money, Move-day (haul, Move Map) and Home (lease, hunt, move-in). Buying, donating and the last three Elves are still stubs: each picks its sub-skill by keyword, acknowledges in its own voice and updates the Crew Board.
- Home Elf (housing search): "looking for a room in allston under 1200 june 1 to aug 30" asks for whatever is missing (budget → area → dates, one thing at a time), acks, then searches Craigslist and Airbnb (Booking.com, Apartments.com, SpareFoot, Zillow and Facebook Marketplace behind flags) in a real browser via Stagehand v4, flags scams (far-below-market price, wire/app prepayment, "I'm abroad", no photos, cross-site price mismatch), ranks what is left, and texts the top three with links. "more", "tell me about 2", "skip 2", "save 1" work on the saved picks. A hotel for a short gap between move-out and move-in rides along. See [Housing search](#housing-search).
- Memory: every move, item, board row and message lives in Postgres (Supabase), so a restart or redeploy loses nothing. Each Elf prompt opens with working memory (rendered live from the move), the facts the crew has learned (preferences, constraints, commitments, open loops, people; deduplicated, ranked by relevance and recency, with owner-private facts kept out of buyer threads), a rolling summary once a thread is long, and the recent transcript, all inside a token budget. Facts and summaries are extracted after the reply goes out, so memory never slows a text. See [Memory](#memory).
- Hosted on Railway: `https://elves-production.up.railway.app/health`.

Next: Deal Engine (`packages/engine`), Stuff Elf with buyer DMs, Money (Nessie), Scam Shield, Last Call. See the implementation plan's work queue.

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

`bun run photon status` shows the project's lines, shared-pool assignments and the last messages in both directions. `bun run photon assign +1XXXXXXXXXX` puts a phone on the shared iMessage pool (25 max). `bun run photon reply-last "text"` replies to the newest inbound message from the CLI.

Environment (all read in `apps/elves/src/config.ts`):

| Variable | Meaning |
| --- | --- |
| `PHOTON_PROJECT_ID`, `PHOTON_API_KEY` | Photon 2.0 project and `pho_sk_` key |
| `PHOTON_INBOUND` | `poll` (GET /messages every `PHOTON_POLL_MS`, default) or `socket` (Socket.IO event stream with cursor replay, plus a slow poll as a safety net) |
| `PHOTON_SINCE` | ISO time; on boot, also handle messages created after this (replay). Default: boot time |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL_FAST`, `ANTHROPIC_MODEL_SMART` | Claude; `claude-haiku-5-5` routes and extracts, `claude-sonnet-5-5` drafts. Unset key → deterministic template replies |
| `ELVES_TRANSPORT` | `photon2` or `script` (in-memory) |
| `ELVES_DEBOUNCE_MS` | quiet window before a batch is handled (default 1200) |
| `ELVES_DATABASE_URL` (or `DATABASE_URL`) | Postgres. With Supabase use the IPv4 session pooler `postgresql://postgres.<ref>:…@aws-0-<region>.pooler.supabase.com:5432/postgres`; the direct `db.<ref>.supabase.co` host is IPv6-only |
| `ELVES_STORE` | `auto` (default: Postgres when the URL is set and reachable, otherwise in-memory with an error log and `degraded` on `/health`), `postgres` (fail fast), `memory` |
| `ELVES_DB_POOL`, `ELVES_DB_MIGRATE` | pool size (default 5); `ELVES_DB_MIGRATE=0` skips the boot-time migration |
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
packages/elves/      Elf contract, router, fact extraction, Crew Lead, Stuff Elf, Home Elf, stub Elves
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
| Working memory | move dates and addresses, every item with range / floor / list price and stage, who else is in the loop, what each Elf is doing | rendered on every turn from `moves`, `items`, `elf_status`, `participants` (a view, so it can never drift) | first block of every Elf prompt |
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
| Reaction | `POST /messages` `content.type=reaction` | on every inbound | refused on the shared pool (same 409); logged, not retried |
| Shared-line assignments | `GET/POST /platforms/imessage/assignments` | `scripts/photon.ts` | yes |
| Lines | `GET /platforms/resources` | `scripts/photon.ts status` | yes |

Shared-pool rules that shaped the design: the pool only sends in direct spaces to a human with an active assignment who has texted first; the agent identity differs per human (each phone gets its own pool number), so the agent id is always taken from the inbound message rather than configured. A dedicated line (the project reports `dedicatedLineAvailableNow: true`) would lift the threading and reaction limits.

## Deploy

`Dockerfile` + `railway.json`. `railway up -s elves` from a linked checkout; variables live in the Railway service, never in the repo. Set `ELVES_DATABASE_URL` to the Supabase session-pooler URL (the direct host is IPv6-only and unreachable from Railway); without it the service boots in-memory and `/health` reports `degraded`. Migrations run on boot. Keep one replica: the per-space debounce pipeline is in-process.

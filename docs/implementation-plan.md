# Implementation plan

> Original planning doc from 2026-10-17, kept for reference. Where it disagrees with [`SPEC.md`](../SPEC.md) (five Elves instead of ten, Claude instead of Grok, Retell instead of ElevenLabs, our own Postgres memory, a Postgres state machine for the Deal Engine), SPEC.md wins. Personal phone numbers are redacted.

This tab is the development plan: where the build stands, the ordered work queue with owners and acceptance tests, the phase breakdowns behind it, and the decisions taken. The Roommate Elf and voice-note briefings sit in the design doc's Backlog; everything else is in scope.

## Where we are

The foundation is built, tested and running live against the Photon project; the next work is state, hosting, and the Deal Engine.

**Built and verified (branch `phase-1-foundation`, 3 commits, 57 tests green):**

- Monorepo: `apps/elves` service, `packages/{shared,pipeline,elves,photon,llm}`, Biome, typecheck, `bun test`, `bun run demo`
- Photon 2.0 transport: REST for users, spaces, messages (threads via `parentMessageId`), reactions, typing, read, polls, attachments; inbound over the Socket.IO event stream with cursor replay or `GET /messages` polling; agent identity resolved per human (pool number on shared iMessage, the 740 line on SMS)
- In-memory script transport so everything runs without credentials
- Pipeline: per-space debounce, batch, cancel, carry-forward, idempotent sends
- Crew Lead router: thread ownership, then Claude classification, then keyword fallback; first contact in the owner chat always goes to the Crew Lead; 36 routing fixtures
- Crew Lead Elf (Claude-written replies, date capture) and stub Elves for the rest of the crew; Crew Board rows; append-only event log
- Claude as the LLM: `claude-haiku-5-5` for routing and extraction, `claude-sonnet-5-5` for negotiation and drafting
- Supabase migration 0001 (schema, RLS, append-only events, realtime publication) and a Management-API migrate script
- `scripts/photon.ts`: status, assign, send, provision-dedicated

**Live right now:** the service runs against the project in polling mode; Gavin's and the teammate's phones are assigned on the iMessage shared pool (each has its own pool number: +1 628-997-9661 and +1 628-263-4622); the first human text to those numbers gets a reaction and a threaded Crew Lead reply.

**Blocked:** pushes to GitHub (Claude GitHub App not installed); migrations from the workspace (`api.supabase.com` not allowed; a teammate can run `supabase db push` instead); the dedicated iMessage line (needs a Photon business plan; ask Photon at the fair); a public host for the service (needed for WebSocket inbound, the mini-app links and the Retell webhook).

## Work queue

Execution order. A ticket starts when its dependencies are done; demo-critical tickets are marked, and together they form the shortest path to a judge-ready walkthrough.

| # | Ticket | Delivers | Depends on | Acceptance | Owner | Demo-critical |
| --- | --- | --- | --- | --- | --- | --- |
| W1 | Apply migration 0001 | Schema live on the project | `api.supabase.com` allowed, or a teammate with the Supabase CLI | `select count(*) from moves` works with the service-role key | Gavin or Claude | yes |
| W2 | Supabase store | `SupabaseStore` over PostgREST passing the MemoryStore contract tests; `sends` table for idempotency | W1 | Contract suite green against the project; service boots with `ELVES_STORE=supabase` | Claude | yes |
| W3 | Live loop check on the shared pool | Reaction, typing, threaded reply confirmed on a real iPhone; text `format` verified; polling latency measured | phones assigned (done) | Screen recording of one exchange; any API quirks fixed | Gavin texts, Claude fixes | yes |
| W4 | Public host | Service deployed with Socket.IO inbound, health, env; one HTTPS origin for mini apps and webhooks | Railway or Fly account | `/health` public; a text from the phone is answered by the hosted service | Gavin (account), Claude (config) | yes |
| W5 | Crew Board page | Server-rendered page from the service; link sent once per move; Realtime updates | W2, W4 | Script flips an Elf's status and the page changes on the phone | Claude | yes |
| W6 | Deal Engine core | `packages/engine`: states, transitions, negotiation policy with floor and ceiling, scheduling with three offered slots and no-show handling; fixtures | none | 60+ fixtures green; adversarial lowball fixtures never breach the floor | Claude | yes |
| W7 | Item intake from a photo | Attachment download, Claude vision extraction (category, weight estimate, condition), comp price range, listing text; `items` rows; Listing Studio page | W2, W5 | Five test photos produce listings a tester would post for at least three | Claude | yes |
| W8 | Sell Elf and buyer DMs | A buyer texting their pool number is created as a `buyer` participant and run through the Deal Engine in their own space; owner gets threaded summaries | W6, W7 | The teammate's phone negotiates to the floor and books a slot while Gavin's chat shows the summary | Claude | yes |
| W9 | Pickup calendar and coverage | `slots` on the Crew Board; owner names who covers; confirmation messages to both sides | W8 | Booked slot shows on the board; a named cover is recorded | Claude | yes |
| W10 | Reaction and poll semantics | 👍 confirms, 👎 declines, ❤️ approves an override; `poll` for price approval and settlement | W6 | Fixtures per gesture; a reaction on a Sell thread changes deal state | Claude | yes |
| W11 | Money: rails, Nessie, escrow, Ledger | `MoneyRails` + fake + Nessie; Moving Fund and Escrow per move; hold, release, refund, purchase, split; Ledger page | W2, W8 | Hold appears on confirm and releases on hand-off; ledger reconciles to the cent | Claude | yes |
| W12 | Scam Shield | Five rules as pure functions with positive and negative fixtures; flags as threaded replies; owner override by reaction | W10 | "Venmo to hold it" flagged with the rule named; precision and recall reported | Claude | yes |
| W13 | Voice plumbing | Photon voice profile on the 740 line pointing at Retell over SIP; Retell agents created by script; custom-LLM websocket handler; post-call webhook | W4, Retell key (done) | A test call in each direction; transcript lands in `calls` | Claude builds, Gavin approves the profile | no |
| W14 | Haul Elf | Storage and truck quotes by call; booking on owner approval; purchase to Money Elf; Storrow/Memorial clearance check | W11, W13 | Outbound storage call returns a summary in 30 s and posts a purchase on 👍 | Claude | no |
| W15 | Green Elf and Move Report | Last Call schedule (T−48h drop, T−24h free, pickup booking, honest `dumped`); outcome tags; impact math with the factor table; Move Report page | W8 | Seeded move with a fake clock walks every stage; report reproducible from `events` | Claude | yes |
| W16 | Lease Elf | Lease PDF attachment to clause extraction (Claude or Daytona); sublet verdict; landlord notice draft; agreement PDF; applicant DMs in room mode | W2, W8 | A sample lease returns a verdict with quoted clauses; an applicant is screened by poll | Claude | no |
| W17 | Hunt and Buy Elves | Forwarded links and screenshots extracted in a Daytona sandbox; comps; ranked shortlist; offer drafts; seller DMs in buy mode | W6, Daytona key (done) | Ten listings rank in the expected order; a forwarded listing scores fair/high/scam | Claude | no |
| W18 | Map Elf on 2.0 | No Find My on the 2.0 API: the Move Map page asks the viewer's browser for location when opened from the link; ETAs and convergence computed server-side | W4, W9 | Two phones opening the link converge and the escrow release fires | Claude | no |
| W19 | Move-in Elf | Bridge stay and luggage drop search; utilities and address-change checklist by text | W2 | Checklist completes on a seeded move | Claude | no |
| W20 | Email channel | Domain verified on the project; Lease and Move-in Elves send and receive email | Gavin (DNS) | Landlord notice sent from the project; a reply lands as a message | Gavin then Claude | no |
| W21 | Evals and traces | Replay corpus from fixtures; policy evals (negotiation, scheduling, screening, routing) in CI; trace id on every event | W6, W12 | CI fails on a policy regression | Claude | no |
| W22 | Demo seed, README maps, Devpost, video | `scripts/demo-seed.ts`; Photon/Nessie/Daytona usage maps; eval results; 2-minute video | W5–W15 | A fresh seed runs the 90-second arc twice without a laptop touch | Team (video, Devpost), Claude (seed, README) | yes |
| W23 | Dedicated iMessage line | One consistent number, group chats, no assignment cap | Photon business plan for the weekend | `mode: dedicated` on the project; both phones reach the same number | Gavin via Photon team | no |

**Shortest path to the judge walkthrough:** W1 → W2 → W3 → W4 → W5 → W6 → W7 → W8 → W9 → W10 → W11 → W12 → W15 → W22. Voice (W13, W14) is the one sub-prize; it plugs in once the host exists and is skipped in the demo if it isn't ready.

## Setup checklist

Five items unblock Phase 1; the rest can lag. Secrets go in a `.env` file attached to the chat, never pasted inline, and never into the repo.

| # | Item | Where to get it | Unblocks | Owner | Done |
| --- | --- | --- | --- | --- | --- |
| 1 | Photon 2.0 project: `PHOTON_PROJECT_ID` + `PHOTON_API_KEY` (`pho_sk_…`) | app.beta.photon.codes → project → API keys | Phase 1 | Gavin | \[x\] |
| 2 | Test phones assigned on the iMessage shared pool (owner +1 XXX-XXX-XXXX → pool number +1 628-997-9661; teammate +1 XXX-XXX-XXXX → +1 628-263-4622) | `scripts/photon.ts assign` | Phase 1 (real iMessage) | Claude | \[x\] |
| 3 | Dedicated iMessage line (requires a Photon business plan; API returned `ENTITLEMENT_REQUIRED`) | Photon team at the sponsor fair, or dashboard billing | Group chats, one consistent number | Gavin | \[ \] |
| 4 | Workspace network allowlist: `*.photon.codes`, `*.supabase.co`, `api.supabase.com`, `api.nessieisreal.com`, `api.retellai.com`, `*.daytona.io` (`api.supabase.com` still missing) | claude.ai Settings → Capabilities | Migrations from the workspace | Gavin | \[ \] |
| 5 | Supabase project: `SUPABASE_URL`, anon key, service-role key | supabase.com → Settings → API | Phase 1 | Gavin | \[x\] |
| 6 | Supabase personal access token for migrations through the Management API | supabase.com/dashboard/account/tokens | Phase 1 | Gavin | \[x\] |
| 7 | Anthropic API key (Claude is the LLM; Grok dropped) | console.anthropic.com | Phase 1 | Gavin | \[x\] |
| 8 | GitHub: Claude GitHub App installed on `arshiyasharma/hackharvard` so pushes work | github.com/apps/claude/installations/select\_target | Pushes (local commits + bundles otherwise) | Repo owner | \[ \] |
| 9 | Nessie API key | nessieisreal.com | Phase 3 | Gavin | \[x\] |
| 10 | Retell API key | retellai.com | Phase 4 | Gavin | \[x\] |
| 11 | Voice profile on the 740 line pointing at Retell over SIP | Photon dashboard → Voice (or API) | Phase 4 | Claude via API, Gavin approves | \[ \] |
| 12 | Daytona API key | daytona.io | Phase 5 | Gavin | \[x\] |
| 13 | Public host for the service and mini apps (Railway or Fly token, or a tunnel from a laptop) | Team choice | W4: WebSocket inbound, links in chat, webhooks | Gavin | \[ \] |
| 14 | Email domain verified on the project (DNS records) | Photon dashboard → Email | Phase 5 | Gavin | \[ \] |

**Until items 2–4 arrive:** the service, the Deal Engine and the Elves are developed against the in-memory script transport (no credentials) with the in-memory store and a `MoneyRails` fake. Everything built this way runs unchanged on the real Photon 2.0 transport, because the Elves never touch a transport directly.

## Division of labor

Claude builds the backend end to end in this workspace and pushes to the shared repo; the team owns accounts, phones, design review, the demo and anything that needs a human in a dashboard. Owners for the mini-app front end and the Retell call personas are open until the roster is confirmed.

| Workstream | Claude builds | Team owns |
| --- | --- | --- |
| Foundation | Monorepo scaffold, Photon service, pipeline, Supabase schema and migrations, Elf contract, Crew Board card plumbing | Photon project, Supabase project, allowlist, repo, phones |
| Deal Engine | State machine, fixtures, Inventory extraction, Listing Studio API, Sell and Buy Elves, calendar sync | Review of negotiation tone and floor-price behavior; listing copy voice |
| Money | `MoneyRails`, Nessie client, escrow lifecycle, Ledger API, Scam Shield rules and fixtures | Nessie key; judgment calls on rule thresholds |
| Voice and Map | Retell agent creation scripts, custom-LLM call handler, SIP config checklists, post-call webhook, Map Elf, Find My flow | Voice profiles in the Photon dashboard; test calls from real phones; persona scripts |
| Rooms and Move-in | Lease parsing, email channel handlers, Hunt and Buy extraction in Daytona, agreement generation, Move-in checklist | Domain and DNS for email; sample leases to test on; sublet sites to target first |
| Green and scale | Last Call scheduler, Move Report, Curb Map API and page, eval harness, traces, Stripe Connect rails | Factor table review; Curb Map launch neighborhoods; content post |
| Mini apps | Next.js routes, Supabase Realtime wiring, signed-token auth, `sendPrompt` actions | Visual design pass; phone-width QA on real devices |
| Demo and submission | `demo-seed` script, README usage maps, eval results page | Video, Devpost copy, rehearsal, the live judge walkthrough |

**Working agreement:** every change lands as a PR with its acceptance test from the phase breakdown below; the terminal-provider run and the fixture suite are the merge gate; nothing touches a real line without a registered test phone on the other end.

## Repo layout, stack and conventions

One TypeScript monorepo. The Deal Engine and the money rails are pure packages with no I/O so they can be tested without any account; providers, databases and third-party APIs are injected at the edge.

```markdown
elves/
  apps/
    elves/            # the service: Photon loop, pipeline, Elves, call handler, webhooks (Bun + Hono)
    web/              # mini apps: Next.js routes, Supabase Realtime, signed-token auth
  packages/
    engine/           # Deal Engine state machine, scheduling, Last Call schedule; pure, fixture-tested
    elves/            # one folder per Elf: prompt, tools, handle(); shares the Elf contract
    rails/            # MoneyRails interface + fake; nessie/ and stripe/ implementations
    photon/           # thin wrappers over spectrum-ts: cards, effects, polls, locations, fallbacks
    voice/            # Retell client, custom-LLM websocket handler, post-call webhook verification
    extract/          # Daytona jobs: listing pages, lease PDFs, walkthrough video -> JSON schemas
    evals/            # replay corpus, policy evals, Chalk runner
    shared/           # zod schemas for every table and event; generated Supabase types
  supabase/
    migrations/       # schema from the design doc
    functions/        # Edge Functions: Curb Map public read
  scripts/
    demo-seed.ts      # resets the demo move
    retell-agents.ts  # creates or updates the call-type agents
  .env.example
```

**Stack**

| Layer | Choice | Why |
| --- | --- | --- |
| Runtime | Bun + TypeScript 5 | One toolchain for the service, scripts and tests |
| Messaging | Photon 2.0 API: REST for users, spaces, messages, attachments, typing; Socket.IO event stream for inbound | The product the hackathon names; works from anywhere without a public URL |
| HTTP | Hono | Mini-app pages, Retell webhooks, health, the owner-choice endpoint |
| Queue | In-process per-space queues now; BullMQ on Redis when the service runs more than one instance | Photon's documented debounce, cancel and carry-forward pipeline |
| Models | Grok via xAI's OpenAI-compatible API: a fast model for routing and extraction, a larger one for negotiation and drafting; a FakeLLM for tests | Latency where it shows, quality where it pays |
| DB | Supabase Postgres with RLS; Realtime for the mini apps; Storage for photos and PDFs | One shared state, live views |
| Mini apps | Server-rendered pages from the same Bun service (Hono + HTML), phone-width, no navigation | One public URL; links unfurl in iMessage; Realtime client |
| Voice | Retell over Photon SIP, with the custom-LLM websocket so the owning Elf runs the call | The only path to real calls until Photon exposes call control |
| Sandbox | Daytona | Untrusted extraction runs outside the service |
| Evals | Chalk Agent Evals over the replay corpus | Prove the policies, not just demo them |
| Tracing | OpenTelemetry to Honeycomb (or the Supabase `events` table alone early on) | One trace per inbound batch |

**Conventions:** every table has a zod schema in `packages/shared` and a generated type; every Elf is `handle(space, message, ctx) → ElfResult`; every external call goes through an interface with a fake; events are append-only; money is integer cents; phone numbers are E.164; no secrets outside `.env` and the deploy's secret store.

## Phase 1: Foundation

Gate: three rapid texts become one reply; the Crew Board card edits in place from a script; an iPhone and an Android both get a tapback, typing and a threaded reply. Tasks 1.1–1.6 need no credentials.

| # | Task | Acceptance test | Needs | Status |
| --- | --- | --- | --- | --- |
| 1.1 | Monorepo scaffold: Bun workspaces, TypeScript, Biome, tests, `.env.example`, CI running the fixture suite | `bun test` green on a fresh clone | — | done |
| 1.2 | `packages/shared`: zod schemas for `moves`, `participants`, `items`, `deals`, `slots`, `ledger`, `elf_status`, `calls`, `events`; event union type; Store interface + MemoryStore | Schema round-trips every fixture row | — | done |
| 1.3 | `supabase/migrations`: tables, RLS policies, indexes, append-only `events` trigger, realtime publication; `scripts/migrate.ts` through the Management API | Migration applies to the project; RLS blocks cross-move reads | `api.supabase.com` allowed | written, not yet applied |
| 1.4 | Transport interface (`inbound()`, `send`, `react`, `typing`, `read`, `createSpace`, `createUser`) with two implementations: `script` (in-memory) and `photon2` (REST + Socket.IO events with cursor replay) | Script transport echo in tests; Photon transport receives a real iMessage/SMS and replies in-thread | Photon API key, assigned phones | script done; photon2 next |
| 1.5 | Pipeline: per-space queue, debounce window, batch flush, cancellation flag per stage, carry-forward table, idempotent send with keys | Three messages 200 ms apart yield one batch; a fourth mid-flight cancels and carries forward; a retried send does not double-post | — | done |
| 1.6 | Elf contract: `handle()` signature, `ElfResult`, stub Elves, the Crew Lead's router (thread ownership, Grok classification, keyword fallback) | Router fixtures: 36 messages map to the expected Elf | Grok key for the LLM path | done |
| 1.7 | Participant and move bootstrap: first message from an unknown number creates a move and an owner participant; group space created with the owner when a roommate is named | New number → move row; a named roommate becomes a participant in a group space | Photon transport | memory path done |
| 1.8 | Crew Board page served by the service; link sent once per move; page updates over Realtime | Script flips an Elf's status and the page changes on the phone | Public host, Supabase store | — |
| 1.9 | Supabase store implementation passing the same contract tests as MemoryStore; `sends` table for idempotency keys | Store contract suite green against the project | Service-role key | next |
| 1.10 | Phone assignment and line management scripts: assign test phones to the iMessage pool, inspect lines, provision the dedicated line on approval | Owner and buyer phones listed as assignments; a real text reaches the loop | Phone numbers | — |
| 1.11 | Deliverability guard in the send stage: per-line counters, opt-in check before any proactive space creation, no links in a first message | Counter blocks past the per-line cap; a first message with a link is rewritten | — | — |
| 1.12 | Observability: trace id per batch carried on every event; structured logs; `/events/:moveId` and `/board/:moveId` debug endpoints | One trace shows debounce → route → Elf → send | — | done |

**Deliverable at gate:** a number that answers like a staffed line, a group that renames itself, a board card that changes on the phone, and a pipeline the rest of the Elves plug into.

## Phase 2: Deal Engine

Gate: a stranger's DM negotiates to the floor price, is offered three slots, books on first confirmation, and the owner chat gets a threaded summary and confetti without the owner typing.

| # | Task | Acceptance test | Needs |
| --- | --- | --- | --- |
| 2.1 | `packages/engine` state machine: \`listed → negotiating → scheduled → handed\_off → paid | relisted | donated |
| 2.2 | Negotiation policy: floor and ceiling enforced in code; counter-offer band and acceptance rule; "ask the owner" when a buyer pushes past the floor; buyer reliability score from response latency and no-shows | 40 adversarial fixtures (lowball, split-the-difference, "my friend will pay more") never breach the floor | — |
| 2.3 | Scheduling: shared pickup calendar per move, at most three offered slots, first confirmation books, no-show reschedules once then refunds; coverage name recorded on the slot | Fixtures for double-booking, no-show, owner-named coverage | — |
| 2.4 | Calendar sync: Google Calendar read for busy times and write for booked pickups; Apple via ICS feed | A booked slot appears on the owner's calendar | Google OAuth app |
| 2.5 | Inventory extraction: walkthrough video → frames → items with category, estimated weight, owner, comp price range; runs in Daytona; owner edits via the Inventory page | A 60 s test video yields a list a human agrees with on 80% of items | Daytona, model key |
| 2.6 | Listing Studio: title and description generation in the owner's voice, photo clean-up, price from comps, copy-per-marketplace, the number as contact | A listing a tester would post without edits for 3 of 5 items | Model key, Vercel |
| 2.7 | Sell Elf: new inbound number on the Sell line → buyer participant and space; listing lookup by item words or photo; runs policy 2.2 and 2.3; `contact()` to owner on confirmation; `effect(confetti)`; cross-space summaries as threaded replies | Terminal provider run with two simulated spaces passes the gate; then a real second phone | Photon project |
| 2.8 | Buy Elf: forwarded link or screenshot → extraction in Daytona → verdict against comps and Curb Map; drafted offer; negotiation when the seller texts in | Fixtures for fair, high and scam listings | Daytona |
| 2.9 | Owner controls in-thread: "go lower", "hold at X", "pull it", "who's covering Saturday"; tapback semantics (👍 confirm, 👎 decline) | Each control changes engine state and the Crew Board row | — |
| 2.10 | Inventory and Listing Studio pages with Realtime and `sendPrompt` actions (price slider posts "set floor to $X") | Slider change arrives in the chat as the owner's message | Vercel |

**Deliverable at gate:** the Sell Elf runs a complete sale with a stranger, and the engine that did it is the same code the room and buy modes will use.

## Phase 3: Money

Gate: a hold appears on the Ledger when a buyer confirms and releases on hand-off; a "pay on Zelle to hold it" message is flagged with the rule named; every Scam Shield rule's fixtures pass.

| # | Task | Acceptance test | Needs |
| --- | --- | --- | --- |
| 3.1 | `packages/rails`: `MoneyRails` interface (`ensureCustomer`, `openFund`, `openEscrow`, `hold`, `release`, `refund`, `purchase`, `split`) and an in-memory fake | Engine fixtures run against the fake | — |
| 3.2 | Nessie implementation: customers, checking (Moving Fund) and savings (Escrow) accounts, deposits, transfers, withdrawals, purchases with merchants; idempotency by deal id; every response cached in `ledger` | Each interface method round-trips against Nessie; a retried hold does not double | Nessie key |
| 3.3 | Escrow lifecycle wired to the engine: hold on buyer confirm; release on two signals (buyer confirm message + owner tapback, or buyer confirm + Map convergence); refund on no-show past 24 h or owner cancel | Fixtures for each signal combination; one signal alone never releases | — |
| 3.4 | Sublet deposits on the same rails: hold on agreement acceptance, release on key hand-off | Room-mode fixture passes | — |
| 3.5 | Purchases and splits: Haul bookings post as purchases on owner tapback; shares the owner names settle as transfers with a `poll` for approval | Ledger reconciles to the cent across a seeded move | — |
| 3.6 | Scam Shield: five rules as pure functions with positive and negative fixtures; flags post as threaded replies naming the rule; one-tap owner override; counterparty marked on the Crew Board | Precision and recall reported per rule on the fixture set | — |
| 3.7 | Ledger page: fund balance, holds by status, purchases by merchant, shares outstanding with settle buttons, deposit tracker, net cost of the move; Realtime | Numbers on the page equal the `ledger` rows | Vercel |
| 3.8 | Security: secrets only in the service; signed move-scoped card tokens with 24 h expiry; RLS on every mini-app read; counterparties never see the owner's number | Token for move A cannot read move B; expired token refused | — |

**Deliverable at gate:** money moves only through escrow, every dollar is on one card, and the scam rules are measured rather than claimed.

## Phases 4–6

These reuse the engine, the rails and the pipeline; the new work is integrations and the sustainability layer.

**Phase 4: Voice and Map.** Gate: an outbound storage call returns a summary in 30 s and posts a purchase on approval; an inbound buyer call offers a slot by text; convergence plus confirm releases escrow.

| # | Task | Acceptance test | Needs |
| --- | --- | --- | --- |
| 4.1 | `scripts/retell-agents.ts`: creates or updates one agent per call type with dynamic variables, max duration and the custom-LLM websocket URL; persona scripts in `packages/elves/haul/calls/` | Script is idempotent; agents listed by name | Retell key |
| 4.2 | SIP checklist per line (Photon voice profile, SHA-256 outbound, Retell SIP endpoint over TLS, codecs) as a runbook plus a `photon` CLI verification step | Test call in both directions on each line | Voice profiles |
| 4.3 | `packages/voice`: custom-LLM websocket handler that routes each call turn to the owning Elf with the move's context and tools; post-call webhook (signature verified) → `calls` row | A simulated call transcript round-trips through the handler with correct tool calls | — |
| 4.4 | Haul Elf: call brief from the move; outbound call via Retell API; summary from call analysis → threaded reply → purchase on owner tapback | Gate call passes with a teammate playing the facility | — |
| 4.5 | Inbound routing: Sell and Lease lines answer with listing or room context; Crew Lead line offers a warm transfer to the owner or a callback task; voicemail → transcript reply | Caller gets a slot by text within a minute of hanging up; a transfer reaches the owner with a spoken brief | — |
| 4.6 | Map Elf: Find My consent request with reason; `watch()` stream → location rows with expiry; convergence detector (both within 100 m of the address) → event | Simulated streams trigger convergence exactly once | — |
| 4.7 | Move Map page: addresses, positions, ETAs, next slot, truck route with Storrow and Memorial Drive clearance warnings | Route through a flagged road shows the warning | Vercel, maps key |

**Phase 5: Rooms and Move-in.** Gate: a lease PDF returns a sublet verdict and a landlord notice email from the project; an applicant is screened and signs an agreement by poll; a sublet deposit runs through escrow; a forwarded listing is scored against comps.

| # | Task | Acceptance test | Needs |
| --- | --- | --- | --- |
| 5.1 | `packages/extract`: Daytona jobs for lease PDFs (clauses: sublet, notice, deposit, guests), listing pages (price, dates, address, photos), screenshots; strict JSON schemas out | Fixture documents extract to expected JSON | Daytona |
| 5.2 | Lease Elf: verdict and clause quotes; landlord notice drafted and sent on the email channel; replies land as messages; agreement PDF generated and accepted by `poll` from both parties | Gate items 1 and 2 | Email channel |
| 5.3 | Room mode of the engine: applicant spaces, screening, viewing slots, deposit via 3.4; Room page | Gate item 3 | — |
| 5.4 | Hunt Elf: requirements parsed and stored; forwarded links extracted and ranked; re-rank on changed requirements; viewing scheduling; outreach drafts | Ranking fixture: 10 listings, expected order | — |
| 5.5 | Move-in Elf: bridge-stay search, luggage drop, utilities and address-change checklist with email filing, move-in photo record | Checklist completes on a seeded move | Email channel |

**Phase 6: Green and scale.** Gate: a lamp at T−24h relists free, pins on the Curb Map and books a pickup; the Move Report's number is reproducible from events; eval pass rates per policy run on every commit; a claimed pin counts on both Move Reports.

| # | Task | Acceptance test | Needs |
| --- | --- | --- | --- |
| 6.1 | Last Call scheduler: T−48h price drop, T−24h free relist, donation or 311 booking, T−0 dumped tag; owner pull-out by tapback | Seeded move with a fake clock walks every stage | — |
| 6.2 | Impact accounting: category factor table with EPA WARM citations; weights editable; diverted weight and CO2e computed from events only | Report recomputed from `events` equals the stored report | — |
| 6.3 | Move Report page and card with `effect(balloons)`; shareable image export | Image renders with the factor source linked | Vercel |
| 6.4 | Curb Map: opt-in pins from free relists, public read through an Edge Function, text-to-claim link opening a DM with the owner's Sell Elf, claim counted on both reports after pickup | Two seeded moves share a map; a claim moves weight on both | — |
| 6.5 | Eval harness: replay corpus from fixtures and consented real moves; policy evals for negotiation, scheduling, screening, routing; Chalk runner; pass rates in CI | CI fails on a policy regression | Chalk |
| 6.6 | Stripe Connect behind `MoneyRails` (manual capture = hold, capture = release, void = refund); feature flag per move | Rails fixtures pass on both implementations | Stripe test keys |
| 6.7 | Load: Sell line auto-scale, per-line counters, queue backpressure; a turnover-week simulation of 200 concurrent buyer conversations | p95 reply under 4 s in the simulation | — |

## Testing strategy

Four layers, cheapest first; nothing reaches a real phone until the layers below it pass.

1. **Pure fixtures.** The engine, the policies, Scam Shield and the rails fake are tested as functions over events. This is the merge gate and runs in under a minute.
2. **Terminal provider runs.** The whole service runs with `terminal.config()` and multiple simulated spaces (owner group, buyer DM, applicant DM). Every Elf is exercised end to end here, including app-card edits, which log instead of render. No credentials needed.
3. **Replay evals.** Recorded conversations (fixtures first, consented real moves later) are replayed through the Crew Lead and each Elf; the expected action is checked per turn. Chalk's Agent Evals runs this in CI and tracks pass rates per policy per commit.
4. **Real-line checks.** A registered test iPhone and Android run the phase gate scripts against the live Photon lines. Each check is scripted so it can be re-run after any Photon-side change (line allocation, quota, plan).

**Demo seed.** `scripts/demo-seed.ts` resets one move to a known state at any phase (listed items, a confirmed buyer, an escrow hold, a pending call) so a live walkthrough can start from any step and so a broken step can be shown from its end state.

**What is not mocked:** Photon's own behavior on a real line. Tapbacks, effects, app cards, Find My and group metadata are confirmed on devices, not assumed from the docs.

## Decisions

**Taken**

- Build on the Photon 2.0 API (REST + event stream), not the stable Spectrum SDK; the team's project is a 2.0 project and 2.0 is what the brief names.
- Claude is the LLM: `claude-haiku-5-5` for routing and extraction, `claude-sonnet-5-5` for negotiation and drafting; Grok dropped after its key failed.
- Roommate Elf deferred; coverage is a name in the thread, item ownership lives in the Inventory, shares the owner names go to the Money Elf.
- Build starts against the in-memory script transport with the in-memory store and a `MoneyRails` fake; real implementations are injected, never imported by Elf code.
- The first message in the owner chat always goes to the Crew Lead; routing by content starts with the second.
- One modular-monolith service plus a worker pool; split only when the Sell line's load demands it.
- The Photon number is the listing's contact; no automated posting to marketplaces.
- Mini apps are hosted pages sent as links (no app cards on 2.0); served by the same service behind one public URL.
- Nessie is the ledger and escrow model; real money moves on Venmo outside the product; real rails are in the Backlog.
- Voice through Retell over SIP until Photon exposes call control.
- Map Elf uses browser geolocation from the Move Map link (no Find My on 2.0).
- Telegram, Android, Stripe and the video walkthrough are in the Backlog; one photo per item is the intake.

**Open**

- [ ] Final product name (chat avatar, Elf contact cards and mini-app branding derive from it)
- [ ] Team roster and owners for the mini-app front end and the Retell call personas
- [ ] Public host: Railway, Fly, or a tunnel from a laptop for the weekend
- [ ] Whether Photon will bump the project to a business plan for the dedicated iMessage line
- [ ] Redis host for the queue when the service runs more than one instance (Upstash), or stay single-instance for the weekend
- [ ] Maps provider for the Move Map (Mapbox or Google) and who holds the key
- [ ] Curb Map launch neighborhoods and the public-read policy for pins
- [ ] Devpost: can one entry tag both Sustainability and Fintech-CyberSec

# Elves — a moving crew you text

HackHarvard 2026. Ten specialist agents ("Elves") live in your iMessage/SMS thread on Photon 2.0 lines and run a move end to end: sell the furniture, book the truck and storage, handle the lease, settle the money, keep things out of the landfill. This repo is the service behind the number.

Design doc and implementation plan: see the team's Notion. This README is the engineering map.

## Status

Phase 1 (foundation) is live:

- A text to an assigned pool number gets a read receipt, a typing indicator and a Crew Lead reply written by Claude, with the move-out date and items captured into the move.
- Three rapid texts become one reply (per-space debounce with cancel and carry-forward).
- Photo intake: an iPhone photo (HEIC) is downloaded, decoded, identified by Claude vision (item, condition, weight, fair resale range, listing title and description) and becomes an `items` row with a suggested list price.
- Sell Elf: a dollar amount sets the floor; the list price is held at the range's upper middle and never below the floor; "yes, list it" marks it approved. Buyers reach it by texting the same number (buyer DMs are the next ticket).
- The Crew Lead routes follow-ups to the right Elf (thread ownership → photo/price rules → Claude classification → keyword fallback); the remaining Elves are stubs that acknowledge in their own voice and update the Crew Board.
- Hosted on Railway: `https://elves-production.up.railway.app/health`.

Next: Deal Engine (`packages/engine`), Supabase store, Sell Elf with buyer DMs, Money (Nessie), Scam Shield, Last Call. See the implementation plan's work queue.

## Run it

```bash
bun install
cp .env.example .env        # fill in PHOTON_PROJECT_ID, PHOTON_API_KEY, ANTHROPIC_API_KEY
bun test                    # 69 tests, no credentials needed
bun run demo                # the whole arc against the in-memory transport, no credentials needed
bun run start               # the service: polls Photon, answers texts, serves the Crew Board
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
| `PUBLIC_URL` | HTTPS origin for mini-app links; links are only sent when set |
| `PORT` | HTTP port (`/health`, `/moves`, `/board/:moveId`, `/events/:moveId`, `/b/:moveId` Crew Board page) |

## Layout

```
apps/elves/          the service: config, batch handler (service.ts), Hono server, boot
packages/shared/     domain types, Store contract, MemoryStore, logger
packages/photon/     Photon 2.0 REST client, poll + Socket.IO inbound, normalization, script transport
packages/pipeline/   per-space debounce, batch, cancel + carry-forward, deterministic send keys
packages/llm/        LLM contract; ClaudeLLM (structured outputs via zod) and FakeLLM
packages/elves/      Elf contract, router, fact extraction, Crew Lead, stub Elves
scripts/             photon operator CLI, offline demo
```

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

`Dockerfile` + `railway.json`. `railway up -s elves` from a linked checkout; variables live in the Railway service, never in the repo. The store is in-memory for now, so run exactly one replica.

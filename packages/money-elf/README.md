# @elves/money-elf — the Money Elf

Spec section 3: every dollar in a move on one Ledger, and no money moves without the owner's OK. The Ledger lives in Nessie: every movement is a tagged Nessie record, and the totals are read back live (`src/books.ts`). Decisions and their reasons: `money-elf-decisions.md` at the repo root.

## What it does

| Owner texts | Money Elf |
| --- | --- |
| `split the $240 truck with Sam and Priya` | Logs the expense and each share, then asks to send the requests |
| `yes` | Approves the most recent pending action only: Nessie bills, plus texts to each roommate (`outbound`) |
| `Sam is 617-555-0101` | Saves the number and sends any approved request that was waiting for it |
| `Sam paid me on venmo` | Marks Sam's share paid (off-ledger, nothing moves in Nessie) |
| `I paid a $500 holding deposit on the sublet, due back Dec 1` | Logs the deposit and its due-back date |
| `got the sublet deposit back` | Marks the deposit returned |
| `Alex picked up the couch` | Asks to OK the release of the escrowed sale money; on `yes` it moves into the Moving Fund once Alex has also confirmed pickup (two signals, either order) |
| `the desk pickup fell through` | Asks to refund the buyer; `yes` refunds and texts them. A no-show 24h past the pickup time asks the same (see the sweep below) |
| `pay Sam $40 for gas` | Asks, then sends on `yes`, from the Moving Fund when it covers it |
| `let Sam pay the truck at $40 a month` | Offers Sam a Moving Fund loan; `yes` opens it in Nessie |
| `show me the ledger` / `ledger` | The Ledger card (an image) plus a signed link to the live Ledger page, both read live from Nessie |
| anything scam-shaped | Warns in plain words; a flagged payment is never staged or paid |

Anything that needs your yes also comes with a tap-to-answer poll (Yes / Not now). The tap approves exactly that action.

Roommates can reply `PAID` or `PAID $50` (money moves into the owner's Moving Fund checking account, and the owner is told), ask for a payment plan ("can I do $20 a month?", which needs the owner's yes), or ask what they owe. Buyers get the escrow notice and confirm pickup by texting `got it` (their half of the release; if the owner hasn't OK'd yet, the owner gets a poll).

## Wiring it into the service

```ts
import { moneyElfFromEnv } from "@elves/money-elf";
const money = moneyElfFromEnv(); // Nessie when NESSIE_API_KEY is set, otherwise FakeRails
// in packages/elves/src/index.ts, replace the "money" stub in allElves with:
const moneyElf: Elf = { ...money, handle: (ctx) => money.handle(ctx) };
```

`handle()` takes the foundation `ElfContext` as is, and returns an `ElfResult` plus new fields the service has to send. None of this is wired yet (decision #37):

- `outbound: {toHandle, text, poll?}[]`: messages to other people (roommates, buyers, the owner).
- `images: {contentType, filename, bytes, alt}[]`: upload each with `POST /v1/projects/{id}/attachments` (multipart/related: a JSON part `{contentType, sizeBytes, filename}`, then the bytes), then send `{type:"attachment", attachmentId}` after the reply text.
- `poll: {question, options, selectionMode}`: send as `{type:"poll", ...}` after the reply text.
- Inbound: map a `poll.vote` content's `selectedOptions` onto the message's `pollVote`, and route any vote whose option id starts with `money:` to this Elf. Today the foundation router sends empty-text messages to the Crew Lead.
- Live Ledger page: `app.get("/ledger/*", async (c) => (await createLedgerHandler({ service: money.service, links })(c.req.raw)) ?? c.notFound())`, with `PUBLIC_URL` and `LEDGER_LINK_SECRET` set. `moneyElfFromEnv()` reads both. The Stuff Elf opens escrow with `money.service.openEscrow(move, { item, buyerName, buyerHandle, amountCents, pickupAt })`. The Deal Engine can call `confirmPickup(move, { via: "engine", entryId })` when it sees the buyer confirm, `mapConverged(move, entryId)` when Move Map pins meet (a stub hook that counts as the owner's 👍), `setPickupTime(move, entryId, iso)` for the one reschedule, and `sweepNoShows(move)` from its periodic sweep (stages a refund with a poll to the owner for each buyer 24h past pickup; nothing moves without the owner's yes). The Ledger is in memory (`MemoryMoneyStore`), like the rest of the store today. `MoneyStore` is the interface to put Supabase behind.

Events: `loan.created`, `payment.requested`, `payment.received`, `payment.sent`, `escrow.opened`, `escrow.owner_ok`, `escrow.buyer_confirmed`, `escrow.map_converged`, `escrow.no_show`, `escrow.released`, `escrow.refunded`, `deposit.recorded`, `deposit.returned`, `scam.flagged`, `approval.requested|granted|cancelled`, `ledger.entry_added`, `ledger.totals`, `money.sensitive_blocked`, `money.error`.

## Install

`bun install` at the repo root. To add a dependency, follow `.claude/skills/money-elf-add-dependency`.

## Run it locally

Chat with the Money Elf in your terminal, as the owner, a roommate or a buyer:

```bash
bun run packages/money-elf/scripts/chat.ts            # fake payments, nothing leaves your machine
bun run packages/money-elf/scripts/chat.ts --nessie   # real Nessie sandbox calls (NESSIE_API_KEY in .env)
```

Inside, type texts as the owner would. Slash commands switch who's talking and show state: `/as roommate Sam`, `/as buyer +16175550199`, `/sale couch Alex $90` (a buyer paying into escrow, the Stuff Elf's future hand-off; it prints the buyer's test number, and `late` makes the pickup 25h overdue), `/map couch` (Move Map convergence), `/sweep` (the no-show sweep), `/ledger`, `/books` (what's in Nessie, account by account), `/pending`, `/events`, `/reset`, `/help`. Messages the Elf would text other people show up as `-> text to <phone>`. Polls print as numbered options; `/vote 1` taps one. `show me the ledger` saves the card under `.data/` (`/open` views it) and prints a signed link to the live page, which the chat serves on `http://localhost:8787` (`--port` to change it). You can also pipe a script: `printf 'split the $60 gas with Sam\nyes\n' | bun run packages/money-elf/scripts/chat.ts`.

Parsing in the local chat uses the rule parser only (no LLM); in the service, Claude parses first, with the rules as the backup.

```bash
bun test packages/money-elf                       # offline, no credentials
bun run packages/money-elf/scripts/smoke.ts       # scripted live run against Nessie
```

Nessie quirks (balances never move, transfers have no payee, bills need `recurring_date`): see `.claude/skills/nessie/SKILL.md`.

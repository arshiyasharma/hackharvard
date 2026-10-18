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
| `show me the ledger` / `ledger` | The Ledger card (an image) plus a signed link to the live Ledger page, both read live from Nessie. Both lead with the **move cost projection**: net cost so far, projected net cost once expected money comes back, and a chart of when (scheduled dates solid, estimates hollow) |
| anything scam-shaped | Warns in plain words; a flagged payment is never staged or paid |
| `plan my move under $300` | **Move Plans.** Three plans for the rest of the move (what to sell and at what price, what to drop now, donate or haul, truck size, movers), each with a likely final cost and its chance of finishing under budget, plus a picture and an A / B / C poll. The odds come from 2,000 simulated moves per plan over the assumptions table in `src/plans.ts`, so they're estimates and labeled that way |
| `go with B` / tap a plan | Picks it (that's your yes; nothing moves). The plan is written to Nessie as **pending, future-dated records**: each likely sale is a pending deposit into the Moving Fund, the truck and movers are pending withdrawals. A switch cancels the old plan's pending records first. Emits `plan.chosen` with each item's price and drop date; the Money Elf never edits a listing |
| `what plan am I on` / `drop the plan` | The plan's current odds, what's behind and what's next; or cancel its pending records |

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

- `outbound: {spaceId, toHandle, text, poll?}[]`: messages to other people (roommates, buyers, the owner), in the crew's `ElfOutbound` shape. The owner's go to `move.ownerSpaceId`, and everyone else's to the space they text from (via `ctx.store`). A handle with no space yet (they've never texted Elves, so the shared pool can't reach them) isn't sent. Instead the owner's reply ends with one line saying who to talk to and about what ("Talk to Priya about the $30 gas share; ..."), and an `outbound.unreachable` event is logged.
- `images: {contentType, filename, bytes, alt}[]`: upload each with `POST /v1/projects/{id}/attachments` (multipart/related: a JSON part `{contentType, sizeBytes, filename}`, then the bytes), then send `{type:"attachment", attachmentId}` after the reply text.
- `poll: {question, options, selectionMode}`: send as `{type:"poll", ...}` after the reply text.
- Inbound: map a `poll.vote` content's `selectedOptions` onto the message's `pollVote`, and route any vote whose option id starts with `money:` to this Elf. Today the foundation router sends empty-text messages to the Crew Lead.
- Live Ledger page: `app.get("/ledger/*", async (c) => (await createLedgerHandler({ service: money.service, links })(c.req.raw)) ?? c.notFound())`, with `PUBLIC_URL` and `LEDGER_LINK_SECRET` set. `moneyElfFromEnv()` reads both. The Stuff Elf opens escrow with `money.service.openEscrow(move, { item, buyerName, buyerHandle, amountCents, pickupAt })`. The Deal Engine can call `confirmPickup(move, { via: "engine", entryId })` when it sees the buyer confirm, `mapConverged(move, entryId)` when Move Map pins meet (a stub hook that counts as the owner's 👍), `setPickupTime(move, entryId, iso)` for the one reschedule, and `sweepNoShows(move)` from its periodic sweep (stages a refund with a poll to the owner for each buyer 24h past pickup; nothing moves without the owner's yes). The Ledger is in memory (`MemoryMoneyStore`), like the rest of the store today. `MoneyStore` is the interface to put Supabase behind.

Move Plans: `elf.plans.sweep(move, items)` is for the periodic sweep. A sold or given item settles its plan record `completed`, a donated or dumped one `cancelled`. An item past the day the plan expected it to sell, with the chance under budget down 10 points or more, sends the owner one nudge per item with a poll to switch to fresh plans. Items come from `ctx.store.listItems` (the crew Store has it) and move-out from `move.moveOutAt`. Without them the Elf says it can't plan, instead of guessing. The Ledger card and page show the chosen plan's path (a 10–90% band, with your real net cost drawn over it) and its records read live from Nessie. Decisions #53–#57.

Events: `plan.drafted`, `plan.chosen`, `plan.switched`, `plan.cancelled`, `plan.drift`, `plan.line_settled`, `plan.stale_vote`, `plan.error`, `loan.created`, `payment.requested`, `payment.received`, `payment.sent`, `escrow.opened`, `escrow.owner_ok`, `escrow.buyer_confirmed`, `escrow.map_converged`, `escrow.no_show`, `escrow.released`, `escrow.refunded`, `deposit.recorded`, `deposit.returned`, `scam.flagged`, `approval.requested|granted|cancelled`, `ledger.entry_added`, `ledger.totals`, `money.sensitive_blocked`, `money.error`.

## Install

`bun install` at the repo root. To add a dependency, follow `.claude/skills/money-elf-add-dependency`.

## Run it locally

Chat with the Money Elf in your terminal, as the owner, a roommate or a buyer:

```bash
bun run packages/money-elf/scripts/chat.ts            # fake payments, nothing leaves your machine
bun run packages/money-elf/scripts/chat.ts --nessie   # real Nessie sandbox calls (NESSIE_API_KEY in .env)
```

Inside, type texts as the owner would. Slash commands switch who's talking and show state: `/as roommate Sam`, `/as buyer +16175550199`, `/sale couch Alex $90` (a buyer paying into escrow, the Stuff Elf's future hand-off; it prints the buyer's test number, and `late` makes the pickup 25h overdue), `/map couch` (Move Map convergence), `/sweep` (the no-show sweep), Move Plans with `/items [days]` (seeds a couch, desk, bookshelf, lamp and a kept mattress, with move-out in 10 days), `/moveout`, `/sold <item>`, `/donated <item>`, `/plansweep`, `/plans` and `/ff <days>` (fast-forwards the clock, so plan dates come due), `/ledger`, `/books` (what's in Nessie, account by account), `/pending`, `/events`, `/reset`, `/help`. Messages the Elf would text other people show up as `-> text to <phone>`. Polls print as numbered options; `/vote 1` taps one. `show me the ledger` saves the card under `.data/` (`/open` views it) and prints a signed link to the live page, which the chat serves on `http://localhost:8787` (`--port` to change it). You can also pipe a script: `printf 'split the $60 gas with Sam\nyes\n' | bun run packages/money-elf/scripts/chat.ts`.

Parsing in the local chat uses the rule parser only (no LLM); in the service, Claude parses first, with the rules as the backup.

Move Plans demo, against the live sandbox:

```bash
printf '/items\nsplit the $360 storage unit with Sam\nyes\nplan my move under $150\n/vote 1\n/books\n/ff 5\n/sold desk\n/plansweep\n/vote 2\n/books\n' \
  | bun --env-file=.env run packages/money-elf/scripts/chat.ts --nessie
```

```bash
bun test packages/money-elf                       # offline, no credentials
bun run packages/money-elf/scripts/smoke.ts       # scripted live run against Nessie
```

Nessie quirks (balances never move, transfers have no payee, bills need `recurring_date`, pending deposits and withdrawals settle with PUT but purchases can't): see `.claude/skills/nessie/SKILL.md`.

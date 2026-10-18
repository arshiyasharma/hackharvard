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
| `show me my dashboard` / `dashboard` / `how's my money` / `ledger` | The Ledger card (an image) plus a signed link to the live dashboard, both read live from Nessie. Both lead with the **move cost projection**: net cost so far, projected net cost once expected money comes back, and a chart of when (scheduled dates solid, estimates hollow) |
| anything scam-shaped | Warns in plain words; a flagged payment is never staged or paid |
| `plan my move under $300` | **Move Plans.** Three plans for the rest of the move (what to sell and at what price, what to drop now, donate or haul, truck size, movers), each with a likely final cost and its chance of finishing under budget, plus a picture and an A / B / C poll. The odds come from 2,000 simulated moves per plan over the assumptions table in `src/plans.ts`, so they're estimates and labeled that way |
| `go with B` / tap a plan | Picks it (that's your yes; nothing moves). The plan is written to Nessie as **pending, future-dated records**: each likely sale is a pending deposit into the Moving Fund, the truck and movers are pending withdrawals. A switch cancels the old plan's pending records first. Emits `plan.chosen` with each item's price and drop date; the Money Elf never edits a listing |
| `what plan am I on` / `drop the plan` | The plan's current odds, what's behind and what's next; or cancel its pending records |

Anything that needs your yes also comes with a tap-to-answer poll (Yes / Not now). The tap approves exactly that action.

Roommates can reply `PAID` or `PAID $50` (money moves into the owner's Moving Fund checking account, and the owner is told), ask for a payment plan ("can I do $20 a month?", which needs the owner's yes), or ask what they owe. Buyers get the escrow notice and confirm pickup by texting `got it` (their half of the release; if the owner hasn't OK'd yet, the owner gets a poll).

## How it's wired into the crew service (on this branch)

`apps/elves/src/index.ts` swaps the canned `money` stub for `moneyElfFromEnv()`; `handle()` takes the crew's `ElfContext` as is, and `test/foundation-compat.ts` makes `tsc` prove it. Besides the usual `ElfResult`, the Money Elf returns fields the service now sends (decision #58):

- `outbound: {spaceId, toHandle, text, poll?}[]`: texts to other people (roommates, buyers, the owner). A handle with no space yet (they've never texted Elves, so the shared pool can't reach them) isn't sent; the owner's reply says who to talk to instead.
- `images`: the Ledger card PNG, uploaded to Photon (`POST /attachments`, multipart/related) and sent as an attachment.
- `poll`: approval polls (Yes / Not now). The Photon 2.0 shared pool refuses them (`422`), so the text always says "Reply yes" too. Poll taps (`poll.vote`) route back to the Money Elf by their `money:` option ids.
- `miniApp: {url}`: **shelved** (decision #72). The Moving Ledger dashboard as an iMessage mini app card through Spectrum (Photon 1.0), only when `ELVES_MINIAPP=1` and the `SPECTRUM_*` credentials are set. By default the dashboard link rides on every Ledger change instead.

The service mounts `/ledger/*` (`createLedgerHandler`) when `PUBLIC_URL` and `LEDGER_LINK_SECRET` are set:
- `/ledger/<move>`: the dashboard, a plain web page that opens in any browser (signed link, never expires);
- `.png`: the card image;
- `.json`: the view.

After any Ledger-changing event (`LEDGER_CHANGING_EVENTS`: payments, deposits, escrow, loans, new shared costs) the owner's reply, or the note they get when someone else's turn caused it, ends with `Dashboard: <link>` (with the shelved mini app on, the service also refreshes the owner's card in place). Hooks for other Elves:
- **Stuff and Home Elves:** `apps/elves/src/money-bridge.ts` turns the Deal Engine's events into `proposeOpenEscrow` (the owner's yes opens escrow), `pickupScheduled`, `confirmPickup`, `proposeEscrow` (refund) and `sweepNoShows`; see "Money: a sale, end to end" in the root README.
Move Plans: `elf.plans.sweep(move, items)` is for the periodic sweep. A sold or given item settles its plan record `completed`, a donated or dumped one `cancelled`. An item past the day the plan expected it to sell, with the chance under budget down 10 points or more, sends the owner one nudge per item with a poll to switch to fresh plans. Items come from `ctx.store.listItems` (the crew Store has it) and move-out from `move.moveOutAt`. Without them the Elf says it can't plan, instead of guessing. The Ledger card and page show the chosen plan's path (a 10–90% band, with your real net cost drawn over it) and its records read live from Nessie. Decisions #66–#70. The dashboard shows it in a **Plan** tab (drafts with the race chart and grid, or the chosen plan's path and its records live from Nessie), and the thread image gets a Move Plan panel.

The Elf's own state (people, entries, waiting approvals, accounts, Nessie merchant ids) is in Postgres via `PostgresMoneyStore` (migration `0010_money.sql`) whenever the crew store is Postgres, and in memory (`MemoryMoneyStore`) otherwise. `bun run test:money-pg` runs this whole package's tests against Postgres.

## The Moving Ledger dashboard (a web page)

"Show me the ledger" sends the Ledger image in the Photon 2.0 thread and the dashboard link (`src/ledger-page.ts`). It's read-only apart from the Approve / Not now buttons, re-reads Nessie every 5 seconds, and carries Open Graph tags so a link preview can show it.

The dashboard, the thread image and the bubble preview share one design system, "Elves Ledger" (decision #64): warm neutrals, ink with one lime accent, Inter with tabular figures, hairline panels. The page has a segmented control (Overview, Coming back, Activity, Plan). Overview leads with net cost so far and where it lands, then the projection chart, anything waiting for your OK (Approve / Not now), balances, who owes you, and what's held or due back. Coming back is a what-if calculator. Activity lists every Nessie movement; tap a row for its record id. The bubble shows a 3:2 preview (`/ledger/<move>.preview.png`).

Past entries can't be edited. A correction by text ("the truck was actually $260") gets an honest "can't change that by text yet" plus the dashboard link (decision #60). To try it on your phone, see `.claude/skills/run-elves-on-phone`.

Events: `plan.drafted`, `plan.chosen`, `plan.switched`, `plan.cancelled`, `plan.drift`, `plan.line_settled`, `plan.stale_vote`, `plan.error`, `ledger.fix_declined`, `ledger.shown`, `loan.created`, `payment.requested`, `payment.received`, `payment.sent`, `escrow.opened`, `escrow.owner_ok`, `escrow.buyer_confirmed`, `escrow.map_converged`, `escrow.no_show`, `escrow.released`, `escrow.refunded`, `deposit.recorded`, `deposit.returned`, `scam.flagged`, `approval.requested|granted|cancelled`, `ledger.entry_added`, `ledger.totals`, `money.sensitive_blocked`, `money.error`.

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

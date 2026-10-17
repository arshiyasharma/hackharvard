# @elves/money-elf — the Money Elf

Spec section 3: every dollar in a move on one Ledger, and no money moves without the owner's OK. Decisions and their reasons: `money-elf-decisions.md` at the repo root.

## What it does

| Owner texts | Money Elf |
| --- | --- |
| `split the $240 truck with Sam and Priya` | Logs the expense and each share, then asks to send the requests |
| `yes` | Approves the most recent pending action only: Nessie bills, plus texts to each roommate (`outbound`) |
| `Sam is 617-555-0101` | Saves the number and sends any approved request that was waiting for it |
| `Sam paid me on venmo` | Marks Sam's share paid (off-ledger, nothing moves in Nessie) |
| `I paid a $500 holding deposit on the sublet, due back Dec 1` | Logs the deposit and its due-back date |
| `got the sublet deposit back` | Marks the deposit returned |
| `Alex picked up the couch` | Asks to release the escrowed sale money; `yes` releases it |
| `the desk pickup fell through` | Asks to refund the buyer; `yes` refunds and texts them |
| `pay Sam $40 for gas` | Asks, then sends on `yes` |
| `ledger` / `who owes what?` | Who owes you, what's in escrow, deposits out |
| anything scam-shaped | Warns in plain words; a flagged payment is never staged or paid |

Roommates can reply `PAID` (recorded as a payment to the owner, and the owner is told) or ask what they owe. Buyers only get the escrow notice.

## Wiring it into the service (foundation branch)

```ts
import { moneyElfFromEnv } from "@elves/money-elf";
const money = moneyElfFromEnv(); // Nessie when NESSIE_API_KEY is set, otherwise FakePayments
// in packages/elves/src/index.ts, replace the "money" stub in allElves with:
const moneyElf: Elf = { ...money, handle: (ctx) => money.handle(ctx) };
```

`handle()` takes the foundation `ElfContext` as is, and returns an `ElfResult` plus a new `outbound: {toHandle, text}[]`. The service needs to send those messages to each handle's space; that part isn't wired yet. The Stuff Elf opens escrow with `money.service.openEscrow(move, { item, buyerName, buyerHandle, amountCents })`. The Ledger is in memory (`MemoryMoneyStore`), like the rest of the store today. `MoneyStore` is the interface to put Supabase behind.

Events: `payment.requested`, `payment.received`, `payment.sent`, `escrow.opened`, `escrow.released`, `escrow.refunded`, `deposit.recorded`, `deposit.returned`, `scam.flagged`, `approval.requested|granted|cancelled`, `ledger.entry_added`, `ledger.totals`, `money.sensitive_blocked`, `money.error`.

## Run it locally

Chat with the Money Elf in your terminal, as the owner, a roommate or a buyer:

```bash
bun run packages/money-elf/scripts/chat.ts            # fake payments, nothing leaves your machine
bun run packages/money-elf/scripts/chat.ts --nessie   # real Nessie sandbox calls (NESSIE_API_KEY in .env)
```

Inside, type texts as the owner would. Slash commands switch who's talking and show state: `/as roommate Sam`, `/as buyer +16175550199`, `/sale couch Alex $90` (a buyer paying into escrow, the Stuff Elf's future hand-off), `/ledger`, `/pending`, `/events`, `/reset`, `/help`. Messages the Elf would text other people show up as `-> text to <phone>`. You can also pipe a script: `printf 'split the $60 gas with Sam\nyes\n' | bun run packages/money-elf/scripts/chat.ts`.

Parsing in the local chat uses the rule parser only (no LLM); in the service, Claude parses first, with the rules as the backup.

```bash
bun test packages/money-elf                       # offline, no credentials
bun run packages/money-elf/scripts/smoke.ts       # scripted live run against Nessie
```

Nessie quirks (balances never move, transfers have no payee, bills need `recurring_date`): see `.claude/skills/nessie/SKILL.md`.

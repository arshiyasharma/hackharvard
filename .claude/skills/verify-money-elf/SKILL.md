---
name: verify-money-elf
description: Run the Money Elf's full check (unit tests, typecheck, Biome lint, and optionally the live Nessie smoke test) and report the results. Use after changing anything in packages/money-elf, before committing or opening a PR, or when the user asks whether the Money Elf still works.
---

# Verify the Money Elf

Run from the repo root. Bun must be installed (`npm i -g bun` if `bun` is missing; ask the user first).

1. If `node_modules` is missing, run `bun install --no-save`. **Never a plain `bun install`** on this branch: it would prune the foundation's packages from `bun.lock` (decision #25). To add a package, use the `money-elf-add-dependency` skill.
2. Format, then lint: `bunx biome check --write packages/money-elf`, then `bunx biome check packages/money-elf`. The package keeps **zero** warnings, like the foundation packages.
3. Typecheck: `bunx tsc -p tsconfig.json --noEmit`.
4. Tests: `bun test packages/money-elf`. Report the pass/fail counts, and quote any failure in full.
5. Live check, only when payments code changed (`src/payments.ts`, `src/service.ts`) or the user asks for it: `bun run packages/money-elf/scripts/smoke.ts`. It needs `NESSIE_API_KEY` in `.env` and creates simulated customers in the team's Nessie sandbox. Before running it, tell the user it writes to Nessie. Every board line it prints must end on a non-`blocked` status.
6. Visual check, when the Ledger card or page changed (`src/ledger-card.ts`, `ledger-page.ts`, `ledger-view.ts`):
   - Run a scenario through the local chat and keep stdin open, so its server stays up:
     ```bash
     ( printf 'Sam is 617-555-0101\nsplit the $240 truck with Sam and Priya\nyes\n/as roommate Sam\ncan I do a payment plan, $40 a month?\n/as owner\nyes\n/as roommate Sam\npaid\n/as owner\n/sale couch Alex $90\nshow me the ledger\n'; sleep 90 ) | bun run packages/money-elf/scripts/chat.ts --port 8799 > <scratchpad>/chat.log 2>&1 &
     ```
   - **Look at** the PNG it saved under `.data/` with the Read tool: text fits, nothing overlaps, no missing glyphs.
   - Open the printed `http://localhost:8799/ledger/...` link in the browser pane at the mobile preset, in light and dark mode.
   - Check the link without `?t=` returns 404.
   - Stop the chat when you're done (`pkill -f money-elf/scripts/chat.ts`) and reset the browser viewport.
7. If the foundation code (`packages/elves`) is in the working tree, also prove the Money Elf still fits the foundation `Elf` contract. Write a temporary `packages/money-elf/test/_compat.ts`:
   ```ts
   import type { Elf, ElfContext } from "@elves/elves";
   import { moneyElfFromEnv } from "@elves/money-elf";
   const money = moneyElfFromEnv({});
   export const asFoundationElf: Elf = { ...money, handle: (ctx: ElfContext) => money.handle(ctx) };
   ```
   Run the typecheck, then delete the file.

Report each step's result in one line. Never say it passed if a step was skipped; say it was skipped.

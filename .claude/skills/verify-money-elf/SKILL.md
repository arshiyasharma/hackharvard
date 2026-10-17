---
name: verify-money-elf
description: Run the Money Elf's full check (unit tests, typecheck, Biome lint, and optionally the live Nessie smoke test) and report the results. Use after changing anything in packages/money-elf, before committing or opening a PR, or when the user asks whether the Money Elf still works.
---

# Verify the Money Elf

Run from the repo root. Bun must be installed (`npm i -g bun` if `bun` is missing; ask the user first).

1. `bun install` if `node_modules` is missing.
2. Format, then lint: `bunx biome check --write packages/money-elf`, then `bunx biome check packages/money-elf`. The package keeps **zero** warnings, like the foundation packages.
3. Typecheck: `bunx tsc -p tsconfig.json --noEmit`.
4. Tests: `bun test packages/money-elf`. Report the pass/fail counts, and quote any failure in full.
5. Live check, only when payments code changed (`src/payments.ts`, `src/service.ts`) or the user asks for it: `bun run packages/money-elf/scripts/smoke.ts`. It needs `NESSIE_API_KEY` in `.env` and creates simulated customers in the team's Nessie sandbox. Before running it, tell the user it writes to Nessie. Every board line it prints must end on a non-`blocked` status.
6. If the foundation code (`packages/elves`) is in the working tree, also prove the Money Elf still fits the foundation `Elf` contract. Write a temporary `packages/money-elf/test/_compat.ts`:
   ```ts
   import type { Elf, ElfContext } from "@elves/elves";
   import { moneyElfFromEnv } from "@elves/money-elf";
   const money = moneyElfFromEnv({});
   export const asFoundationElf: Elf = { ...money, handle: (ctx: ElfContext) => money.handle(ctx) };
   ```
   Run the typecheck, then delete the file.

Report each step's result in one line. Never say it passed if a step was skipped; say it was skipped.

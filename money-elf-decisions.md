# Money Elf decisions

A running log of decisions made while building the Money Elf (spec section 3). Newest at the bottom. Each entry: what we decided, why, and who decided (team = asked in chat, Claude = default chosen during build, open to override).

## 2026-10-17

1. **Branch base: clean `money-elf` (from `main`), not `phase-1-foundation`.** The Money Elf code takes priority over the other branch when both merge into main. (team) **Superseded by #39.**
2. **Scope: only the Money Elf.** The foundation code's 10-Elf layout vs. the spec's 5 Elves is out of scope here; the Elf name stays `money`. (team)
3. **Self-contained package `packages/money-elf/` (originally `packages/money/`, see #23).** Nothing outside it (except root config) is added, so "ours wins" on merge cannot overwrite teammates' files. The package defines its own minimal context types that are structurally compatible with foundation's `ElfContext`/`ElfResult` (`packages/elves/src/contract.ts`), so wiring it in is a one-line swap of the `money` stub. (Claude)
4. **Payments model: simulated Nessie accounts.** Each participant (owner, roommate, buyer) gets a Nessie customer and checking account, created lazily; each move gets one escrow account. Split requests are Nessie bills. The local Ledger mirrors everything. (team)
5. **Skills in scope: Ledger + board totals, Splits / Moving Fund, Escrow for sales, Deposits + scam check.** (team)
6. **Payment requests to roommates go out through a new `outbound` field on the Elf result** (messages addressed to a participant handle). The service sends them once wired up; this branch returns and tests them, and creates a Nessie bill per person. (team)
7. **Money is integer cents everywhere**, in the Ledger and in Nessie (Nessie balances read 8000 for $80). Keeps splits exact. (team)
8. **Tooling: Bun + TypeScript + Biome, the same as foundation**, so the package drops into the workspace. Bun installed via `npm i -g bun`. (team)
9. **Nessie behavior verified live (prod-api.nessieisreal.com, Oct 17 2026):** (Claude, from probing)
   - Auth is the `?key=` query param. Create calls return `{code, message, objectCreated: {_id, ...}}`, and ids are UUIDs (the published spec says only a string comes back).
   - `POST /accounts/{id}/transfers` accepts only `{transaction_date, status, amount, description}`, with no payee field, so a transfer can't name a recipient.
   - Withdrawals and deposits are stored but **do not change account balances**, and overdrafts are accepted.
   - So: **a money movement is recorded in Nessie as a withdrawal on the payer's account plus a deposit on the payee's account.** The Ledger is the source of truth for balances and checks for overdrafts itself. Nessie is the audit trail. **Partly superseded by #26:** Nessie is now the live ledger the owner sees.
10. **Roommate roster lives in the Money Elf.** Foundation stores roommates only as names (facts.ts). The Money Elf keeps name → phone handle. When a split names someone without a known number, it still creates the ledger entry and bill, and asks the owner for that one number. (Claude)
11. **Approvals:** every money-moving action (sending split requests, releasing escrow, refunding a buyer, paying someone) becomes a pending action. An owner "yes" approves the **most recently proposed** one, and only that one; the reply then names the next one still waiting. "No", "wait" or "hold" cancels the latest one, and nothing moves. Logging something already paid off-platform ("I paid the $500 sublet deposit", "Sam paid me on Venmo") needs no approval, because no money moves through us. We dropped matching a yes to the proposal's thread: Elves never learn the message id of the reply the service sends, so there's nothing to match. (Claude)
12. **Parsing: LLM first, rules as backup, like the Crew Lead.** Any dollar amount the LLM returns must appear in the owner's text, or it is discarded and the rule parser is used. This guards against invented amounts. (Claude)
13. **Scam check is deterministic rules** (overpayment check, "I'll send a mover", off-platform/gift-card/wire/crypto asks, deposit before viewing, price far below market, requests for card/bank numbers). A flagged request is blocked from ever being paid. (Claude)
14. **Events:** the spec's `payment.requested`, `payment.received`, `escrow.released`, `scam.flagged`, plus `escrow.opened`, `escrow.refunded`, `deposit.recorded`, `deposit.returned`, `ledger.entry_added`, `approval.requested`, `approval.cancelled`. (Claude)
15. **Replies are deterministic templates, not LLM drafts.** Amounts in a money reply must be exact, and templates keep each reply to at most 3 plain lines with one thing to approve. The LLM is used only to parse intent (#12). (Claude)
16. **Splits include the owner by default** ("split the $240 truck with Sam and Priya" means 3 ways), unless the text says "not me" or "just them". **The owner is assumed to have fronted the cost**: it's logged as an expense paid by the owner, and each roommate's share as a `split` row owed to the owner. "My roommates" expands to the Money Elf's roster. Leftover cents go to the earliest people in the list, so the parts always add up exactly. (Claude)
17. **Ledger statuses are the spec's pending / paid / refunded, plus `cancelled`** for a payment the owner said no to. Flagged (scam) rows are kept for the audit trail but excluded from every total. (Claude)
18. **Role limits:** only the owner can approve, split, pay or release. A roommate can reply PAID (recorded as a Nessie movement from their account to the owner's, and the owner is notified) and see only their own balance. A buyer gets a fixed "payments only go through escrow on this number" reply, with the scam check still applied. (Claude)
19. **Escrow opens through `MoneyService.openEscrow()`**, the hand-off point for the Stuff Elf once buyer conversations exist (the next ticket). The buyer paying is the buyer's own action, so it needs no owner approval. Release and refund both need the owner's yes, and an escrow can't be released or refunded twice. (Claude)
20. **Payments failures never half-apply an approval.** If Nessie errors, the reply says nothing moved, the board row goes `blocked`, and the pending action is restored, so the owner's next yes retries. Each execute step skips work it already finished (for example, requests already sent). (Claude)
21. **Nessie bills need `recurring_date`.** Without it, Nessie stores the bill but then fails to read it back, so `createBill` sets it to the due date's day of month. Simulated customers get a placeholder Cambridge address; the owner's real address never goes to Nessie. Nessie has no customer delete, so smoke-test data stays in the sandbox. (Claude, verified live)
22. **Card and bank numbers in a text are refused** (Luhn-checked card numbers, routing/account numbers): the Elf replies with a warning, and the number is never parsed, stored, echoed or put in an event. (Claude)
23. **Everything is named for the Money Elf: package `packages/money-elf/` (`@elves/money-elf`), Elf in `src/money-elf.ts`, tests in `test/money-elf.test.ts`.** The branch builds only the Money Elf, so the names say so and won't collide with a generic `elf.ts` or `money` package elsewhere. (team)
24. **Local testing is a terminal chat, `packages/money-elf/scripts/chat.ts`**, with fake payments by default and `--nessie` for the real sandbox. You can switch speakers (owner / roommate / buyer) and simulate an escrow sale, and texts to other people are printed instead of sent. It uses the rule parser only, because the LLM client lives in the foundation branch. (Claude)
25. **Superseded by #39.** The root files on `money-elf` (`package.json`, `biome.json`, `tsconfig.json`, `bun.lock`, `.gitignore`) are the foundation branch's versions plus only the Money Elf additions** (one `@elves/money-elf` path in `tsconfig.json`, its workspace entry in `bun.lock`). So when the branches meet in main, our versions are a superset of the foundation's and don't drop teammates' packages or dependencies. Don't re-run `bun install` on this branch alone: it would prune the lockfile down to only this package. `.gitignore` keeps `.env` out of git. (Claude)
26. **Nessie is the live ledger.** The "ledger" reply and the Crew Board's Money line are rebuilt every turn by reading the move's Nessie accounts back (`src/books.ts`): withdrawals, deposits, bills and loans. The local store keeps only what Nessie has no field for: who owes whom, phone numbers, pending approvals, escrow state and deposit due-back dates. We're optimizing for creative use of Nessie at the hackathon, not for production, so Nessie outages aren't a concern. (team)
27. **Every Nessie movement is tagged in its description** as `[elves:<kind>:<ledgerEntryId>]`, with kinds expense, deposit_out, deposit_back, share_paid, share_paid_outside, loan_payment, escrow_in, escrow_release, escrow_refund and payment. Only tagged records count toward the totals. Nessie loans carry `[elves:loan:<entryId>]`. (Claude)
28. **The Moving Fund is a Nessie Savings account on the owner's own customer.** **Account type superseded by #42; shared costs by #45.**
    - Roommates' PAID payments move from their checking account into the Fund.
    - A payment the owner reports ("Sam paid me on Venmo") is recorded as money arriving from outside into the owner's checking account.
    - "Pay Priya $30" comes out of the Fund when the Fund covers it, otherwise from the owner's checking account.
    - A shared cost the owner fronts is a tagged withdrawal from the owner's checking account.
    - "Spent" counts shared costs and payments only; deposits show separately as "deposits out".
    (Claude)
29. **Roommate IOUs are Nessie loans.** A roommate can ask for a payment plan ("can I do $20 a month?"), or the owner can offer one ("let Sam pay the truck at $40 a month"). Either way it waits for the owner's yes, because the owner is the lender. If no monthly amount is given, the plan is about four payments, rounded up to whole dollars, minimum $5. On approval:
    - The roommate's payment request (bill) is cancelled.
    - A loan opens on the roommate's account with type "Moving Fund IOU", status open, and `credit_score` 0, since Nessie requires a score and an IOU has none.
    - After each payment the loan's `amount` is updated to what's left, and it becomes "paid off" at $0.
    (team chose loans; terms are Claude defaults)
30. **Payments can be partial.** "PAID $50" pays $50; a bare PAID pays one monthly installment on a loan, or the whole balance otherwise; paying more than is owed is capped, and the reply says so. Without a loan, the Nessie bill's amount drops to what's left, and the bill is completed at $0. (Claude)
31. **No rewards points.** We considered using Nessie's `rewards` field for "Green Points" (items kept out of the landfill) and skipped it, because the angle didn't feel appealing. (team)
32. **"Show me the ledger" sends an image card plus a link, not a Photon mini app.** App cards (`app(url, {live:true})`) exist only in Photon 1.0 (Spectrum). Photon 2.0's send API has no app or rich-link type (checked against its live OpenAPI spec). So the owner gets:
    - the Ledger card as a PNG attachment, shown inline in iMessage with no tap;
    - a one-line summary;
    - a link to a live, phone-sized Ledger page that refreshes every 30s and has Open Graph tags, so it previews as the card.
    If Photon adds app cards to 2.0, the same page can become the mini app. (team)
33. **The card is SVG rendered to PNG with `@resvg/resvg-js` 2.6.2 and a bundled Inter font (`@expo-google-fonts/inter` 0.4.2).** It loads no system fonts, so it renders the same on macOS and in the Linux container, which has no fonts. resvg ships prebuilt binaries for macOS and Linux (glibc and musl). If rendering fails, the reply falls back to the text Ledger. Dependencies were added with the `money-elf-add-dependency` process, which keeps `bun.lock` a superset of the foundation's. (Claude)
34. **Ledger links are signed.** Each link is `/ledger/<moveId>?t=<token>`, where the token is HMAC-SHA256 over the move id with `LEDGER_LINK_SECRET`, truncated to 22 characters. A wrong or missing token returns 404. The page, `.png` and `.json` all need the token, and responses are `no-store` and `noindex`. Links are sent only when both `PUBLIC_URL` and `LEDGER_LINK_SECRET` are set; otherwise the card goes without a link. (Claude)
35. **Only the owner gets the Ledger card and link**, because they name who owes what. A roommate asking gets their own balance as text. (Claude)
36. **Every approval also sends a Photon 2.0 poll** ("Yes" / "Not now"). The option ids are `money:approve:<pendingId>` and `money:decline:<pendingId>`, so a tap approves exactly that action, unlike a typed "yes", which approves the most recent one (#11). Details:
    - Only the owner's taps count.
    - A second tap on an action that's already handled does nothing.
    - If the platform drops our option ids, a "Yes" or "Not now" tap falls back to the most recent action.
    - The text reply still says "Reply yes", because polls on the shared iMessage pool aren't verified yet.
    - A roommate's payment-plan request reaches the owner with a poll attached to the outbound message.
    (team chose polls; mechanics Claude)
37. **The reply contract grows, and the foundation service must handle the new fields** when the Money Elf is wired in. **The `outbound` part is superseded by #48.** This needs the foundation side, so it's listed rather than built here:
    - Upload `images[]` with `POST /v1/projects/{id}/attachments` and send each as an attachment after the text.
    - Send `poll` and `outbound[].poll` as `{type:"poll"}` content.
    - Normalize inbound `poll.vote` content to `pollVote`.
    - Route any vote whose option id starts with `money:` to the Money Elf. The foundation router sends empty-text messages to the Crew Lead today.
    - Mount `createLedgerHandler` under `/ledger/`.
    (Claude)
38. **Superseded by #39.** Teammates install with `bun install --no-save` on a fresh `money-elf` checkout. It installs from the lockfile and leaves it byte-identical; a plain `bun install` would prune the foundation's packages from it. (Claude, verified)
39. **`money-elf` is rebased onto `team-stable`, and merges there by PR, not into `main`.** The team's stable branch now carries the five Elves, the Postgres store and the SPEC, so the Money Elf sits on top of the real crew code. With every workspace present:
    - Root files are `team-stable`'s, plus one `@elves/money-elf` path in `tsconfig.json`.
    - A normal `bun install` / `bun add` is safe again, and `bun.lock` was regenerated with additions only. #1, #25 and #38 no longer apply.
    - `test/foundation-compat.ts` makes the typecheck prove the Money Elf still fits the crew's `Elf` contract.
    (team)
40. **The Money Elf knows the `seller` role** (someone the owner buys from), which `team-stable` added. A seller gets the same treatment as a buyer: no owner actions, just the "payments only go through escrow" reply, and the scam check still applies. (Claude)
41. **Known differences from `team-stable`'s SPEC.md §4, flagged for review rather than changed during the rebase.** (resolved by #42–#47; `docs/elves-spec.md` §3 updated to match)
    - **Account types:** SPEC wants the Moving Fund as checking and Escrow as savings; built is Fund = savings, Escrow = checking.
    - **Escrow release:** SPEC wants two signals (the buyer confirms, plus the owner's 👍 or Move Map convergence), with the money going to the Moving Fund. Built releases on the owner's yes alone, to the owner's checking account.
    - **Refunds:** SPEC auto-refunds a buyer after a 24h no-show. Built refunds on the owner's yes.
    - **Nessie record types:** SPEC posts truck, storage and movers as Nessie purchases, and roommate shares as transfers. Built uses tagged withdrawals and deposits, because Nessie transfers can't name a payee (#9).
    - **Interface name:** SPEC calls it `MoneyRails`; built is `PaymentsProvider`.
42. **The Moving Fund is a Nessie Checking account and Escrow is a Savings account, as SPEC §4 says.** The Fund is a second Checking account on the owner's own customer; Escrow stays on its own "Elves Escrow" customer, now as Savings (`MoneyService.fundAccount` / `escrowAccount` in `packages/money-elf/src/service.ts`). Accounts opened before this keep their old type, and `books.ts` reads them the same either way. (team, from SPEC)
43. **An escrow release needs two signals, in either order, and goes into the Moving Fund.** Signal one is the buyer confirming pickup, either by texting "got it" in their own chat (`buyerConfirmsPickup` in `parse.ts`) or by the Deal Engine calling `confirmPickup(move, { via: "engine", entryId })`. Signal two is the owner's 👍, which is their yes or poll tap on "move $X from escrow to the Moving Fund", or Move Map convergence via `mapConverged(move, entryId)`, a stub hook until the Map exists. Details:
    - If the owner OKs first, the money waits, and the buyer is nudged to confirm.
    - If the buyer confirms first, the owner gets the release question with a poll.
    - Releasing closes any other open question about that sale.
    - The money moves Escrow → Moving Fund, tagged `escrow_release`, and `books.salesCents` now counts Fund deposits. Older releases to the owner's checking account still count.
    - Map convergence counts as the owner's 👍 because SPEC says so. It's the one release that runs without the owner's tap, so the Deal Engine should call it only on a real pin match.
    (team chose both buyer paths, and either order for the owner's yes/poll; Map rule from SPEC)
44. **A buyer no-show 24h past the pickup time stages a refund for the owner's yes; it doesn't refund on its own.** SPEC says a no-show "refunds the buyer", but every money move still needs the owner's explicit yes, so the rule asks. `MoneyService.sweepNoShows(move)` is for the Deal Engine's periodic sweep. It finds held sales more than 24h past `pickupAt` with no buyer confirmation (`isNoShow`, `NO_SHOW_MS`) and texts the owner a refund question with a poll, once per sale (`noShowAt`). `openEscrow` takes an optional `pickupAt`. `setPickupTime` handles the Deal Engine's one reschedule and clears the question. An owner cancel ("the pickup fell through") still refunds after the owner's yes. (team)
45. **Truck, storage, movers and any other shared cost the owner fronts are posted as Nessie purchases**, made with `POST /accounts/{id}/purchases` at a merchant named after the cost ("Truck"). Each merchant is created once with `POST /merchants` and cached by name per process (`NessieRails.purchase` in `rails.ts`). Verified live on Oct 17 2026:
    - The body is `{merchant_id, medium:"balance", amount, status, purchase_date, description}`, and a merchant is `{name, category}` with `category` as a string.
    - Leaving out `status` or `purchase_date` stores the purchase but breaks that account's purchase list for good.
    - `merchant_id` isn't validated.
    - `GET /merchants` doesn't list merchants we create.
    - Balances don't change.
    `books.ts` now reads purchases too, so "spent" counts them. Older expense withdrawals still count. (team, from SPEC; shapes Claude, verified)
46. **Roommate shares stay a tagged withdrawal + deposit pair, not Nessie transfers.** SPEC §4 says transfers. A fresh probe on Oct 17 2026 still rejects `payee_id` (and `medium`) on `POST /accounts/{id}/transfers`, so a transfer can't say who received the money and the Ledger couldn't be rebuilt from it (#9). (Claude, verified)
47. **The payments interface is `MoneyRails` (SPEC §4), in `packages/money-elf/src/rails.ts`.** The interface, the Nessie and fake implementations, the error class and the env helper are renamed together: `PaymentsProvider` → `MoneyRails`, `NessiePayments` → `NessieRails`, `FakePayments` → `FakeRails`, `PaymentsError` → `RailsError`, `paymentsFromEnv` → `railsFromEnv`. `createMoneyElf` and `MoneyService` take `rails` instead of `payments`. The fake stays for tests and the offline chat, so Stripe Connect can be swapped in later. (team, from SPEC)
48. **Outbound texts use the crew's `ElfOutbound` shape: each one carries the `spaceId` it goes into, plus the `toHandle` it was meant for.** `team-stable` added `outbound` to `ElfResult` with a required `spaceId`, and the crew service sends into spaces, not to phone numbers. The shared pool can only text someone who has texted first, so a handle with no space can't be reached anyway. `finish()` in `packages/money-elf/src/money-elf.ts` does the addressing:
    - The owner's texts go to `move.ownerSpaceId`. Anyone else's go to the space they text from, looked up with `ctx.store.listParticipants`. `MoneyContext` takes an optional `store`, and `MoneyMove` an optional `ownerSpaceId`, both of which the crew's `ElfContext` already has.
    - A handle with no space is left out and logged as an `outbound.unreachable` event.
    - Without a store (tests, local chat, smoke test), the handle stands in for the space.
    - `MoneyService` methods still return handle-addressed texts, so the Deal Engine can call them directly.
    (Claude; found merging `team-stable`)
49. **When Elves can't text someone, the owner's reply tells them who to talk to and about what, in one short line.** Example: "Talk to Priya about the $30 gas share; I can't text them until they've texted Elves." Everything else still happens: the Ledger entry, the Nessie bill, loan or escrow record, and texts to everyone Elves can reach. Details:
    - Each outbound text carries `toName` and a few-word `about`, and `talkLine()` in `packages/money-elf/src/money-elf.ts` groups them by person.
    - The line always fits in the 3-line reply.
    - The service takes a `Reach` check (`approve`, `executeSplitRequests`, `addContact`). Only reachable people count as "sent" or get `notified`, so the owner is never told a text went out when it didn't.
    - Callers without a reach check (the Deal Engine, tests) treat everyone as reachable.
    (team chose "only when it can't reach them"; wording Claude)
50. **The Ledger grows into a "Move Money" dashboard, starting with a move cost projection** (`src/projection.ts`). It answers one question: what this move costs the owner today, and what it lands at once the expected money comes back. It sits on the live page and the PNG card, built from the Nessie books plus the dates the Ledger knows.
    - **Net cost so far** = (shared costs + purchases + payments + deposits still out) − (roommate shares + loan payments + sales).
    - **Projected net cost** = net cost so far − everything expected back.
    - A step chart shows the net cost over time, since money comes back in jumps.
    - A move that pays for itself reads "$10 ahead", not "−$10".
    (team chose the dashboard; formulas Claude)
51. **Every expected amount says how sure it is.** *Scheduled* means a date someone agreed to: a deposit's due-back date, a loan's monthly payments (every 30 days from today), a set pickup time. *Estimated* means no date was agreed, so it assumes a requested share lands within 7 days, a sale within 3 days and a deposit within 30 days (`ASSUMED_DAYS`). Estimates show as hollow dots, with the assumptions written out on the page, so the dashboard never presents a guess as a fact. (Claude)
52. **Scope cut: no card or partnership recommendations on the dashboard.** Nessie has no real product catalog, so any offer would be invented under Capital One's brand, and pushing credit to students mid-move reads as an ad. The dashboard sticks to numbers backed by Nessie records. Still planned on this track, in order: an honest "recovered by your crew" number, one visible automation (a sale sweep into the Moving Fund that the owner opts into and can switch off), and a seed script for the demo. (team)

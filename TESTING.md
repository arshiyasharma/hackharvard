# Testing every function, by hand

One row per function: what it is, and the quickest way to see it work. Texts in quotes are what you send from the owner's phone to the Elves number; "buyer" and "applicant" rows need a second phone (or `bun run scripts/sim-negotiation.ts`). ✅ means it is also covered by an automated test; the manual row is for seeing it with your own eyes (and your own phone, picture and link).

Legend: **OWNER** = your phone. **BUYER** = a second phone texting the same number. **WEB** = open the dashboard link in a phone browser. **CLI** = a command in the repo.

## 0. Before you start (the gates)

| What | How |
| --- | --- |
| All automated suites, no credentials | CLI `bun test` (614) |
| Same suites against Postgres (state survives restarts) | CLI `docker run -d --rm --name elves-pg-test -e POSTGRES_PASSWORD=elves -p 54329:5432 postgres:15-alpine` then `bun run test:pg` (640) and `bun run test:money-pg` (189) |
| Types | CLI `bun run typecheck` |
| Whole arc offline (no Photon, no keys) | CLI `bun run demo` |
| Buyer negotiation offline, both sides printed | CLI `bun run scripts/sim-negotiation.ts 80 120 50 "ok 70" "90 is my best" "1"` |
| Money Elf against the **real** Nessie sandbox | CLI `bun run packages/money-elf/scripts/smoke.ts` (needs `NESSIE_API_KEY`; creates real sandbox records) |
| Talk to the Money Elf in a terminal | CLI `bun --env-file=.env run packages/money-elf/scripts/chat.ts --nessie` (`/help` lists `/as roommate Sam`, `/as buyer …`, `/sale`, `/map`, `/sweep`, `/items`, `/ff <days>`, `/books`, `/ledger`, `/pending`, `/events`) |
| Photon lines, assignments, last messages | CLI `bun run photon status`; `bun run photon assign +1XXXXXXXXXX` puts a phone on the shared pool |
| Database | CLI `bun run db status` |
| Live service up | WEB `https://elves-production.up.railway.app/health` (`degraded` means the store fell back to memory) |

## 1. Plumbing every text goes through

| Function | How to test |
| --- | --- |
| Read receipt + typing | OWNER sends any text: you see "Read" and the typing dots before the reply |
| 👍 tapback on your text | Dedicated line only: OWNER sends a text, a 👍 lands on it. On the shared pool it is skipped by design |
| Debounce / batching | OWNER sends three short texts in a row within a second: one reply covers all three |
| Newer text cancels slow work | OWNER sends "find me a room in allston under 1200", then a new text while it searches: the new text is queued, not lost |
| Idempotent sends | Restart the service mid-conversation: no reply is sent twice |
| Long reply splitting (the 422 bug) | OWNER texts "what can you do?" (~2,300 characters): it arrives as readable chunks, never an error |
| Elf header on every text | Every reply starts with its Elf's emoji and name (🧭 Crew Lead, 🏠 Home Elf, 📦 Stuff Elf, 💸 Money Elf), and the body has at most one emoji |
| Threaded replies | Dedicated line only; the shared pool falls back to flat replies |
| First contact | A brand-new phone texts "hi": the crew intro arrives first |
| Memory | Tell it a fact ("my roommate Sam has a car"), later ask "who has a car?": it answers from memory. WEB `/memory/<moveId>` shows what it kept |
| Crew Board | WEB `/b/<moveId>` (the link the Crew Lead sends once): one row per Elf with its current task, live |
| Operator endpoints | WEB `/moves`, `/board/<moveId>`, `/events/<moveId>` (every event the Elves emitted), `/report/<moveId>` |

## 2. Crew Lead

| Function | How to test |
| --- | --- |
| Crew intro, exact ability list | New phone: "hi" → "Hey, I'm the Crew Lead…", Home 3, Stuff 3, Money 5 bullets, the 🚫 limits, the STATUS / DASHBOARD line |
| "What can you do?" from anywhere | "what can you do?" / "help" in any thread (also mid-onboarding): same list, onboarding doesn't advance |
| Onboarding call (text) | Answer in your own words: "out of Allston Nov 1, hard date, into Somerville, selling the couch and desk, keeping the bed, Sam has a car, lease ends Nov 1" → it plays the brief back, "yes" locks it in |
| Onboarding call (voice) | Call the Retell number; or CLI `bun run mock-call <url> <ownerPhone> "I move out Nov 1 and want to sell my couch"` sends the signed webhook and prints what was saved |
| Brief → dispatch | After "yes": "Locked in", who is on what, the STATUS line, the Crew Board link, and **the Money Elf's hello** (ledger set up, asks your budget) |
| Onboarding quality | CLI `bun run eval:onboarding` scores turns, coverage and planning leaks |
| STATUS | OWNER "STATUS" (also "where are we"): one block per Elf, only what is true |
| STATUS reminder | The line "Text STATUS … or DASHBOARD …" closes the intro, "what can you do?" and "Locked in"; in the last 7 days before move-out it closes every Crew Lead reply with the days left |
| DASHBOARD keyword | OWNER "DASHBOARD": goes straight to the Money Elf: the ledger picture plus the link |
| Refusals, one per limit | "book me a u-haul for saturday", "hire movers", "plan my route", "read my lease", "email my landlord", "post it on facebook for me", "pay my rent", "transfer to my bank", "should I invest the fund": each gets "The crew can't …" and the closest thing it can do |
| Small talk, move questions | "thanks!", "when is my move-out?": answered, never "which did you mean?" |
| Ask which Elf | "my deposit for the apartment" (Home or Money) and "I owe the buyer" (Stuff or Money): it asks with numbered options; "1" sends your original words to that Elf |
| Nothing it can place | "blorp the frobnicator": asks with all three jobs. "Which did you mean?" left 30 minutes is dropped |
| Both Elves in one text | "sell my desk and find me storage for june": Stuff's reply then Home's, both board rows move |
| Approvals | Nothing is booked, posted, paid or agreed without your yes (see each Elf) |

## 3. Stuff Elf

| Function | How to test |
| --- | --- |
| Item from a photo | OWNER sends a photo of a couch + "lowest I'd take is $60": what it sees, fair range, list price, floor recorded |
| Floor asked if missing | Photo with no price: it asks for the lowest you'd take |
| Listing line + ref code | "yes, list it": a `sell_item` deal, a ref code, the line for **your own** post ("Text +1 … and mention N9D3"). The crew never posts |
| Typed items | "I have a lamp to sell for $20", "sell my couch": captured without a photo |
| Buyer inquiry | BUYER texts "is the couch still available? ref N9D3": greeted with the price; the floor is never revealed |
| Counter, hold the floor | BUYER "$50?" (under floor): countered at the floor |
| Low offer asked of you | If BUYER holds firm: OWNER gets "Take $50? yes, no, or a number"; reply "yes", "no", "$55"; a 👍 counts as yes |
| Agree + pickup slots | BUYER "deal": three slots; "2" books it; OWNER hears "Booked: buyer picks up … Sat 10am" |
| Pickup reminder | Wait or fast-forward: a reminder goes out before pickup |
| Hand-off | BUYER "picked it up": handed off, escrow release starts on the Money side |
| Scam Shield | BUYER "can I pay by venmo": told escrow only. "gift card", "cashier's check", "send me the verification code", an overpayment: conversation ends, OWNER is told |
| Keep / no last call | "keep the couch" holds it out of Last Call; "no last call" holds everything |
| Last Call 72 h / 48 h | Move-out within 72 h: unsold asks drop 20%, then 25% more at 48 h, each text says percent, old and new price, hours left, offers keep or donate; buyers mid-talk get "Price drop… ref H2P3" |
| Last Call 24 h / dump | At 24 h it relists free; at move-out anything open is marked dumped |
| Donate | "donate the lamp": listing comes off now, marked donated, asks the city if unknown, lists pickups (Boston 311, Salvation Army, Goodwill, Habitat ReStore) and drafts a request for you to send |
| Give away | "give away the bookshelf": listed free |
| Buy an item | Forward a listing link + "max $40": "I'll cap the offer at $40… yes?", "yes" opens a `buy_item` deal |
| Move Report | "what did we keep out of the landfill?" / "move report": pounds kept out, kg CO2e (approximate), dollars recovered |

## 4. Home Elf

| Function | How to test |
| --- | --- |
| Housing hunt | "find me a room in allston under 1200 june 1 to aug 30": ack, real-browser search, top 3 with a line each and scam flags (browser: `ELVES_BROWSER=browserbase` or `local`; `off` uses fixtures) |
| One missing fact at a time | "find me a room": asks budget, then area, then dates |
| Follow-ups | "more", "tell me about 2", "2", "skip 2", "save 2", "search again" |
| Forwarded listing | Paste a listing URL: ranked with the picks |
| Scam flags | Fixture/live results with price under half the median, wire or gift-card asks, "I'm abroad": flagged or sunk out of the picks |
| Hotel for the gap | "find a hotel for the gap nov 1 to nov 3": nightly picks |
| Storage | "find storage june to august": SpareFoot units by monthly price; never asks for a photo |
| Reach out | "reach out to 2": a `find_sublet` deal; with a dedicated line it texts the lister; the lister's replies run through the Deal Engine |
| Sublet post | "sublet my room for $1500": dates, area, room photos (vision), then the post with ref and number; "change the title…" redrafts; "post it" approves; you put it up yourself |
| Applicants | APPLICANT "hi, ref K7Q2, still open?": greeted with rent; "$1300?" countered then put to you; "deal": viewing times |
| **Viewing needs your yes** | APPLICANT picks "1": OWNER gets "Book it? yes or no"; "yes" books, "no" offers the other times. Nothing books without it |
| Lease not read | "can I sublet my room?": the lease and landlord decide; the crew does not read leases |
| Move-in checklist | "set up internet at the new place": asks move-in date, new address, then the dated checklist (electric, gas, internet, renters insurance, USPS, keys, condition report, gap bags) |
| Checklist edits | "done with internet", "skip insurance", "what's left", "address is 14 Elm St", "move-in is nov 5" (re-dates open tasks) |
| Checklist reminders | One reminder per task as it comes due |
| Pickups on the checklist | After Stuff books a pickup, "what's left" shows "Pickups booked (Stuff Elf)" |

## 5. Deal Engine (under Stuff and Home)

| Function | How to test |
| --- | --- |
| Four modes | `sell_item`, `buy_item`, `sublet_out`, `find_sublet`: run each once from the rows above |
| Negotiation | CLI `bun run scripts/sim-negotiation.ts 80 120 50 "ok 70" "90 is my best"`: greeting, counter, floor held, asks owner, agrees |
| Calendar | Agree on a deal: three slots, one booked, no double-booking |
| Scam Shield | Same rows as Stuff: off-escrow ask, gift card, check, code, overpayment |
| Last Call sweep | Stuff rows; `/sweep` in the Money chat does the Money-side equivalent |
| Ledger events | After agree, pickup and hand-off WEB `/events/<moveId>` shows `ledger.hold`, `pickup.scheduled`, `ledger.release` (or `ledger.refund` if they walk) |

## 6. Money Elf

| Function | How to test |
| --- | --- |
| Hello after the brief | Confirm a brief: a Money text says the ledger is set up in Nessie and asks your budget (or offers plans at the brief's budget) |
| Add a roommate | "Sam is 617-555-0101": saved; any request waiting for the number is sent |
| Split a cost | "split the $240 truck with Sam and Priya": "Truck $240 split: you $80, Sam $80, Priya $80. Send the 2 requests?" → "yes" sends them |
| Uneven split math | "split the $100 cleaning with Sam and Priya": $33.34 / $33.33 / $33.33, adds to the penny |
| Excluding yourself | "Sam and Priya split the $60 pizza, not me" |
| Roommate pays | Sam (as roommate) texts "paid": marked, owner notified; "Sam paid me on venmo" logs it; paying more than owed counts only what was owed |
| Payment plan | "let Sam pay the truck at $40 a month": plan set, Sam is told; "PAID" from Sam each time |
| Deposit | "I paid a $500 sublet deposit, due back Dec 1": logged once, reminder promised; "I paid $400 for a sublet deposit" (no `$` works); a date alone ("Dec 1") answers "when is it due back?" |
| Deposit not doubled | Say the same deposit twice: "already on the Ledger"; "another $400 sublet deposit" adds a second |
| Deposit back | "got my deposit back": with two open asks which; "all of them", "both" or "the sublet one" answers; "got all my deposits back" does it in one go |
| Pay a roommate | "pay Sam $40 for gas": "Pay Sam $40? Reply yes" → "yes" pays from the Moving Fund in Nessie |
| Missing details asked | "split", "split the truck", "pay Sam", "pay $40", "pay", "I paid a deposit": one question each, with an example |
| Questions answered first | "who owes me?", "is anything in escrow?", "how much have I spent?", "how much did I make?", "what's my balance?": one-line answer, then the ledger |
| Menu | "help" / "what can you do": the menu with a text that does each thing |
| Can't, with an alternative | "pay my rent", "send money to my landlord", "transfer to my bank", "invest the fund", "do my taxes": 🚫 plain "I can't…" |
| Venmo | "can you venmo Sam $40": pays through the Ledger and says it isn't Venmo |
| Unsure | "asdf qwerty": "I'm not sure what you'd like me to do with that", with the likeliest options |
| Fix refused | "the truck was actually $260": says past entries can't be changed by text and points at the dashboard |
| Sensitive numbers | Text a card or bank number: refused, never stored or repeated |
| Scam check | "is this a scam": checked; an off-escrow payment ask is blocked |
| Approvals, three ways | A pending question is answered by "yes"/"no", by tapping the poll (where polls work), or by the dashboard buttons: each approves exactly that one action |
| Wrong/stale approval | Tap an already-decided approval: nothing changes |
| Escrow open | A deal agrees a price: OWNER gets "Hold their $60 in escrow until pickup?" → "yes" opens it in Nessie |
| Escrow release | Pickup booked, BUYER confirms, OWNER says yes: released into the Moving Fund (Move Map convergence can stand in for the owner's yes: `/map couch`) |
| Refund | "refund the buyer" with money held: asks, then refunds; with nothing held says so |
| No-show | BUYER 24 h past pickup without confirming: OWNER gets a refund question (`/sweep`, or `/sale couch Alex $90 late` in the chat) |
| Sublet escrow | Applicant agrees rent: held until keys change hands |
| Buying side | You owe a seller: "Pay them $X?" at hand-off |
| Real Nessie | `/books` in the chat (or `smoke.ts`) lists every account's records; the totals must match the dashboard |
| Postgres state | Add a split, restart the service, ask "who owes me?": same answer; a waiting yes survives |
| Ledger-changing events | After any change the reply ends with `Dashboard: <link>` as its own block |

## 7. Smart Plan (beyond the ledger)

| Function | How to test |
| --- | --- |
| Setup question | Confirm a brief: the Money hello asks your budget |
| Draft plans | "plan my move under $300": three plans A, B, C with likely cost, odds of finishing under budget, a picture, and the dashboard link |
| Pick | "go with B" (or tap the poll where polls work): "On plan B…", written to Nessie as pending future-dated records, no money moves |
| Offered after a change | Add a split or deposit with no plan picked: a second text follows with three plans built around a budget worked out from your spend |
| Not asked twice | Pick a plan, add a deposit: no new offer |
| Bare keyword | "smart plan" / "what's my smart plan" / "show me my plan": a picked plan's odds and what's next; drafts again; or an offer; always with the picture and the link |
| No ledger yet | "smart plan" on an empty ledger: says there is nothing to plan around and asks a budget |
| No items / no move-out | Without items it says it can't see them; without a move-out date it asks for one |
| Switch | "go with C" after picking B: B's pending records cancelled, C's written |
| Drop | "drop the plan": its pending records cancelled |
| Different budget | "plan my move under $500": redrafted, odds change |
| Settling | `/sold desk` then `/plansweep` in the chat: that item's plan record completes; a donated item's cancels |
| Drift nudge | `/ff 5` with unsold items past their expected date and odds down 10 points: one nudge per item with a poll to switch |
| Pending never counts | Compare the dashboard totals before and after picking a plan: unchanged |
| Odds table | WEB Smart Plan tab, "How the odds are estimated": every assumption printed; every likelihood labelled an estimate |

## 8. Dashboard and pictures

| Function | How to test |
| --- | --- |
| The link | OWNER "dashboard": picture + link; WEB opens in a phone browser with nothing to install |
| Never expires | The link works after a restart and after a day; only changing `LEDGER_LINK_SECRET` revokes it |
| Bad token | Change one character of `t=`: 404; another move's id: 404 |
| Auto refresh | Change the Ledger in chat: the page picks it up within 5 seconds |
| Overview tab | Net cost so far, where it lands (Projected), chart, "Needs your OK", **Smart Plan panel in the middle**, balances, who owes you, held and due back |
| Smart Plan panel | Empty ledger: how-it-works. Something on the ledger and no plan: "Your move has cost $X… Where should it land?" with budget chips (tap to copy the text). Drafts: odds per plan. Picked: "Plan A is running your move" |
| Smart Plan tab | Chosen plan's 10 to 90% band with your real net cost over it; "In Nessie" pending records; choose / switch / budget / drop buttons |
| Plan buttons | Tap "Switch" or a budget chip: toast, reload, your chat gets "From your dashboard: …" |
| Coming back tab | Switch off one expected payment: projected net cost changes; "everyone pays late" does too |
| Activity tab | Every Nessie movement, newest first; tap a row for its record id |
| Approve / Not now | Pending question on the page: "Approve" asks "Tap to confirm"; "Not now" declines; chat is told |
| Dark mode + phone width | Phone in dark mode; browser at 375 px: no horizontal scroll, readable |
| Ledger card picture | "show me the ledger": a short card (headline, balances, a few rows, one footer line) |
| Plans picture | "plan my move under $300": the three-plan card; once picked, answers attach the ledger card |
| Preview picture | WEB `/ledger/<move>.preview.png?t=…` (1200×800); `.png` (tall); `.json` (the view) |
| Math cross-check | Read the card, the page and `.json` for the same move: out, back, net, owed, deposits, escrow must agree (and agree with `/books`) |

## 9. Failure and edge paths

| Function | How to test |
| --- | --- |
| No model key | Unset `ANTHROPIC_API_KEY`: deterministic template replies, nothing crashes |
| Nessie down | Bad `NESSIE_API_KEY`: "I couldn't reach the payments system just now, so nothing moved" and nothing is half-written |
| Store fallback | Bad `ELVES_DATABASE_URL` with `ELVES_STORE=auto`: runs on memory, `/health` says `degraded` |
| Shared-pool limits | Polls and threaded replies are refused on the shared pool: picks and approvals by text still work |
| Stale poll | Tap an old plan poll after a redraft: "out of date, want fresh ones?" |
| Duplicate texts | Send the same text twice quickly: handled once |
| Shelved mini app | `ELVES_MINIAPP=1` brings back the Photon 1.0 card (off by default) |

## 10. Suggested human run (about 40 minutes)

1. `bun test`, `bun run test:pg`, then `bun run packages/money-elf/scripts/smoke.ts` (real Nessie).
2. New phone: "hi" → intro → onboarding → "yes" → Money hello. "STATUS", "DASHBOARD".
3. Refusals: one of each (truck, lease, rent, bank, invest).
4. Stuff: photo + floor → "yes, list it" → BUYER negotiates → low offer → agree → slot → pickup → hand-off. Then a scam ask. Then "donate the lamp". "move report".
5. Money: split, a roommate "paid", a deposit (twice, to see it counted once), "got all my deposits back", "pay Sam $40", "refund the buyer".
6. Smart Plan: "smart plan", "plan my move under $300", "go with B", add something (watch the offer logic), "go with C", "drop the plan".
7. Home: hunt (one fact at a time) → "more" → "reach out to 2"; sublet post → applicant → viewing "Book it?" → "yes"; move-in checklist.
8. Dashboard: open the link on a phone, walk every tab, tap a plan switch, an Approve, a budget chip; compare numbers with `/books`.
9. Restart the service; ask "who owes me?" and "what's my smart plan"; the answers must be unchanged.

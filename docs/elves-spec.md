# Elves spec sheet: the five Elves

> Detailed target behavior for each Elf, written 2026-10-17 after the ten Elves from the design doc were folded into five. "Built today" reflects that date; see [`SPEC.md`](../SPEC.md) for current status (the Home Elf housing search has since been built).

## Overview

Elves is a moving crew the owner texts. Five Elves share one phone number: the Crew Lead runs the chat and hands work to four specialists, each with a few sub-skills. Today the Crew Lead and Stuff Elf selling are built on the LLM. Every other skill sends a fixed reply and updates the Crew Board. This sheet specifies the full target behavior of each Elf, including the new Room Scan on the Move-day Elf.

| Elf | ID | Owns | Sub-skills | Built today |
| --- | --- | --- | --- | --- |
| Crew Lead | `crew_lead` | The chat, the plan, dates, addresses, roommates, hand-offs | Intake, plan, approvals, board link | Yes |
| Stuff Elf | `stuff` | Everything the owner owns or wants | Sell, Buy, Donate / Last Call | Sell only |
| Money Elf | `money` | Every dollar that moves | Escrow, Ledger, splits, scam check. Nessie is the ledger | No (fixed reply) |
| Move-day Elf | `moveday` | Getting the stuff from A to B, after the Home Elf has planned everything | Room Scan, U-Haul pick and quote, Move Map route, return-time planning | No (fixed reply); Room Scan is new |
| Home Elf | `home` | The place you leave, the place you go, the gap between | Lease, Hunt, Move-in week | No (fixed reply) |

Every Elf has the same shape in code: `handle(ctx)` returns replies, a board update, events and changes to the move record (`packages/elves/src/contract.ts`). Elves never send messages themselves; the service does.

## 1. Crew Lead (`crew_lead`)

The Crew Lead is the owner's single point of contact: it captures the move's facts, says which Elf is on what, and asks for one missing thing per turn.

**Gets the message when:** it is the owner's first contact; it's a greeting, a thank-you or a status check; it mentions dates, addresses, roommates or the plan; or nothing else matches.

**Voice variant** (`VOICE_ONBOARDING_PROMPTS` in `packages/elves/src/onboarding-voice.ts`): the same call as a Retell single-prompt voice agent. `story_first` (the one on trial) hands the caller the floor, mirrors the move back with the gaps as blanks and states assumptions aloud, plays the brief back, and on a yes calls the `submit_brief` custom function, then `end_call`. The prompt is in Retell's shape (Role, Call flow steps, Closing, Rules; built-in `{{current_time}}` and `{{user_number}}`); the brief's shape lives in the function's JSON schema, generated from `BriefWire` plus `status` by `retellSubmitBriefTool()`, so `args` is the wire brief (`""` / `-1` for unknowns) and the webhook parses it with `SubmitBriefArgs` and `briefFromWire`. `bun run scripts/retell-agent.ts` prints everything to paste into the dashboard. The service-side `submit_brief` webhook is not built yet. The other two voice variants (`sweep`, `thread`) are in `docs/crew-lead-retell-prompts.md`, still in long form.

**Inputs:** the owner's batched messages, any photos, the move record, the item list, the Crew Board, and memory (the conversation so far plus working memory).

**What it does each turn**

1. Extracts facts with the LLM, with a rule-based parser as a backup: move-out and move-in dates, from and to addresses, items with their intent (sell, donate, keep, buy, unknown), roommates, and explicit requests.
2. Identifies items in any photos at the same time, using the shared photo intake.
3. Saves new facts to the move record, but never overwrites an address the owner already gave.
4. Creates items it hasn't seen, with default weights per category (couch 150 lb, mattress 60 lb, desk/table 70 lb, chair 20 lb, bookshelf/dresser 90 lb, small 10 lb, other 25 lb).
5. Hands work out on the board: items to sell or donate go to the Stuff Elf; once a move-out date is set, Last Call is scheduled 48 hours before it; once the move-out date and an item list exist, it suggests a Room Scan to the Move-day Elf (new).
6. Records an approval ("yes", "go ahead", "list it") when an item is waiting for one.
7. Sends the live Crew Board link once, on a turn after the first, when the service has a public URL.

**Reply rules**

- Plain text, 2 to 4 short lines, one sentence each, at most one emoji.
- Confirms what it captured in the owner's own words.
- Names only Elves that actually have work this turn.
- Asks for at most one missing thing, in this order: move-out date, then the lowest price for a photographed item, then a photo of an item to sell, then a room photo for moving estimates (new).
- On first contact, opens by saying it's their moving crew.
- Never repeats facts already confirmed, and answers questions from working memory.

**Guardrails:** it never promises to move money, post to a marketplace or book anything without the owner's OK.

**Writes:** move record fields, items, the board rows for Crew Lead and Stuff Elf, and the events `move.date_captured`, `item.captured`, `item.identified`, `listing.approved`.

**Status:** built (`packages/elves/src/crew-lead.ts`). The Room Scan hand-off and the room-photo ask are new.

## 2. Stuff Elf (`stuff`)

The Stuff Elf decides what happens to every item: sold, bought, given away, donated or hauled. The goal is that nothing ends up on the curb.

**Gets the message when:** it holds a photo (unless it's first contact), it's just a price ("$60", "lowest 80"), it's a reply in a Stuff Elf thread, or it mentions selling, buying or getting rid of things.

**Choosing a sub-skill:** photos, prices and approvals always go to Sell. Otherwise keyword scores decide, and Buy or Donate wins only when it scores strictly higher than Sell.

### 2a. Sell (built)

1. **Photo intake:** up to 4 photos per batch go to the vision model. For each sellable item it returns a name, category, condition (like new, good, fair, worn), estimated weight, a fair used-price range for a US college town, a listing title under 60 characters and a 1–2 sentence description. People, pets and the room itself are ignored.
2. **Matching:** a photo enriches an item the owner already named ("couch" plus a photo of a gray sofa makes one item, not two).
3. **Lowest price:** a typed amount ("$4", "4 bucks", "I'd take 80", "floor is 50") sets the item's minimum. The item is matched by name, then category word, then the item just photographed, then the newest item without a minimum.
4. **List price:** the higher of the owner's minimum and 60% of the way up the fair range, rounded (to $10 above $100, to $5 above $20).
5. **Approval:** nothing is listed until the owner says yes. A "no", "wait" or "hold" blocks it.
6. **Buyers:** buyers text the same number. The Elf negotiates and never goes below the minimum without the owner's OK. (Buyer conversations are the next ticket.)
7. **Pickup:** confirms the buyer's pickup time and tells the Move-day Elf the item is leaving, so it drops out of the truck estimate.

**Replies:** 2–3 plain lines. It says what it sees and the fair range, confirms the minimum and the list price, then asks for exactly one thing. It never asks for a photo or minimum it already has, and never claims to have posted anywhere.

### 2b. Buy (fixed reply today)

- **Input:** a forwarded listing link or screenshot, plus the owner's max price.
- **Does:** reads the listing (item, condition, price, seller), compares it with similar used prices, gives a verdict (good deal, fair, overpriced, likely scam) and drafts an offer.
- **Hand-offs:** payment goes through the Money Elf. Delivery goes to the Move-day Elf, and the item is added to the new place's item list.
- **Guardrail:** sends an offer only with the owner's OK.

### 2c. Donate / Last Call (fixed reply today)

- **Last Call** starts 48 hours before move-out. Unsold items drop in price, then go free, then get booked for donation or a 311 / bulk pickup.
- **Direct requests:** "donate the rest", "give away the lamp" and "can it go on the curb" mark items to donate or give away.
- **Move Report:** after the move it sums what was sold, donated and dumped, by weight, so the owner sees how much skipped the landfill.

**Writes:** items (photos, range, condition, minimum, list price, approval, outcome), the Stuff Elf board row, and the events `item.identified`, `item.floor_set`, `listing.approved`.

## 3. Money Elf (`money`)

The Money Elf tracks every dollar in the move on one Ledger. No money moves without the owner's OK.

**Gets the message when:** it mentions payments, Venmo, Zelle, Cash App, deposits, escrow, splitting, owing, refunds, the ledger or scams. Keyword ties ("split the truck cost") resolve to Money over Move-day.

**Skills**

- **Escrow for sales:** a buyer pays into escrow, and the money is released to the owner when pickup is confirmed. If a pickup falls through, the buyer is refunded.
- **Deposits:** tracks holding deposits on a sublet, the truck, storage or movers, with who paid and when each is due back.
- **Moving Fund and splits:** roommates agree how to split shared costs (truck, storage, cleaning), evenly or by share. The Elf sends each person a payment request and tracks who has paid.
- **Ledger (on Nessie):** Nessie is the ledger. Every sale, escrow hold and release, purchase (U-Haul, storage, movers) and split is a Nessie transaction, and the Ledger is one running list per move built from them: date, what, who paid, who owes, amount, status (pending, paid, refunded). Its totals show on the Crew Board.
- **Scam check:** flags overpayment checks, "I'll send a mover", off-platform payment requests, deposits asked before a viewing, and prices far below market. It warns in plain words and never pays a flagged request.

**Hand-offs:** sale proceeds come from the Stuff Elf; quotes to split come from the Move-day Elf; rent and deposit terms come from the Home Elf.

**Guardrails:** it never sends, requests or releases money without the owner's explicit yes for that payment. It never asks anyone for card or bank numbers in the chat.

**Replies:** 2–3 plain lines, with amounts in dollars and one action to approve.

**Writes:** ledger entries, the Money board row, and the events `payment.requested`, `payment.received`, `escrow.released`, `scam.flagged` (proposed).

**Status:** fixed reply today. Nessie is the ledger; a production payments provider (Stripe Connect behind `MoneyRails`) is later.

## 4. Move-day Elf (`moveday`)

The Move-day Elf turns "what's in my room" into a box count, the right U-Haul and a route, then runs the day itself.

**When it works:** after the Home Elf has planned everything: lease end, move-in date, the gap between, and whether storage is needed. Then, on move day, it handles four things. Room Scan, which sizes the load. Finding the right U-Haul: truck size, number of boxes, furniture dolly and the rest of U-Haul's specs, then asking the cost and confirming with the owner. The Move Map and route planning. And all of it planned around **when the U-Haul has to be returned**. Room Scan is its front door: every quote starts from it.

**Gets the message when:** it mentions trucks, U-Haul, movers, storage, permits, vans, boxes, packing, ETAs, meeting up or being late; when the owner sends room photos after a Room Scan ask; or when it's a reply in a Move-day thread.

### 4a. Room Scan (new)

The owner texts 1–6 photos of a room. The Elf replies with what it sees, how many boxes to pack, how much space it all takes and which truck fits.

**Routing:** photos normally go to the Stuff Elf. A batch goes to Room Scan instead when the text mentions a room, packing, boxes, a truck or a quote; when it replies to a Room Scan ask; or when the vision model sees a whole room rather than one item (proposed rule: more than 3 distinct items, or a shelf, closet or wall in frame).

**Steps**

1. **Inventory:** the vision model lists every visible item with its category, size (small, medium, large) and quantity, plus loose stuff to box: books, clothes, kitchenware, decor, electronics. It tags each photo with a room (bedroom, kitchen, living room, bathroom, closet).
2. **Merge:** items already on the move's list are matched, not duplicated. Items the Stuff Elf will sell or donate before move day are left out of the load, with the count shown so the owner sees the savings.
3. **Boxes:** loose stuff becomes boxes by type: books to small boxes, kitchen and decor to medium (with packing paper), clothes and linens to large, hanging clothes to wardrobe boxes. Shelves visible but not in frame add a 20% buffer.
4. **Volume and weight:** each item and box adds cubic feet and pounds from a lookup table, starting from the category weights the crew already uses.
5. **Truck size:** total cubic feet at 80% packing efficiency picks the smallest vehicle that fits, with the next size up as a fallback when it's within 10% of the limit.
6. **Labor:** estimates loading hours for a 2-person crew from item count, heavy items (over 100 lb) and stairs. It asks once whether either address has stairs or an elevator.
7. **Reply:** 3–4 plain lines, for example: "Bedroom: bed, dresser, desk, 2 shelves of books. About 14 boxes (6 small, 5 medium, 3 large) and ~210 cu ft. A cargo van fits; a 10' truck if you keep the desk. Want quotes for Nov 1?"
8. **Corrections:** the owner can reply "no desk" or "add a bike" and the estimate updates in place. Each room adds to one running Move Estimate on the Crew Board.

**Default estimation tables (approximate, to be tuned with real moves)**

| Box | Size | Volume (cu ft) | Typical contents |
| --- | --- | --- | --- |
| Small | 16×12×12 in | 1.5 | Books, tools, pantry |
| Medium | 18×18×16 in | 3.0 | Kitchen, decor, electronics |
| Large | 18×18×24 in | 4.5 | Clothes, linens, pillows |
| Wardrobe | 24×21×46 in | 13.0 | Hanging clothes |

| Vehicle | Usable space (cu ft, approx.) | Fits about |
| --- | --- | --- |
| Cargo van | 245 | A dorm room or a lightly furnished bedroom |
| 10' truck | 400 | A studio or one full bedroom |
| 15' truck | 760 | A 1–2 bedroom apartment |
| 20' truck | 1,000 | A 2–3 bedroom apartment |
| 26' truck | 1,680 | A 3+ bedroom home |

Vehicle capacities are approximate and must be checked against the rental company's published specs before launch.

**Output (the Move Estimate):** item list by room, box counts by type, total cu ft and lb, recommended vehicle and fallback, crew hours, and a supplies list (boxes, tape, paper, mattress bag) with an estimated cost.

### 4b. The right U-Haul, and other haul quotes

- **Input:** the Move Estimate, move-out date, both addresses, stairs and elevators, and whether storage is needed (from the Home Elf's gap check).
- **Picks the U-Haul:** the smallest vehicle that fits, using U-Haul's published specs: cargo van or 10', 15', 20', 26' truck, with usable cu ft, max load, deck height and loading ramp. It also gives the number and sizes of boxes to buy, plus add-ons: furniture dolly, appliance dolly, furniture pads, mattress bag.
- **Asks the cost and confirms:** it gets the price for the vehicle, mileage and add-ons for the owner's pickup and return times, shows the total, and books only after the owner confirms. The cost goes to the Money Elf.
- **Return time:** it records when and where the truck must be returned. Everything else on move day is scheduled backward from that.
- **Does:** gets quotes for the recommended truck rental, for 2-person movers by the hour, and for storage sized to the estimate (5×5, 5×10, 10×10). It shows 2–3 options side by side with total cost.
- **Permits:** flags when the city needs a moving or parking permit for a truck on the street and drafts the application.
- **Booking:** books only on the owner's OK. The cost goes to the Money Elf to split.

### 4c. Move Map

- **On move day:** sends everyone (owner, roommates, movers, buyers picking up) a Move Map link with each person's live location and ETA, by consent.
- **Running late:** "running late" or "on my way" updates the ETA for everyone and nudges the next pickup.
- **Route planning:** plans the route and order of stops: buyer pickups first, then load, then storage, then the new place. It flags low-clearance roads (Storrow and Memorial Drive) for trucks.
- **Return deadline:** the route is built around when the U-Haul is due back. If the plan, or someone running late, would miss the return time, it warns the owner early and suggests what to drop or move.

**Guardrails:** it never books, reserves or pays without the owner's OK. Estimates are labeled as estimates, and location is shared only by people who opt in.

**Writes:** room scans and the Move Estimate, quotes, the Move-day board row, and the events `room.scanned`, `estimate.updated`, `quote.received`, `booking.confirmed` (proposed).

**Status:** fixed replies today for Haul and Map. Room Scan is new: it reuses the photo intake and vision call in `packages/elves/src/intake.ts` with a room-level schema.

## 5. Home Elf (`home`)

The Home Elf covers housing at both ends: getting out of the current lease cleanly, finding the next place, and getting through move-in week.

**Gets the message when:** it mentions the lease, subletting, the landlord, notice, the security deposit, a room or apartment search, budget, neighborhoods, utilities, internet, an address change, insurance, hotels or luggage.

### 5a. Lease

- **Input:** the lease PDF or photos of its pages.
- **Does:** answers whether the owner can sublet or break early and at what cost, quotes the exact clauses with page numbers, and lists the notice deadline as a date.
- **Drafts:** the landlord notice, a sublet request, and a move-out checklist for getting the deposit back (photos of each room, cleaning, keys).
- **Deposit:** tracks the return deadline and reminds the owner, with the Money Elf logging the amount.

### 5b. Hunt

- **Input:** budget, dates, neighborhoods, must-haves, plus any listings the owner forwards.
- **Does:** ranks listings against those requirements, with one line on why each ranks where it does.
- **Scam flags:** no viewing allowed, a deposit before a viewing, a price far below the neighborhood, or a copied photo. These go to the Money Elf's scam check too.
- **Outreach:** drafts the message to a lister; it sends only with the owner's OK.

### 5c. Move-in week

- **The gap:** if move-out comes before move-in, it finds luggage storage or a short stay for those nights, and tells the Move-day Elf to price storage.
- **Checklist:** electricity, gas, internet, renters insurance, USPS address change, keys and a move-in condition report with photos, each with a due date relative to move-in.
- **Reminders:** sends one text per due item, in the days before move-in.

**Guardrails:** it never signs, submits or pays for anything; it drafts, and the owner sends. It gives lease readings as summaries with the clause quoted, not legal advice.

**Writes:** move-in date and to-address (if the Crew Lead doesn't have them yet), checklist items, the Home board row, and the events `lease.read`, `listing.ranked`, `checklist.created` (proposed).

**Status:** fixed reply today, one per sub-skill.

## 6. Shared rules

Every Elf follows the same routing, reply style and approval rules, so the owner experiences one crew rather than five bots.

**Routing order** (`packages/elves/src/router.ts`), first match wins:

1. First contact goes to the Crew Lead.
2. A reply inside an Elf's thread goes to that Elf.
3. Photos go to the Stuff Elf, or to Room Scan when the room rule matches (new).
4. A short message that's just a price goes to the Stuff Elf.
5. The fast LLM classifies against each Elf's description, if it is at least 0.5 confident.
6. Keyword scores decide; ties go to the earlier Elf (Crew Lead, Stuff, Money, Move-day, Home).
7. Otherwise the message goes to the Crew Lead.

**Inside an Elf:** each grouped Elf scores its sub-skills by keyword; ties and no-match go to its first sub-skill (Sell, Room Scan, Lease).

**Reply style:** plain text only, no markdown, 2–4 short lines, at most one emoji. Each reply threads under the owner's message when the space allows it, and falls back to a flat send when it doesn't. Every reply asks for at most one thing.

**Approvals:** anything that spends, sends, posts, books or signs needs an explicit yes from the owner for that action. A yes covers only the item it answered.

**Memory:** every Elf's prompt starts with working memory and the conversation so far, so no Elf asks for something the crew already has. (The Stuff Elf's selling prompt doesn't include it yet; fix in the next pass.)

**Crew Board:** one row per Elf: status (idle, working, waiting, done, blocked), current task, last update. Room Scan adds a Move Estimate panel.

**Events:** every state change is an event with the move ID and trace ID, so a move can be replayed and audited.

## 7. Open questions and build order

**Open questions**

- [ ] Room Scan routing: is the "whole room in frame" rule good enough, or should the Crew Lead ask "selling this, or scanning the room?" when unsure?
- [ ] Quote sources: which truck rental, mover and storage providers do we pull real prices from, and is there an API or do we draft requests?
- [ ] Estimation tables: whose numbers do we calibrate against (past moves, a moving company's calculator)?
- [ ] Payments: which provider handles escrow and payment requests in production?
- [ ] Move Map: what location consent flow do roommates and buyers see?
- [ ] Lease reading: what disclaimer appears with lease summaries?

**Proposed build order**

1. Room Scan: the vision schema, estimation tables, Move Estimate on the board, and the Crew Lead's room-photo ask.
2. Haul quotes from the Move Estimate, with booking on approval.
3. Stuff Elf buyer conversations and Last Call.
4. Money Elf escrow and Ledger, tied to sales and split quotes.
5. Home Elf lease reading and the move-in checklist.
6. Hunt and Move Map.

## 8. Elf connections (Home ↔ Money, Home ↔ Move-day)

The Home Elf is a sublet agent in both directions. Each direction ends in a hand-off to another Elf; these are the seams to build against, recorded here so they are not lost between branches.

| Direction | Home does | Hands off to | Carrier today |
| --- | --- | --- | --- |
| Sublet out | Collects rent, dates, area, photos; writes the post (owner pastes it); applicants text the number with the ref; the Deal Engine (`sublet_out`) screens, holds the rent floor, asks the owner on low offers, offers viewing slots | **Money Elf**: sublease agreement and deposit/escrow once an applicant is agreed | `deal.agreed` + `ledger.hold` events; Money is still a canned stub, no contract exists |
| Hunt | Finds listings by cost, area, dates; ranks, flags scams; "reach out to N" opens `find_sublet` (and, on the outreach branch, texts the lister from the dedicated line) | **Money Elf**: verify the landlord/lister before any deposit (identity, lease authority, payment outside escrow) | listing `scamFlags` + the engine's Scam Shield (`scam.flagged`); no landlord verification exists |
| The gap | Hotel nights between move-out and move-in (Airbnb), storage query (SpareFoot behind a flag), luggage-gap task on the move-in checklist branch | **Move-day Elf**: consumes hotel, storage and flight plans with `pickup.scheduled` when it plans the day | nothing emits a gap plan yet; flights are not searched |

Verified 2026-10-17 on branch `gavin` with the fake model and the script transport: the sublet_out applicant conversation above runs end to end (join by ref → floor held → owner asked/answered → agreed → viewing slots → `ledger.hold`). Gaps seen in the same run: an applicant asking to view *before* agreeing gets the availability line again; "how do I pay the deposit?" is not answered (Money's job); flights have no recipe.


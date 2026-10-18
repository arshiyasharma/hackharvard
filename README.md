# Elves — a moving crew you text

HackHarvard 2026. A Crew Lead and three specialist agents ("Elves": Home, Stuff, Money) live in your iMessage/SMS thread on Photon 2.0 lines and run a move: find the next place and storage, sublet the old one, sell the furniture, keep the ledger, keep things out of the landfill. This repo is the service behind the number.

Product spec and decisions: [`SPEC.md`](SPEC.md). Five-Elf behavior, including Room Scan: [`docs/elves-spec.md`](docs/elves-spec.md). Original design and the W1–W23 plan: [`docs/`](docs/). **This README is the state of `team-stable`.** SPEC §2, §3 and §6 still describe an older snapshot (Deal Engine "not on this branch", Buy and Donate as stubs, 202 tests, migrations stopping at `0003`). When they disagree with the table below, trust this README, then the code.

## State of this branch

`bun test` is 340 tests across 28 files, no credentials. `bun run typecheck` is clean. Live host: `https://elves-production.up.railway.app/health`.

Branch from here when you want the crew that actually runs. The rows marked **empty** answer with a canned line and a Crew Board update. They do not call an API.

| Area | On `team-stable` | Still empty |
| --- | --- | --- |
| Crew Lead | Built. The onboarding call first: from the owner's first text until they confirm the brief, the Crew Lead only gathers (dates, from/to, what goes and what has to go, how it moves, people, lease, money, worries), plays the brief back, and dispatches the specialists on "yes" (`packages/elves/src/onboarding.ts`; board link goes out with the dispatch). The first text opens with the crew's exact ability list (below), "what can you do?" gets it again, "status" gets one paragraph, and anything off the list gets "the crew can't do that" plus the closest thing it can do. After that: dates, items, routing, approvals as before. | Mini-app polish. The board page exists; it is not a live mini app. With the fake model there is no onboarding call (the deterministic Crew Lead answers). |
| Stuff (from `stuff-elf`, merged 2026-10-17) | Per-item approval, floors kept private from buyers, donate/give/keep, outcomes, Last Call, the Move Report (`impact.ts`), Buy verdict. See [`docs/stuff-elf-plan.md`](docs/stuff-elf-plan.md). | Nobody posts the listing anywhere; the owner pastes it. |
| Stuff · Sell | Built. Photo → vision → item, floor, list price, "yes, list it" opens a `sell_item` deal. Buyers text this number. | Nobody posts the listing to a marketplace. The owner pastes the ref into their own post. |
| Stuff · Buy | Opens a `buy_item` deal after an explicit yes. Needs a forwarded link and a max price. The ceiling is the deal's limit. | No comps. No message to the seller. The seller has to text this number and quote the ref. The canned "I'll check comps" line is no longer what runs when the text is a real buy. |
| Stuff · Donate | "Donate the lamp" acts at once (no "say yes"): the open sell deal is closed `donated` so the listing is off, the item is marked `donated`, and `pickup.requested` is emitted. The Elf asks which item if it can't tell, and the city only if the move-out address doesn't say (an address in a Boston neighborhood is enough). Then it sends two texts: who picks up there (Boston 311 bulk pickup for Boston itself, a "search <city> bulk item pickup" line for any other town, plus Salvation Army, Goodwill, Habitat ReStore) and a request drafted for you to forward, naming the item and the move-out date (`donate.ts`). A question ("can I donate it if it doesn't sell?") takes nothing off sale. | The Elf places no call and books nothing; you send the draft. Contacts in `donate.ts` are written from memory and should be checked before a demo. A bare "last call" / "recycle" question with no item is still the canned green reply. |
| Last Call | Sweep in `lastCallSweep`, gradual: T−72h cuts the ask 20%; T−48h cuts it another 25% (60% of where it started); T−24h relisted free and `pickup.requested`; move-out: anything still open is `dumped`. A sweep that first sees a deal inside 48h makes both cuts at once and says 40%. Each cut texts the owner how much and why ("move-out is in about 38 hours, so I cut the armchair by 40%, from $35 to $21"), and offers `keep the armchair` (hold this price) or `donate the armchair` (off sale, draft the request). Buyers still in the talk get only the new price and the deal's ref code ("Price drop: the armchair (ref H2P3) is now $21. Want it?"), never the floor. "Keep the couch" sets `last_call_opt_out`. Stages: `none → drop_1 → dropped → free → closed`. | The pickup is an event, not a booked truck. The floor follows the ask down, as before. |
| Deal Engine | Built. Postgres state machine plus a sweep. Not Mastra. Modes: `sell_item`, `buy_item`, `sublet_out`, `find_sublet`. States: listed → negotiating → scheduled → handed_off → paid, plus relisted / donated / dumped. Floor and ceiling are code. Three pickup slots, one shared calendar. Scam Shield blocks off-escrow payment on a deal. | No no-show timeout sweep. No poll for "both accepted". A stranger whose text matches two open deals is not joined (ambiguity returns null). A counterparty already in two talks is asked which item when the text names more than one. |
| Money · Nessie | The engine emits `ledger.hold` when a price is agreed, `escrow.requested` and `ledger.release` on hand-off, and `ledger.refund` if that party walks before hand-off. | **Nessie is not integrated.** No `MoneyRails`, no Nessie client, no Moving Fund, no Escrow account, no Ledger page. The Money Elf is a canned reply. Real dollars are not moved. |
| Home · Hunt | Built. One missing fact at a time (budget → area → dates), then Craigslist and Airbnb. Scam flags, rank, top 3. "more" / "tell me about 2" / "skip" / "save". "search again" bypasses the 3-minute cache. A forwarded listing URL is ranked with the picks. "Reach out to 2" opens `find_sublet`; when the listing shows a phone, the dedicated line texts the lister the drafted note, the owner hears "Texted them from <line>", and the lister's replies run through the Deal Engine as summaries in the owner chat. | Booking, SpareFoot, Apartments, Zillow, and Facebook are off the default allowlist (blocks). A listing with no phone (Craigslist, Airbnb) still gets a note the owner sends. Without a dedicated line (`PHOTON_DEDICATED_AGENT_ID` or a discoverable one) the note goes to the owner too; the shared pool cannot text first. Email contacts are not used. |
| Home · Sublet | "Sublet my room for $1500" opens `sublet_out` at once, then asks for dates and area one at a time, reads room photos with vision, and writes the post (title + body with the ref and the number) in `sublet_posts`. "Change …" redrafts, "post it" approves. An applicant who agrees a rent is offered viewing times; the time they pick is held and the owner is asked "Book it?", and only a yes books it (a no offers them the other times). The same holds for a lister's viewing on `find_sublet`. | The owner pastes the post; nothing is posted to Craigslist or Facebook by the crew. No landlord is contacted. The crew does not read leases: "can I sublet my room?" gets "your lease and landlord decide that one". |
| Home · Move-in | Built. "Set up internet at the new place" / "what do I need for move-in" asks for the move-in date and the new address one at a time (both written onto the move), then texts the checklist with dates from `movein_tasks`: electric, gas and internet 10 days out, renters insurance and the USPS address change 7 days out, keys and the condition report on the day, bags for the gap when move-out comes first (the hotel itself stays with the hunt). "Done with internet", "skip insurance", "what's left" and "address is …" keep it current; a moved date re-dates the open tasks. `moveinSweep` runs on the Last Call timer and texts one reminder per task within 2 days of its date. Working memory carries a "Move-in week" section so any Elf can answer "did we set up internet?". | Nothing is ordered: the owner places every order and the crew calls no utility or ISP. No provider lookup for the address. One reminder per task, no snooze. |
| Move-day | **Folded into Home on 2026-10-17; there is no Move-day Elf.** Storage is a Home search (SpareFoot), the move checklist and "status" cover what move-in week needed. A booked pickup still emits `pickup.scheduled`. | Trucks, U-Haul, movers, Room Scan, the Move Map and ETAs are out of scope: the Crew Lead says the crew can't, by design. Old `moveday` board rows stay in the table and are hidden. |
| Owner yes | Inbound 👍 / heart / ✅ with no text counts as "yes" on the owner's question, and on a pending buy or donate. | Outbound 👍 fails on the shared Photon pool (`409`). Replies stay plain text. There is no tapback override for a scam flag. |
| Memory and store | Postgres (Supabase) via `Bun.sql`. Working memory, transcript, facts, notes. Migrations `0001`–`0009` run on boot. | `0005_workflows.sql` still creates `deal_runs` and `last_call_runs`. The Mastra package that used them was deleted. Nothing writes those tables. |

**Deal Engine, precisely.** `packages/engine` decides; the Elves only phrase it. `openDeal`, `attributeInbound`, `counterpartyTurn`, `ownerTurn`, `lastCallSweep`. A buyer is matched by the ref code in the post (`K7Q2`) or, on a first text, by one shared title word. Negotiation never crosses the owner's floor or ceiling; an offer past the line becomes one question in the owner chat. Hand-off tags the item `sold` or `given`. Payment copy says escrow. That escrow is the ledger events above, not Nessie. Each mode has a voice (`packages/engine/src/voice.ts`): `find_sublet` speaks as the buyer who texted first ("Is it still available? We can do up to $X", "Great, $X works; when could we see it?"), opens at min(listed rent, budget) so a lister holding above the budget is countered at it and then put to the owner, relays each counter to the owner, and never sends the owner's address to a lister.

**Routing** (`packages/elves/src/router.ts`), first match wins: counterparty role → that deal's Elf; first contact → Crew Lead; an owner whose brief is not confirmed yet → Crew Lead (the onboarding call); thread owner; "keep the couch" → the Elf that owns the open Last Call deal; "yes" / "no" / a price while an offer or a buy/donate confirm is waiting → that Elf; "2" / "more" / "search again" / a forwarded URL after Home spoke → Home; a date or address after Home asked for one, or "done with internet" / "what's left" on a move-in checklist, after Home spoke → Home; photo → Stuff; a bare price → Stuff, unless keywords already point at another Elf (so "sublet my room for $1500" stays Home); Claude Haiku at ≥ 0.5; keywords; else Crew Lead. Room Scan is not a route.

**What to build next, in the order the demo needs:**

1. Nessie behind the ledger events (Money Elf voice stays the Elf; the engine keeps the rules). No money moves without the owner's yes.
2. Room Scan on Move-day, skipping any item whose deal already emitted `pickup.scheduled`.
3. Move Report from item outcomes and weights. Dumped counts against the total.
4. U-Haul quotes and the Move Map are still canned.

Do not reintroduce `packages/workflows` or `@mastra/core`. SPEC already records that decision. Leave `0005_workflows.sql` in place so existing databases still migrate.

## The crew: a Crew Lead and three Elves

One list in code says what the crew can do: `CREW_ABILITIES` and `CREW_LIMITS` in [`packages/elves/src/crew.ts`](packages/elves/src/crew.ts). The Crew Lead's text prompt, its first message, the onboarding call and the Retell voice prompt all read it, so the owner hears the same abilities everywhere. Change an ability there, not in a prompt.

| Elf | What it does | What it never does |
| --- | --- | --- |
| **Home** | Finds a place to move into, a hotel for the gap, or storage (Craigslist, Airbnb, Booking.com, SpareFoot), flags scams, texts the top 3. Sublets your place: asks rent, dates, area and room photos, writes the post for you to put up, handles applicants. Keeps the move checklist (utilities, internet, renters insurance, USPS address change, keys, condition report). | Books a viewing without your yes (the applicant's pick is held and you get "Book it? yes or no"). Reads leases or contacts landlords. Posts anything for you. |
| **Stuff** | Prices an item from a photo and writes the listing line. Negotiates with buyers who text the number, never under your lowest price, asking you on low offers. Last Call: 20% off at 72 hours before move-out, another 25% at 48 (each text says how much and why), free at 24; at any point "donate it" takes the listing off and drafts the pickup request. (Yashashri's `stuff-elf` branch carries the newer Stuff work.) | Posts to Facebook Marketplace or anywhere else; you paste the post. |
| **Money** | The move's ledger on Nessie: every sale, escrow hold and release, the money set aside for the move. A dashboard and a ledger-editing mini app are ideas, not built, and are not advertised. | Pays, sends or requests money for you. |

**What the crew cannot do** (said the same way every time): book trucks, U-Hauls or movers; plan the route or run move day; post listings for you; read leases or contact landlords; pay, send or request money for you; give legal or financial advice; anything not about the move.

### Crew Lead on iMessage / SMS

The prompt is `SYSTEM` in [`packages/elves/src/crew-lead.ts`](packages/elves/src/crew-lead.ts) (the onboarding call's is `CONTRACT` in `onboarding.ts`). What it does, in order:

- **First text:** opens with `crewIntro()` word for word: "Hey, I'm the Crew Lead at Elves, your moving crew. Here's what we can do:", one line per ability, then what the crew can't do. Never "text me anything". On the live model the onboarding call's first question follows it; with the fake model the deterministic reply follows it.
- **"what can you do?" / "help":** `abilitiesReply()`, the same list. Routed to the Crew Lead from any thread (`via: "scope"`), during onboarding too, without moving the call along.
- **"status" / "where are we?":** `statusReport()` in [`status.ts`](packages/elves/src/status.ts), one paragraph read straight off the store, nothing invented: dates and addresses; the checklist (open items with due dates, done items); the sublet post and applicants; housing picks; Stuff listed, sold and booked pickups; the ledger (held in escrow, released); and anything waiting on your yes (a low offer, a viewing time).
- **Out of scope:** `outOfScope()` matches trucks and movers, move-day logistics, lease reading and landlords, posting for you, paying someone, and legal or financial advice. The reply is the fixed "The crew can't …" sentence plus the closest thing it can do. Anything else off the list is caught by the prompt's scope rules, which forbid improvising an ability.
- **Approvals:** nothing is booked, posted, paid or agreed without the owner's yes.
- **Calling other Elves:** see "How a text moves through the crew" below.

### How a text moves through the crew

Every text takes the same path (`apps/elves/src/service.ts`):

1. **Batch.** Texts from one phone within the debounce window become one batch; the last one is acknowledged (read receipt, a 👍 per text, typing).
2. **Route** (`packages/elves/src/router.ts`), first match wins: counterparty (a buyer, applicant or lister in their own space) → the Elf that owns their deal; first contact → Crew Lead; the onboarding call until the brief is confirmed → Crew Lead; `status` → Home, `what can you do?` → Crew Lead; a reply inside an Elf's thread → that Elf; a pending deal question (`yes` / `no` / `$70`, "keep the couch") → the Elf that asked; Home follow-ups (`2`, `more`, `search again`, a date or address Home asked for, `done with internet`) → Home; a room photo while Home writes the sublet post → Home; a photo → Stuff; a bare price → Stuff; **a text whose keywords hit both Stuff and Home → Crew Lead** (`via: "delegate"`); then the fast model classifies, then keywords, then Crew Lead.
3. **Handle.** The routed Elf gets one `ElfContext` (store, LLM, move, participant, batch, working memory, listings source, clock) and returns one `ElfResult`: `replies` for this space, `outbound` texts for other spaces, `events`, `movePatch`, `boardPatch`, and an optional `later()` for slow work (a browser search) that runs after the replies go out.
4. **Deliver.** The service writes the move patch, patches the board row, appends the events, sends the replies (idempotent per message), sends the outbound texts, records the thread owner, and runs `later()`.

**The Elf API is one interface** (`Elf` in `contract.ts`: `name`, `description`, `keywords`, `handle(ctx)`), and Crew Lead, Stuff, Home and the Money stub all implement it, so any of them can be routed to or called by another. The registry (`registry.ts`) is how they call each other: `allElves` registers every Elf by name once; `callElf(ctx, "stuff")` runs one on the current batch, `callElves(ctx, ["stuff", "home"])` runs several in order and merges their results (replies and outbound in order, every event, move patches merged, each Elf's board row patched). No Elf imports another, so there are no import cycles.

**When you text the Crew Lead and the work spans Elves:** "sell my couch and find me a room in Allston under 1200" routes to the Crew Lead, which calls `stuffElf.handle` then `homeElf.handle` on the same batch. You get Stuff's reply (the couch is captured; it asks for a photo and a floor) and then Home's (budget and area captured; it asks for dates), both board rows move, and from then on each thread routes to its own Elf. It is keyword-based: a text that clearly asks for both. A text for one Elf goes straight to that Elf, and the Crew Lead's own LLM reply never spawns an Elf on its own. Not on first contact, and not with photos (those stay with intake).

### What each Elf does now

**Crew Lead** (`crew-lead.ts`, `onboarding.ts`, `crew.ts`)
- First text: the crew intro with the exact ability list, then the onboarding call (gather the brief in 2–4 asking turns, play it back, `yes` locks it in and dispatches the Elves with their first tasks on the board).
- After the brief: captures move-out / move-in dates and addresses, items the owner names (`sell`, `donate`, `buy`), photos (vision → item, condition, price range → asks for the floor), "yes, list it" approvals (opens the `sell_item` deal and gives the owner the line for their own post), roommates.
- `what can you do?` / `help` → the ability list. Anything the crew does not do → "The crew can't …" plus the closest thing it can. Nothing is booked, posted, paid or agreed without the owner's yes.
- Hands one text to both Stuff and Home when it needs both (above). Sends the Crew Board link once.

**Stuff Elf** (`sell.ts`, `intake.ts`, `impact.ts`, the engine)
- Sell: photo → item with condition and a price range → the owner's floor → `yes, list it` → a `sell_item` deal with a ref code; the owner posts the listing themselves. Per-item approval; floors are never told to buyers.
- Buyers text this number with the ref (or a title word): the Deal Engine greets, holds the floor, counters, puts a low offer to the owner (`yes` / `no` / a number), agrees, offers three pickup slots on the shared calendar, books one, and reminds. Scam Shield blocks off-escrow payment asks.
- Owner side: `keep the couch` holds a price through Last Call; `donate the lamp` takes the listing off, marks it donated, lists who picks up in your area and drafts the request for you to send (no "yes" step); `give away`; buy a forwarded listing with a max price after `yes` (`buy_item` deal).
- Last Call sweep: 72 h before move-out the ask drops 20% and 48 h before it drops another 25% (60% of the start); each text tells the owner the percent, the old and new price, and the hours left, and offers `keep` or `donate`. Buyers in the talk get the new price and the ref code. 24 h before it relists free, at move-out anything open is dumped.
- Move Report: `what did we keep out of the landfill?` → pounds diverted and kg CO2e avoided (EPA WARM, approximate), dollars recovered.

**Home Elf** (`home.ts`, `home-sublet.ts`, `home-movein.ts`, `status.ts`)
- Hunt: budget → area → dates, one missing fact per text, then a real-browser search of Craigslist, Airbnb, Booking.com and SpareFoot (storage); scam flags; the top 3 with a line each. `more`, `tell me about 2`, `skip 2`, `save 2`, `search again`, a forwarded listing URL. `reach out to 2` opens a `find_sublet` deal and, with a dedicated line, texts the lister; the lister's replies run through the Deal Engine as the buyer.
- Sublet out: `sublet my room for $1500` → dates, area, room photos (vision) → the post (title and body with the ref and the number) for the owner to put up; `change …` redrafts, `post it` approves. Applicants text the number with the ref; the engine screens, holds the rent floor, asks the owner on low offers, agrees, offers viewing times, and **holds the time the applicant picks until the owner says `yes`** ("Book it?"); a `no` offers them the other times.
- `can I sublet my room?` → the lease and landlord decide; the crew does not read leases.
- Move-in week: `set up internet at the new place` → move-in date → new address (both written onto the move) → the dated checklist (electric, gas, internet, renters insurance, USPS address change, keys, condition report, bags for the gap when move-out comes first). `done with internet`, `skip insurance`, `what's left`, `address is …`; one reminder per task as it comes due. The checklist and `what's left` show the pickups Stuff booked.
- `status` → one paragraph off the store: dates and addresses, the checklist, the sublet, housing picks, Stuff's listed / sold / pickups, the Move Report headline, the ledger, and anything waiting on the owner's yes.

**Money Elf**: unchanged on this branch (the canned reply; the engine's ledger events). See the Money rows above.

### How the Elves talk to each other

Four carriers, all plain data: the **Move row** (one Elf writes `movePatch`, every Elf reads `ctx.move`), the **store** (items, deals, listings, the checklist), **events** (`store.listEvents`), and **`callElf`** (one Elf runs another on the same batch). The table is `ELF_RELATIONS` in [`packages/elves/src/relations.ts`](packages/elves/src/relations.ts); a test checks every row names Elves on the crew and that the Stuff → Home carriers work end to end (`packages/elves/test/relations.test.ts`, and the "Elves talk through the move and the store" case in `apps/elves/test/service.test.ts`).

| From | To | What | Carrier | Read by |
| --- | --- | --- | --- | --- |
| Crew Lead | Stuff Elf | Items the owner names and photographs, the move-out date Last Call counts down to, listing approvals | store items + move.moveOutAt + events item.captured / listing.approved | sell.ts (items, floors), engine lastCallSweep (moveOutAt) |
| Crew Lead | Home Elf | The confirmed brief: needs a place and what, sublet out, move-in needs, dates and addresses | board row from dispatchBrief + move dates/addresses + working memory | home.ts (ctx.move, memoryPreamble) |
| Crew Lead | Stuff Elf | One text that asks for both Elves' work is handed to each in turn | callElves(ctx, ["stuff", "home"]) on the same batch | crew-lead.ts handle → registry.ts |
| Stuff Elf | Home Elf | Booked pickups, so the move checklist and status show when buyers come | sell_item deals in state scheduled with a slot (engine) | relations.ts bookedPickups → home-movein.ts formatChecklist, status.ts |
| Stuff Elf | Home Elf | What was sold, given, donated or dumped, for the status paragraph and the Move Report line | item.outcome on store items + impact.ts moveReport | status.ts |
| Home Elf | Stuff Elf | The move-in date and new address once the checklist captures them, so Stuff's board and Last Call lines name real dates | movePatch moveInAt / toAddress → ctx.move | crew-lead.ts, sell.ts (ctx.move) |
| Home Elf | Money Elf | An agreed sublet and its rent, for the contract and deposit escrow | events deal.agreed + ledger.hold (sublet_out) | not read yet: Money is a stub |
| Stuff Elf | Money Elf | Escrow holds, releases and refunds on each sale | events ledger.hold / ledger.release / ledger.refund / escrow.requested | status.ts (ledger line); Money itself is a stub |

Stuff ↔ Home today: Stuff's booked pickups appear on Home's checklist, on `what's left` and in `status`; Stuff's outcomes feed the Move Report line in `status`; the move-in date and address Home captures reach Stuff and the Crew Lead through the move row the next turn. Home → Money and Stuff → Money are events only, since Money is still a stub.

### How every text is formatted

Every text the crew sends follows one style, `TEXT_STYLE` in [`packages/elves/src/contract.ts`](packages/elves/src/contract.ts), pasted into every drafting prompt (Crew Lead, onboarding, Home hunt and move-in, the Deal Engine's buyer-facing redraft) and applied by hand to every template: short lines, a blank line between the parts that do different jobs (what was captured, what happens next, the one question on its own last line), and at most two emojis, each at the start of a line as a signpost, never inside a sentence. The signposts: 👋 the intro, 🏠 📦 💸 an Elf by name, 🔎 the hunt's picks, 🏠 a listing's detail, ⚠️ a scam flag, 📋 a list or checklist, 🚚 pickups Stuff booked, 💬 a hint or a counter, ❓ a question for you, ✅ confirmed or booked, 🤝 agreed, 🎉 handed off, 🚨 Scam Shield, ↩️ a buyer walked, 🔁 a new time, ⏳ waiting on you, 🚫 something the crew can't do. Owner-facing Deal Engine lines get theirs by message kind in `deal.ts` (`OWNER_LEAD`); buyers and listers get plain text with at most one.

The first text, for example:

```
👋 Hey, I'm the Crew Lead at Elves, your moving crew. Here's what we can do:

🏠 Home Elf
• Finds you a place to move into, a hotel for the gap, or storage (Craigslist, Airbnb, Booking.com, SpareFoot), flags scams and texts you the top 3.
• Sublets your place: asks the rent, dates, area and room photos, writes the post for you to put up, and handles applicants. No viewing gets booked without your yes.
• Keeps your move checklist (utilities, internet, renters insurance, address change, keys). Text "status" anytime for where everything stands.

📦 Stuff Elf
• Prices an item from a photo and writes the listing line; you post it yourself on Facebook Marketplace or wherever you like.
• Negotiates with buyers who text this number, never under your lowest price, and checks with you on low offers.
• Runs Last Call: 72 and 48 hours before move-out unsold things drop in price (and it tells you how much and why), at 24 hours they go free; say "donate it" any time and it takes the listing off and drafts the pickup request.

💸 Money Elf
• Keeps the move's ledger on Nessie: every sale, escrow hold and release, and the money set aside for the move.

🚫 The crew can't book trucks, U-Hauls or movers, plan the route or run move day, post listings on Facebook, Craigslist or anywhere else for you, read leases or contact your landlord, pay, send or request money for you or give legal or financial advice.

Text STATUS anytime to see where everything stands.
```

The hunt's picks:

```
🔎 Top picks for a room in Allston under $1,200 (Jun 1 – Aug 30):

1. Room in 3BR near Packard's Corner · $1,150/mo · Allston
https://boston.craigslist.org/…
Under budget, your dates, near the T.

2. Furnished room, Comm Ave · $1,200/mo · Allston
https://boston.craigslist.org/…
At budget, furnished.

3. Sunny room off Harvard Ave · $1,100/mo · Allston
https://boston.craigslist.org/…
Cheapest, no laundry.

Skipped 1 that looks like a scam. Say "more" for the next 3, or "tell me about 1".
```

The move-in checklist:

```
📋 Move-in checklist for 12 Elm St (move-in Nov 3):

• Internet: done
• Keys: pick up on Nov 3

🚚 Pickups booked (Stuff Elf): couch Sat 10am.

💬 Say "done with internet", "skip insurance" or "what's left" as you go; I'll nudge you as each one comes due.
```

### How a buyer reaches a listing

A buyer joins a deal by texting the crew with the listing's ref code (`N9D3`), or, on a line with one open listing, by naming the item. Which number they text depends on the line:

| Line | Who can text it | What the post line should say | Today |
| --- | --- | --- | --- |
| **Shared iMessage pool** (now) | Only phones assigned to the pool (`bun run photon assign <phone>`, 25 max); each gets its own pool number and texts *that* | Nothing useful: a stranger can't text the owner's pool number | Buyers for the demo are assigned phones; they text their own pool number with the code. A phone that already runs its own move flips to buyer on that text and back to owner when the deal closes (`elsewhere()` in `service.ts`) |
| **SMS / voice line** `+1 740-255-8982` | Anyone, no registration | "Text +1 740-255-8982 and mention N9D3" | The service listens on every platform, so inbound SMS reaches it; not yet tried live, and the post line still prints the owner's pool number |
| **Dedicated iMessage line** | Anyone | "Text <that number> and mention N9D3" | `bun run photon provision-dedicated` (status says `dedicatedLineAvailableNow: true`; may need the Photon business plan). Also fixes threads and the 👍 |

Recommended order: for the hackathon demo, assign the buyer phones and have them quote the code; switch the post line to the SMS line as soon as one inbound SMS is confirmed; get the dedicated line if Photon allows it.

### STATUS

Text **STATUS** (or `status`, `where are we`, `how's it going`) at any time. The Home Elf answers from the store, nothing invented, as one block per Elf with a blank line between them and only the blocks that have something to say:

```
📋 STATUS

🗓 Dates
Out Nov 1 from Allston
In Nov 3 at 12 Elm St

🏠 Home
Checklist: 1 to go
  • Keys: pick up on Nov 3
  ✅ Done: Internet

📦 Stuff
Listed: couch
Sold: desk
🌱 Move Report: about 60 lb kept off the curb, 67 kg CO2e avoided

💸 Money
$60 held in escrow

⏳ Waiting on your yes
A viewing Fri 6pm for the room: reply yes or no
```

**The crew reminds you.** "Text STATUS anytime to see where everything stands." closes the first text (the crew intro), the "what can you do?" list, and the "Locked in" message after you confirm the brief. In the last seven days before move-out, every Crew Lead reply ends with the days left and that line ("5 days to move-out. Text STATUS anytime…"), so the reminder is loudest right before the move. (`STATUS_HINT` in `crew.ts`, `statusNudge` in `status.ts`.)

### The ideal run: every scenario, in order

One owner, one number, every function. Texts you send are in quotes; what comes back is in plain words. Buyers and applicants text the same number from their own phones.

**1. Meet the crew**
- "hi" → the crew intro (what the three Elves do, what the crew can't, the STATUS line), then the onboarding call starts: one or two bundled questions about the move.
- Answer in your own words: "out of my Allston place Nov 1, hard date, into Somerville but nothing found yet, selling the couch and desk, keeping the bed, my roommate Sam has a car, lease ends Nov 1" → the Crew Lead plays the brief back. "yes" → "Locked in", who starts on what, the STATUS line, the Crew Board link.
- "what can you do?" or "help" → the ability list again.
- "can you book me a u-haul for saturday" → "The crew can't book trucks, U-Hauls or movers." plus the closest thing it can do. Same for "read my lease", "post it on Facebook for me", "venmo the deposit for me".

**2. Sell (Stuff Elf)**
- A photo of the couch + "lowest I'd take is $60" → what the photo shows, the fair range, the list price; the floor is recorded. "yes, list it" → a `sell_item` deal with a ref code and the line for your own post: "Cream loveseat, $290. Text +1 628… and mention N9D3." You paste that on Marketplace; the crew never posts.
- A buyer texts the number: "is the couch still available? ref N9D3" → greeted with the price. "$50?" → under your floor: the engine counters, and if they hold firm you get "A buyer offers $50 for the couch (your floor $60; I'm holding at $60). Take $50? Reply yes, no, or a number." Reply "yes", "no" or "$55". A 👍 tapback counts as yes.
- "deal" from the buyer → three pickup slots on the shared calendar; "2" books it (pickups book without asking you; only viewings wait for your yes), you hear "Booked: buyer picks up the couch Sat 10am for $60", and `pickup.scheduled` fires. "picked it up" from the buyer → handed off, escrow release on the ledger.
- Scam Shield: a buyer who asks to pay outside escrow (Venmo, Zelle, cash app) is told escrow only; a gift card, a cashier's check or money order, a verification code or an overpayment ends the conversation, and you're told.
- "keep the couch" → held out of Last Call; "no last call" holds everything. Otherwise the sweep cuts unsold asks 20% at 72 h before move-out and another 25% at 48 h ("move-out is in about 38 hours, so I cut the armchair by 40%, from $35 to $21"), relists free at 24 h, and marks what's left dumped at move-out. Buyers who were talking get "Price drop: the armchair (ref H2P3) is now $21. Want it?"
- "donate the lamp" → the listing comes off at once and the lamp is marked donated; if the move-out address doesn't say the city, "What city or neighborhood is the pickup in?" → "Allston" → who picks up there (Boston 311, Salvation Army, Goodwill, Habitat ReStore) and a drafted request to forward ("Hi, I'm moving out of … on Nov 1 and would like to donate a lamp. Can you pick it up before Nov 1?…"). The crew places no call. Forward a listing link + "max $40" → "I'll cap the offer at $40 … Say yes and I'll set that ceiling." → "yes" → a `buy_item` deal; the seller texts the number.
- "move report" or "how did we do" → pounds kept off the curb, kg CO2e avoided, dollars recovered.

**3. Find a place, a hotel, storage (Home Elf)**
- "find me a room in allston under 1200 june 1 to aug 30" → the search runs in a real browser (Craigslist, Airbnb, Booking.com, SpareFoot) and you get the top 3 with one line each and scam flags. Give the facts one at a time if you like: it asks for the one missing thing (budget → area → dates).
- "more" / "next" → the next three. "tell me about 2" / "2" → the detail and link. "skip 2", "save 2", "search again". Paste a listing URL → it is ranked with the picks.
- "reach out to 2" → a `find_sublet` deal. With a dedicated Photon line the crew texts the lister the drafted note and you hear "Texted them from +1 …"; the lister's replies run through the Deal Engine as the buyer (it offers up to your max, puts a higher ask to you, agrees, proposes viewing times) and a viewing is booked only on your yes. Without a dedicated line you get the note to send yourself.
- "find a hotel for the gap nov 1 to nov 3" → Booking.com and Airbnb nightly picks. "find storage june to august" → SpareFoot units by monthly price. Storage is found from budget, area and dates; nothing is sized from a photo (if an Elf ever asks for one here, that is the model improvising, and the prompts now forbid it).

**4. Sublet your place (Home Elf)**
- "sublet my room for $1500" → it asks the dates, then the area, one text each. Send room photos → vision reads them (this one is real: light, furniture, condition go into the post). → the post: title and body with the ref code and the number, for you to put up. "change the title to …" or "make it shorter" → redrafted. "post it" → approved.
- An applicant texts the number: "hi, ref K7Q2, is the room still open?" → greeted with the rent. "$1300?" → under your minimum: countered, then put to you. "deal" → viewing times offered. They pick "1" → **held**, and you get "The applicant for the room ($1,400/mo) wants a viewing Thu 6pm. Book it? Reply yes or no." "yes" books it; "no" offers them the other times. Nothing is booked without you.
- "can I sublet my room?" → the lease and landlord decide that; the crew doesn't read leases.

**5. Move-in week (Home Elf)**
- "set up internet at the new place" (or "what do I need for move-in") → "What day do you move in?" → "nov 3" → "What's the new address?" → "12 Elm St" → the dated checklist: electric, gas and internet 10 days out, renters insurance and the USPS address change 7 days out, keys and the condition report on the day, bags for the gap when move-out comes first; plus "Pickups booked (Stuff Elf): couch Sat 10am" when there are any.
- "done with internet", "skip insurance", "what's left", "address is 14 Elm St" (re-dates nothing; moves the address), "move-in is nov 5" (re-dates the open tasks). One reminder per task as it comes due.

**6. Both Elves in one text (Crew Lead)**
- "sell my desk and find me storage for june" → the Crew Lead calls Stuff then Home on the same text; you get both replies back to back and both board rows move.

**7. STATUS, anytime**
- "STATUS" → the block above. The reminder appears in the intro, after "yes" on the brief, and in every reply during the last week before move-out.

What needs a dedicated Photon line: the 👍 on each of your texts, threaded replies, and the crew texting a lister first. Everything else runs on the shared pool today.

### Crew Lead on a call (Retell)

The voice agent's prompt lives only in the Retell portal, not in this repo; it says the same abilities and limits as `crew.ts`. The `submit_brief` webhook that receives the call is in `packages/voice`. Dashboard notes: [`docs/crew-lead-retell-prompts.md`](docs/crew-lead-retell-prompts.md).

## Run it

```bash
bun install
cp .env.example .env        # fill in PHOTON_PROJECT_ID, PHOTON_API_KEY, ANTHROPIC_API_KEY
bun test                    # no credentials needed; in-memory store and memory
bun run test:pg             # the same suites against a local Postgres (docker run -d --rm --name elves-pg-test -e POSTGRES_PASSWORD=elves -p 54329:5432 postgres:15-alpine)
bun run demo                # the whole arc against the in-memory transport, no credentials needed
bun run db status           # ping the database, list migrations and row counts (needs ELVES_DATABASE_URL)
bun run start               # the service: migrates the database, polls Photon, answers texts, serves the Crew Board
```

`bun run eval:onboarding` runs the onboarding call under each prompt variant against three simulated owners (Haiku, with hidden ground truth) and scores turns, questions, brief coverage, nuance and planning leaks; transcripts land in `.data/onboarding-eval/`. `ELVES_ONBOARDING_PROMPT` picks the variant live (`one_at_a_time`, `sweep`, `mirror`).

`bun run photon status` shows the project's lines, shared-pool assignments and the last messages in both directions. `bun run photon assign +1XXXXXXXXXX` puts a phone on the shared iMessage pool (25 max). `bun run photon reply-last "text"` replies to the newest inbound message from the CLI.

Environment (all read in `apps/elves/src/config.ts`):

| Variable | Meaning |
| --- | --- |
| `PHOTON_PROJECT_ID`, `PHOTON_API_KEY` | Photon 2.0 project and `pho_sk_` key |
| `PHOTON_INBOUND` | `poll` (GET /messages every `PHOTON_POLL_MS`, default) or `socket` (Socket.IO event stream with cursor replay, plus a slow poll as a safety net) |
| `PHOTON_SINCE` | ISO time; on boot, also handle messages created after this (replay). Default: boot time |
| `PHOTON_DEDICATED_AGENT_ID` | Agent user id (`pho_usr_…`) of the dedicated iMessage line that may text someone first. Unset: discovered from the project's agent users (`details.type = dedicated`) |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL_FAST`, `ANTHROPIC_MODEL_SMART` | Claude; `claude-haiku-5-5` routes and extracts, `claude-sonnet-5-5` drafts. Unset key → deterministic template replies |
| `ELVES_TRANSPORT` | `photon2` or `script` (in-memory) |
| `ELVES_DEBOUNCE_MS` | quiet window before a batch is handled (default 1200) |
| `ELVES_DATABASE_URL` (or `DATABASE_URL`) | Postgres. With Supabase use the IPv4 session pooler `postgresql://postgres.<ref>:…@aws-0-<region>.pooler.supabase.com:5432/postgres`; the direct `db.<ref>.supabase.co` host is IPv6-only |
| `ELVES_STORE` | `auto` (default: Postgres when the URL is set and reachable, otherwise in-memory with an error log and `degraded` on `/health`), `postgres` (fail fast), `memory` |
| `ELVES_DB_POOL`, `ELVES_DB_MIGRATE` | pool size (default 5); `ELVES_DB_MIGRATE=0` skips the boot-time migration |
| `ELVES_ONBOARDING_PROMPT` | Crew Lead onboarding-call prompt variant: `sweep` (default), `mirror`, `one_at_a_time` |
| `ELVES_MEMORY`, `ELVES_MEMORY_MESSAGES`, `ELVES_MEMORY_BUDGET` | `off` disables conversational memory; transcript window (default 24 messages) and its token budget (default 1400) |
| `ELVES_BROWSER`, `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`, `BROWSERBASE_CONTEXT_ID` | housing search browser: `browserbase` (hosted; prod), `local` (your Chrome; dev) or `off` (fixtures). The context id (from `bun run browser login`) holds the owner's Facebook login |
| `ELVES_LISTINGS_SITES`, `STAGEHAND_MODEL`, `ELVES_LISTINGS_*_TIMEOUT_MS`, `ELVES_LISTINGS_CONCURRENCY` | site allowlist (default: craigslist,airbnb), extraction model, per-site / total timeouts, pages in flight |
| `PUBLIC_URL` | HTTPS origin for mini-app links; links are only sent when set |
| `PORT` | HTTP port (`/health`, `/moves`, `/board/:moveId`, `/events/:moveId`, `/memory/:moveId`, `/b/:moveId` Crew Board page) |

## Layout

```
apps/elves/          the service: config, batch handler (service.ts), Hono server, boot
packages/shared/     domain types, Store contract, MemoryStore (in-process), logger
packages/db/         Postgres via Bun.sql: connection, migrations (packages/db/migrations), PostgresStore
packages/memory/     conversational memory: transcript + summaries, facts, notes, token-budgeted context; two backends
packages/photon/     Photon 2.0 REST client, poll + Socket.IO inbound, normalization, script transport
packages/pipeline/   per-space debounce, batch, cancel + carry-forward, deterministic send keys
packages/llm/        LLM contract; ClaudeLLM (structured outputs via zod) and FakeLLM
packages/engine/     Deal Engine: four modes, negotiation, calendar, Scam Shield, Last Call sweep. Ledger events only; no Nessie client
packages/elves/      Elf contract, router, Crew Lead, Stuff (sell/buy/donate), Home (hunt + sublet deals). Money and Move-day are canned stubs
packages/listings/   housing search: site recipes, Stagehand v4 runner, dedupe, scam rules, fixtures
scripts/             photon operator CLI, browser CLI (login, search, sites), offline demo
```

## Housing search

The Home Elf's hunt is a pipeline in `packages/listings` plus `packages/elves/src/home*.ts`:

1. Requirements: the fast model (with a regex fallback) pulls kind (room / sublet / apartment / hotel / storage), neighborhoods, budget, dates, beds, furnished and must-haves out of the text and merges them into the move's `housing_searches` row. One missing thing is asked per turn: budget, then area, then dates.
2. Ack, then search: the Elf replies "On it. Checking Craigslist, Apartments.com and Airbnb for a room in Allston under $1,200…" and returns a `later` step. The service sends the ack, settles the batch (a newer text now queues instead of cancelling), keeps the typing indicator alive, runs the search, then sends the results. Each site is a recipe (`packages/listings/src/recipes`): a pure URL builder for the query, an extraction instruction and one shared zod schema. Stagehand opens one browser session per search and one page per site, a couple at a time, with per-site and total timeouts; a site that fails is one failed run, never a failed search. Prices are parsed by code and every link is checked to stay on the site before the owner sees it.
3. Scam rules run on the raw results (price under half the median, wire / gift card / app payment before a viewing, "I'm abroad", no location, no photos, a different price for the same title on another site); hard flags sink a listing out of the picks. Duplicates across sites collapse to the most trusted copy.
4. Ranking: the fast model scores up to 25 candidates against the requirements with a one-line reason; a heuristic fills gaps and stands alone with the fake LLM. Picks are stored in `listings` with a rank, and the top three go out as plain text with exact links. Working memory gets a `## Housing search` section so every Elf can answer "did you find me a place?".

Operator commands: `bun run browser sites --kind room --area allston --max 1200` prints every recipe URL; `bun run browser search …` runs a real search and prints the runs table; `bun run browser login --site facebook` opens a Browserbase live view to log in once and prints the `BROWSERBASE_CONTEXT_ID` to set. Verified live from a headless local Chrome: Craigslist (rooms, sublets, apartments) and Airbnb (furnished rooms and sublets, and the hotel gap; Airbnb quotes a sample stay rather than the exact dates, so its monthly figure is that stay's nightly rate × 30 and the ranker treats it as an estimate). Booking.com (drops the search parameters and lands on its search form), Apartments.com (Akamai "Access Denied"), SpareFoot (Cloudflare challenge), Zillow (PerimeterX) and Facebook Marketplace are off the default allowlist until `bun run browser search` passes on that deployment (Browserbase with proxies); Facebook only runs inside the owner's own persisted login. A block page shows up as a failed run, never as "no results". Automating these sites is against their terms and accounts can be checkpointed; searches are read-only, one per ask, with a three-minute repeat guard.

## Memory

The crew remembers in three layers, all behind `MoveMemory` in `packages/memory`:

| Layer | What | Where | How it reaches the prompt |
| --- | --- | --- | --- |
| Working memory | move dates and addresses, every item with range / floor / list price and stage, who else is in the loop, what each Elf is doing, the confirmed brief (or the draft, marked as unconfirmed) | rendered on every turn from `moves`, `items`, `elf_status`, `participants` and the onboarding cursor (a view, so it can never drift) | first block of every Elf prompt |
| Transcript | every inbound text and every reply, per Photon space, keyed by the Photon message id (replays never duplicate) | `memory_threads`, `memory_messages`; once a thread has 40 unsummarized messages the oldest are folded into a rolling summary (the fast model) | newest 24 messages trimmed to 1,400 tokens, plus the summary |
| Facts | durable statements extracted after each exchange: preferences, constraints, commitments, open loops, people, with confidence, provenance and an audience flag | `memory_facts`, deduplicated on `(move, kind, normalized text)`, Postgres full-text search | top 12 ranked by relevance to the incoming text + recency + confidence; `owner_private` facts (floor prices, urgency, budget) appear only in owner threads and are listed as confidential anywhere else |
| Notes | an Elf's own scratchpad per move (`memory.setNote`) | `memory_notes` | the handling Elf's notes, as JSON |

Flow per batch: route → `memory.context()` (one parallel round of reads, about 25 ms on Supabase) → the Elf answers → replies are sent → `memory.afterTurn()` schedules extraction and summarization in the background, serialized per thread. Memory failures are logged and never block a reply; with `ELVES_MEMORY=off` Elves get an empty context. `GET /memory/:moveId` shows threads, facts and notes; `bun run db memory <moveId>` and `bun run db facts <moveId> "<query>"` do the same from a shell.

Storage: `packages/db` opens one `Bun.sql` pool (no driver dependency), applies `packages/db/migrations/*.sql` on boot under an advisory lock (tracked in `schema_migrations`), and implements the `Store` contract on Postgres. The same contract tests run against the in-memory store and Postgres.

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
| Reaction | `POST /messages` `content.type=reaction` with `parentMessageId` = the inbound message | 👍 on the last message of every inbound batch, before the model call (`apps/elves/src/service.ts`) | refused on the shared pool (same 409); logged, not retried. See "A 👍 on every text" below |
| Shared-line assignments | `GET/POST /platforms/imessage/assignments` | `scripts/photon.ts` | yes |
| Lines | `GET /platforms/resources` | `scripts/photon.ts status`; dedicated-line discovery when several agents are dedicated | yes |
| Text someone first | `GET /users?kind=agent` (find the dedicated agent, `details.type=dedicated`), `POST /users {handle, platform}`, `POST /spaces {participantIds: [line, them]}` with `Idempotency-Key = space:<line>:<user>`, then `POST /messages` as the line | `Transport.openSpace`, from the Home Elf's "reach out to N" when the listing shows a phone | offline (fake fetch); not yet exercised on a live dedicated line |

Shared-pool rules that shaped the design: the pool only sends in direct spaces to a human with an active assignment who has texted first; the agent identity differs per human (each phone gets its own pool number), so the agent id is always taken from the inbound message rather than configured. A dedicated line (the project reports `dedicatedLineAvailableNow: true`) would lift the threading and reaction limits.

**Which lines can message first.** Only a dedicated line. `Transport.openSpace(handle, platform)` creates (or finds) the Photon user for a phone number and the direct space between it and the dedicated line's agent user, then the service sends as that agent and records the person as a `lister` participant and deal party. The agent user comes from `PHOTON_DEDICATED_AGENT_ID`, or is discovered once from the project's agent users. Shared-pool numbers never open spaces: with no dedicated line `openSpace` rejects, the note is dropped with a log line, and the Home Elf falls back to handing the owner the text to send.

**A 👍 on every text when the agent reads it.** The code already does the call: as soon as a batch arrives, `service.ts` sends a 👍 tapback on the last message, then the read receipt, then typing, all best effort. What blocks it is the line, not the code: on the **shared iMessage pool** Photon answers a reaction (it is a message with `parentMessageId`) with `409 SPACE_NOT_SENDABLE`, the same refusal as threaded replies, while read receipts and typing go through. `bun run photon status` on 2026-10-17 showed the project in `mode: "shared"` with `dedicatedLineAvailableNow: true`, and no reaction among the sent messages. To turn it on:

1. **Get a dedicated iMessage line.** `bun run photon provision-dedicated` asks Photon for one (it may need the Photon business plan; it earlier returned `ENTITLEMENT_REQUIRED`). Owners then text the line's number instead of their pool number, so update the numbers you hand out, and set `PHOTON_DEDICATED_AGENT_ID` (or let it be discovered).
2. **React to every message, not only the last of the batch,** and in the order you described: read receipt first, then 👍 on each text in the batch (one idempotency key per message, `react:<msgId>`). A small change in the acknowledge block of `service.ts`.
3. **iMessage only.** Skip the tapback when the inbound platform is SMS (the `+1 740` voice/SMS line): SMS has no tapbacks, and a fallback would show up as a "Liked …" text.
4. **Stop asking a space that refuses.** Remember spaces that returned 409 for a reaction (like `noThreads` for threaded replies) so the shared pool isn't hit with a failing call on every text.

Until there is a dedicated line, the visible "I read it" signal on the shared pool is the read receipt plus the typing indicator, which already work.


## Deploy

`Dockerfile` + `railway.json`. `railway up -s elves` from a linked checkout; variables live in the Railway service, never in the repo. Set `ELVES_DATABASE_URL` to the Supabase session-pooler URL (the direct host is IPv6-only and unreachable from Railway); without it the service boots in-memory and `/health` reports `degraded`. Migrations run on boot. Keep one replica: the per-space debounce pipeline is in-process.

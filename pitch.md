# Elfie: the pitch plan

*Elfie is the product. The four agents behind it are the Crew Lead and the Home, Stuff and Money Elves.*

HackHarvard 2026. One doc for every judge: the main pitch, a tailored pitch for each track, the demo, the deck outline, and the pitch website. Everything in here is something the repo actually does (checked against `README.md`, `TESTING.md`, `SPEC.md` and the code). Anything marked **[CONFIRM]** is a claim to verify with the team before saying it on stage.

**Tracks we apply to:** Photon 2.0 (iMessage track, plus Best Voice Agent) · Best Use of Nessie (Capital One) · Sustainability · Cybersecurity and Fintech.

---

## 1. The one-liner

> **Moving is a group project nobody is running. Elfie is a crew you text: four agents on one number that find the place, sublet the old one, sell the furniture, and keep every dollar straight, and nothing happens without your yes.**

Shorter, for a slide: **"Elfie: a moving crew in your iMessage."**

Problem in one breath (the interviews back this up; add the best quote from the Short):
- A move is 15 tabs, 4 group chats and a spreadsheet nobody trusts.
- Boston moves on one day. About two-thirds of leases turn over on Sept 1, and the city hauled away 38 extra tons of trash and 1,700 mattresses in one week of 2023 ("Allston Christmas"). *(figures from `SPEC.md`; city and press numbers, cite on the slide)*
- Rental scams hit exactly this crowd: the FTC logged about 65,000 reports from 2020 to mid-2025, a $1,000 median loss. *(from `SPEC.md`)*

---

## 2. The main pitch (2 minutes, spoken)

1. **Hook (10 s).** "Raise your hand if you've ever moved out in a week. Now keep it up if you threw something good in the trash because you ran out of time."
2. **The problem (20 s).** The three bullets above, plainly. End on: "You don't need another app. You're already in a thread."
3. **The product (30 s).** "Elfie is one phone number. You text it like a friend. Behind it are four different agents: a Crew Lead, a Home Elf, a Stuff Elf and a Money Elf. Each one is a full agent with its own tools, memory and rules. You only ever see one thread." Show the phone.
4. **The trust line (20 s).** "It never books, posts, pays or agrees to anything without your yes. It won't read your lease or pay your rent. It tells you what it can't do."
5. **The twist (25 s).** "Under the thread is a ledger in Nessie. On top of the ledger is a Smart Plan that simulates your move 2,000 ways and tells you your odds of finishing under budget."
6. **Close (15 s).** "Nobody throws their couch in the street. They text the crew. Try it: text the number."

**The line judges must not miss (say it twice, once in the hook and once at the close):**
"It looks like one chat. It is four agents, a deal engine, a ledger and a voice line, all on Photon."

---

## 2.5 Our originals: say these to every judge, on every track

These are the ideas we came up with ourselves. They are not wrappers around an API; they are the product. Every track pitch below leans on at least two of them.

| Original | One line | Where it shows up |
| --- | --- | --- |
| **Deal Engine** | A Postgres state machine we built: four deal modes, negotiation that holds your floor, one shared calendar, Scam Shield, Last Call, and the ledger events that open and close escrow | Photon (strangers negotiate over one number), Nessie (negotiation becomes ledger entries), Cybersec (floors and Scam Shield enforced in code), Sustainability (Last Call) |
| **Smart Plan** | Three plans, each simulated 2,000 times, with your odds of finishing under budget, written to Nessie as pending future-dated records | Photon (a picture and a pick in the thread), Nessie (the predictive layer), Cybersec (plans advise, never act), Sustainability (donate-or-haul is an option) |
| **Last Call** | Prices fall 20% at 72 hours, 25% more at 48, free at 24, with the reason in every text | Sustainability, Nessie, Photon |
| **Scam Shield + house-hunt scam rules** | Off-escrow, gift card, check, code and overpayment asks end the chat; listings are flagged | Cybersec and Fintech, Photon |
| **Ask-which-Elf** | A numbered question when two Elves fit, and your original words go to the one you pick | Photon |
| **One list of abilities** | One source writes the text prompt, the voice script, the refusals and the docs | Photon, Cybersec |

## 3. The four agents (do not let anyone overlook this)

It looks like one agent in one chat. It is **four separate agents behind one number** (`packages/elves`, `packages/money-elf`), each implementing one `Elf` interface (`name`, `description`, `keywords`, `handle(ctx)`):

| Agent | Its own world | Tiniest details worth saying |
| --- | --- | --- |
| **Crew Lead** | Onboarding call (text or voice), routing, STATUS, the list of what the crew can and can't do | One ability list (`CREW_ABILITIES`, `CREW_LIMITS`) feeds the text prompt, the first message, the voice prompt and the README. Asks "which did you mean?" with numbered options instead of guessing. Hands one text to two Elves when it needs both ("sell my desk and find me storage"). |
| **Home Elf** | Housing hunt (Craigslist, Airbnb, Booking.com, SpareFoot), scam flags, sublet posts, applicants, viewings, move-in checklist | A real browser (Browserbase + Stagehand) does the search. One missing fact asked per turn. A viewing is held until the owner says yes. Dated checklist: electric, gas, internet 10 days out; renters insurance and USPS 7 days out; keys and condition report on the day. |
| **Stuff Elf** | Photo to price (Claude vision), listings, buyer negotiation, Last Call, donate, Move Report | Floor price never leaves the owner's chat. Last Call cuts 20% at 72 h, 25% more at 48 h, free at 24 h. "Donate it" acts at once and drafts the pickup request. |
| **Money Elf** | Ledger in Nessie, splits, loans, deposits, escrow, Smart Plan, dashboard | Every money move is a question first: one yes approves exactly one action. Totals are read back from Nessie, never from our own memory. |

Plus the pieces underneath: the **Deal Engine** (a Postgres state machine: four deal modes, negotiation, one shared calendar, Scam Shield, Last Call sweep) and **memory** (working memory, transcript with rolling summary, deduplicated facts, per-Elf notes).

How to show it on stage: open the Crew Board (`/b/<moveId>`): four rows, four live tasks, one thread. Then text something that fires two agents at once.

---

## 4. Photon: the pitch to win it

The Photon page rewards "AI that lives with us": agents that participate, not utilities. Our answer is a crew that lives in the thread, remembers across channels, and is careful with the user's trust. Below, every question the judges' page asks, with our answer.

### 4.1 Requirements: ship on Photon 2.0, live on a Photon channel

| Requirement | Us |
| --- | --- |
| Built on Photon 2.0 beta | Photon 2.0 REST (`api.photon.codes/v1`) plus the Socket.IO event stream. We deliberately skipped Photon 1.0 for the agent. |
| Live on a Photon channel | iMessage on the shared pool (three real phones assigned), plus the SMS/voice line. Hosted on Railway: `https://elves-production.up.railway.app/health`. |
| Texting | iMessage first; SMS for voice. Replies go out as the agent identity the human texted (`receivedBy.id`). |
| Voice on an SMS number, via SIP | Crew Lead's onboarding call runs on the Photon SMS number, connected to Retell. **[CONFIRM the exact SIP path and number before stage.]** |
| Docs and cookbooks | We verified against the live OpenAPI spec (the 2.0 messaging docs were still a placeholder) and wrote it down as a project skill. |

### 4.2 What great looks like → how we answer

| Photon wants | What we built |
| --- | --- |
| **Real human-in-the-loop collaboration, not a demo reel of prompts** | Approvals are the product. The owner's yes gates: a viewing, a price below the floor, an escrow hold, a release, a refund, a payment, a split request, a plan. A 👍 or ✅ with no text counts as yes. Pending questions can be answered by text, by poll tap, or by a button on the dashboard, and each answer applies to exactly one action. |
| **Context-awareness that persists across time, channels, and teammates** | Memory in Postgres: working memory (rendered each turn from the move, items, board and brief), transcript with a rolling summary, deduplicated facts with confidence and audience scoping, per-Elf notes. The same move is touched by text, a phone call, a web dashboard and other people (buyers, applicants, roommates) in their own spaces. A thread's owner is remembered, so a reply goes back to the Elf that asked. |
| **A delightful default: elevates the moment without demanding attention** | One header and one emoji per text (`🧭 Crew Lead`, `🏠 Home Elf`, `📦 Stuff Elf`, `💸 Money Elf`). Short blocks, never walls. Read receipt and typing indicator around every model call. Replies batch: three quick texts get one answer. The reminder line ("Text STATUS… DASHBOARD… or HELP…") teaches the three words that matter. |
| **Thoughtful safety and fallback behaviors that earn trust** | See section 6: scam shield, refusals, never-reveal floors, no card numbers stored, nothing happens without a yes. Fallbacks: a poll refused on the shared pool falls back to "reply yes"; a threaded reply refused falls back to a flat send and remembers the space; no model key falls back to deterministic replies; a dead payments API says "nothing moved" and writes nothing half-way. |
| **Voice: natural turn-taking, low latency, remembers the call when it moves back to text** | Retell agent with a single prompt and an explicit call flow (listen, mirror with blanks, stragglers, play back, yes). The `submit_brief` webhook writes the **same tables a text writes** (move fields, items, facts, transcript, a note per Elf), then the Crew Lead texts a recap on the same number. The call and the thread are one conversation. |
| **Our Deal Engine, inside the thread** | Buyers, applicants and listers text the same Photon number from their own phones; our Postgres state machine matches them by ref code, holds your floor, books three slots on one calendar, and asks you only when it must |
| **Smart Plan, in your messages** | "smart plan" returns a picture of three plans with odds; reply B to pick; the dashboard link switches plans and the chat confirms |

### 4.3 Judging criteria → our answer

- **Vision: does it push hybrid intelligence?** An agent society, not a chatbot: four specialists that call each other (`callElf`, `callElves`), share a move row, a store and an event stream, and coordinate with humans who aren't the owner (buyers, applicants, roommates) in their own threads. The owner supervises with one-word approvals.
- **Craft: cohesive, responsive, tastefully integrated?** One layout for every text; one list of abilities in every surface; one design system shared by the dashboard, the card image and the preview image; an image sent in the thread because 2.0 has no app card, and a link to a page that refreshes every 5 seconds.
- **Depth: real-world context and edge cases?** The Deal Engine (counters, floors, ceilings, three slots, no-shows), Last Call timing, escrow with two signals, a 24-hour no-show sweep, a viewing held for consent, duplicate-proof deposits, uneven-split math that adds to the penny, 614 automated tests (640 on Postgres), real Nessie smoke tests, message idempotency, restart safety.
- **Traction: could this run with real users tomorrow?** It already does: hosted on Railway, Postgres on Supabase, real phones, real Nessie sandbox, migrations on boot, `/health`, a `TESTING.md` with ~190 human test rows. Boston alone has a built-in launch day every September 1.

### 4.4 The Photon features we use, in detail (say these; judges like specifics)

| Photon 2.0 primitive | How Elves uses it |
| --- | --- |
| Inbound messages (poll and Socket.IO event stream with cursor replay) | Hosted instance runs the socket stream with a slow poll as a safety net; idempotent on message id; cursor persisted so a restart replays nothing twice |
| Attachments (download) | A phone photo (HEIC) is fetched, converted, and read by Claude vision to price a couch or describe a room |
| Attachments (upload and send) | The Ledger card, the Smart Plan card and the plans picture are drawn as SVG, rendered to PNG (resvg, Inter font), uploaded and sent in the thread, because 2.0 has no mini app card |
| Replies as the right agent | Every reply is sent as `receivedBy.id`, so each human talks to their own agent identity |
| Idempotency keys | `reply:<msgId>:<n>`; a replay never double-sends |
| Read receipts and typing | Sent around the model call and kept alive through slow work (a browser search) |
| Reactions (👍) | A tapback on the last text of every batch on a dedicated line; inbound 👍, heart and ✅ count as "yes" |
| Polls | Approve / Not now and A / B / C plan picks; the option ids carry the action id so a tap can't hit the wrong action; a stale tap is rejected ("out of date, want fresh ones?") |
| Text someone first | The dedicated line opens a space with a lister and texts the drafted note ("Texted them from +1…") **[CONFIRM a dedicated line is live before claiming]** |
| Threaded replies | Used where allowed; the shared pool refuses (409), so the transport falls back to flat and remembers |
| Shared-pool assignments and lines | `bun run photon status` / `assign`: an operator CLI we wrote to manage 25-phone shared-pool assignments |
| Chunking | Replies over the 422 limit are split into readable chunks, never an error |

### 4.5 The Photon skills, 2.0, voice and integrated APIs (the four things to name)

**Photon skills.** We wrote the platform down as project skills the whole team's agents load: `photon` (what 2.0 can and can't send, verified against the live OpenAPI spec, including that 2.0 has no app card, that the shared pool refuses polls and reactions, and how attachments upload) and `run-elves-on-phone` (how to run the crew against a real Photon project from your own iPhone). That is how three people building in parallel never coded against a feature Photon doesn't have.

**Photon 2.0.** REST client, Socket.IO inbound with cursor replay, normalization of inbound events, an in-memory `script` transport so the same service runs offline in tests and demos, and an operator CLI.

**Photon voice.** A Retell voice agent on the Photon SMS number runs the Crew Lead's onboarding call (listen, mirror the move back with the gaps as blanks, play the brief back, get a yes). `submit_brief` writes the call into the same store a text uses and a recap text follows on the same number. Prompt variants are scored by `bun run eval:onboarding` against three simulated owners. `bun run mock-call` sends a signed fake webhook for testing.

**APIs integrated with Photon (name them all):**

| API | Role in the product |
| --- | --- |
| Photon 2.0 | The whole transport: text, images, polls, receipts, reactions, voice line |
| Anthropic Claude (Haiku 5.5 fast, Sonnet 5.5 smart, vision) | Routing, extraction, drafting, photo to price, room photos to sublet post |
| Retell | Voice agent and the `submit_brief` webhook (signed) |
| Capital One Nessie | The ledger: accounts, deposits, withdrawals, purchases, pending future-dated records |
| Browserbase + Stagehand | Real-browser housing search: Craigslist, Airbnb, Booking.com, SpareFoot |
| Supabase Postgres (Bun.sql) | Store, memory, Deal Engine state, Money state, plans |
| Railway | Hosting; migrations on boot; `/health` |
| EPA WARM factors | The Move Report's CO2e |
| Boston 311, Salvation Army, Goodwill, Habitat ReStore | Donation pickup options in the drafted request |
| Photon 1.0 Spectrum | Evaluated for an iMessage app card, then deliberately shelved behind `ELVES_MINIAPP=1`: the agent stays on 2.0 |

### 4.6 Best Voice Agent (separate prize)

- Real phone call in, on a Photon number, built on the SMS channel.
- **Turn-taking by design**: short sentences, one thought per breath, a single backchannel while the caller talks, never fills silence, "Keep going, what else?" once.
- **Smart structure**: mirror the move back with the gaps as blanks (answering is filling blanks), cap of five asking turns, then play the brief back and ask exactly one question.
- **Remembers**: the call lands in the same memory as the thread; a recap text goes out; the Crew Lead already knows the move when the owner texts.
- **Honest scope**: the call can't promise anything and says what the crew can't do.
- Demo moment: the call ends and the phone buzzes with the recap before the judge has put it down.

### 4.7 Questions Photon's team might ask, and answers

- *Why four agents, not one?* Different tools, rules and risk. Money must never improvise; Home drives a browser; Stuff negotiates. A single prompt with all of it either leaks floors or books things. Separate agents with one routing layer keep each one small and testable.
- *Why no mini app?* Mini apps don't work on Photon 2.0 (it has no app card). After hours of experiments, including a full Photon 1.0 Spectrum build, we drew the ledger, plans and Move Report ourselves as pictures in the thread and linked a live page. 1.0 needed a second number and registered users only, so we shelved it.
- *What fails on the shared pool?* Polls, reactions, threads. Every feature has a text fallback, tested.
- *What happens when a text arrives mid-search?* It queues; it never cancels the search.
- *How do you know it works?* 614 tests, 640 with Postgres, real Nessie smoke test, a 190-row human test list.

---

## 5. Nessie (Capital One): the pitch

**The line:** "Nessie isn't our bank. It's our ledger and our crystal ball. Every dollar of a move is a Nessie record, and on top of it we predict the rest of the move."

### 5.1 What we use Nessie for (the whole list)

**As the book of record**
- Every money movement is a **tagged Nessie record** (`[elves:kind:id]`): purchases for costs, deposits and withdrawals for transfers, a Moving Fund checking account and an Escrow savings account per move.
- **Totals are read back from Nessie**, not remembered. Our own Postgres holds only what Nessie can't: who is who, what an entry was for, waiting approvals.
- The dashboard re-reads Nessie **every 5 seconds**. Open a record id from the Activity tab.
- Real sandbox verified: customers, accounts, records created live (`smoke.ts`).

**Roommate money**
- Splits that add to the penny ($100 three ways: $33.34 / $33.33 / $33.33), excluding yourself, uneven shares.
- Request texts to each roommate; "PAID" back; paying more than owed counts only what was owed.
- **Payment plans** ("Sam pays the truck at $40 a month") as Moving Fund loans.
- **Paying a roommate back** from the Moving Fund, after one yes.
- Deposits you paid: logged once (saying it twice doesn't double it), due-back date, a reminder, "got all my deposits back".

**Escrow for sales and sublets**
- Buyer's money held in the Escrow account, released into the Moving Fund when pickup is confirmed by two signals (owner yes plus buyer confirmation, or Move Map convergence), refunded after the owner's yes if the buyer walks (24-hour no-show sweep).
- The Deal Engine's negotiation (floor held, counters, agreed price) is what opens the hold: negotiation outcomes become ledger events (`ledger.hold`, `pickup.scheduled`, `ledger.release`, `ledger.refund`).

**Gradual price drops as ledger events**
- Last Call: asks drop **20% at 72 hours**, **another 25% at 48** (60% of the start), free at 24, dumped at move-out. Each cut texts the owner the percent, old and new price, and hours left. Sales that follow land in the ledger as money in.

**The Smart Plan: "beyond the normal Nessie layer"**
- Budget setting: the Money Elf asks your budget the moment the ledger is set up.
- **Three plans** (what to sell and at what price, when each price drops, donate or haul, truck size, movers or not), each simulated **2,000 times** over a visible assumptions table, with likely final cost, a 10 to 90% band, the **odds of finishing under your budget**, and how hands-on it is.
- The chosen plan is written into Nessie as **pending, future-dated deposits and withdrawals** that settle to completed or cancelled as items sell. We verified live that Nessie accepts `status: pending` with a future date and settles with `PUT`. Purchases can't settle, so expected costs are pending withdrawals. Plan records never count toward totals.
- Offered after every ledger change; switchable from chat or the dashboard; a drift nudge when an item is past its expected sale date and the odds drop 10 points.

**The dashboard (the proof)**
- Overview: net cost so far, **expected payments versus net cost** ("projected" line), anything awaiting your OK, the Smart Plan panel in the middle, balances, who owes you, what's held or due back.
- Smart Plan tab: the plan's 10 to 90% band with your **real net cost drawn over it day by day**.
- Coming back: the what-if. Switch off a payment you aren't counting on, or assume everyone pays late.
- Activity: every Nessie movement, tap for the record id.
- A never-expiring signed link (HMAC), a short ledger picture sent in the thread, 404 on a bad token.

### 5.2 Why this is a strong Nessie entry
- **Depth of API use**: purchases, deposits, withdrawals, accounts, customers, pending and settled states, tagged records, read-back.
- **A real product reason** for each call (a split, an escrow, a plan).
- **A twist**: a predictive layer on a record-keeping API.
- **Honest about the sandbox**: we document its quirks (balances never move, transfers have no payee, bills need `recurring_date`, purchases can't be settled) in a project skill.

### 5.3 Nessie demo (60 seconds)
1. "split the $240 truck with Sam and Priya" → "yes". Show the three-way split and the Nessie record.
2. "I paid a $400 sublet deposit, due back Dec 1" (point out it's counted once).
3. "smart plan" → three plans with odds → "go with B". Show pending Nessie records appear.
4. Open the dashboard: Smart Plan panel, expected vs net, Activity with record ids.
5. Tap a different plan on the page: the chat confirms "From your dashboard".

---

## 6. Cybersecurity and Fintech: the pitch

**The line:** "This is an AI that touches money and strangers, so it's built to say no, to ask first, and to spot the scam before you do."

### 6.1 Refusals: what it won't do, said plainly
- Won't book trucks, movers or U-Hauls; plan routes; post listings for you; read leases or contact landlords; pay rent, bills or a landlord; move money to or from a bank; invest; do taxes; give legal or financial advice.
- Every refusal names the **closest thing it can do** instead ("I can't pay rent. I can split a cost, pay a roommate from the Moving Fund, log a deposit…").
- One list in code (`CREW_LIMITS`) is the source for the text prompt, the voice prompt and the README, so the refusals never drift apart.
- Tested: every refusal phrase, every ability example goes to the right Elf.

### 6.2 Acceptances: nothing happens without your yes
- **A viewing is held until you say yes.** The applicant picks a time; you get "Book it? Reply yes or no." Only yes books it; no offers them other times.
- Money: a split request, a payment, an escrow hold, a release, a refund, a plan all need a yes. One yes approves exactly one action (by id), by text, poll or dashboard button.
- Price: an offer below your floor becomes one question to you; the engine never crosses the floor or ceiling. Floors are never told to buyers.
- Posting: the crew never posts for you; you paste the line it writes.
- Plans: picking is the yes, and no money moves.

### 6.3 Scam flags: Home hunt and Scam Shield
**House-hunt scam rules** (run on raw search results; hard flags sink a listing out of the top 3):
- Price under half the median.
- Wire, gift card or app payment demanded before a viewing.
- "I'm abroad" stories.
- No location; no photos.
- The same title at a different price on another site.
- Duplicates across sites collapse to the most trusted copy.

**Scam Shield on deals** (buyers, applicants, listers):
- Off-escrow payment asks (Venmo, Zelle, Cash App) get "escrow only".
- Gift card, cashier's check, money order, verification-code requests and overpayments **end the conversation** and tell the owner.
- A scam check on demand in the Money Elf ("is this a scam").
- Payment copy always says escrow.

### 6.4 Fintech controls
- **Escrow with two signals** before release; refund only after the owner's yes; 24-hour no-show sweep.
- **Nessie is the record; reads are live**, so the dashboard can't drift from the bank.
- **Card and bank numbers in a text are refused and never stored or repeated.**
- **Signed dashboard links** (HMAC with a server secret, no personal data in the URL); wrong token or another move's id is a 404; the Approve button asks "Tap to confirm".
- **Idempotent sends and approvals**: a replay or a double tap changes nothing; a stale approval is rejected.
- **Failure is safe**: if Nessie is unreachable, "I couldn't reach the payments system just now, so nothing moved," with nothing half-written.
- **Deposits counted once**; splits to the penny; totals cross-checked in tests and live.
- **Our Deal Engine enforces it**: floors and ceilings, Scam Shield and the viewing hold all run in the engine we built, so no prompt can talk its way past them.
- **Least authority**: the Money Elf never lists, prices or finds a place; Stuff and Home never split, hold escrow or track a deposit (enforced in routing and descriptions).

### 6.5 Demo (45 seconds)
1. "pay my rent" → the plain refusal and what it can do.
2. A buyer texts "can I pay with a gift card?" → conversation ended, owner told.
3. An applicant picks a viewing → "Book it?" → owner says yes.
4. A forged dashboard link → 404.

---

## 7. Sustainability: the pitch

**The line:** "Every September 1 in Boston, thousands of good couches end up on the curb. Elves makes moving out a plan, so nothing good gets thrown away."

### 7.1 The story
- Allston Christmas: about two-thirds of Boston leases turn over on Sept 1; about 2,400 moving permits approved; 38 extra tons of trash and 1,700 mattresses collected in one week of 2023. *(SPEC.md research; add the city source on the slide)*
- People don't want to waste; they run out of time, hands and a plan.

### 7.2 What Elves does about it
- **Last Call is our Deal Engine's sweep**, not a reminder: it reprices every open deal on schedule and tells buyers already talking.
- **A plan for every item at the start**: the onboarding asks what goes and what has to go, and each item is sell, donate, keep, or undecided.
- **Last Call**: unsold items get cheaper on a schedule (20% at 72 h, 25% more at 48 h, free at 24 h) so they leave your place instead of sitting there; each text tells you how much and why and offers keep or donate.
- **Donate in one text**: "donate the lamp" takes the listing off, marks it donated, finds pickups in your area (Boston 311 bulk pickup, Salvation Army, Goodwill, Habitat ReStore) and drafts the request for you to send.
- **Give away free** and **buy used** (a forwarded listing plus a max price).
- **Smart Plan** includes donate-or-haul as options, so the plan itself favors reuse when it's cheaper.
- **Move Report**: "what did we keep out of the landfill?" → pounds diverted, **kg CO2e avoided** (EPA WARM v13 source-reduction factors, category-to-material mapped, labeled approximate), dollars recovered. Dumped items count against the total, so it's honest.

### 7.3 Demo (45 seconds)
1. Photo of a couch → price, "yes, list it".
2. Fast-forward: Last Call cut text ("move-out is in about 38 hours, so I cut the armchair by 40%, from $35 to $21").
3. "donate the lamp" → the pickups and the drafted request.
4. "move report" → pounds, CO2e, dollars.

---

## 8. Demo plan

**Setup:** three phones on the shared pool (owner, buyer, applicant), the Crew Board and dashboard open on the laptop, a seeded fallback state for every step.

**90-second main demo** (from `SPEC.md`, updated to what is built):

| Time | What happens | Track it serves |
| --- | --- | --- |
| 0–15 s | Couch photo + "moving out Aug 29": plan, board link; Money says hello and asks the budget | Photon, Nessie |
| 15–40 s | Buyer: "is the couch still available? $50?" → counter at the floor → owner asked "Take $50?" | Photon, Fintech |
| 40–55 s | Escrow hold appears; owner says yes; dashboard updates within 5 seconds | Nessie, Fintech |
| 55–70 s | Applicant picks a viewing → "Book it?" → owner yes | Photon, Cybersec |
| 70–80 s | "smart plan" → three plans with odds → tap one on the dashboard | Nessie |
| 80–90 s | Last Call cut, "donate the lamp", "move report" | Sustainability |

**Voice moment (optional, strong for Best Voice Agent):** judge calls the number, tells the move in 20 seconds, hears the brief played back, says yes, and the recap text arrives.

**Fallbacks:** `bun run demo` (offline arc), `bun run scripts/sim-negotiation.ts` (both sides printed), screenshots of every step.

---

## 9. The pitch deck (10 slides)

1. **Title**: Elves, a moving crew in your iMessage. One line, one phone.
2. **The problem**: Allston Christmas photo + the three facts.
3. **What we heard**: the interview Short, one quote.
4. **The product**: the phone, one thread.
5. **It's four agents**: Crew Lead, Home, Stuff, Money, each with its tools. (Diagram.)
6. **Never without your yes**: approvals and refusals.
7. **The ledger and the plan**: Nessie, the dashboard, the Smart Plan.
8. **Less waste**: Last Call, donate, Move Report.
9. **Built on Photon**: the primitives table, voice, skills, APIs.
10. **Try it**: the number, the website, the team.

Per-track appendix slides (swap in for that judge): Photon (4.2 + 4.4), Nessie (5.1), Cyber/Fintech (6), Sustainability (7).

---

## 10. The pitch website

**Goal:** a page that opens like a product launch and works like a cheat sheet on stage. Built in `site/` (static HTML, CSS and JS, no build step). Name: **Elfie**.

### 10.1 The flow (top to bottom)
1. **Title screen.** A giant "Elfie" and one problem line: big tasks like moving take weeks of websites, people and coordination. Sixteen floating chips (Craigslist, Venmo, U-Haul, the group chat…) drift around it.
2. **The scroll story.** As you scroll, the title shrinks, the chips swarm into one point, and a single **Crew Lead** appears. Then three wires draw out, one at a time, to the **Home**, **Stuff** and **Money** Elves, each popping in with its three jobs. This is the "one agent branching into three sub-agents" moment.
3. **What we heard.** The interview Short (YouTube embed slot) beside two huge numbers that count up: **15** people interviewed, **30+** on the waitlist.
4. **Demo time.** A dark full-screen pause: a ringing phone, "Demo time.", the four things we'll do live, the number to call, and a link to the simulator in case the line drops.
5. **Photo strip.** A slowly scrolling film strip of photos from the build (placeholder tiles until real photos are added), with a second strip, running the other way, later on.
6. **The Elves, simulated.** (A strip of four quick words sits at the top, and again in Demo time and Text the crew: **HELP** for all your options, **STATUS** for the move-day checklist and where everything stands, **DASHBOARD** for the live ledger, picture and link, **SMART PLAN** for three plans with your odds. Tap one to play it.) Tabs for Crew Lead, Home, Stuff and Money. Every main function is a button; click it and an iPhone replays the exact reply format. Each Elf also lists what it won't do. This is the backup if the live demo fails.
7. **Inside the Money Elf.** A working ledger simulator: Overview, Smart Plan, Coming back, Activity. Switch plans, change the budget (the odds recompute), toggle expected payments (the projected net cost updates), see the pending Nessie records.
8. **How it fits together.** You → Photon 2.0 → router → four agents → Deal Engine, memory, Nessie, Postgres.
9. **Pick a track.** A dropdown shows one track at a time: "Why Photon" (or Nessie, Sustainability, Cybersec and Fintech), a big statement, the APIs used, and eight tap-to-open tiles (a line each, a "more" on tap) plus a "See it in the thread" button that plays the matching conversation.
10. **What nobody else built.** Fourteen distinct things, one line each.
11. **Every API and service.** A searchable list of everything we used, filterable by category (Messaging, Voice, AI, Money, Data, Housing search, Hosting, Runtime, Pictures, Sustainability data, Built by us, Dev tooling), with the test counts above it.
12. **What's next.** Eight future items.
13. **Text the crew.** The number, the team, the repo.

### 10.2 Look and feel
iMessage and Photon calm: airy near-white canvas, soft blue for "you", gray for "them", hairline borders, Onest type, a small pointed-hat face for each agent (ink, green, amber, lime). The signature is the scroll-driven story; everything else is quiet. No gradients on text, no emoji used as icons, no card grids as page structure. It honors reduced-motion (the story becomes a static diagram).

### 10.3 Assets to gather (we cannot make these)
- The interview Short: upload to YouTube, paste the id in `site/data.js` (`SITE.interviewYouTubeId`).
- Night-coding photos: drop images into `site/assets/night/` and list them in `SITE.nightPhotos` (optional `SITE.nightCaptions`). They scroll in both strips.
- The number to text: `SITE.number` (shown in Demo time and Text the crew).
- The waitlist and interview counts: `SITE.waitlist` and `SITE.interviews` (currently 30+ and 15).
- Team names and spellings (taken from the git history, confirm).

### 10.4 Run it and host it
- Preview locally: `python3 -m http.server 8788 --directory site`, then open `http://localhost:8788`.
- Host: GitHub Pages (publish `site/`) or any static host; no backend.
- All copy, conversations, tracks, the stack list and the future list live in `site/data.js`.

### 10.5 Honesty rules for the site
- Demo conversations are labeled **example conversations** in the product's real reply format.
- All dashboard figures on the page are synthetic and labeled so.
- Statistics keep their source in a footnote in the deck.
- "Mini apps don't work on Photon 2.0, so we drew pictures after hours of experiments" is stated in the Photon track.

---

## 11. Before you go on stage (confirm list)

- [ ] Dedicated Photon line available? If not, drop the 👍 and "texts the lister first" claims.
- [ ] Voice number and the Retell → Photon SIP wiring: say it exactly as it is.
- [ ] `LEDGER_LINK_SECRET` and `PUBLIC_URL` set on Railway (the dashboard link only appears when both are).
- [ ] Nessie key live; run `smoke.ts` that morning.
- [ ] Three phones assigned on the shared pool; each has texted once.
- [ ] Run `TESTING.md` section 10 end to end once.
- [ ] Interview Short uploaded; photos dropped in; team names checked.
- [ ] Source for the Allston and FTC figures on the slide.

---

## 12. What's unique, and what's next

**What nobody else built (say three of these, pick by judge):**
- One number, four agents, each with its own tools, rules and memory.
- It asks before it guesses: a numbered "which did you mean?", and your original words go to the Elf you pick.
- A viewing waits for your yes; your floor never leaves your chat.
- Last Call: prices fall on a schedule (20% at 72 h, 25% more at 48 h, free at 24 h), and each cut says why.
- The ledger is Nessie, read live; Smart Plans are written to Nessie as pending, future-dated records that settle.
- Odds, not guesses: every plan simulated 2,000 times, assumptions printed.
- Pictures in the thread because 2.0 has no mini apps.
- A voice call that becomes a thread: same memory, then a recap text.
- One list of abilities writes the prompt, the voice script, the refusals and the docs.
- A real-browser house hunt (Craigslist, Airbnb, Booking.com, SpareFoot, Apartments.com, Zillow, Facebook) with scam rules on the results.
- A Move Report with CO2e (EPA WARM) that counts dumped items against us.
- Built for the shared pool: every feature has a fallback.

**What's next (the honest roadmap):**
- A dedicated Photon line for everyone (tapbacks, threads, texting a lister first).
- Move day: truck and mover quotes, a room scan, ETAs.
- Roommates in one group thread.
- Outbound calls to storage facilities and landlords, with your yes.
- More channels: WhatsApp, Telegram, email.
- Odds learned from real moves instead of an assumptions table.
- Beyond Boston: every city has its own September 1.
- Bring-your-own bank, once Nessie-style rails are real.

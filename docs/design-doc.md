# Elves — Product Design Doc (HackHarvard 2026)

> Original planning doc from 2026-10-17, kept for reference. Where it disagrees with [`SPEC.md`](../SPEC.md) (five Elves instead of ten, Claude instead of Grok, Retell instead of ElevenLabs, our own Postgres memory, a Postgres state machine for the Deal Engine), SPEC.md wins. Personal phone numbers are redacted.

Oct 17, 2026 · @Gavin Zhou

## Overview

Elves (working title) is a moving crew you text. Ten specialist agents, each a contact in your phone with its own Photon line, sit in your group chat and in their own DMs: they sell your furniture, book the truck and storage, find and screen sublets, handle the lease and the landlord, settle the money, and keep your stuff out of the landfill. You never open an app: every chore already happens in a text thread, so the crew lives there too.

**Pitch line:** Moving is 15 chores and every one of them ends in a text message. Elves is the crew that answers them.

**Hackathon context:** HackHarvard 2026, Oct 16–18, Cambridge MA, with the venue in Allston, where roughly two-thirds of Boston leases turn over every September 1 and the city hauls away tens of tons of abandoned furniture ("Allston Christmas"). That is the sustainability hook, unforced. This doc plans the full product; the hackathon is where the first version is shown, not the boundary of what we design.

**What we are entering:**

| Target | Type | Why it fits |
| --- | --- | --- |
| Build a Messaging Agent with Photon 2.0 | Sponsor challenge (main) | A team of agents on their own lines, collaborating with humans across spaces, live on iMessage, Telegram, email and voice |
| Sustainability (ASUS "Save the Earth") | Track (headline) | Last Call mode, Green Elf and the Curb Map measurably divert furniture from the curb |
| Best Use of Nessie (Capital One) | Sponsor challenge | Moving Fund, escrow on every hand-off, roommate splits, Scam Shield |
| Fintech-CyberSec | Track (secondary, if Devpost allows multiple) | Same Nessie escrow + scam screening, backed by FTC rental-scam data |
| Best Use of Daytona | Sponsor challenge (fits) | Elves run untrusted code (listing-page extraction, comp pricing, lease parsing) in Daytona sandboxes |
| Best Data-Driven Agent on Chalk | Sponsor challenge (fits) | The negotiation and screening policies are evaluated against replayed conversations; Chalk's Agent Evals is the harness |
| ASUS content challenge | Bonus | One teammate posts a build vlog; separate prize |

**Design decisions, and why (none are time cuts):** we do not automate posting to Facebook Marketplace, because there is no public API and automated posting breaks its terms; instead the Photon number is the listing's contact and the agent owns every conversation after the post, which is where the work actually is. Payments run on Nessie as the ledger and escrow model; real money moves on Venmo outside the product, and real rails are in the Backlog. Mini apps are hosted web pages sent as links, because Photon 2.0 has no app-card type and iMessage's rich previews make a link feel native. Telegram and Android are in the Backlog.

## Goals and success criteria

Done means a stranger can text the number from their own phone and have an entire move run end to end: furniture sold or donated, truck and storage booked, roommates coordinated, room sublet, money settled, and a report that says what stayed out of the landfill. For the hackathon, a judge watches three Elves finish real work inside 90 seconds, but the build target is the whole move.

| Aspect | End goal | How it is verified |
| --- | --- | --- |
| Photon main track | A crew of agents, each on its own dedicated line, lives on iMessage with Telegram, email and voice as peers. Every interaction uses native primitives (reactions, typing, threaded replies, group participants, polls, attachments, read receipts, edits) rather than bare sends. Humans in different spaces (owner group, buyer DMs, applicant DMs, a landlord's email) are coordinated by the same agents | A judge texts the number as a buyer; the owner chat updates in-thread, the Sell Elf posts as itself in the group, confetti fires on sale |
| Photon voice prize | The number is a real business line: inbound calls are answered by an agent with the move's context; Elves place outbound calls to facilities, movers and landlords; calls can be transferred to the owner; every call returns a transcript and extracted fields to the chat | A judge answers a call from the number on their own phone, playing the facility, and watches the summary land |
| Sustainability track | Every item ends with an outcome (sold, given, donated, dumped). Last Call mode turns unsold items into pickups before move-out. The Move Report states pounds diverted and CO2e avoided with the factor cited. The Curb Map pools free items across all users in a neighborhood during turnover week | A judge photographs a lamp, sets move-out to tomorrow, and watches it list, price-drop, flip to free, appear on the Curb Map and book a pickup |
| Nessie challenge | A Moving Fund per move; escrow holds on every sale and every sublet deposit that release on confirmed hand-off; truck, storage and movers post as purchases; roommate shares settle as P2P transfers; the Ledger shows net cost of the move | Nessie transactions appear on the Ledger card as the deal runs |
| Fintech-CyberSec (secondary) | Scam Shield screens every counterparty against the rule set and blocks deposits outside escrow; identity requests are refused and reported | A judge sends "pay the deposit on Zelle to hold it" and is flagged with the rule named |
| Mini apps | Hosted pages open from app cards inside Messages and update in place as agent state changes: Crew Board, Listing Studio, Inventory, Ledger, Move Map, Room, Move Report | A judge taps a card; status changes while they watch |
| Multi-agent orchestration | The Crew Lead routes every inbound message to the right Elf; Elves report as themselves in the group and as Crew Board rows; the owner can DM any Elf directly or redirect it by replying in its thread; Elves hand work to each other (Sell to Money on confirmation, Haul to Map on move day) | A judge replies "go lower" in the Sell thread and sees the floor change; a sale shows up on the Ledger without anyone asking |
| Quality | Negotiation, scheduling and screening policies are evaluated against replayed conversations before any change ships; every agent action is traceable in the event log | The eval dashboard shows pass rates per policy; a judge can ask "why did it counter at $70" and get the trace |
| Submission | Devpost entry with video, a README that maps every Photon, Nessie, Supabase, ElevenLabs and Daytona call to the feature it powers, and a working number judges can text unaided | Judges text the number during judging without us touching a laptop |

**What we are optimizing for, in order:** (1) a product a stranger can use from their own phone with no instructions, (2) depth and correctness of Photon usage, (3) a sustainability number that is real, (4) completeness across the whole move.

The order matters when two goals conflict: a feature that makes the chat feel staffed beats a feature that adds coverage, and a real number beats a bigger claim.

## The moving journey

The pain is concentrated in three places: scheduling strangers, the last 72 hours before move-out, and the sublet hunt. The journey below comes from Gavin's two NYC move-out/move-in/sublet cycles plus the research cited at the end of the doc.

| Phase | Pain point | Who feels it | Feature that answers it |
| --- | --- | --- | --- |
| Weeks before | Knowing what you own and what it is worth before you list anything | Seller | Inventory: a video walkthrough of the apartment becomes an item list with categories, weights and comp prices |
| Weeks before | Listing furniture one item at a time; writing descriptions and guessing prices | Seller | Sell Elf and Listing Studio: photo in, listing and price out, one tap to copy anywhere |
| Weeks before | Negotiating with many buyers at once, most of whom ghost | Seller | Sell Elf runs each buyer in their own DM within a floor price and ranks them by reliability |
| Weeks before | Scheduling pickups; you are not home, so the roommate covers | Seller, roommate | Pickup calendar on the Crew Board, synced to Google or Apple Calendar; the owner names who is covering in the thread |
| Weeks before | Researching storage companies and prices for the summer gap | Student | Storage via Haul Elf: compares options for your dates and volume, calls to confirm, books |
| Last 72 hours | "I can't take this" items listed in a panic, hoping someone shows up | Seller | Last Call mode: list, auto price-drop, flip to free, Curb Map, donation pickup |
| Last 72 hours | Mattresses and bulk items end up on the curb; Boston fines unscheduled mattress dumping | Seller, city | Green Elf books the 311 or donation pickup and confirms it happened |
| Move-out day | U-Haul booking, moving permit, truck on a low-clearance road | Mover | Haul Elf books by phone, files the street permit where the city offers it online, checks the route against Storrow and Memorial Drive |
| Move-out day | Key hand-off, landlord walkthrough, security deposit evidence | Tenant | Move-out photo checklist against the move-in record; deposit tracker on the Ledger; demand letter if the deposit is late (MA: 30 days, NY: 14) |
| Between homes | Finding a sublet on unofficial sites (Marketplace, Leasebreak, FB groups); terms and reviews to vet; requirements change mid-search | Hunter | Hunt Elf: requirements by text, forwarded links extracted and ranked, re-ranked when requirements change, Scam Shield on every listing |
| Between homes | Deposit-before-viewing scams; ages 18–29 lose money at three times the rate of other adults, half start on Facebook | Hunter | Scam Shield + Nessie escrow for every deposit; identity requests refused |
| Between homes | Nights between the flight and the move-in date, luggage with nowhere to go | Student | Move-in Elf finds the bridge stay and a luggage drop, and schedules the storage-to-apartment run |
| Move-in | Buying furniture, negotiating from the buyer side | Buyer | Buy Elf: evaluates forwarded listings against comps and the Curb Map, drafts the offer, negotiates when the seller texts the number, schedules pickup |
| Move-in | Leases, contracts, payment methods | Tenant | Lease Elf reads the lease PDF, flags clauses, generates agreements as attachments; rent and deposit through escrow |
| Move-in | Utilities, internet, address change, renters insurance | Tenant | Move-in Elf runs the checklist and files what can be filed by text or email |
| Subletting out | Photos, listing, screening applicants, an agreement both sides accept | Subletter | Deal Engine in room mode; Lease Elf checks the sublet clause and emails the landlord notice from the same number's email channel |
| Any time | Roommate ownership disputes ("whose couch is it") | Roommates | The Inventory records who owns what from day one (a dedicated Roommate Elf is deferred) |

**Research that shaped this:** Boston approves about 2,400 moving permits for the Sept 1 turnover and in one 2023 week collected 38 extra tons of trash and 1,700 mattresses. The FTC logged nearly 65,000 rental-scam reports and about $65M in losses from 2020 to mid-2025, with a $1,000 median loss; young adults were targeted through the Facebook groups students use to find sublets.

## Core product: the Deal Engine

Every moving chore is the same six-step loop, so we build it once and run it in four modes. This is the technical story for judges: one engine, parameterized, not seven bots.

&#91;embedded content: Deal Engine · 6 steps, 2 loops, 1 escape hatch\]

A buyer who walks away returns the item to the inbound queue; a no-show reschedules; anything unsold at T−48h drops into Last Call and relists free. The Photon number is the listing's public contact, so inbound conversations arrive on their own, in their own spaces.

| Mode | What is listed | Who texts in | What "your floor" means | Hand-off evidence |
| --- | --- | --- | --- | --- |
| Sell item | A piece of furniture | Buyers | Minimum price, pickup window, roommate availability | Both locations converge at the address; buyer confirms in their DM |
| Buy item | A listing the user forwards | Sellers (or the user relays) | Maximum price, delivery radius | Seller confirms; user tapbacks received |
| Sublet out | The user's room | Applicants | Minimum rent, dates, house rules | Agreement PDF accepted by both via poll; keys handed over |
| Find sublet | The user's requirements | Listers | Maximum rent, dates, neighborhoods | Lease Elf reviews terms; deposit only through escrow |

**Engine rules that hold in every mode:**

1. Every inbound party gets their own space; the owner chat only sees threaded summaries.
2. The agent never agrees below the floor or above the ceiling; it asks the owner in-thread instead.
3. Scheduling offers at most three slots from the shared pickup calendar and books on first confirmation.
4. Money never moves outside Nessie escrow; any request to pay elsewhere trips Scam Shield.
5. Every item exits with an outcome tag (sold, given, donated, dumped) so the Move Report can count it.

State per deal: `listed → negotiating → scheduled → handed_off → paid | relisted | donated | dumped`, stored in Supabase and mirrored on the Crew Board.

## The Elves

Ten agents, each a contact in your phone. Every Elf runs on its own dedicated Photon line with its own name and avatar, so the owner can DM an Elf directly or watch the whole crew in the group. In the group, Elves speak only when they have something to report, always as a threaded reply under the message that started the work, and the Crew Lead is the only one that answers open questions. This is what "a team of agents you manage from one place" means in practice: the group chat is the standup, each DM is a 1:1.

| Elf | Owns | End goal | Inputs | Outputs | Photon features |
| --- | --- | --- | --- | --- | --- |
| Crew Lead | Orchestration, the owner group, the Crew Board, memory of the move, coverage | Every message in the group is routed to one Elf within 2 s; the owner can redirect any Elf by replying in its thread; the Lead knows the whole move's state, answers any question about it, and records who is covering a pickup the owner can't make | All inbound in the owner space; every Elf's events | Plan, threaded summaries, Crew Board edits, chat rename and avatar, coverage assignments, morning briefing | `react`, `responding`, `reply`, `rename`, `avatar`, `app` + `edit`, `poll`, `space.create` for briefings, debounce pipeline |
| Sell Elf | Inventory, Listing Studio, Deal Engine in sell mode | From a video walkthrough or a photo, every item is listed with a defensible price; each buyer is run in their own DM to a booked slot without the owner typing | Video or photos, floor prices, buyer messages | Inventory rows, listings, buyer replies, pickup bookings, buyer reliability scores, confetti on sale | Cross-space send, `group` albums, `richlink`, `contact`, `effect(confetti)`, `poll` for price approval |
| Buy Elf | Deal Engine in buy mode | A forwarded listing is evaluated against comps and the Curb Map within seconds; the Elf negotiates when the seller texts the number and schedules delivery | Forwarded links and screenshots, ceiling prices, delivery window | Verdicts (fair, high, scam), drafted offers, seller replies, delivery bookings | `richlink`, `reply`, `attachment` for screenshots, Scam Shield |
| Green Elf | Last Call mode, outcomes, impact accounting, Curb Map | Zero items leave a move without an outcome; unsold items get a donation or 311 pickup before move-out; the Curb Map shows every free item in the neighborhood during turnover week | Items, move-out date, outcome events, opt-in from other moves | Price-drop schedule, free relists, pickup bookings, Curb Map pins, Move Report | `effect(balloons)`, `app` Move Report and Curb Map, scheduled proactive sends |
| Money Elf | Nessie: Moving Fund, escrow, splits, Ledger, Scam Shield for payments | Every dollar in the move is on one card; every deposit sits in escrow until hand-off; no payment request ever reaches the owner unscreened | Sale and sublet confirmations, bookings, shares the owner names, counterparty messages | Nessie customers, accounts, transfers and purchases; Ledger edits; flags | `app` Ledger + `edit`, `reply` for flags, `poll` for settlement approval |
| Haul Elf | Trucks, movers, storage, permits, the route | Truck and storage are booked by phone from the owner's dates and inventory volume; the street permit is filed where the city allows; the route is checked for low clearances | Move dates, Inventory volume, addresses | Call summaries, bookings, permit confirmations, route warnings, purchases to Money Elf | Photon SIP line + Retell outbound calls, post-call webhook, `reply`, `attachment` for confirmations |
| Map Elf | Move-day location and the Move Map | On pickup and move day everyone involved sees everyone else approaching on one map, and hand-offs are confirmed by convergence | Location shared from the Move Map link by buyers, covering friends, movers (browser geolocation; no Find My on the 2.0 API) | Move Map card, ETA messages, convergence events to Money Elf | `locations.request` / `watch`, `app` Move Map + `edit` |
| Lease Elf | Leases, sublet clauses, agreements, landlord correspondence, Scam Shield for rooms | Send a lease PDF and get a verdict on subletting, the clauses that matter, and a landlord notice sent by email from the same project; every applicant is screened; agreements are generated and accepted in-thread | Lease PDFs, applicant DMs, landlord replies by email | Verdicts, notice emails, agreement PDFs, screening results, deposit requests to Money Elf | `attachment` in and out, Photon email channel, `poll` for acceptance |
| Hunt Elf | Finding the owner a sublet | Requirements by text produce a vetted, ranked shortlist; changed requirements re-rank it; viewings are scheduled; every listing passes Scam Shield before a deposit is possible | Requirements, forwarded links and screenshots, lister replies | Shortlist as rich links, extracted listing facts, viewing bookings, draft outreach | `richlink`, `reply`, Daytona sandbox for page extraction, Scam Shield |
| Move-in Elf | The gap and the first week | Bridge stay and luggage drop booked for the nights between flight and move-in; utilities, internet, address change and renters insurance handled by text or email; move-in photo record captured for the deposit | Flight and move-in dates, new address, lease | Bookings, checklist progress, filed changes, move-in photo set | `reply`, `attachment`, email channel, `poll` for choices |

**Deferred:** the Roommate Elf lives in the Backlog section below. What survives now is the minimum: the owner names who is covering a pickup in the thread (Crew Lead), the Inventory records an owner per item, and shares the owner names are settled by the Money Elf.

**Elf contract (so they compose):** every Elf exposes `handle(space, message, context) → ElfResult` where `ElfResult = { replies: Content[], boardPatch: Partial<Row>, events: Event[] }`. The Crew Lead applies the patch to Supabase, edits the Crew Board card, and posts replies as threaded replies to the message that triggered the Elf. No Elf sends into the owner chat directly.

## Mini apps

Eight hosted web pages, each sent into the chat as a link. Photon 2.0 has no app-card content type, so a mini app is an HTTPS URL that iMessage unfurls into a rich preview; the pages are served by the Elves service itself behind one public URL (Railway or Fly for the weekend; a Cloudflare tunnel from a laptop also works). Each page reads Supabase with Realtime subscribed, so the page changes the moment an Elf writes a row. Where a page needs input (a price slider, an outcome override, a settle button), the action posts back to the service, which sends the owner's choice into the chat as a message, so the conversation stays the system of record.

| Mini app | End goal | Contents | Updated by |
| --- | --- | --- | --- |
| Crew Board | The one place to see and steer every Elf | One row per Elf: status, current task, last update, a nudge button; a pickup calendar strip across the top synced to the owner's calendar; the move's countdown | Crew Lead after every Elf result |
| Inventory | Every item in the apartment, owned, weighed and priced before anything is listed | Items extracted from the walkthrough video with category, estimated weight, owner, keep/sell/donate decision, comp price range; bulk edit | Sell Elf on extraction, owner edits |
| Listing Studio | A listing the owner would post themselves, in one tap | Photos (cleaned, background-blurred), generated title and description, price with the comp range behind it, a copy button per marketplace, the number as contact | Sell Elf on creation and on every price change |
| Ledger | The move's money on one screen | Moving Fund balance, escrow holds by status, purchases by merchant, roommate splits with settle buttons, deposit tracker, net cost of the move | Money Elf on every Nessie write |
| Move Map | Move-day coordination at a glance | Pickup and delivery addresses, positions of buyers, roommates and movers from Find My, ETAs, the next slot, the truck's route with low-clearance warnings | Map Elf on each location update |
| Room | The sublet pipeline for the owner's room | Listing, applicant pipeline with screening results, viewing slots, agreement status, deposit status | Lease Elf and Deal Engine in room mode |
| Move Report | The sustainability number and the closing moment | Items by outcome, pounds diverted, CO2e avoided with the factor cited, dollars recovered, Curb Map contribution, a shareable card image | Green Elf at move complete |
| Curb Map | Free items across all moves in a neighborhood during turnover week | Opt-in pins from Last Call relists with photo, pickup window and a text-to-claim link to the owner's Sell Elf | Green Elf on every free relist and claim |

**Card lifecycle:** the Crew Lead sends each card once at the start of a move and keeps the returned message (it carries the `miniAppCardSession` metadata). Later updates always `edit` that message; a card sent twice is a bug. Card captions change with state ("3 Elves working · next pickup Sat 2 PM"), so the chat itself reads like a status line even if nobody taps.

**Auth:** each card URL carries a signed, move-scoped token minted at send time (the `app()` builder accepts a thunk, so the token is minted per send). No login screen; the token identifies the move and the viewer's phone.

**Design rule:** phone-width first, one screen, no navigation. A judge taps once and sees the point.

## Photon integration spec

We build on the Photon 2.0 API (`api.photon.codes/v1`): REST for users, spaces, messages, attachments and typing, and the Socket.IO event stream for inbound. The team's project ("HHUH") is a 2.0 project, which is the product the hackathon brief names; the `spectrum-ts` SDK in the skills repo is Photon's stable product with a different credential type and does not attach to it. Channels: iMessage (shared pool now, a dedicated line when provisioned), SMS and voice on +1 740-255-8982, and email once a domain is verified. The goal is unchanged: a judge reading our README sees every Photon primitive tied to a user-visible moment, not a bare `send`.

**Channels and line requirements**

| Need | Requirement | How we meet it |
| --- | --- | --- |
| Owner and buyer phones can text the agent on iMessage | Shared pool: each phone is assigned to the project (`POST /platforms/imessage/assignments`, 25 max); a dedicated line needs no assignments | Assign test phones by API now; provision the dedicated line when the team approves the credit spend |
| Group chats with the owner and a roommate or mover | iMessage spaces take 2–1000 participants; the project agent is always a participant | `POST /spaces` with the participant user ids; participants added or removed with `space.participants.update` |
| Threaded replies | `parentMessageId` on `POST /messages` | Every Elf reply carries the id of the message it answers |
| Voice calls | A voice-capable line with a Voice profile | The 740 line has `pstn_voice`; Retell agents attach over SIP through a voice profile |
| Inbound without a public URL | Socket.IO events at `/v1/projects/{id}/events/ws` with cursor replay | The service subscribes from wherever it runs; webhooks are added once there is a public URL |
| Proactive outreach | Spaces are created from user ids; no allowlist on the 2.0 API | Opt-in recorded per participant; replies preferred over cold sends |
| Landlords and institutions | Email platform on a verified project domain | Lease and Move-in Elves use the same `POST /messages` with `platform: email` |

**Primitive-to-moment map** (every row is a line in the README):

| Primitive (Photon 2.0) | Where it fires | Why it matters to a judge |
| --- | --- | --- |
| `reaction` (add) within 300 ms | On every inbound message, before any model call | Feels like a person acknowledging, not a webhook |
| `space.typing.update` | Around every LLM, Nessie or sandbox call | Typing indicator instead of dead air |
| `parentMessageId` on every reply | Every Elf result | Threads keep a busy group chat legible |
| Spaces created from user ids | Owner group, each buyer or applicant DM | Counterparties get their own conversation with the same crew |
| `space.participants.update` | Covering friend or mover added for move day | The crew manages its own room |
| `poll` + `poll.vote` | Price approval, agreement acceptance, settlement approval | Decisions without typing |
| Reaction reads on inbound | 👍 = confirm, 👎 = decline, ❤️ = approve a Scam Shield override | Social context as input |
| `group` of attachments | Listing photos, move-in photo record | Album, not a photo spam |
| Links in text | Listings, shortlists, bookings, the mini apps | Native rich previews on iMessage |
| `attachment` in and out | Item photos in, lease PDF in, agreements and confirmations out | Documents stay in the thread |
| `text.update` / `message.delete` | Price corrections, retracted offers | The agent fixes its own mistakes the way a person would |
| `voice` | Call recaps, Backlog briefings | A voice note from the crew |
| Email platform | Landlord notice, deposit demand, insurer and utility forms | The same project reaches institutions where they live |
| Event stream with cursor replay | Every inbound | Nothing lost across restarts; at-least-once with idempotent handling |
| Debounce pipeline | Every inbound burst | Three rapid texts become one turn (Photon's own best-practice architecture) |
| `message.read` | After the Elf has read the batch | Read receipts where the platform shows them |

**Message handling architecture:** one process, one `for await (const [space, message] of app.messages)` loop. Each inbound is enqueued per space with a short debounce; the flush builds a batch, the Crew Lead classifies it to an Elf, the Elf runs, and the send stage paces replies. A newer message in the same space cancels the in-flight job and carries the batch forward. This is Photon's documented pipeline, implemented with BullMQ on Supabase-hosted Postgres as the queue store.

**Deliverability:** reactive first (judges text us), proactive only to registered numbers, no links in a first message, under 50 new conversations per line per day.

## Voice

Voice is a first-class channel, not a demo trick: the Elves' numbers are real business lines that answer, place and transfer calls. Photon's SDK has no call control yet, so calls run through Retell agents connected to the lines over SIP (Photon's cookbook covers the trunk); when `spectrum-ts` ships call control, dial-out moves into the Elves service and Retell stays as the voice runtime. Retell was chosen over ElevenLabs for warm transfer over SIP, pay-as-you-go pricing, and a custom-LLM websocket that lets the owning Elf's own code run the call. End goal: anything a human would resolve with a phone call (a storage quote, a mover's slot, a landlord's walkthrough time, a buyer who prefers to call) is resolved by the responsible Elf, and the transcript and extracted facts land in the chat within 30 seconds of hang-up.

**Outbound (the demo call):**

1. Haul Elf drafts a call brief from the move (dates, volume, destination) and writes it to Supabase.
2. It triggers ElevenLabs' outbound-call endpoint for our SIP-trunk number with the brief as the agent's dynamic variables.
3. The ElevenLabs agent (persona: a polite assistant calling on the owner's behalf) asks for availability and price, confirms a slot, and ends the call.
4. ElevenLabs' post-call webhook hits a Supabase Edge Function with the transcript and extracted fields.
5. Haul Elf posts a threaded reply ("Booked SecureSpace Allston, 5×5 unit, Jun 1–Aug 31, $89/mo"), Money Elf logs the purchase, Crew Board row flips to done.

**Inbound (secondary):** a buyer who calls the number instead of texting reaches the same agent, which answers listing questions from Supabase and offers to text them a pickup slot. This makes the number feel like a real business line.

**What the judge experiences:** they give us a phone number, play the storage facility, answer the call on their own phone, and watch the summary appear in the chat they are already in.

**Call types and owners**

| Call | Direction | Elf | Agent persona and goal | Returns to chat |
| --- | --- | --- | --- | --- |
| Storage quote and booking | Outbound | Haul | Assistant calling on the owner's behalf; gets price, unit size, dates; books on approval | Quote, booking confirmation, purchase to Money Elf |
| Mover or truck confirmation | Outbound | Haul | Confirms slot, truck size, insurance; asks about building rules | Confirmation, certificate-of-insurance request if the building needs one |
| Landlord walkthrough or deposit follow-up | Outbound | Lease | Schedules the walkthrough; asks for the deposit timeline; stays polite and factual | Appointment, deposit status, escalation to a demand letter if late |
| Buyer or applicant who calls instead of texting | Inbound | Sell or Lease | Answers listing or room questions from Supabase; offers to text a slot; never agrees on price below the floor | Transcript, slot offered, counterparty created |
| Anyone asking for the owner | Inbound | Crew Lead | Explains it is the owner's moving crew; offers a transfer or a callback | Transfer to the owner's phone via SIP, or a callback task |
| Voicemail | Inbound | Crew Lead | Takes the message | Transcript as a threaded reply, action proposed |

**Setup**

- Voice profiles on the Haul, Sell and Lease lines; outbound enabled with SHA-256 credentials stored in the service's secret store
- Each line imported into Retell as a SIP number (no monthly charge); inbound destination set to Retell's SIP endpoint over TLS per Photon's Retell cookbook
- One Retell agent per call type, each with the call brief passed as dynamic variables, a hard maximum duration, and the custom-LLM websocket pointed at the Elves service so the Elf runs the conversation
- Post-call webhook into the Elves service with signature verification; transcript and call analysis written to `calls`, then handed to the owning Elf
- Transfer to the owner as a Retell warm transfer to the owner's number, with the agent briefing the owner before bridging; a failed transfer becomes a callback task on the Crew Board
- Business profile registered with Photon so outbound calls are not flagged

**Guardrails:** an agent on a call can quote, schedule and confirm, but it books money only on a tapback from the owner in the chat (the Haul Elf posts the quote and waits). It states that it is an AI assistant when asked and at the start of every outbound call. It never reads out a phone number, address or price the owner marked private.

**Voice notes** (briefings and call recaps as iMessage voice memos through `voice()`) are in the Backlog; briefings go out as markdown until then.

## Money: Nessie, escrow, and Scam Shield

The move funds itself. The couch pays for the U-Haul, and every dollar passes through one Nessie account so the Ledger card can show the net cost of the move. Nessie is a simulation, which is exactly right for a hackathon: we get customers, accounts, deposits, withdrawals, transfers, purchases and merchants over plain HTTP with no payment risk.

**Nessie object model for one move**

| Nessie object | We create | When |
| --- | --- | --- |
| Customer | One per phone number that joins the move (owner, each roommate, each buyer who reaches escrow) | First message from that number |
| Checking account "Moving Fund" | One per move, owned by the owner | Move created |
| Savings account "Escrow" | One per move | Move created |
| Deposit into Escrow | Buyer's agreed price | Buyer confirms in their DM |
| Transfer Escrow → Moving Fund | Same amount | Hand-off confirmed (both parties, or location convergence + buyer confirm) |
| Withdrawal from Escrow | Refund | Buyer no-show past 24 h or owner cancels |
| Purchase at merchant | U-Haul, storage, movers | Haul Elf books |
| Transfer roommate → Moving Fund | Their share | Roommate taps settle on the Ledger card |

**Escrow lifecycle:** `held → released | refunded`. Release requires two signals: the buyer's confirmation message in their DM, and either the owner's tapback in the owner chat or a Find My convergence event from the Map Elf. One signal alone leaves the hold in place and the Money Elf asks the missing party in-thread.

**Sublet deposits use the same rails.** Applicant deposit goes to Escrow on agreement acceptance; releases on key hand-off. This is the feature that answers the FTC data: no deposit ever moves to a stranger before the room is seen.

**Scam Shield rules (Lease Elf for rooms, Sell Elf for items):**

1. Any request to pay or hold with Zelle, Venmo, Cash App, gift cards, or wire outside escrow → flag, reply with the escrow link instead.
2. Deposit or fee requested before a viewing or hand-off → flag.
3. Rent or price more than 35% below the move's own comps → flag as "too good".
4. Request for SSN, ID photo, or a paid credit-check link → block and warn the owner.
5. Pressure language ("others are interested, pay today") combined with any of the above → escalate to the owner with a one-line summary.

Each flag posts a threaded reply in the owner chat with the rule that fired and the message that tripped it, and marks the counterparty on the Crew Board. The owner can override with a tapback.

**Ledger card end state:** Moving Fund balance, escrow holds by status, purchases by merchant, roommate shares outstanding, and one number at the top: net cost of the move. Target for the demo move: a positive number, because the furniture sold for more than the truck cost.

**Security note for the Fintech-CyberSec track:** Nessie keys and ElevenLabs secrets live only in Supabase Edge Function env; card URLs carry move-scoped signed tokens with a 24-hour expiry; phone numbers are the only identity and are never shown to counterparties (the agent brokers every exchange).

**Path to real rails:** the `packages/nessie` client implements a `MoneyRails` interface (customer, account, hold, release, refund, purchase, split). Nessie is the first implementation; Stripe Connect with manual capture (hold = authorization, release = capture, refund = void) is the second, and Plaid Transfer the third for roommate settlement. Nothing in the Elves or the Ledger changes when the implementation does, which is the point of modeling escrow as holds rather than as account balances.

## Sustainability layer

The sustainability claim must be a number a judge can audit, not an adjective. End goal: every item in the move ends with an outcome tag, and the Move Report states pounds diverted from landfill and CO2e avoided with the emission factor cited.

**Last Call mode (the Allston Christmas feature):** when an item is still unsold at move-out minus 48 hours, the Green Elf takes over the deal.

1. T−48h: price drops to 60% of list; buyers already in conversation get a "price dropped" message in their DM.
2. T−24h: relisted free; the Crew Lead posts the free list to the owner chat for forwarding to building and Buy Nothing groups.
3. T−24h, in parallel: Green Elf books a donation pickup (Boston: Goodwill, Habitat ReStore, Big Brother Big Sister; NYC: Housing Works, Salvation Army) or a 311 bulk/mattress pickup, which Boston requires for mattresses on pain of a fine.
4. T−0: anything with no pickup is tagged dumped, so the report is honest.

The owner can pull any item out of Last Call with a tapback in its thread.

**Impact accounting:** each item carries a category and an estimated weight (from the Sell Elf's photo classification, editable by the owner). Diverted weight is the sum over items with outcome sold, given, or donated, and avoided emissions are that weight times the category's factor:

```latex
\text{CO}_2\text{e avoided} = \sum_{i \in \text{diverted}} w_i \cdot f_{c(i)}
```

Here w is the item's weight and f is the landfill-versus-reuse emission factor for its category c from the EPA WARM model, cited in the README. Weight defaults are approximate and must be labeled as such in the UI.

| Category | Default weight (lb, approximate) | Source for the factor |
| --- | --- | --- |
| Couch / sofa | 150 | EPA WARM, furniture |
| Mattress | 60 | EPA WARM, mattress |
| Desk / table | 70 | EPA WARM, wood furniture |
| Chair | 20 | EPA WARM, furniture |
| Bookshelf / dresser | 90 | EPA WARM, wood furniture |
| Small item (lamp, rug, mirror) | 10 | EPA WARM, mixed |

**Move Report (the closing beat):** items by outcome, pounds diverted, CO2e avoided, dollars recovered, and one sentence ("Your move kept 212 lb off the curb"). Sent as an app card with `effect(balloons)`, exportable as an image for the ASUS content challenge post.

**Why this beats a generic "eco" angle:** the venue is in Allston, the city's own numbers (38 extra tons, 1,700 mattresses in one week) are on the slide, and the product changes the outcome at the exact moment people give up on selling.

**Curb Map (the network effect):** every free relist from Last Call can be published, with the owner's opt-in, to a neighborhood map that any Elves user and any passer-by with the link can open. A pin shows the photo, the pickup window and a text-to-claim link that opens a DM with that owner's Sell Elf, which then schedules the pickup like any other deal. During turnover week in a dense student neighborhood this turns one person's panic into another person's free couch, and every claimed pin counts as diverted weight on both Move Reports. The map is the product's sustainability flywheel: more moves, more pins, fewer curbs.

**Impact accounting rules of honesty:** dumped items count against the report; weights are labeled approximate until an owner edits them; the factor table and its source are one tap from the report; a claimed Curb Map pin counts only after the claimer confirms pickup.

## Architecture and data

One service owns all the Photon lines; Supabase is the only shared state; the mini apps are read-mostly views of it. The service is a modular monolith: the Deal Engine, each Elf and the money rails are separate packages with typed interfaces, deployed as one process plus a worker pool, so a single trace covers a message from arrival to the last side effect. It splits into services only where load demands it (the Sell Elf's line during turnover week), not by default.

&#91;embedded content: System architecture · 6 components\]

Messages flow down from the chats through Photon into the Elves service, which writes state to Supabase and reads it back; the mini apps subscribe to the same rows over Realtime. Voice bypasses the service on the way in (SIP straight to Retell), runs the conversation back through the service over Retell's custom-LLM websocket, and returns the transcript through a webhook. Untrusted work (extracting a forwarded listing page, running a pricing script, parsing a lease) runs in a Daytona sandbox and returns structured JSON, never code or HTML, to the service.

**Supabase schema (core tables)**

| Table | Key columns | Written by |
| --- | --- | --- |
| `moves` | id, owner\_phone, move\_out\_at, move\_in\_at, group\_space\_id, nessie\_fund\_id, nessie\_escrow\_id, board\_card\_msg\_id | Crew Lead |
| `participants` | move\_id, phone, role (owner, roommate, buyer, applicant, lister), space\_id, nessie\_customer\_id, scam\_flags | Crew Lead, Sell Elf, Lease Elf |
| `items` | move\_id, name, category, weight\_lb, photos\[\], list\_price, floor\_price, outcome (listed, sold, given, donated, dumped), last\_call\_stage | Sell Elf, Green Elf |
| `deals` | item\_id or room\_id, counterparty\_id, state, agreed\_price, slot\_at, escrow\_hold\_id, thread\_msg\_id | Deal Engine |
| `slots` | move\_id, starts\_at, ends\_at, covered\_by (phone), deal\_id | Roommate Elf |
| `ledger` | move\_id, kind (deposit, release, refund, purchase, split), amount, nessie\_txn\_id, memo | Money Elf |
| `elf_status` | move\_id, elf, status, current\_task, updated\_at | Every Elf via Crew Lead |
| `calls` | move\_id, deal\_id, eleven\_conv\_id, transcript, extracted jsonb, outcome | Haul Elf |
| `events` | move\_id, type, payload jsonb, created\_at | Everything (audit log; also the Move Report source) |

**Event flow for one inbound message**

1. `app.messages` yields `[space, message]`; the handler looks up the space in `participants` to learn the move and the role.
2. Enqueue into the per-space debounce queue; a message arriving mid-flight cancels the running job and carries forward.
3. On flush: `react("👍")` on the last message, open `responding()`.
4. Crew Lead classifies the batch (role + intent) to one Elf and calls `handle()`.
5. Elf result: write `boardPatch` and `events` to Supabase in one transaction; send `replies` as threaded replies; `edit` the Crew Board card.
6. Side effects (Nessie, ElevenLabs, donation booking) run as follow-up jobs so a slow API never blocks the reply.

**Repo layout:** `apps/elves` (the service), `apps/web` (mini apps), `packages/engine` (Deal Engine state machine, pure functions, unit-tested), `packages/nessie` (typed client), `supabase/` (migrations, Edge Functions). The README maps every Photon, Nessie, Supabase and ElevenLabs call to the feature it powers, because two sponsor challenges ask for exactly that.

**Evaluation and observability**

Every agent decision is reproducible, and no policy change ships without a replayed eval run.

- Replay corpus: every conversation is stored as events; a fixture is a span of events plus the expected Elf action. The corpus starts with the scripted demo deals and grows from real moves with owner consent.
- Policy evals: negotiation (never below floor, counters within the band, accepts at the right moment), scheduling (offers three slots, books on first confirmation, reschedules a no-show once), screening (every Scam Shield rule has positive and negative fixtures), routing (the Crew Lead sends each fixture to the right Elf). Pass rates per policy are tracked per commit; Chalk's Agent Evals is the harness.
- Traces: one OpenTelemetry trace per inbound batch, spanning debounce, classification, LLM calls, sandbox runs, Nessie and ElevenLabs calls, and sends; linked from the `events` row so "why did it counter at $70" is one click.
- Audit log: Photon's dashboard logs plus our `events` table give two independent records of every send.
- Memory: per-move state in Supabase; per-owner preferences (tone, floor-price habits, usual slots) in a small profile the Crew Lead reads at the start of every batch.

**Security and privacy**

- Secrets (Photon, Nessie, Retell, Daytona) in the service's secret store only; the mini apps hold no secrets and read through row-level-secured Supabase policies.
- Card URLs carry move-scoped signed tokens with a 24-hour expiry; a counterparty's card never exposes the owner's number or address.
- Phone numbers are the only identity; counterparties see an Elf, never the owner, until the owner chooses to share a contact card.
- Find My requests state their purpose and expire with the deal; location rows are deleted when the deal closes.
- Outbound messaging complies with 10DLC registration and opt-in records; every proactive send has a consent row behind it.

## Demo script and judging

The demo runs on the judge's own phone, not ours. We hand them a card with the number, they text it, and we narrate. Judging is 9:00 AM–12:00 PM Sunday in two periods; expect three to five minutes per judge, so the arc below is 90 seconds of action and the rest is questions.

**The 90-second arc**

| Second | Who acts | What happens | What the judge sees |
| --- | --- | --- | --- |
| 0–15 | Judge texts a couch photo + "moving out Aug 29" | Crew Lead tapbacks, types, replies with a three-line plan, renames the chat, sends the Crew Board card | A chat that feels staffed in under five seconds |
| 15–40 | Judge switches hats: texts "is the couch still available? $80?" from the same phone (we explain it's the buyer's DM) | Sell Elf counters at the floor price, offers two slots from the calendar, confirms | A negotiation that holds a line without the owner typing |
| 40–50 | Confirmation lands | Confetti effect in the owner chat, buyer's contact card arrives, Ledger card shows the escrow hold | The emotional beat plus the money |
| 50–70 | Judge forwards a lease PDF: "can I sublet my room?" | Lease Elf returns the verdict, quotes the clause, drafts the landlord notice email | A document read and acted on inside the thread |
| 70–85 | We text "book storage June–August"; Haul Elf calls the judge's phone | Judge answers as the facility, gives a price; summary posts to the chat | A real call from the same number |
| 85–90 | Judge sends a lamp photo with "can't take this, leaving tomorrow" | Last Call: listed, price-dropped, pinned on the Curb Map, donation pickup booked; Move Report card with pounds diverted and balloons | The sustainability number, live |

**If something breaks:** every step has a pre-seeded fallback move in Supabase so we can show the end state on the mini app. A broken voice call is skipped with one sentence; the arc still lands.

**Talking points per judge type**

- Photon judge: the primitive-to-moment map, the debounce pipeline, cross-space orchestration, and that the number is a real business line (inbound calls answered).
- Sustainability judge: Allston numbers, Last Call mode, the audited impact formula with its factor source, outcome tags that admit when something was dumped.
- Capital One judge: the Nessie object model, escrow as the anti-scam primitive, roommate settlement, net cost of the move on one card.
- General judges: moving is the most hated chore in a student's year, and every part of it is already a text thread.

**Devpost submission checklist**

- [ ] Title, one-line tagline, 2-minute video recorded on a phone screen with the real chat
- [ ] Inspiration paragraph with the Allston Christmas stat and the FTC stat, both linked
- [ ] "What it does" organized by Elf, "How we built it" organized by sponsor API
- [ ] README sections: Photon usage map (the primitive-to-moment table), Nessie usage map, Daytona usage (what runs in the sandbox and why), eval results
- [ ] Challenges tagged: Photon, Nessie, Sustainability track, Fintech-CyberSec if multi-track is allowed, Daytona, Chalk
- [ ] Public repo with `.env.example`, no secrets, and a `demo-seed` script that resets the demo move
- [ ] ASUS content post published and the proof-of-content form submitted

## Build plan

Six phases, each gated by the exit criterion of the one before it. There is no calendar in this plan: the product is the plan, and the hackathon shows whichever phases are done when judging starts. Within a phase, workstreams run in parallel across people; across phases, the gate is the only thing that decides when the next one begins.

&#91;embedded content: Build plan · 6 phases, 6 gates\]

Foundation must be alive before any Elf is written against it. Money precedes Voice because a call that books a quote needs escrow to post into. Rooms reuses the Deal Engine and adds the email channel. Green runs last because it counts outcomes the other phases produce.

**Phases in detail**

| Phase | Delivers | Exit criterion | Depends on |
| --- | --- | --- | --- |
| 1 · Foundation | Business plan with a dedicated line per Elf and Telegram identities; the `app.messages` loop with debounce, cancellation and routing; Supabase schema and migrations; Crew Board card sent once and edited in place; the Elf contract and a stub Elf | Three rapid texts produce one reply; the board edits in place from a script; a teammate's iPhone and an Android phone both get tapback, typing and a threaded reply | Photon Business plan, Supabase project |
| 2 · Deal Engine | `packages/engine` state machine with unit tests; Inventory extraction from a walkthrough video; Listing Studio; Sell Elf in sell mode with per-buyer spaces; coverage assignment in the thread; pickup calendar synced to the owner's calendar | A stranger's DM negotiates to the floor, is offered three slots, books on first confirmation, and the owner chat gets a threaded summary and confetti without the owner typing | Phase 1 |
| 3 · Money | `MoneyRails` interface with the Nessie implementation; Moving Fund and Escrow per move; holds, releases, refunds, purchases, splits; Ledger page; Scam Shield rule set with positive and negative fixtures | A hold appears on the Ledger when a buyer confirms and releases on hand-off; a "pay on Zelle to hold it" message is flagged with the rule named; every rule's fixtures pass | Phase 2 |
| 4 · Voice and Map | Voice profiles and Retell SIP numbers on the Haul, Sell and Lease lines; call-type agents; post-call webhook; transfer and callback; Map Elf with browser-geolocation consent from the Move Map link; Move Map with route and clearance warnings; convergence events into escrow release | An outbound storage call returns a summary in 30 s and posts a purchase on approval; an inbound buyer call offers a slot by text; convergence plus confirm releases escrow | Phases 1 and 3 |
| 5 · Rooms and Move-in | Deal Engine in room and buy modes; Lease Elf with PDF parsing in a Daytona sandbox and landlord email on the email channel; Hunt Elf with forwarded-link extraction and ranking; Buy Elf; Move-in Elf checklist and bridge stay; Room page | A lease PDF returns a sublet verdict and a landlord notice email from the project; an applicant is screened and signs an agreement by poll; a sublet deposit runs through escrow; a forwarded listing is scored against comps | Phases 2, 3 and 4 |
| 6 · Green and scale | Last Call schedule and relists; Green Elf pickup bookings; Move Report with the cited factor table; Curb Map with opt-in pins and text-to-claim; replay corpus and policy evals in Chalk; OpenTelemetry traces linked from events; Stripe Connect behind `MoneyRails`; load test of the Sell line with auto-scale | A lamp at T−24h relists free, pins on the Curb Map, and books a pickup; the Move Report's number is reproducible from events; eval pass rates per policy run on every commit; a claimed pin is counted on both Move Reports | All prior phases |

**Sequencing rules**

- Nothing is written against Photon until the pipeline passes its gate; every Elf is developed against the terminal provider first and the real lines second.
- The Deal Engine is pure functions with fixtures before it is wired to any channel; the same fixtures become the eval corpus.
- Every external system (Nessie, ElevenLabs, Daytona, calendars) sits behind an interface with a fake, so any phase can be demoed without the others being live.
- A mini app ships only with the Elf that writes its rows; a page with no writer is not built.
- The sustainability number is never estimated by hand; if a phase cannot produce real outcomes, its contribution to the report is zero until it can.

**Definition of done for the product:** a person who has never seen Elves texts the number, runs a real move end to end over several weeks (sell, store, haul, sublet, move in), never opens anything but Messages and the cards inside it, and ends with a Move Report whose numbers can be reproduced from the event log and a Ledger that reconciles to the cent.

The work breakdown, setup checklist and owners live in Implementation plan.

## Backlog

Real features, deliberately not built before the core passes its gates. Each has a trigger that pulls it back in; nothing here is cut for good.

| Item | What it is | Why deferred | Pull-in trigger |
| --- | --- | --- | --- |
| Roommate Elf | A dedicated agent for group coordination: coverage polls, item claims by tapback, automatic cost splits, "whose couch is it" | More than the product needs at first; the Crew Lead covers the minimum (named coverage, Inventory ownership, owner-named shares) | Real moves show group coordination as a bottleneck, or a roommate-heavy demo is wanted |
| Voice-note briefings | Crew Lead morning briefing and call recaps as iMessage voice memos via Photon `voice` content with a TTS provider | A second vendor (ElevenLabs TTS) for one flourish; briefings read fine as text | Phases 1–3 pass, and either Retell exposes a TTS path or the team wants one more Photon content type on show |
| Telegram and Android | Telegram bot identities in the same event loop so Android counterparties get the same crew | iMessage and SMS cover the demo; one more platform is one more thing to test | An Android judge or a real counterparty on Android |
| Real payment rails | Stripe Connect or Plaid behind `MoneyRails` | Nessie carries the ledger and escrow model for the hackathon; real money moves on Venmo outside the product | A real user who wants the escrow to hold real dollars |
| Video walkthrough inventory | A 60-second apartment video becomes the full item list | One photo per item gives the same pricing, weight and listing pipeline with far less model cost | Owners ask to list a whole apartment at once |
| App cards and screen effects | Live cards and confetti from Photon's stable Spectrum product | Not in the 2.0 API; links with rich previews and reactions do the job | Photon ships them on 2.0 |

Add to this table rather than to the Elves or mini-app tables; an item leaves the Backlog only by being scheduled into a phase with an acceptance test.

## Risks, open questions, and asks

The risks that matter are about the Photon lines, deliverability, and the places where an agent could spend or share something it shouldn't. Each has an owner and a mitigation that is part of the build, not a fallback.

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Dedicated lines not granted, or fewer than one per Elf | Medium | Elves can't appear as separate contacts; no agent-created groups | Design the Crew Lead to carry every Elf's voice on one line with named threads; add lines as granted; the Elf contract does not depend on line count |
| iMessage filtering flags a line after bursts of outbound | Medium | Messages stop for that line | Replies over cold sends; no links in first messages; per-line quotas enforced in the send stage; auto-scale on the Sell line; business profile registered |
| Counterparty on a channel we don't have (SMS-only phone, WeChat) | Medium | Deal can't run | SMS/RCS fallback on the same number; the owner relays with a one-tap "forward to Elf" card; channel coverage tracked on the Crew Board |
| Retell SIP misconfiguration (TLS, codecs, transfer) | Medium | Calls fail or can't transfer | Per-line call test in the Phase 4 gate; transfer failure becomes a callback task, never a dropped caller |
| LLM latency makes the chat feel slow | Medium | Loses the "feels staffed" moment | Tapback within 300 ms before any model call; streaming text; a small model for classification and a larger one only for negotiation and drafting |
| Agent agrees to a price, slot or payment it shouldn't | Low | Owner loses money or trust | Floors and ceilings enforced in the engine, not the prompt; money moves only on an owner tapback; evals with adversarial fixtures |
| Scam Shield false positives annoy legitimate buyers | Medium | Lost sales | Flags go to the owner with a one-tap override; rules tuned on the replay corpus; precision tracked per rule |
| Find My consent refused | High | No convergence signal | Convergence is one of two signals; the buyer's confirm message alone can release with an owner tapback |
| Nessie sandbox rate limits or outages | Low | Ledger stale | Every Nessie response cached in `ledger`; the card renders from our rows; `MoneyRails` fake for demos |
| Identity and PII handling under scrutiny (Fintech-CyberSec judges) | Medium | Credibility | Counterparties never see the owner's number; identity requests refused and reported; secrets only in the service; row-level security on every mini-app read |
| Scope: ten Elves and eight pages | High | Nothing finishes well | The gates; no mini app without a writer; every external system behind a fake so phases demo independently |

**Asks for Photon:**

- [ ] On the 2.0 API: how do we send screen effects, rename a group chat, request Find My location, and send app cards? The marketing page lists them for iMessage; the `2026-07-01` OpenAPI spec does not expose them. Is there a newer API version or a dashboard-only path?
- [ ] Dedicated iMessage line: cost in credits for the weekend, and whether group spaces work on the shared pool
- [ ] Confirmation that `format` on text content accepts markdown (or which formats it accepts), and that links unfurl to rich previews on iMessage
- [ ] Quota for new conversations and messages per line during turnover week
- [ ] Voice: whether the 740 line's voice profile can point at Retell's SIP endpoint directly, and whether call events (`call.started`, `call.ended`) carry the remote number
- [ ] Their view of the primitive-to-moment map: which 2.0 features they most want to see demoed, and the judging rubric from the guidelines page

**Asks for the Capital One booth:**

- [ ] Nessie API key and any rate limits for the weekend
- [ ] Whether escrow modeled as a savings account plus transfers reads as a "creative use" to their judges

**Open questions for the team:**

- [ ] Final name: Elves, or something else; the chat avatar, Elf contact cards and mini-app branding all derive from it
- [ ] Owners per phase and per Elf; who holds the Photon, Supabase, ElevenLabs and Daytona accounts
- [ ] Does Devpost allow tagging both Sustainability and Fintech-CyberSec? If not, Sustainability
- [ ] Which neighborhoods the Curb Map launches in first (Allston and the NYU area are the obvious two)
- [ ] Whether the walkthrough-video Inventory runs on a hosted vision model or a Daytona job; decide on cost and latency
- [ ] Who owns the ASUS content post

## Sources

- [HackHarvard 2026 challenges and schedule](https://hhuh.io/)
- [Photon skills repo, spectrum and photon-cli](https://github.com/photon-hq/skills)
- [Photon docs index](https://photon.codes/docs/llms.txt)
- [Photon app cards](https://photon.codes/docs/spectrum-ts/content/app)
- [Photon iMessage provider: lines, quotas, effects](https://photon.codes/docs/spectrum-ts/providers/imessage)
- [Photon Find My locations](https://photon.codes/docs/advanced-kits/imessage/locations)
- [Photon voice over SIP](https://photon.codes/docs/spectrum-ts/providers/voice)
- [Photon + Retell cookbook](https://photon.codes/docs/beta/cookbooks/voice/retell)
- [Retell vs ElevenLabs comparison, Sep 2026](https://www.getmacha.com/blog/retell-ai-vs-elevenlabs)
- [Photon message-handling architecture](https://photon.codes/docs/best-practices/architecture)
- [Nessie API](https://nessieisreal.com/)
- [CBS Boston: Allston Christmas trash and mattress counts (Aug 2023)](https://www.cbsnews.com/boston/news/allston-christmas-moving-apartments-trash-furniture-mattresses/)
- [FTC Rental Scams Spotlight 2025 (PDF)](https://search.ftc.gov/system/files/ftc_gov/pdf/rental-scams-spotlight-2025.pdf)

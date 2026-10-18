/* Everything the page says that is not layout: the conversations the emulator plays, the agents' lists, the tracks.
   Conversations mirror the product's real reply formats (header line with the Elf's emoji and name, short blocks).
   They are example conversations, labelled as such on the page. */

window.SITE = {
  // Fill these in; the page renders sensible empty states until you do.
  number: "", // e.g. "+1 628 997 9661", shown in "Demo time" and "Try it" when set
  interviewYouTubeId: "h2k7D7NcFDU", // the interview Short (youtube.com/shorts/h2k7D7NcFDU)
  nightPhotos: [], // e.g. ["assets/night/1.jpg", "assets/night/2.jpg"]; they scroll in the strips
  nightCaptions: [], // optional, one per photo, e.g. ["Fri 11pm", "Sat 3am"]
  // Team portraits for "Text the crew": drop photos into assets/team/ and list them here (photo is optional).
  team: [
    { name: "Gavin Zhou", role: "", photo: "" },
    { name: "Arshiya Sharma", role: "", photo: "" },
    { name: "Zohaib Shaikh", role: "", photo: "" },
    { name: "Yashashri G.", role: "", photo: "" },
  ],
  interviews: 15,
  waitlist: "30+",
  repoUrl: "https://github.com/arshiyasharma/hackharvard",
};

window.AGENTS = {
  crew: { name: "Crew Lead", emoji: "🧭", tone: "ink", blurb: "Meets you, listens to the whole move, and sends each text to the right Elf. Asks when it isn't sure." },
  home: { name: "Home Elf", emoji: "🏠", tone: "green", blurb: "Finds the next place, a hotel for the gap or storage. Sublets the old one. Keeps the move-in checklist." },
  stuff: { name: "Stuff Elf", emoji: "📦", tone: "amber", blurb: "Prices things from a photo, deals with buyers, never under your lowest price. Runs Last Call and donations." },
  money: { name: "Money Elf", emoji: "💸", tone: "lime", blurb: "Keeps the ledger in Nessie. Splits, deposits, escrow. Then plans the rest of your move, with odds." },
};

/* A message: { from: "you" | "elf", agent, text, img?, wait? }.  img: couch | room | ledger | plans | dash */
window.SCENES = [
  /* ---------------- Crew Lead ---------------- */
  {
    id: "crew-intro", agent: "crew", title: "Meets the crew",
    line: "First text: exactly what the crew can and can't do.",
    msgs: [
      { from: "you", text: "hi" },
      { from: "elf", agent: "crew", text: "Hey, I'm the Crew Lead at Elves, your moving crew. Here's what we can do:\n\n🏠 Home: find a place, sublet yours, move-in checklist\n📦 Stuff: price, sell, donate\n💸 Money: split costs, escrow, plan your budget" },
      { from: "elf", agent: "crew", text: "🚫 The crew can't book trucks or movers, read leases, or pay rent.\n\nText STATUS anytime to see where everything stands, DASHBOARD to see your money, or HELP to see all your options." },
    ],
  },
  {
    id: "crew-brief", agent: "crew", title: "Onboarding: the brief",
    line: "Tell the whole move in your own words. It plays it back.",
    msgs: [
      { from: "you", text: "out of my Allston place Nov 1, hard date, into Somerville but nothing found yet, selling the couch and desk, keeping the bed, Sam has a car" },
      { from: "elf", agent: "crew", text: "Here's what I've got:\nOut of Allston Nov 1 (hard date). Into Somerville, no place yet. Couch and desk go, bed stays. Sam can drive.\n\nStill TBD: your budget, the lease.\n\nReply yes to lock it in, or tell me what to change." },
      { from: "you", text: "yes" },
      { from: "elf", agent: "crew", text: "✅ Locked in. Here's who's on what:\n\n🏠 Home: find you a place in Somerville\n📦 Stuff: price the couch and desk\n💸 Money: keep the ledger" },
      { from: "elf", agent: "money", text: "I've set up your Moving Ledger in Nessie. Every dollar of the move goes on it, and nothing moves without your yes.\n\nWhat's your budget for the rest of the move?" },
    ],
  },
  {
    id: "crew-refuse", agent: "crew", title: "Says no, and what it can do",
    line: "Refusals name the closest thing it can do.",
    msgs: [
      { from: "you", text: "can you book me a u-haul for saturday" },
      { from: "elf", agent: "crew", text: "🚫 The crew can't book trucks, U-Hauls or movers.\n\nI can find storage for the gap, or split the truck cost with your roommates once you've booked it." },
    ],
  },
  {
    id: "crew-ask", agent: "crew", title: "Asks instead of guessing",
    line: "Two Elves fit? It asks, then sends your words to the one you pick.",
    msgs: [
      { from: "you", text: "my deposit for the apartment" },
      { from: "elf", agent: "crew", text: "I can take that two ways:\n\n1. Money Elf: splitting costs, deposits, who owes what\n2. Home Elf: finding or subletting a place, your move checklist\n\n❓ Which did you mean? Reply 1 or 2, or say it another way." },
      { from: "you", text: "1" },
      { from: "elf", agent: "money", text: "I'll log that deposit on the Ledger.\n\n❓ How much was it, and when is it due back?" },
    ],
  },
  {
    id: "crew-status", agent: "crew", title: "STATUS",
    line: "One block per Elf, read straight off the store.",
    msgs: [
      { from: "you", text: "STATUS" },
      { from: "elf", agent: "home", text: "📋 STATUS\n\n🗓 Dates\nOut Nov 1 from Allston\nIn Nov 3 at 12 Elm St\n\n🏠 Home\nChecklist: 1 to go\n  • Keys: pick up on Nov 3\n  ✅ Done: Internet\n\n📦 Stuff\nListed: couch\nSold: desk\n\n💸 Money\n$60 held in escrow\n\n⏳ Waiting on your yes\nA viewing Fri 6pm: reply yes or no" },
    ],
  },
  {
    id: "crew-both", agent: "crew", title: "Two Elves, one text",
    line: "The Crew Lead calls Stuff, then Home, on the same text.",
    msgs: [
      { from: "you", text: "sell my desk and find me storage for june" },
      { from: "elf", agent: "stuff", text: "📦 Stuff Elf\n\nGot the desk. Send me a photo and the lowest you'd take." },
      { from: "elf", agent: "home", text: "🏠 Home Elf\n\nStorage for June. What's your budget per month, and which area?" },
    ],
  },

  /* ---------------- Home ---------------- */
  {
    id: "home-hunt", agent: "home", title: "Find a place",
    line: "A real browser searches Craigslist and Airbnb. Scams get flagged.",
    msgs: [
      { from: "you", text: "find me a room in allston under 1200 june 1 to aug 30" },
      { from: "elf", agent: "home", text: "🏠 Home Elf\n\nOn it. Checking Craigslist and Airbnb for a room in Allston under $1,200…" },
      { from: "elf", agent: "home", text: "Top 3:\n\n1. Sunny room near Harvard Ave, $1,100\n2. Room in a 3-bed, $1,050, flagged: asks for a wire first\n3. Furnished room, $1,150\n\nReply 2 for details, more for the next three, or reach out to 3." },
    ],
  },
  {
    id: "home-viewing", agent: "home", title: "Never books a viewing without you",
    line: "The applicant's pick is held until you say yes.",
    msgs: [
      { from: "elf", agent: "home", text: "🏠 Home Elf\n\nThe applicant for the room ($1,400/mo) wants a viewing Thu 6pm.\n\n❓ Book it? Reply yes or no." },
      { from: "you", text: "yes" },
      { from: "elf", agent: "home", text: "Booked: Thu 6pm. I'll remind them." },
    ],
  },
  {
    id: "home-sublet", agent: "home", title: "Sublet your room",
    line: "Reads room photos, writes the post. You paste it.",
    msgs: [
      { from: "you", text: "sublet my room for $1500" },
      { from: "elf", agent: "home", text: "🏠 Home Elf\n\nWhat dates, and which area?" },
      { from: "you", text: "Jun 1 to Aug 30, Allston", img: "room" },
      { from: "elf", agent: "home", text: "Here's your post to put up yourself:\n\nSunny furnished room, Allston. $1,500/mo, Jun 1 to Aug 30. Text +1 628… and mention K7Q2.\n\nSay change… to redraft, or post it when it's up." },
    ],
  },
  {
    id: "home-movein", agent: "home", title: "Move-in checklist",
    line: "Dated tasks that remind you as they come due.",
    msgs: [
      { from: "you", text: "set up internet at the new place" },
      { from: "elf", agent: "home", text: "🏠 Home Elf\n\nWhat day do you move in?" },
      { from: "you", text: "nov 3, 12 Elm St" },
      { from: "elf", agent: "home", text: "Your move-in checklist:\n\n• Electric, gas, internet: Oct 24\n• Renters insurance, USPS address change: Oct 27\n• Keys and condition report: Nov 3\n\nSay done with internet, skip insurance, or what's left." },
    ],
  },

  /* ---------------- Stuff ---------------- */
  {
    id: "stuff-sell", agent: "stuff", title: "Photo to listing",
    line: "Sees the couch, prices it, keeps your floor private.",
    msgs: [
      { from: "you", text: "lowest I'd take is $60", img: "couch" },
      { from: "elf", agent: "stuff", text: "📦 Stuff Elf\n\nCream loveseat, good condition. Fair range $240 to $320. I'd list it at $290 and never go under $60.\n\n❓ Want me to list it? Reply yes." },
      { from: "you", text: "yes, list it" },
      { from: "elf", agent: "stuff", text: "Here's your line to post:\n\nCream loveseat, $290. Text +1 628… and mention N9D3." },
    ],
  },
  {
    id: "stuff-deal", agent: "stuff", title: "Buyer talks, you decide",
    line: "Counters at your floor. Only asks you when it has to.",
    msgs: [
      { from: "elf", agent: "stuff", text: "📦 Stuff Elf\n\nA buyer offers $50 for the couch (your floor $60; I'm holding at $60).\n\n❓ Take $50? Reply yes, no, or a number." },
      { from: "you", text: "$55" },
      { from: "elf", agent: "stuff", text: "Countered at $55. I'll tell you if they agree." },
      { from: "elf", agent: "stuff", text: "Booked: buyer picks up the couch Sat 10am for $55." },
    ],
  },
  {
    id: "stuff-lastcall", agent: "stuff", title: "Last Call",
    line: "Prices drop on a schedule, and each text says why.",
    msgs: [
      { from: "elf", agent: "stuff", text: "📦 Stuff Elf\n\nMove-out is in about 38 hours, so I cut the armchair by 40%, from $35 to $21.\n\nReply keep the armchair to hold this price, or donate the armchair." },
      { from: "you", text: "donate the armchair" },
      { from: "elf", agent: "stuff", text: "Taken off the listings and marked donated.\n\nPickups near Allston: Boston 311 bulk pickup, Salvation Army, Goodwill, Habitat ReStore. Here's a request to forward:\n\n“Hi, I'm moving out on Nov 1 and would like to donate an armchair…”" },
    ],
  },
  {
    id: "stuff-report", agent: "stuff", title: "Move Report",
    line: "Pounds kept out of the landfill, CO2e avoided.",
    msgs: [
      { from: "you", text: "what did we keep out of the landfill?" },
      { from: "elf", agent: "stuff", text: "📦 Stuff Elf\n\n🌱 Move Report\n\nKept out of the landfill: 148 lb\nCO2e avoided: about 190 kg\nMoney recovered: $215\nStill open: 1 item\n\nCO2e uses EPA WARM factors, approximate." },
    ],
  },
  {
    id: "stuff-shield", agent: "stuff", title: "Scam Shield",
    line: "Off-escrow payment asks end the conversation.",
    msgs: [
      { from: "elf", agent: "stuff", text: "📦 Stuff Elf\n\n🚫 A buyer asked to pay with gift cards, so I ended the conversation.\n\nI told them escrow only. Nothing was sent and your floor was never shown." },
    ],
  },

  /* ---------------- Money ---------------- */
  {
    id: "money-split", agent: "money", title: "Split a cost",
    line: "Adds to the penny. Sends requests only after your yes.",
    msgs: [
      { from: "you", text: "split the $240 truck with Sam and Priya" },
      { from: "elf", agent: "money", text: "💸 Money Elf\n\nTruck $240 split: you $80, Sam $80, Priya $80.\n\n❓ Want me to send the 2 requests? Reply yes." },
      { from: "you", text: "yes" },
      { from: "elf", agent: "money", text: "✅ Sent. I'll tell you when each one pays.\n\nDashboard: your live ledger link" },
    ],
  },
  {
    id: "money-deposit", agent: "money", title: "Deposits, counted once",
    line: "Say it twice, it's still one deposit.",
    msgs: [
      { from: "you", text: "I paid a $500 sublet deposit, due back Dec 1" },
      { from: "elf", agent: "money", text: "💸 Money Elf\n\n✅ Logged your $500 sublet deposit.\n\nI'll remind you if it isn't back by 2026-12-01." },
      { from: "you", text: "I paid a $500 sublet deposit" },
      { from: "elf", agent: "money", text: "That $500 sublet deposit is already on the Ledger, so I didn't add it again." },
      { from: "you", text: "got all my deposits back" },
      { from: "elf", agent: "money", text: "Nice, the $500 sublet deposit is back. Marked it on the Ledger." },
    ],
  },
  {
    id: "money-pay", agent: "money", title: "Pay a roommate back",
    line: "From the Moving Fund, in Nessie, after one yes.",
    msgs: [
      { from: "you", text: "pay Sam $40 for gas" },
      { from: "elf", agent: "money", text: "💸 Money Elf\n\n❓ Pay Sam $40 for gas from the Moving Fund? Reply yes to send it." },
      { from: "you", text: "yes" },
      { from: "elf", agent: "money", text: "✅ Paid Sam $40. It's on the ledger in Nessie." },
    ],
  },
  {
    id: "money-escrow", agent: "money", title: "Escrow for a sale",
    line: "Held until pickup, released on two signals.",
    msgs: [
      { from: "elf", agent: "money", text: "💸 Money Elf\n\n❓ A buyer agreed $60 for the couch. Hold their payment in escrow until pickup? Reply yes." },
      { from: "you", text: "yes" },
      { from: "elf", agent: "money", text: "✅ $60 is in escrow. The buyer confirmed pickup, so I'm releasing it into your Moving Fund once you say yes." },
    ],
  },
  {
    id: "money-plan", agent: "money", title: "Smart Plan",
    line: "Three plans, 2,000 simulated moves each, with your odds.",
    msgs: [
      { from: "you", text: "smart plan" },
      { from: "elf", agent: "money", text: "💸 Money Elf\n\nHere are three ways to finish the move, built around a $300 budget:\n\nA · best odds · $190 · 92% under $300\nB · runner-up · $235 · 82% under $300\nC · least effort · $285 · 56% under $300\n\nReply A, B or C to pick one.", img: "plans" },
      { from: "you", text: "go with B" },
      { from: "elf", agent: "money", text: "On plan B: $235, 82% under $300.\n\nWritten to Nessie as 3 pending records. Nothing moves until it happens.\n\nDashboard: your live ledger link" },
    ],
  },
  {
    id: "money-ledger", agent: "money", title: "Ledger and dashboard",
    line: "A picture in the thread and a link that never expires.",
    msgs: [
      { from: "you", text: "DASHBOARD" },
      { from: "elf", agent: "money", text: "📋 Your money, live from Nessie: $740 out, $33 back, $593 expected.", img: "ledger" },
      { from: "elf", agent: "money", text: "Dashboard: your live ledger link" },
    ],
  },
  {
    id: "money-refuse", agent: "money", title: "Says no to rent",
    line: "Won't pay rent, move money to a bank, invest or do taxes.",
    msgs: [
      { from: "you", text: "pay my rent" },
      { from: "elf", agent: "money", text: "🚫 I can't pay rent, bills or a landlord.\n\nI can split a cost, pay a roommate from the Moving Fund, log a deposit, plan the rest of the move, or hold sale money in escrow." },
    ],
  },
];

/* What each agent will not do */
window.WONT = {
  crew: ["Book trucks, U-Hauls or movers", "Plan the route or run move day", "Give legal or financial advice", "Do anything not about the move"],
  home: ["Book a viewing without your yes", "Read your lease or contact your landlord", "Post a listing for you"],
  stuff: ["Go under your lowest price", "Post to Marketplace for you", "Reveal your floor to a buyer"],
  money: ["Move money without your yes", "Pay rent, bills or a landlord", "Move money to or from a bank", "Invest or do taxes"],
};

/* What the crew does, for the scroll story */
window.STORY = {
  crew: { name: "Crew Lead", tasks: ["Listens to the whole move", "Sends each text to the right Elf", "Asks when it isn't sure"], head: "One number. One Crew Lead.", sub: "It listens, plans the brief, and decides who handles what." },
  home: { name: "Home Elf", tasks: ["Finds a place, a hotel, storage", "Sublets yours, writes the post", "Keeps the move-in checklist"], head: "Home Elf finds the place.", sub: "A real browser searches the sites for you, and flags the scams." },
  stuff: { name: "Stuff Elf", tasks: ["Prices a couch from a photo", "Negotiates, never under your floor", "Drops prices, then donates"], head: "Stuff Elf sells it all.", sub: "Buyers text it. You only hear about it when it matters." },
  money: { name: "Money Elf", tasks: ["Splits costs, pays roommates", "Escrow and the ledger in Nessie", "Plans your budget, with odds"], head: "Money Elf keeps it straight.", sub: "Every dollar is a Nessie record. Nothing moves without your yes." },
  end: { head: "Four agents. One thread.", sub: "Nothing happens without your yes." },
};

window.CHIPS = [
  { t: "Craigslist", c: "#5A2D82", l: ["Room in Allston $1,150", "no photos, wire a deposit?"] },
  { t: "Airbnb", c: "#FF5A5F", l: ["June 1 to Aug 30", "$1,480 + cleaning fee"] },
  { t: "Zillow", c: "#006AFF", l: ["Studio, Somerville", "saved 14 listings"] },
  { t: "Booking.com", c: "#003B95", l: ["Hotel for the gap", "2 nights, nov 1"] },
  { t: "SpareFoot", c: "#00A859", l: ["10x10 unit $119/mo", "compare 6 more"] },
  { t: "U-Haul", c: "#E5701C", l: ["15 ft truck", "Saturday: sold out"] },
  { t: "Marketplace", c: "#0866FF", l: ["Couch, still available?", "is $50 ok??"] },
  { t: "Gmail", c: "#EA4335", l: ["Re: Re: lease?", "Fwd: deposit", "Landlord: notice"] },
  { t: "move budget FINAL v3", c: "#188038", l: ["truck ??", "deposit 400", "who paid gas"] },
  { t: "Notes", c: "#F5B800", l: ["call landlord", "sell couch??", "utilities!!"] },
  { t: "Group chat", c: "#34C759", l: ["who has the car", "can't Saturday", "??"] },
  { t: "Utilities", c: "#0B5BD3", l: ["Electric: set up", "Internet: hold 40 min"] },
  { t: "311 bulk pickup", c: "#1F4E8C", l: ["Request form", "pickup in 3 weeks"] },
  { t: "Apartments.com", c: "#0B5BD3", l: ["Sort by price", "scam?"] },
  { t: "Venmo", c: "#3D95CE", l: ["You owe Priya $33.33", "Sam: pay me back"] },
  { t: "Facebook groups", c: "#0866FF", l: ["Sublet Allston 2026", "DM me for the room"] },
  { toast: true, t: "Sam", s: "who's paying for the truck??" },
  { toast: true, t: "Craigslist", s: "3 new replies (2 look like scams)" },
  { toast: true, t: "Landlord", s: "Move-out inspection Friday" },
  { toast: true, t: "Mom", s: "did you find a place yet" },
  { toast: true, t: "Zelle", s: "Payment request: $240" },
  { toast: true, t: "Calendar", s: "Keys due in 3 days" },
  { toast: true, t: "Priya", s: "can I get the lamp?" },
  { toast: true, t: "Reminder", s: "Cancel the internet!!" },
];

/* One track at a time. Each tile: short title, one line, and a "more" that opens on tap. */
window.TRACKS = [
  {
    id: "photon", name: "Photon", scene: "crew-brief",
    why: "Every part of Elfie is a Photon feature: one number, four agents, voice, pictures.",
    tiles: [
      { k: "Agents", t: "Four agents, one thread", s: "It looks like one chat. It is a crew.", more: "Crew Lead, Home, Stuff and Money are separate agents with their own tools, rules and memory behind one Photon number. They call each other when one text needs two, and a router asks you when it is not sure which one you meant." },
      { k: "Photon 2.0", t: "The whole 2.0 surface", s: "REST, Socket.IO, attachments, polls, receipts.", more: "Inbound over the Socket.IO event stream with cursor replay (and a slow poll as a safety net). Replies go out as the agent identity each person texted, with idempotency keys so a replay never double-sends. Read receipts and typing wrap every model call; polls carry the action id so a stale tap is rejected." },
      { k: "Pictures", t: "Mini apps don't work on 2.0", s: "So we drew pictures. After hours of tests.", more: "Photon 2.0 has no app card. We tried Photon 1.0 Spectrum cards: a second number, registered users only, and a second app to open. After hours of experiments we shipped the ledger, the plans and the Move Report as images drawn on the server (SVG to PNG), sent in the thread, with a never-expiring link to a live page behind each one." },
      { k: "Voice", t: "A call that remembers", s: "Retell on the Photon line, then a recap text.", more: "The Crew Lead's onboarding call runs on the Photon phone line through Retell. When the call ends, the webhook writes the same memory a text writes (dates, items, facts, a note for every Elf), and a recap text arrives in the thread. The call and the chat are one conversation." },
      { k: "Skills", t: "We taught our tools Photon", s: "Project skills, checked against the live spec.", more: "The 2.0 docs were still being written, so we verified against the live OpenAPI spec and saved it as project skills (photon, run-elves-on-phone). Three people building in parallel never coded against a feature 2.0 does not have." },
      { k: "Trust", t: "A human in every loop", s: "One yes approves exactly one action.", more: "Viewings, escrow holds, releases, refunds, payments, plans: each waits for a yes by text, a poll tap or a dashboard button. A 👍 counts as yes. A stale or repeated tap changes nothing." },
      { k: "Fallbacks", t: "Built for the shared pool", s: "Polls refused? Reply yes. Threads refused? Flat.", more: "The shared iMessage pool refuses polls, reactions and threaded replies. Every feature has a text fallback, the transport remembers which spaces refuse, and a missing model key falls back to deterministic replies." },
      { k: "Context", t: "One move across every channel", s: "Text, call, web page, buyers, roommates.", more: "Working memory is rebuilt every turn from the move, items, board and brief. A rolling transcript summary, deduplicated facts with audience scoping, and per-Elf notes follow the move across the thread, the phone call and the dashboard." },
    ],
    apis: ["Photon 2.0 REST", "Socket.IO events", "Attachments", "Polls", "Read receipts + typing", "Reactions", "SMS line", "Retell voice", "Claude", "Nessie"],
  },
  {
    id: "nessie", name: "Nessie", scene: "money-plan",
    why: "Nessie is not our bank, it is our ledger and our crystal ball.",
    tiles: [
      { k: "Ledger", t: "Every dollar is a Nessie record", s: "Totals are read back, never remembered.", more: "Splits, deposits, payments, escrow and sales are tagged Nessie records in a Moving Fund account and an Escrow account per move. The dashboard re-reads Nessie every five seconds, and every row opens its record id." },
      { k: "Roommates", t: "Splits, plans, paybacks", s: "To the penny, with one yes each.", more: "$100 three ways is $33.34, $33.33, $33.33. A roommate can pay a truck off at $40 a month as a Moving Fund loan. Paying someone back comes out of the Moving Fund after a yes. Paying more than owed counts only what was owed." },
      { k: "Deals", t: "Negotiation becomes the ledger", s: "Agreed price opens escrow; pickup releases it.", more: "The deal engine holds your floor and counters buyers. When a price is agreed it opens an escrow hold; two signals (your yes and the buyer's confirmation) release it into the Moving Fund; a no-show past 24 hours is refunded after your yes." },
      { k: "Last Call", t: "Prices fall on a schedule", s: "20% at 72 hours, 25% more at 48, free at 24.", more: "Unsold items get cheaper as move-out nears so they actually leave. Each cut is texted with the percent, the old and new price and the hours left. What sells lands in the ledger as money in." },
      { k: "Budget", t: "Set a budget, get odds", s: "Three plans, 2,000 simulated moves each.", more: "The Money Elf asks your budget the moment the ledger is set up. Each plan (what to sell and when to drop it, donate or haul, truck size, movers or not) is simulated 2,000 times and shows a likely cost, a 10 to 90% band and your odds of finishing under budget." },
      { k: "Smart Plan", t: "The plan lives in Nessie", s: "Pending, future-dated records that settle.", more: "The plan you pick is written to Nessie as pending deposits and withdrawals with future dates, and they complete or cancel as items sell. We verified live that Nessie accepts pending status and settles it with a PUT. Plan records never count toward totals." },
      { k: "Dashboard", t: "Expected vs net cost, live", s: "Your real spend drawn over the plan's range.", more: "Overview shows net cost so far and where it lands. The Smart Plan tab draws the plan's band with your real net cost over it day by day. Coming back is a what-if for money still owed. Activity lists every Nessie movement." },
    ],
    apis: ["Customers", "Accounts", "Purchases", "Deposits", "Withdrawals", "Merchants", "Pending to completed", "Tagged records", "Read-back"],
  },
  {
    id: "sustain", name: "Sustainability", scene: "stuff-lastcall",
    why: "Nobody should throw a good couch in the street because they ran out of time.",
    tiles: [
      { k: "Problem", t: "Allston Christmas", s: "38 tons of trash, 1,700 mattresses, one week.", more: "About two-thirds of Boston leases turn over on September 1. In one week of 2023 the city collected 38 extra tons of trash and 1,700 mattresses. Most of it was usable. People did not want to waste it; they ran out of time, hands and a plan." },
      { k: "Plan", t: "A plan for every item", s: "Sell, donate, keep, or undecided. At the start.", more: "The first conversation asks what goes and what has to go, so nothing is left for the last night. The Smart Plan includes donate-or-haul as options, so the plan itself favors reuse when it is cheaper." },
      { k: "Last Call", t: "Prices drop, things leave", s: "20% at 72 h, 25% more at 48 h, free at 24 h.", more: "Each cut is texted with how much and why, and offers keep or donate. Buyers already talking get the new price and the ref code. At move-out anything still open is marked dumped, and that counts against the report." },
      { k: "Donate", t: "Donate in one text", s: "Listing off, pickups found, request drafted.", more: "\"Donate the lamp\" takes the listing down at once and marks it donated, then lists pickups near you (Boston 311 bulk pickup, Salvation Army, Goodwill, Habitat ReStore) and drafts the request for you to send." },
      { k: "Reuse", t: "Give free, buy used", s: "Free listings, and a forwarded link to buy.", more: "\"Give away the bookshelf\" lists it free. Forward a used listing with a max price and Elfie opens a buying deal with your ceiling as the limit." },
      { k: "Proof", t: "Move Report", s: "Pounds kept out, CO2e avoided, dollars back.", more: "A report in one text: pounds diverted, kg CO2e avoided using EPA WARM v13 source-reduction factors (mapped by category and labeled approximate), money recovered, and items still open. Dumped items count against the total, so it stays honest." },
    ],
    apis: ["EPA WARM v13", "Boston 311", "Goodwill", "Salvation Army", "Habitat ReStore"],
  },
  {
    id: "cyber", name: "Cybersec and Fintech", scene: "home-viewing",
    why: "An AI that touches money and strangers has to say no, ask first and spot the scam.",
    tiles: [
      { k: "Acceptance", t: "Nothing without your yes", s: "A viewing is held until you approve it.", more: "An applicant picks a time and you get \"Book it? yes or no.\" Only yes books it. The same gate sits on escrow holds, releases, refunds, payments, split requests and plans, and one yes applies to exactly one action." },
      { k: "Refusal", t: "It says no, out loud", s: "No rent, no bank moves, no lease reading.", more: "It won't book trucks or movers, read leases, contact landlords, post for you, pay rent or bills, move money to or from a bank, invest, do taxes or give legal or financial advice. Every refusal names the closest thing it can do. One list in code feeds every prompt, so refusals never drift." },
      { k: "House hunt", t: "Scam flags on every listing", s: "Price, payment asks, 'I'm abroad', no photos.", more: "Rules run on raw search results: price under half the median, wire or gift-card or app payment before a viewing, 'I'm abroad' stories, no location, no photos, the same title at a different price elsewhere. Hard flags sink a listing out of the top three." },
      { k: "Scam Shield", t: "Off-escrow asks end the chat", s: "Gift cards, checks, codes, overpayments.", more: "A buyer who asks to pay outside escrow is told escrow only. Gift cards, cashier's checks, money orders, verification codes and overpayments end the conversation and tell the owner. There is also an on-demand scam check." },
      { k: "Privacy", t: "Your floor never leaves your chat", s: "Buyers never see your lowest price.", more: "The engine counters at the floor and asks you before going below it, in code. Card and bank numbers in a text are refused and never stored or repeated." },
      { k: "Fintech", t: "Escrow, signed links, safe failure", s: "Two-signal release, live Nessie reads.", more: "Escrow releases on two signals; refunds need your yes. The dashboard is a signed HMAC link with no personal data in the URL (a wrong token is a 404). Approvals are idempotent, a stale one is rejected, and if Nessie is unreachable nothing is half-written." },
    ],
    apis: ["Escrow", "HMAC-signed links", "Idempotency keys", "Scam rules", "Scam Shield", "Floor privacy"],
  },
];

/* Every API and service in the project, searchable. */
window.STACK = [
  // Messaging
  { n: "Photon 2.0 REST API", c: "Messaging", w: "iMessage and SMS: text, images, polls, reactions, typing, read receipts", p: "packages/photon" },
  { n: "Photon 2.0 Socket.IO events", c: "Messaging", w: "Inbound stream with cursor replay and a poll safety net", p: "packages/photon" },
  { n: "Photon shared iMessage pool", c: "Messaging", w: "Three real phones assigned; operator CLI manages assignments", p: "scripts/photon.ts" },
  { n: "Photon dedicated line", c: "Messaging", w: "Tapbacks, threads, texting a lister first", p: "packages/photon" },
  { n: "Photon SMS and voice line", c: "Messaging", w: "Carries the phone call and SMS", p: "packages/voice" },
  { n: "Photon attachments", c: "Messaging", w: "Download HEIC photos, upload PNG cards", p: "packages/photon" },
  { n: "Photon idempotency keys", c: "Messaging", w: "A replay never double-sends", p: "packages/pipeline" },
  { n: "Photon 1.0 Spectrum", c: "Messaging", w: "App cards; evaluated, shelved (2.0 has no app card)", p: "packages/money-elf/src/spectrum.ts" },
  { n: "socket.io-client", c: "Messaging", w: "Photon event stream client", p: "packages/photon" },
  // Voice
  { n: "Retell AI", c: "Voice", w: "The Crew Lead's onboarding phone call", p: "packages/voice" },
  { n: "Retell webhook (signed)", c: "Voice", w: "call_ended and submit_brief write the call into memory", p: "packages/voice" },
  { n: "Retell mock call CLI", c: "Voice", w: "Sends a signed fake webhook for testing", p: "scripts/mock-call.ts" },
  // AI
  { n: "Anthropic Claude API", c: "AI", w: "Routing, extraction, drafting, vision", p: "packages/llm" },
  { n: "Claude Haiku 5.5", c: "AI", w: "Fast model: routing, extraction, ranking", p: "packages/llm" },
  { n: "Claude Sonnet 5.5", c: "AI", w: "Smart model: drafting and vision", p: "packages/llm" },
  { n: "Claude vision", c: "AI", w: "Couch photo to price; room photos to a sublet post", p: "packages/elves" },
  { n: "heif2jpeg", c: "AI", w: "iPhone HEIC photos to JPEG for vision", p: "packages/llm" },
  { n: "Zod structured outputs", c: "AI", w: "Typed model replies and webhook validation", p: "all packages" },
  { n: "Onboarding eval (simulated owners)", c: "AI", w: "Scores prompt variants against three simulated owners", p: "scripts/onboarding-eval.ts" },
  // Money
  { n: "Capital One Nessie API", c: "Money", w: "The ledger: customers, accounts, purchases, deposits, withdrawals", p: "packages/money-elf" },
  { n: "Nessie pending and settle", c: "Money", w: "Smart Plan records, future-dated, settled with PUT", p: "packages/money-elf/src/plan-service.ts" },
  { n: "Moving Fund and Escrow accounts", c: "Money", w: "Two Nessie accounts per move", p: "packages/money-elf" },
  { n: "Smart Plan simulator", c: "Money", w: "Seeded Monte Carlo, 2,000 runs per plan", p: "packages/money-elf/src/plans.ts" },
  // Data
  { n: "Supabase Postgres", c: "Data", w: "Store, memory, deals, Money state, plans", p: "packages/db" },
  { n: "Bun.sql", c: "Data", w: "Postgres with no driver dependency", p: "packages/db" },
  { n: "SQL migrations (11)", c: "Data", w: "Run on boot under an advisory lock", p: "packages/db/migrations" },
  { n: "Postgres full-text search", c: "Data", w: "Ranks remembered facts", p: "packages/memory" },
  { n: "Docker Postgres", c: "Data", w: "Same tests against a real database", p: "bun run test:pg" },
  // Browser and sources
  { n: "Browserbase", c: "Housing search", w: "Hosted Chrome, persistent logins, live view", p: "packages/listings" },
  { n: "Stagehand v4", c: "Housing search", w: "Browser automation and page extraction", p: "packages/listings" },
  { n: "Craigslist", c: "Housing search", w: "Rooms and sublets", p: "packages/listings/src/recipes" },
  { n: "Airbnb", c: "Housing search", w: "Short stays for the gap", p: "packages/listings/src/recipes" },
  { n: "Booking.com", c: "Housing search", w: "Hotels for the gap", p: "packages/listings/src/recipes" },
  { n: "SpareFoot", c: "Housing search", w: "Storage units by monthly price", p: "packages/listings/src/recipes" },
  { n: "Apartments.com", c: "Housing search", w: "Apartment listings", p: "packages/listings/src/recipes" },
  { n: "Zillow", c: "Housing search", w: "Rental listings", p: "packages/listings/src/recipes" },
  { n: "Facebook (logged-in context)", c: "Housing search", w: "Sublet groups, via a saved browser login", p: "packages/listings/src/recipes" },
  // Hosting
  { n: "Railway", c: "Hosting", w: "Production host with a /health check", p: "railway.json" },
  { n: "Docker (oven/bun slim)", c: "Hosting", w: "One image, migrations on boot", p: "Dockerfile" },
  { n: "GitHub", c: "Hosting", w: "Branches per agent, merged into team-stable", p: "repo" },
  { n: "Hono", c: "Hosting", w: "HTTP server: health, Crew Board, dashboard, webhook", p: "apps/elves" },
  // Runtime
  { n: "Bun", c: "Runtime", w: "Runtime, package manager, test runner", p: "everywhere" },
  { n: "TypeScript 5.9", c: "Runtime", w: "One typed monorepo, a package per agent", p: "everywhere" },
  { n: "Biome", c: "Runtime", w: "Lint and format", p: "biome.json" },
  // Images
  { n: "resvg-js", c: "Pictures", w: "SVG to PNG for the ledger, plan and report cards", p: "packages/money-elf" },
  { n: "Inter (Expo Google Fonts)", c: "Pictures", w: "Fonts bundled so images match on any server", p: "packages/money-elf" },
  { n: "Server-drawn SVG", c: "Pictures", w: "Cards and charts, no mini app needed", p: "packages/money-elf" },
  // Data sources
  { n: "EPA WARM v13", c: "Sustainability data", w: "CO2e avoided per pound reused", p: "packages/elves/src/impact.ts" },
  { n: "Boston 311 bulk pickup", c: "Sustainability data", w: "Donation pickup option", p: "packages/elves" },
  { n: "Salvation Army, Goodwill, Habitat ReStore", c: "Sustainability data", w: "Donation options in the drafted request", p: "packages/elves" },
  { n: "FTC Consumer Sentinel", c: "Sustainability data", w: "Rental scam research behind Scam Shield", p: "SPEC.md" },
  // Built by us
  { n: "Deal Engine", c: "Built by us", w: "Negotiation, shared calendar, Scam Shield, Last Call sweep", p: "packages/engine" },
  { n: "Memory", c: "Built by us", w: "Working memory, transcript, facts, notes", p: "packages/memory" },
  { n: "Router and clarify flow", c: "Built by us", w: "Right Elf, or a numbered question", p: "packages/elves/src/router.ts" },
  { n: "Pipeline", c: "Built by us", w: "Debounce, batch, cancel, idempotent sends", p: "packages/pipeline" },
  { n: "Crew Board page", c: "Built by us", w: "Live status of every Elf", p: "apps/elves" },
  { n: "Ledger dashboard", c: "Built by us", w: "Live page, signed link, refreshes every 5 seconds", p: "packages/money-elf" },
  { n: "Scam rules", c: "Built by us", w: "Listing flags and deal shield", p: "packages/listings, packages/engine" },
  // Dev
  { n: "Claude Code project skills (6)", c: "Dev tooling", w: "photon, nessie, run-elves-on-phone, verify-money-elf, record-decision, money-elf-add-dependency", p: ".claude/skills" },
  { n: "Photon operator CLI", c: "Dev tooling", w: "Lines, assignments, last messages", p: "scripts/photon.ts" },
  { n: "Offline demo and negotiation sim", c: "Dev tooling", w: "Whole arc with no keys", p: "scripts/demo.ts" },
  { n: "TESTING.md", c: "Dev tooling", w: "About 190 human test rows", p: "TESTING.md" },
];

window.UNIQUE = [
  ["One number, four agents", "Each with its own tools, rules and memory, behind a single thread."],
  ["It asks before it guesses", "Not sure which Elf? A numbered question, then your original words go to the one you pick."],
  ["A viewing waits for your yes", "The applicant's pick is held. Only yes books it."],
  ["Your floor never leaves your chat", "Counters are code. Buyers never see your lowest price."],
  ["Prices fall on a schedule", "Last Call: 20% at 72 hours, 25% more at 48, free at 24, and each cut says why."],
  ["The ledger is Nessie, read live", "Totals come back from Nessie every five seconds, never from memory."],
  ["A plan that lives in the bank", "Smart Plans are written to Nessie as pending, future-dated records that settle."],
  ["Odds, not guesses", "Every plan simulated 2,000 times, with the assumptions printed."],
  ["Pictures in the thread", "No mini apps on 2.0, so cards are drawn on the server and sent as images."],
  ["A call that becomes a thread", "The voice call writes the same memory as a text, then texts you a recap."],
  ["One list of abilities", "The same list writes the prompt, the voice script, the refusals and the docs."],
  ["Real-browser house hunt", "Craigslist, Airbnb, Booking.com, SpareFoot, with scam rules on the results."],
  ["Move Report", "Pounds kept out of the landfill and CO2e avoided, with dumped items counted against us."],
  ["Built for the shared pool", "Every feature has a fallback when polls, reactions or threads are refused."],
];

window.FUTURE = [
  ["A dedicated Photon line for everyone", "Tapbacks on every text, threaded replies, and the Elves texting a lister first."],
  ["Move day", "Truck and mover quotes, a room scan for what is left, ETAs on the day."],
  ["Roommates in one group thread", "A shared chat where the crew splits costs and settles up in the open."],
  ["Outbound calls", "A voice agent that calls storage facilities and landlords for you, with your yes."],
  ["More channels", "WhatsApp, Telegram and email, so a move can include everyone you know."],
  ["Odds learned from real moves", "Swap the assumptions table for sale times and prices from real Elfie users."],
  ["Beyond Boston", "Every city has its own September 1: more pickup partners and local scam patterns."],
  ["Bring-your-own bank", "Point the ledger at a real account once Nessie-style rails are available."],
];

/* Captions for the placeholder strip until real photos are listed in SITE.nightPhotos (no times claimed). */
window.NIGHT = ["First live reply", "Deal Engine", "Photo to price", "Money Elf joins", "Voice call lands", "Ledger in Nessie", "Smart Plan", "Demo day"];

/* Icons: [local file in assets/icons | "mono:X" | "elf:tone", brand color]. Monograms are drawn tiles, not logos. */
window.ICONS = {
  "Photon 2.0 REST API": ["mono:P", "#0A84FF"], "Photon 2.0 Socket.IO events": ["socketdotio", "#010101"], "Photon shared iMessage pool": ["imessage", "#34C759"],
  "Photon dedicated line": ["mono:P", "#0A84FF"], "Photon SMS and voice line": ["mono:P", "#0A84FF"], "Photon attachments": ["mono:P", "#0A84FF"],
  "Photon idempotency keys": ["mono:P", "#0A84FF"], "Photon 1.0 Spectrum": ["mono:P", "#8e93a1"], "socket.io-client": ["socketdotio", "#010101"],
  "Retell AI": ["mono:R", "#6B4EFF"], "Retell webhook (signed)": ["mono:R", "#6B4EFF"], "Retell mock call CLI": ["mono:R", "#6B4EFF"],
  "Anthropic Claude API": ["anthropic", "#191919"], "Claude Haiku 5.5": ["claude", "#D97757"], "Claude Sonnet 5.5": ["claude", "#D97757"], "Claude vision": ["claude", "#D97757"],
  "heif2jpeg": ["apple", "#111111"], "Zod structured outputs": ["zod", "#408AFF"], "Onboarding eval (simulated owners)": ["claude", "#D97757"],
  "Capital One Nessie API": ["mono:N", "#D03027"], "Nessie pending and settle": ["mono:N", "#D03027"], "Moving Fund and Escrow accounts": ["mono:N", "#D03027"], "Smart Plan simulator": ["elf:lime"],
  "Supabase Postgres": ["supabase", "#3FCF8E"], "Bun.sql": ["bun", "#14151a"], "SQL migrations (11)": ["postgresql", "#4169E1"], "Postgres full-text search": ["postgresql", "#4169E1"], "Docker Postgres": ["docker", "#2496ED"],
  "Browserbase": ["mono:B", "#F26B3A"], "Stagehand v4": ["mono:S", "#14151a"], "Craigslist": ["mono:C", "#5A2D82"], "Airbnb": ["airbnb", "#FF5A5F"], "Booking.com": ["mono:B", "#003B95"],
  "SpareFoot": ["mono:S", "#00A859"], "Apartments.com": ["mono:A", "#0B5BD3"], "Zillow": ["zillow", "#006AFF"], "Facebook (logged-in context)": ["facebook", "#0866FF"],
  "Railway": ["railway", "#14151a"], "Docker (oven/bun slim)": ["docker", "#2496ED"], "GitHub": ["github", "#181717"], "Hono": ["hono", "#E36002"],
  "Bun": ["bun", "#14151a"], "TypeScript 5.9": ["typescript", "#3178C6"], "Biome": ["biome", "#2563EB"],
  "resvg-js": ["mono:R", "#14151a"], "Inter (Expo Google Fonts)": ["googlefonts", "#4285F4"], "Server-drawn SVG": ["mono:S", "#0A84FF"],
  "EPA WARM v13": ["mono:E", "#2E7D32"], "Boston 311 bulk pickup": ["mono:B", "#1F4E8C"], "Salvation Army, Goodwill, Habitat ReStore": ["mono:G", "#2FB36B"], "FTC Consumer Sentinel": ["mono:F", "#14151a"],
  "Deal Engine": ["elf:amber"], "Memory": ["elf:green"], "Router and clarify flow": ["elf:ink"], "Pipeline": ["elf:ink"], "Crew Board page": ["elf:green"], "Ledger dashboard": ["elf:lime"], "Scam rules": ["elf:amber"],
  "Claude Code project skills (6)": ["claude", "#D97757"], "Photon operator CLI": ["mono:P", "#0A84FF"], "Offline demo and negotiation sim": ["mono:D", "#14151a"], "TESTING.md": ["mono:T", "#14151a"],
};

/* The Deal Engine, as a walk-through. */
window.DEAL = {
  modes: [
    ["sell_item", "You sell", "Buyers text the number with your ref code."],
    ["buy_item", "You buy", "Your max price is the ceiling."],
    ["sublet_out", "You sublet", "Applicants screened, viewings wait for you."],
    ["find_sublet", "You find a place", "The lister's replies run through the same engine."],
  ],
  steps: [
    { k: "Listed", ev: "deal.opened", t: "A ref code and a private floor", p: ["Your floor is stored in code, never in a prompt", "Buyers match by ref code or one shared title word", "You paste the post yourself"] },
    { k: "Negotiating", ev: "offer.countered", t: "It counters at your floor", p: ["Offers at or above your price are agreed", "Below the floor: held, countered, or asked to you", "Scam Shield watches every message"] },
    { k: "Scheduled", ev: "pickup.scheduled", t: "Three slots on one calendar", p: ["No double-booking across deals", "Pickups book without asking", "A viewing waits for your yes"] },
    { k: "Handed off", ev: "ledger.release", t: "Two signals release the money", p: ["Buyer confirms, you say yes", "A no-show past 24 hours is refunded after your yes", "Item marked sold, given or donated"] },
    { k: "Paid", ev: "ledger.hold", t: "Every step lands in Nessie", p: ["Agreed price opens an escrow hold", "Release moves it to the Moving Fund", "Totals read back from Nessie"] },
    { k: "Last Call", ev: "price.dropped", t: "Unsold? The price falls on a schedule", p: ["20% at 72 hours, 25% more at 48", "Free at 24 hours, then donate", "Anything left at move-out is dumped, and counted"] },
  ],
};

/* The original ideas, added to every track so every judge hears them. */
(function () {
  var T = function (id) { return window.TRACKS.filter(function (t) { return t.id === id; })[0]; };
  T("photon").tiles.unshift(
    { k: "Ours", own: true, t: "A Deal Engine inside the thread", s: "Strangers negotiate over the same number.", more: "Buyers, applicants and listers text the Photon number from their own phones. Our Deal Engine, a Postgres state machine we built, matches them to a deal by ref code, counters at your floor, offers three slots on one calendar and asks you only when it must. It is Photon spaces plus a state machine, not a prompt." },
    { k: "Ours", own: true, t: "Smart Plan, in your messages", s: "Three plans, odds, and a pick by text.", more: "Say \"smart plan\" and a picture of three plans arrives with the odds of each landing under your budget. Reply B (or tap a poll where polls work). The same plans are on the dashboard link, and a switch there sends a note back to your chat." }
  );
  T("nessie").tiles.unshift(
    { k: "Ours", own: true, t: "The Deal Engine writes the ledger", s: "Negotiation outcomes become Nessie records.", more: "Our Deal Engine holds your floor, counters buyers and books pickups. Its events (hold, pickup, release, refund) are what open and close escrow in Nessie, so a negotiated price becomes a bookkeeping entry with the owner's yes at each money move." }
  );
  T("sustain").tiles.unshift(
    { k: "Ours", own: true, t: "Last Call lives in the Deal Engine", s: "The sweep that keeps things out of the landfill.", more: "A sweep over every open deal cuts the ask 20% at 72 hours and 25% more at 48, relists free at 24 and offers donation. Buyers already talking get the new price. It is our engine, not a reminder." },
    { k: "Ours", own: true, t: "Smart Plan favors reuse", s: "Donate-or-haul is an option, not an afterthought.", more: "Each plan decides what to sell, when to drop it, and what to donate or haul, then simulates the cost 2,000 times. When donating is the cheaper path, a plan says so." }
  );
  T("cyber").tiles.unshift(
    { k: "Ours", own: true, t: "Scam Shield is in the Deal Engine", s: "The shield runs on every counterparty message.", more: "Because every buyer, applicant and lister goes through our Deal Engine, Scam Shield sees each message: off-escrow asks, gift cards, checks, codes, overpayments. The floor and ceiling are enforced in code at the same place." },
    { k: "Ours", own: true, t: "Plans advise, never act", s: "Smart Plan moves no money and edits no listing.", more: "Picking a plan writes pending, future-dated records and never moves money. It never edits a listing price and never goes below your floor. Expected money stays out of the totals." }
  );
})();

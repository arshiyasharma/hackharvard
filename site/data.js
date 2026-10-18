/* Everything the page says that is not layout: the conversations the emulator plays, the agents' lists, the tracks.
   Conversations mirror the product's real reply formats (header line with the Elf's emoji and name, short blocks).
   They are example conversations, labelled as such on the page. */

window.SITE = {
  // Fill these in; the page renders sensible empty states until you do.
  number: "", // e.g. "+1 628 997 9661", shown in "Try it" when set
  interviewYouTubeId: "", // the id of the interview Short, e.g. "abc123XYZ"
  nightPhotos: [], // e.g. ["assets/night/1.jpg", "assets/night/2.jpg"]
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
      { from: "elf", agent: "money", text: "💸 Money Elf\n\nHere are three ways to finish the move, built around a $300 budget:\n\nA · best odds · $47 ahead · 92% under $300\nB · runner-up · $15 ahead · 81% under $300\nC · least effort · $190 · 54% under $300\n\nReply A, B or C to pick one.", img: "plans" },
      { from: "you", text: "go with B" },
      { from: "elf", agent: "money", text: "On plan B: $15 ahead, 81% under $300.\n\nWritten to Nessie as 3 pending records. Nothing moves until it happens.\n\nDashboard: your live ledger link" },
    ],
  },
  {
    id: "money-ledger", agent: "money", title: "Ledger and dashboard",
    line: "A picture in the thread and a link that never expires.",
    msgs: [
      { from: "you", text: "DASHBOARD" },
      { from: "elf", agent: "money", text: "📋 Your money, live from Nessie: $740 out, $593 expected back.", img: "ledger" },
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

window.TRACKS = [
  {
    id: "photon", name: "Photon", scene: "crew-brief",
    head: "Four agents. One number. Built on Photon end to end.",
    points: [
      ["It's not one chat, it's four agents", "Crew Lead, Home, Stuff and Money each run on their own tools, rules and memory behind one thread, and call each other when a text needs two."],
      ["Photon 2.0, all of it", "REST plus the Socket.IO event stream with cursor replay, replies as the agent each person texted, idempotency keys, read receipts, typing, reactions, polls, attachments."],
      ["Pictures instead of mini apps", "2.0 has no app card, so the ledger, the plans and the Move Report are drawn as images and sent in the thread, with a live page behind a link."],
      ["Voice that remembers", "A Retell agent on the Photon SMS line runs the onboarding call. The call writes to the same memory a text does, and a recap text follows."],
      ["Photon skills", "We wrote what 2.0 can and can't send into project skills, checked against the live OpenAPI spec, so the whole team built against what exists."],
      ["Fallbacks that earn trust", "Poll refused on the shared pool? Reply yes. Threads refused? Flat send. No model key? Deterministic replies."],
    ],
    apis: ["Photon 2.0", "Anthropic Claude (Haiku, Sonnet, vision)", "Retell voice", "Capital One Nessie", "Browserbase + Stagehand", "Supabase Postgres", "Railway", "EPA WARM"],
  },
  {
    id: "nessie", name: "Nessie", scene: "money-plan",
    head: "Nessie is the ledger, and the crystal ball.",
    points: [
      ["Every dollar is a Nessie record", "Splits, deposits, payments, escrow and sales are tagged records. Totals are read back from Nessie every 5 seconds."],
      ["Roommate money, three ways", "Splits to the penny, payment plans, and paying a roommate back from the Moving Fund. One yes each."],
      ["Negotiation becomes a ledger", "The deal engine's agreed price opens an escrow hold; pickup releases it; a no-show refunds it."],
      ["Prices drop on a schedule", "Last Call: 20% off at 72 hours, 25% more at 48, free at 24. Each cut is texted with why."],
      ["Smart Plan, beyond the ledger", "Set a budget, get three plans simulated 2,000 times with your odds of finishing under it. The chosen plan lives in Nessie as pending, future-dated records."],
      ["A dashboard that shows it", "Expected payments against net cost, your real spend over the plan's range, every Nessie record one tap away."],
    ],
    apis: ["Accounts", "Purchases", "Deposits", "Withdrawals", "Pending to completed", "Tagged records", "Read-back"],
  },
  {
    id: "sustain", name: "Sustainability", scene: "stuff-lastcall",
    head: "Nobody should throw a good couch in the street.",
    points: [
      ["Allston Christmas", "Two-thirds of Boston leases turn over on September 1. In one week of 2023 the city collected 38 extra tons of trash and 1,700 mattresses."],
      ["A plan for every item", "At the start, each thing is sell, donate, keep or undecided, so nothing is left for the last night."],
      ["Last Call", "Unsold things get cheaper on a schedule so they leave your place, then go free, then get donated."],
      ["Donate in one text", "Boston 311 bulk pickup, Salvation Army, Goodwill, Habitat ReStore, and a request drafted for you."],
      ["Move Report", "Pounds kept out of the landfill, CO2e avoided (EPA WARM, labelled approximate), money recovered. Dumped items count against you."],
    ],
    apis: ["EPA WARM", "Boston 311", "Goodwill", "Salvation Army", "Habitat ReStore"],
  },
  {
    id: "cyber", name: "Cybersec and Fintech", scene: "home-viewing",
    head: "An AI that touches money and strangers, built to say no and ask first.",
    points: [
      ["Nothing without your yes", "Viewings, escrow, releases, refunds, payments and plans each wait for one yes, applied to exactly one action."],
      ["Refuses out loud", "No rent, bank moves, investing, taxes, lease reading or posting for you, and it names what it can do instead."],
      ["Scam flags on the hunt", "Prices under half the median, wire or gift-card asks, \"I'm abroad\", no photos or place, mismatched duplicates."],
      ["Scam Shield on deals", "Off-escrow asks get escrow only. Gift cards, cashier's checks, codes and overpayments end the chat."],
      ["Fintech controls", "Escrow on two signals, live reads from Nessie, no card numbers stored, signed links, idempotent approvals, safe failure."],
    ],
    apis: ["Escrow", "HMAC links", "Idempotency keys", "Scam Shield", "Floor privacy"],
  },
];

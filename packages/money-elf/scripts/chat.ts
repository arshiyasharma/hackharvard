/**
 * Text the Money Elf from your terminal, as the owner, a roommate or a buyer.
 *
 *   bun run packages/money-elf/scripts/chat.ts            fake payments, nothing leaves your machine
 *   bun run packages/money-elf/scripts/chat.ts --nessie   real Nessie sandbox calls (needs NESSIE_API_KEY in .env)
 *   ... --port 8788                                       serve the live Ledger page on another port (default 8787)
 *
 * "show me the ledger" saves the Ledger card under .data/ (gitignored) and prints a link to the live page.
 * Approval polls print as numbered options; /vote 1 taps one.
 *
 * Type a message and press enter. Lines starting with / are commands; /help lists them.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  booksLine,
  createLedgerHandler,
  createMoneyElf,
  FakeRails,
  fmtUsd,
  MemoryMoneyStore,
  type MoneyRails,
  NessieRails,
  parseAmounts,
  readTag,
} from "../src/index.ts";
import type {
  MoneyContext,
  MoneyItem,
  MoneyPoll,
  MoneyResult,
  MoneySpaces,
  OutboundMessage,
  Role,
} from "../src/types.ts";

const useNessie = process.argv.includes("--nessie");
const OWNER = "+16175550100";

function makeRails(): MoneyRails {
  if (!useNessie) return new FakeRails();
  const apiKey = process.env.NESSIE_API_KEY;
  if (!apiKey) throw new Error("--nessie needs NESSIE_API_KEY in .env");
  return new NessieRails({ apiKey, baseUrl: process.env.NESSIE_BASE_URL });
}

const portArg = process.argv.indexOf("--port");
const PORT = portArg > 0 ? Number(process.argv[portArg + 1]) : 8787;
// Links are signed like in production; the secret only lives for this run.
const links = { publicUrl: `http://localhost:${PORT}`, secret: randomBytes(16).toString("hex") };
const CARD_DIR = resolve(import.meta.dir, "../../../.data");

// The time machine: /ff <days> moves this clock forward, so plan dates come due and drift shows.
let offsetDays = 0;
const clock = () => new Date(Date.now() + offsetDays * 86_400_000);
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

let store = new MemoryMoneyStore();
let rails = makeRails();
let elf = createMoneyElf({ store, rails, links, now: clock });
// The move's items, standing in for the crew Store (the Stuff Elf's items). /items seeds a demo set.
let items: MoneyItem[] = [];
const crew: MoneySpaces = {
  // Everyone on the Ledger with a number counts as reachable, texting from a space named after their number.
  listParticipants: async (moveId) =>
    (await store.listPeople(moveId)).flatMap((p) =>
      p.handle ? [{ handle: p.handle, spaceId: p.handle }] : [],
    ),
  listItems: async () => items,
};
let lastPoll: MoneyPoll | null = null;
let lastCard: string | null = null;

Bun.serve({
  port: PORT,
  fetch: async (req) =>
    (await createLedgerHandler({ service: elf.service, links })(req)) ??
    new Response("not found", { status: 404 }),
});
let move: { id: string; ownerHandle: string; name: null; moveOutAt: string | null } = {
  id: `mv_local_${Date.now()}`,
  ownerHandle: OWNER,
  name: null,
  moveOutAt: null,
};
let speaker: { role: Role; handle: string; label: string } = { role: "owner", handle: OWNER, label: "owner" };
let showEvents = false;
let n = 0;
let sales = 0;

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

const log = {
  debug() {},
  info() {},
  warn: (m: string, d?: unknown) => console.warn(yellow(`warn: ${m} ${d ? JSON.stringify(d) : ""}`)),
  error: (m: string, d?: unknown) => console.error(yellow(`error: ${m} ${d ? JSON.stringify(d) : ""}`)),
};

function print(r: Omit<MoneyResult, "outbound"> & { outbound?: OutboundMessage[] }) {
  for (const x of r.replies)
    console.log(
      green(x.text.replace(/^/gm, "  Money Elf: ").replace(/\n {2}Money Elf: /g, "\n             ")),
    );
  for (const img of r.images ?? []) {
    mkdirSync(CARD_DIR, { recursive: true });
    lastCard = resolve(CARD_DIR, `${img.filename.replace(/\.png$/, "")}-${Date.now()}.png`);
    writeFileSync(lastCard, img.bytes);
    console.log(cyan(`  [image] ${img.alt}`));
    console.log(dim(`          saved to ${lastCard}  (/open to view)`));
  }
  const showPoll = (poll: MoneyPoll, to?: string) => {
    lastPoll = poll;
    console.log(cyan(`  [poll${to ? ` to ${to}` : ""}] ${poll.question}`));
    console.log(
      cyan(
        `         ${poll.options.map((o, i) => `(${i + 1}) ${o.text}`).join("   ")}   /vote <n> as the owner`,
      ),
    );
  };
  if (r.poll) showPoll(r.poll);
  for (const o of r.outbound ?? []) {
    console.log(cyan(`  -> text to ${o.toHandle}: ${o.text}`));
    if (o.poll) showPoll(o.poll, o.toHandle);
  }
  if (r.boardPatch)
    console.log(
      dim(`  board: [${r.boardPatch.status}] ${r.boardPatch.currentTask} | ${r.boardPatch.lastUpdate}`),
    );
  if (showEvents)
    for (const e of r.events ?? []) console.log(dim(`  event ${e.type} ${JSON.stringify(e.payload)}`));
}

async function send(text: string | null, vote?: { id: string; text: string }) {
  n++;
  const ctx: MoneyContext = {
    llm: { name: "fake", extract: async () => Promise.reject(new Error("rules parser only")) },
    move,
    participant: { handle: speaker.handle, role: speaker.role },
    batch: {
      spaceId: `local_${speaker.handle}`,
      traceId: `tr_${n}`,
      messages: [{ id: `m${n}`, text, pollVote: vote ? { selectedOptions: [vote] } : null }],
    },
    traceId: `tr_${n}`,
    log,
    now: clock,
    store: crew,
  };
  print(await elf.handle(ctx));
}

async function personHandle(nameOrPhone: string): Promise<{ handle: string; label: string } | null> {
  if (/^\+?\d[\d\s().-]{6,}$/.test(nameOrPhone))
    return { handle: nameOrPhone.replace(/[^\d+]/g, ""), label: nameOrPhone };
  const p = await elf.service.findPerson(move.id, nameOrPhone);
  return p?.handle ? { handle: p.handle, label: p.name } : null;
}

const HELP = `Commands:
  /as owner                     talk as the owner (default)
  /as roommate <name|phone>     talk as a roommate (save their number first: "Sam is 617-555-0101")
  /as buyer <phone>             talk as a buyer
  /sale <item> <buyer> <$amt> [late]
                                a buyer pays into escrow (what the Stuff Elf will do), e.g. /sale couch Alex $90.
                                The buyer gets a test number (shown), so "/as buyer <it>" then "got it" confirms
                                pickup. "late" sets the pickup time 25h ago, for /sweep
  /map <item>                   Move Map convergence for a sale (the owner-side release signal; a stub hook)
  /sweep                        run the Deal Engine's no-show sweep (24h past pickup asks the owner to refund)
  /items [days]                 seed demo items (couch, desk, bookshelf, lamp, kept mattress); move-out in
                                <days> (default 10). Then "plan my move under $300"
  /moveout <YYYY-MM-DD|+days>   set the move-out date
  /sold <item>                  mark an item sold (what the Deal Engine does); /plansweep settles its plan record
  /donated <item>               mark an item donated
  /plansweep                    run the plan drift sweep (settles records, nudges when you fall behind)
  /plans                        the drafts and the chosen plan's Nessie records
  /ff <days>                    fast-forward the clock (the time machine)
  /ledger                       every Ledger row
  /books                        the live Ledger straight from Nessie, account by account
  /pending                      actions waiting for the owner's yes
  /vote <n>                     tap option n on the last poll (as whoever is talking)
  /open                         open the last Ledger card image
  /events                       toggle showing events
  /reset                        start a fresh move
  /quit
Move Plans: /items, "plan my move under $300", /vote 2, /books, /ff 6, /plansweep, "what plan am I on", "show me the ledger".
Try: "Sam is 617-555-0101", "split the $240 truck with Sam and Priya", "yes", "/as roommate Sam",
"can I do a payment plan, $20 a month?", "/as owner", "yes", "/as roommate Sam", "paid", "/books".`;

async function command(line: string) {
  const [cmd, ...rest] = line.slice(1).trim().split(/\s+/);
  switch (cmd) {
    case "help":
      console.log(HELP);
      return;
    case "as": {
      const role = rest[0] as Role | undefined;
      if (role === "owner") {
        speaker = { role: "owner", handle: OWNER, label: "owner" };
      } else if (role === "roommate" || role === "buyer") {
        const who = await personHandle(rest.slice(1).join(" "));
        if (!who) {
          console.log(
            yellow(
              `  I don't know a number for "${rest.slice(1).join(" ")}". As the owner, text "<Name> is <phone>" first, or pass a phone.`,
            ),
          );
          return;
        }
        speaker = { role, handle: who.handle, label: `${role} ${who.label}` };
      } else {
        console.log(yellow("  /as owner | /as roommate <name|phone> | /as buyer <phone>"));
        return;
      }
      console.log(dim(`  now talking as ${speaker.label}`));
      return;
    }
    case "sale": {
      const [item, buyer, amt, late] = rest;
      const cents = parseAmounts(amt?.startsWith("$") ? amt : `$${amt ?? ""}`)[0];
      if (!item || !buyer || !cents) {
        console.log(yellow("  usage: /sale couch Alex $90"));
        return;
      }
      const buyerHandle = `+1617555${String(1000 + (++sales % 9000)).padStart(4, "0")}`;
      const r = await elf.service.openEscrow(move, {
        item,
        buyerName: buyer,
        buyerHandle,
        amountCents: cents,
        pickupAt: late === "late" ? new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() : null,
      });
      console.log(dim(`  ${buyer} is ${buyerHandle}`));
      print({ replies: [], outbound: r.outbound, events: r.events });
      return;
    }
    case "map": {
      const sale = (await store.listEntries(move.id)).find(
        (e) => e.kind === "sale" && e.escrow === "held" && (!rest[0] || e.what.includes(rest[0])),
      );
      if (!sale) {
        console.log(yellow("  no held sale by that name; /sale one first"));
        return;
      }
      const r = await elf.service.mapConverged(move, sale.id);
      print({
        replies: r.lines.length ? [{ text: r.lines.join("\n") }] : [],
        outbound: r.outbound,
        events: r.events,
      });
      return;
    }
    case "sweep": {
      const r = await elf.service.sweepNoShows(move);
      if (!r.outbound.length) console.log(dim("  no no-shows"));
      print({ replies: [], outbound: r.outbound, events: r.events });
      return;
    }
    case "items": {
      const days = Number(rest[0] ?? 10) || 10;
      const mk = (
        id: string,
        name: string,
        category: string,
        weightLb: number,
        list: number,
        floor: number | null,
        keep = false,
      ): MoneyItem => ({
        id,
        name,
        category,
        weightLb,
        listPriceCents: list,
        floorPriceCents: floor,
        outcome: "listed",
        ...(keep ? { keep } : {}),
      });
      items = [
        mk("it_couch", "couch", "furniture", 120, 12000, 8000),
        mk("it_desk", "desk", "furniture", 60, 8000, 5000),
        mk("it_shelf", "bookshelf", "furniture", 40, 4000, 2000),
        mk("it_lamp", "lamp", "decor", 8, 2500, 1500),
        mk("it_mattress", "mattress", "furniture", 70, 0, null, true),
      ];
      move = { ...move, moveOutAt: isoDay(new Date(clock().getTime() + days * 86_400_000)) };
      for (const it of items)
        console.log(
          dim(
            `  ${it.name.padEnd(10)} ${it.keep ? "keeping".padStart(9) : fmtUsd(it.listPriceCents ?? 0).padStart(9)}  floor ${it.floorPriceCents ? fmtUsd(it.floorPriceCents) : "-"}  ${it.weightLb} lb`,
          ),
        );
      console.log(dim(`  move-out ${move.moveOutAt}`));
      return;
    }
    case "moveout": {
      const a = rest[0] ?? "";
      const d = a.startsWith("+") ? isoDay(new Date(clock().getTime() + Number(a.slice(1)) * 86_400_000)) : a;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        console.log(yellow("  usage: /moveout 2026-10-28 or /moveout +10"));
        return;
      }
      move = { ...move, moveOutAt: d };
      console.log(dim(`  move-out ${d}`));
      return;
    }
    case "sold":
    case "donated": {
      const it = items.find((i) => i.name === rest[0]);
      if (!it) {
        console.log(yellow(`  no item "${rest[0] ?? ""}"; /items first`));
        return;
      }
      it.outcome = cmd === "sold" ? "sold" : "donated";
      console.log(dim(`  ${it.name} is ${it.outcome}; /plansweep settles its plan record in Nessie`));
      return;
    }
    case "plansweep": {
      const r = await elf.plans.sweep(move, items);
      if (!r.outbound.length && !r.events.length) console.log(dim("  on plan; nothing to settle or nudge"));
      for (const e of r.events) console.log(dim(`  ${e.type} ${JSON.stringify(e.payload)}`));
      print({ replies: [], outbound: r.outbound, events: [] });
      return;
    }
    case "plans": {
      const st = await store.getPlans(move.id);
      if (!st) {
        console.log(dim('  no plans yet; /items then "plan my move under $300"'));
        return;
      }
      for (const p of st.drafts)
        console.log(
          `  ${p.label} ${p.name.padEnd(13)} ${fmtUsd(p.stats.p50Cents).padStart(8)}  ${Math.round(p.stats.chanceUnderBudget * 100)}% under ${fmtUsd(st.budgetCents)}`,
        );
      console.log(dim(`  chosen: ${st.chosenLabel ?? "none"}`));
      for (const l of st.lines)
        console.log(
          `    ${l.status.padEnd(9)} ${l.date}  ${fmtUsd(l.cents).padStart(8)}  ${l.label}  ${dim(l.recordId)}`,
        );
      return;
    }
    case "ff": {
      const days = Number(rest[0] ?? 1) || 1;
      offsetDays += days;
      console.log(dim(`  it's now ${isoDay(clock())} (${offsetDays} days ahead)`));
      return;
    }
    case "ledger": {
      const entries = await store.listEntries(move.id);
      if (!entries.length) console.log(dim("  (empty)"));
      for (const e of entries) {
        const who = async (id: string | null) => (id ? ((await store.getPerson(id))?.name ?? id) : "-");
        console.log(
          `  ${e.date}  ${e.kind.padEnd(8)} ${e.what.padEnd(12)} ${fmtUsd(e.amountCents).padStart(9)}  ${e.status.padEnd(9)}` +
            ` paid by ${await who(e.paidBy)}, owed by ${await who(e.owedBy)}, to ${await who(e.paidTo)}` +
            `${e.escrow ? `  escrow:${e.escrow}` : ""}${e.dueBackAt ? `  due back ${e.dueBackAt}` : ""}${e.flagged ? "  FLAGGED" : ""}`,
        );
      }
      console.log(dim(`  ${booksLine(await elf.service.books(move))}`));
      return;
    }
    case "books": {
      const people = await store.listPeople(move.id);
      const accounts: [string, string | null | undefined][] = [
        ...people.map((p): [string, string | null] => [`${p.name} (${p.role})`, p.nessieAccountId]),
        ["Moving Fund (checking)", await store.getFundAccount(move.id)],
        ["Escrow (savings)", await store.getEscrowAccount(move.id)],
      ];
      for (const [label, id] of accounts) {
        if (!id) continue;
        const r = await rails.readAccount(id);
        console.log(`  ${label}  ${dim(id)}`);
        for (const w of r.withdrawals)
          console.log(
            `    - ${fmtUsd(w.amountCents).padStart(8)} out  ${readTag(w.description)?.tag ?? "?"}  ${w.status !== "completed" ? `${yellow(w.status)} ${w.date}  ` : ""}${dim(w.description.replace(/ \[elves:.*\]$/, ""))}`,
          );
        for (const d of r.deposits)
          console.log(
            `    + ${fmtUsd(d.amountCents).padStart(8)} in   ${readTag(d.description)?.tag ?? "?"}  ${d.status !== "completed" ? `${yellow(d.status)} ${d.date}  ` : ""}${dim(d.description.replace(/ \[elves:.*\]$/, ""))}`,
          );
        for (const x of r.purchases)
          console.log(
            `    - ${fmtUsd(x.amountCents).padStart(8)} buy  ${readTag(x.description)?.tag ?? "?"}  ${dim(x.description.replace(/ \[elves:.*\]$/, ""))}`,
          );
        for (const b of r.bills)
          console.log(`    bill  ${fmtUsd(b.amountCents).padStart(8)} ${b.status}  ${b.nickname}`);
        for (const l of r.loans)
          console.log(
            `    loan  ${fmtUsd(l.amountCents).padStart(8)} left, ${fmtUsd(l.monthlyCents)}/mo, ${l.status}`,
          );
      }
      console.log(dim(`  ${booksLine(await elf.service.books(move))}`));
      return;
    }
    case "pending": {
      const all = await store.listPending(move.id);
      if (!all.length) console.log(dim("  (nothing waiting)"));
      for (const a of all) console.log(`  ${a.kind}: ${a.summary}`);
      return;
    }
    case "vote": {
      const opt = lastPoll?.options[Number(rest[0]) - 1];
      if (!opt) {
        console.log(yellow("  no poll to vote on, or no such option"));
        return;
      }
      await send(null, opt);
      return;
    }
    case "open":
      if (!lastCard) console.log(yellow('  no card yet; text "show me the ledger" first'));
      else execFile(process.platform === "darwin" ? "open" : "xdg-open", [lastCard]);
      return;
    case "events":
      showEvents = !showEvents;
      console.log(dim(`  events ${showEvents ? "on" : "off"}`));
      return;
    case "reset":
      store = new MemoryMoneyStore();
      rails = makeRails();
      elf = createMoneyElf({ store, rails, links, now: clock });
      lastPoll = null;
      items = [];
      offsetDays = 0;
      move = { id: `mv_local_${Date.now()}`, ownerHandle: OWNER, name: null, moveOutAt: null };
      speaker = { role: "owner", handle: OWNER, label: "owner" };
      console.log(dim("  fresh move"));
      return;
    case "quit":
    case "exit":
      process.exit(0);
      return;
    default:
      console.log(yellow(`  unknown command /${cmd}; try /help`));
  }
}

console.log(
  `Money Elf local chat (${useNessie ? "LIVE Nessie sandbox" : "fake payments"}). Live Ledger pages on ${links.publicUrl}. /help for commands.\n`,
);
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
const piped = !process.stdin.isTTY;
if (!piped) {
  if (!piped) {
    rl.setPrompt(`${speaker.label}> `);
    rl.prompt();
  }
}
// Lines are handled one at a time, in order, so a piped script behaves like typing.
for await (const raw of rl) {
  const line = raw.trim();
  if (line) {
    if (piped) console.log(`${speaker.label}> ${line}`);
    try {
      if (line.startsWith("/")) await command(line);
      else await send(line);
    } catch (err) {
      console.error(yellow(`  ${String(err)}`));
    }
  }
  if (!piped) {
    rl.setPrompt(`${speaker.label}> `);
    rl.prompt();
  }
}
// Input ended (piped script or Ctrl-D): stop the local Ledger server too.
process.exit(0);

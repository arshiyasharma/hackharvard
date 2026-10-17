/**
 * Text the Money Elf from your terminal, as the owner, a roommate or a buyer.
 *
 *   bun run packages/money-elf/scripts/chat.ts            fake payments, nothing leaves your machine
 *   bun run packages/money-elf/scripts/chat.ts --nessie   real Nessie sandbox calls (needs NESSIE_API_KEY in .env)
 *
 * Type a message and press enter. Lines starting with / are commands; /help lists them.
 */
import { createInterface } from "node:readline";
import {
  boardLine,
  createMoneyElf,
  FakePayments,
  fmtUsd,
  ledgerTotals,
  MemoryMoneyStore,
  NessiePayments,
  type PaymentsProvider,
  parseAmounts,
} from "../src/index.ts";
import type { MoneyContext, MoneyResult, Role } from "../src/types.ts";

const useNessie = process.argv.includes("--nessie");
const OWNER = "+16175550100";

function makePayments(): PaymentsProvider {
  if (!useNessie) return new FakePayments();
  const apiKey = process.env.NESSIE_API_KEY;
  if (!apiKey) throw new Error("--nessie needs NESSIE_API_KEY in .env");
  return new NessiePayments({ apiKey, baseUrl: process.env.NESSIE_BASE_URL });
}

let store = new MemoryMoneyStore();
let payments = makePayments();
let elf = createMoneyElf({ store, payments });
let move = { id: `mv_local_${Date.now()}`, ownerHandle: OWNER, name: null };
let speaker: { role: Role; handle: string; label: string } = { role: "owner", handle: OWNER, label: "owner" };
let showEvents = false;
let n = 0;

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

function print(r: MoneyResult) {
  for (const x of r.replies)
    console.log(
      green(x.text.replace(/^/gm, "  Money Elf: ").replace(/\n {2}Money Elf: /g, "\n             ")),
    );
  for (const o of r.outbound ?? []) console.log(cyan(`  -> text to ${o.toHandle}: ${o.text}`));
  if (r.boardPatch)
    console.log(
      dim(`  board: [${r.boardPatch.status}] ${r.boardPatch.currentTask} | ${r.boardPatch.lastUpdate}`),
    );
  if (showEvents)
    for (const e of r.events ?? []) console.log(dim(`  event ${e.type} ${JSON.stringify(e.payload)}`));
}

async function send(text: string) {
  n++;
  const ctx: MoneyContext = {
    llm: { name: "fake", extract: async () => Promise.reject(new Error("rules parser only")) },
    move,
    participant: { handle: speaker.handle, role: speaker.role },
    batch: { spaceId: `local_${speaker.handle}`, traceId: `tr_${n}`, messages: [{ id: `m${n}`, text }] },
    traceId: `tr_${n}`,
    log,
    now: () => new Date(),
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
  /sale <item> <buyer> <$amt>   a buyer pays into escrow (what the Stuff Elf will do), e.g. /sale couch Alex $90
  /ledger                       every Ledger row
  /pending                      actions waiting for the owner's yes
  /events                       toggle showing events
  /reset                        start a fresh move
  /quit
Try: "Sam is 617-555-0101", "split the $240 truck with Sam and Priya", "yes", "/as roommate Sam", "paid".`;

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
      const [item, buyer, amt] = rest;
      const cents = parseAmounts(amt?.startsWith("$") ? amt : `$${amt ?? ""}`)[0];
      if (!item || !buyer || !cents) {
        console.log(yellow("  usage: /sale couch Alex $90"));
        return;
      }
      const r = await elf.service.openEscrow(move, {
        item,
        buyerName: buyer,
        buyerHandle: null,
        amountCents: cents,
      });
      print({ replies: [], outbound: r.outbound, events: r.events });
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
      const owner = await elf.service.owner(move);
      console.log(dim(`  ${boardLine(ledgerTotals(entries, owner.id))}`));
      return;
    }
    case "pending": {
      const all = await store.listPending(move.id);
      if (!all.length) console.log(dim("  (nothing waiting)"));
      for (const a of all) console.log(`  ${a.kind}: ${a.summary}`);
      return;
    }
    case "events":
      showEvents = !showEvents;
      console.log(dim(`  events ${showEvents ? "on" : "off"}`));
      return;
    case "reset":
      store = new MemoryMoneyStore();
      payments = makePayments();
      elf = createMoneyElf({ store, payments });
      move = { id: `mv_local_${Date.now()}`, ownerHandle: OWNER, name: null };
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
  `Money Elf local chat (${useNessie ? "LIVE Nessie sandbox" : "fake payments"}). /help for commands.\n`,
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

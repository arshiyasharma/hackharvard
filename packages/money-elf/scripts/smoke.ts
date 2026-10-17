/**
 * Live smoke test of the Money Elf against Nessie: a split, the owner's yes, a roommate paying, a deposit,
 * and an escrow sale released on pickup. Creates simulated customers/accounts in your Nessie sandbox.
 *
 *   bun run packages/money-elf/scripts/smoke.ts        (reads NESSIE_API_KEY from .env)
 */
import { createMoneyElf, MemoryMoneyStore, NessiePayments } from "../src/index.ts";
import type { MoneyContext, Role } from "../src/types.ts";

const apiKey = process.env.NESSIE_API_KEY;
if (!apiKey) throw new Error("NESSIE_API_KEY is not set");

const store = new MemoryMoneyStore();
const payments = new NessiePayments({ apiKey, baseUrl: process.env.NESSIE_BASE_URL });
const elf = createMoneyElf({ store, payments });
const OWNER = "+16175550100";
const SAM = "+16175550101";
const move = { id: `mv_smoke_${Date.now()}`, ownerHandle: OWNER, name: "Smoke Owner" };
const log = {
  debug() {},
  info() {},
  warn: console.warn,
  error: console.error,
};
let n = 0;

async function say(text: string, from = OWNER, role: Role = "owner") {
  const ctx: MoneyContext = {
    llm: { name: "fake", extract: async () => Promise.reject(new Error("no llm")) },
    move,
    participant: { handle: from, role },
    batch: { spaceId: "smoke", traceId: `tr_${++n}`, messages: [{ id: `m${n}`, text }] },
    traceId: `tr_${n}`,
    log,
    now: () => new Date(),
  };
  const r = await elf.handle(ctx);
  console.log(`\n> ${role}: ${text}`);
  for (const x of r.replies) console.log(x.text.replace(/^/gm, "  "));
  for (const o of r.outbound ?? []) console.log(`  [to ${o.toHandle}] ${o.text}`);
  console.log(`  board: ${r.boardPatch?.status} | ${r.boardPatch?.lastUpdate}`);
  if (r.boardPatch?.status === "blocked") throw new Error("payments call failed");
  return r;
}

await say(`Sam is ${SAM}`);
await say("split the $240 truck with Sam");
await say("yes");
await say("can I do a payment plan, $40 a month?", SAM, "roommate");
await say("yes");
await say("paid", SAM, "roommate");
await say("paid $80", SAM, "roommate");
await say("I paid a $500 holding deposit on the sublet, due back Dec 1");
const sale = await elf.service.openEscrow(move, {
  item: "couch",
  buyerName: "Alex",
  buyerHandle: "+16175550199",
  amountCents: 9000,
});
console.log(`\n[escrow opened] ${sale.outbound[0]?.text}`);
await say("Alex picked up the couch");
await say("yes");
await say("ledger");

const books = await elf.service.books(move);
console.log(
  `\nLive from Nessie: fund ${books.fundCents}c, escrow ${books.escrowCents}c, ${books.records} tagged records`,
);
const entries = await store.listEntries(move.id);
const ids = entries.flatMap((e) => [
  ...e.nessie.withdrawalIds,
  ...e.nessie.depositIds,
  e.nessie.billId ?? "",
]);
console.log(`\nNessie records created: ${ids.filter(Boolean).length}`);
const people = await store.listPeople(move.id);
console.log(`Accounts: ${people.map((p) => `${p.name}=${p.nessieAccountId}`).join(", ")}`);
console.log(`Escrow account: ${await store.getEscrowAccount(move.id)}`);

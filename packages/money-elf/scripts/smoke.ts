/**
 * Live smoke test of the Money Elf against Nessie: a split (the truck posted as a purchase), the owner's yes,
 * a roommate paying, a deposit, an escrow sale released into the Moving Fund on two signals (owner OK + buyer
 * confirms), and a no-show refunded after the owner's yes. Creates customers and accounts in your Nessie
 * sandbox (real API, real records; each run is a new move).
 *
 *   bun run packages/money-elf/scripts/smoke.ts        (reads NESSIE_API_KEY from .env)
 */
import { createMoneyElf, MemoryMoneyStore, NessieRails } from "../src/index.ts";
import type { MoneyContext, Role } from "../src/types.ts";

const apiKey = process.env.NESSIE_API_KEY;
if (!apiKey) throw new Error("NESSIE_API_KEY is not set");

const store = new MemoryMoneyStore();
const rails = new NessieRails({ apiKey, baseUrl: process.env.NESSIE_BASE_URL });
const elf = createMoneyElf({ store, rails });
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
await say("got it, thanks", "+16175550199", "buyer");

const late = await elf.service.openEscrow(move, {
  item: "desk",
  buyerName: "Jo",
  buyerHandle: "+16175550198",
  amountCents: 6000,
  pickupAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
});
console.log(`\n[escrow opened] ${late.outbound[0]?.text}`);
const swept = await elf.service.sweepNoShows(move);
console.log(`[no-show sweep] ${swept.outbound[0]?.text ?? "nothing"}`);
if (!swept.outbound.length) throw new Error("the no-show sweep didn't flag the desk");
await say("yes");
await say("ledger");

const books = await elf.service.books(move);
console.log(
  `\nLive from Nessie: fund ${books.fundCents}c, escrow ${books.escrowCents}c, sales ${books.salesCents}c, spent ${books.spentCents}c, ${books.records} tagged records`,
);
// Truck $240 (a purchase); couch $90 released into the fund; desk refunded; Sam paid $80 into the fund.
const want = { escrowCents: 0, salesCents: 9000, spentCents: 24000 };
for (const [k, v] of Object.entries(want))
  if (books[k as keyof typeof want] !== v)
    throw new Error(`books.${k} is ${books[k as keyof typeof want]}, want ${v}`);
if (books.fundCents < 9000)
  throw new Error(`the couch sale didn't land in the Moving Fund (${books.fundCents}c)`);
const entries = await store.listEntries(move.id);
const ids = entries.flatMap((e) => [
  ...e.nessie.withdrawalIds,
  ...e.nessie.depositIds,
  ...e.nessie.purchaseIds,
  e.nessie.billId ?? "",
]);
console.log(`\nNessie records created: ${ids.filter(Boolean).length}`);
const people = await store.listPeople(move.id);
console.log(`Accounts: ${people.map((p) => `${p.name}=${p.nessieAccountId}`).join(", ")}`);
console.log(`Moving Fund (checking): ${await store.getFundAccount(move.id)}`);
console.log(`Escrow (savings): ${await store.getEscrowAccount(move.id)}`);

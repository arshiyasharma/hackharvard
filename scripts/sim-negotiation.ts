/**
 * Simulate an owner listing a couch and a buyer negotiating for it, on the in-memory transport (no Photon, no keys).
 * Usage: bun run scripts/sim-negotiation.ts [floorUsd] [listUsd] [buyer opening offer] ...more buyer lines
 *   e.g. bun run scripts/sim-negotiation.ts 80 120 50 "ok 90 then" "1"
 * Prints every text each side receives, labelled, so you can see what the owner and the buyer would each see.
 */
import { FakeLLM } from "@elves/llm";
import { FakeListings } from "@elves/listings";
import { ScriptTransport } from "@elves/photon";
import { createLogger, MemoryStore } from "@elves/shared";
import { createService } from "../apps/elves/src/service.ts";

const [floor = "80", list = "120", ...buyerLines] = process.argv.slice(2);
const script = buyerLines.length ? buyerLines : ["is it still available? would you take 50?", "ok what about 70", "90 is my best", "1"];
const OWNER = "+19195357564";
const BUYER = "+16175550101";

const transport = new ScriptTransport();
const store = new MemoryStore();
const service = createService({
  store,
  transport,
  llm: new FakeLLM(),
  memory: null,
  listings: new FakeListings(),
  debounceMs: 30,
  publicUrl: "https://elves.example",
  logger: createLogger("sim", "error"),
  sweepMs: 0,
});
const ctrl = new AbortController();
void service.run(ctrl.signal);

const who = (spaceId: string) => (spaceId === transport.spaceFor(OWNER) ? "OWNER's phone" : "BUYER's phone");
let printed = 0;
async function turn(handle: string, text: string) {
  console.log(`\n${handle === OWNER ? "OWNER" : "BUYER"} texts: ${text}`);
  transport.push(handle, text);
  await transport.settled();
  await service.pipeline.idle();
  for (const s of transport.sent.slice(printed)) console.log(`  -> ${who(s.spaceId)} receives: ${s.text.replace(/\n/g, "\n     ")}`);
  printed = transport.sent.length;
}

await turn(OWNER, "moving out nov 1, selling a couch");
const move = (await store.listMoves())[0]!;
const couch = (await store.listItems(move.id))[0]!;
await store.upsertItem({
  id: couch.id,
  moveId: move.id,
  name: couch.name,
  category: couch.category,
  floorPriceCents: Number(floor) * 100,
  listPriceCents: Number(list) * 100,
});
await turn(OWNER, "yes list it");
const deal = (await store.listDeals(move.id))[0]!;
console.log(`\n[owner pastes the ref into a post; the buyer sees it and texts ${deal.code}]`);

await turn(BUYER, `hi, is ${deal.code} still available?`);
for (const line of script) {
  await turn(BUYER, line);
  const ask = (await store.listDealParties(deal.id))[0]?.status;
  if (ask === "awaiting_owner") {
    console.log("\n[the buyer's offer is under the floor: the owner was asked. Owner answers:]");
    await turn(OWNER, "no, hold at my price");
  }
}
const end = (await store.listDeals(move.id))[0]!;
console.log(`\nFINAL: deal ${end.state}, agreed ${end.agreedCents != null ? `$${end.agreedCents / 100}` : "none"}, slot ${end.slot?.label ?? "none"}, floor was $${floor} (an agreed price is never below it)`);
ctrl.abort();
process.exit(0);

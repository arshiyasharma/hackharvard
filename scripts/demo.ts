/** Runs the service against the in-memory script transport and prints the conversation. No credentials needed. */
import { FakeListings } from "@elves/listings";
import { FakeLLM } from "@elves/llm";
import { InMemoryBackend, MoveMemory } from "@elves/memory";
import { ScriptTransport } from "@elves/photon";
import { createLogger, MemoryStore } from "@elves/shared";
import { createService } from "../apps/elves/src/service.ts";

const transport = new ScriptTransport();
const store = new MemoryStore();
const llm = new FakeLLM();
const memory = new MoveMemory({
  backend: new InMemoryBackend(),
  store,
  llm,
  logger: createLogger("memory", "warn"),
});
const service = createService({
  store,
  transport,
  llm,
  memory,
  listings: new FakeListings(),
  debounceMs: 150,
  publicUrl: "https://elves.example",
  logger: createLogger("demo", "warn"),
});
const ctrl = new AbortController();
void service.run(ctrl.signal);

let printed = 0;
function print() {
  for (const s of transport.sent.slice(printed))
    console.log(`🧝 (thread ${s.parentMessageId ?? "-"}): ${s.text.replace(/\n/g, "\n   ")}`);
  printed = transport.sent.length;
}

const owner = "+14255269066";
const say = async (...texts: string[]) => {
  for (const t of texts) {
    console.log(`👤 ${owner}: ${t}`);
    transport.push(owner, t);
  }
  await transport.settled();
  await service.pipeline.idle();
  print();
};

await say("Im moving out november 1 and i have a couch and a lamp to sell");
await say("also", "can you book storage", "for june to august");
await say("my landlord says i cant sublet, can you check the lease?");
await say("my roommate Sam can cover saturday pickups, I'd rather not do mornings, and I take venmo");
await say("looking for a room in allston under 1200 june 1 to aug 30");
await say("tell me about 2");
await memory.flush();

const move = (await store.listMoves())[0]!;
console.log("\n📋 Crew Board:");
for (const row of await store.getBoard(move.id))
  console.log(
    `  ${row.elf.padEnd(10)} ${row.status.padEnd(8)} ${row.currentTask}${row.lastUpdate ? ` — ${row.lastUpdate}` : ""}`,
  );
console.log(
  `\nmove-out: ${move.moveOutAt}  items: ${(await store.listItems(move.id)).map((i) => i.name).join(", ")}`,
);
console.log(`events: ${(await store.listEvents(move.id)).map((e) => e.type).join(", ")}`);
console.log(
  `reactions: ${transport.reactions.length}, typing events: ${transport.typingEvents.length}, replies: ${transport.sent.length}`,
);
const ctx = await memory.context({
  threadId: transport.spaceFor(owner),
  moveId: move.id,
  elf: "crew_lead",
  role: "owner",
  query: "pickup saturday",
});
console.log(`\n🧠 Memory (${memory.kind}): ${ctx.messageCount} messages, ~${ctx.tokens} tokens of context`);
console.log(ctx.workingMemory);
console.log("\nFacts the crew learned:\n" + (ctx.facts.join("\n") || "(none)"));
console.log(`\nTranscript window:\n${ctx.transcript}`);
ctrl.abort();

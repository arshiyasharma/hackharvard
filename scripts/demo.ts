/** Runs the service against the in-memory script transport and prints the conversation. No credentials needed. */
import { FakeLLM } from "@elves/llm";
import { ScriptTransport } from "@elves/photon";
import { createLogger, MemoryStore } from "@elves/shared";
import { createService } from "../apps/elves/src/service.ts";

const transport = new ScriptTransport();
const store = new MemoryStore();
const service = createService({
  store,
  transport,
  llm: new FakeLLM(),
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
ctrl.abort();

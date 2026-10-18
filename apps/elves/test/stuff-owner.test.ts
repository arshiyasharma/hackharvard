import { describe, expect, test } from "bun:test";
import { FakeListings } from "@elves/listings";
import { FakeLLM } from "@elves/llm";
import { ScriptTransport } from "@elves/photon";
import { createLogger, MemoryStore } from "@elves/shared";
import { createService } from "../src/service.ts";

const owner = "+14255269066";

function boot() {
  const transport = new ScriptTransport();
  const store = new MemoryStore();
  const service = createService({
    store,
    transport,
    llm: new FakeLLM(),
    memory: null,
    listings: new FakeListings(),
    debounceMs: 30,
    publicUrl: null,
    logger: createLogger("test", "error"),
  });
  const ctrl = new AbortController();
  void service.run(ctrl.signal);
  const say = async (text: string) => {
    const before = transport.sent.length;
    transport.push(owner, text);
    await transport.settled();
    await service.pipeline.idle();
    return transport.sent
      .slice(before)
      .map((s) => s.text)
      .join("\n");
  };
  return { store, say, stop: () => ctrl.abort() };
}

describe("Stuff Elf owner side through the service", () => {
  test("a yes lists only the item it answers; each listing gets its own deal and ref code", async () => {
    const b = boot();
    await b.say("moving out nov 1 and selling a couch and a lamp");
    await b.say("$80 for the couch");
    await b.say("$5 for the lamp");
    const reply = await b.say("yes");
    const move = (await b.store.listMoves())[0]!;
    const items = await b.store.listItems(move.id);
    expect(items.find((i) => i.name === "lamp")?.listingApproved).toBe(true);
    expect(items.find((i) => i.name === "couch")?.listingApproved).toBe(false);
    expect(await b.store.listDeals(move.id)).toHaveLength(1);
    expect(reply).toContain("lamp");

    await b.say("yes list the couch too");
    expect((await b.store.listItems(move.id)).every((i) => i.listingApproved)).toBe(true);
    expect(await b.store.listDeals(move.id)).toHaveLength(2);
    b.stop();
  });

  test("move report counts what left and what was dumped", async () => {
    const b = boot();
    await b.say("moving out nov 1 and selling a couch and a lamp");
    const move = (await b.store.listMoves())[0]!;
    const [couch, lamp] = await b.store.listItems(move.id);
    await b.store.upsertItem({ ...couch!, outcome: "donated", weightLb: 150 });
    await b.store.upsertItem({ ...lamp!, outcome: "dumped", weightLb: 10 });
    const reply = await b.say("send me the move report");
    expect(reply).toContain("150 lb");
    expect(reply).toContain("counts against");
    b.stop();
  });
});

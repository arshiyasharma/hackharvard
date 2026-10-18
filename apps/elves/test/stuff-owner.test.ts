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

  test("'list it' always answers with a ref code, 'list it at 200' sets the price, and a dumped item can be relisted", async () => {
    const b = boot();
    await b.say("moving out nov 1 and selling a couch");
    await b.say("$80 for the couch");
    const listed = await b.say("list it at 200");
    const move = (await b.store.listMoves())[0]!;
    let deals = await b.store.listDeals(move.id);
    expect(deals).toHaveLength(1);
    expect(deals[0]!.askCents).toBe(20000);
    expect(deals[0]!.limitCents).toBe(8000);
    expect(listed).toContain(deals[0]!.code);
    expect(listed).toContain("mention");

    // Last Call dumped it (or the sale fell through): the item is still the owner's, so "list it" reopens it
    const first = deals[0]!;
    await b.store.upsertDeal({ ...first, state: "dumped", outcome: "dumped" });
    const couch = (await b.store.listItems(move.id))[0]!;
    await b.store.upsertItem({
      id: couch.id,
      moveId: move.id,
      name: couch.name,
      category: couch.category,
      outcome: "dumped",
    });
    const again = await b.say("list it");
    deals = await b.store.listDeals(move.id);
    expect(deals).toHaveLength(2);
    const fresh = deals.find((d) => d.id !== first.id)!;
    expect(fresh.code).not.toBe(first.code);
    expect(again).toContain(fresh.code);
    expect((await b.store.listItems(move.id))[0]!.outcome).toBe("listed");
    b.stop();
  });

  test("asking for the ref code lists the item and hands it over; asking again reads it back", async () => {
    const b = boot();
    await b.say("moving out nov 1 and selling a chair and a lamp");
    await b.say("$5 for the chair");
    const listed = await b.say("can u list it and tell me the ref code");
    const move = (await b.store.listMoves())[0]!;
    const deals = await b.store.listDeals(move.id);
    expect(deals).toHaveLength(1);
    expect(listed).toContain(deals[0]!.code);
    expect(listed).toContain("mention");

    const again = await b.say("what ref code do i tell the buyer to enter for my chair");
    expect(again).toContain("📦 Ref codes for your listings:");
    expect(again).toContain(`chair: ${deals[0]!.code}`);
    expect(again).toContain("mention");
    expect(await b.store.listDeals(move.id)).toHaveLength(1);

    // the second item, once it has a floor: "did you make a ref code yet" lists it
    await b.say("$8 for the lamp");
    const lamp = await b.say("did u come up with a ref code yet");
    const two = await b.store.listDeals(move.id);
    expect(two).toHaveLength(2);
    expect(lamp).toContain(two.find((d) => d.title === "lamp")!.code);
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

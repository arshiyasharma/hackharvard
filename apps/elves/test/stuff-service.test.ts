import { describe, expect, test } from "bun:test";
import { bostonTime, type DealHooks } from "@elves/elves";
import { FakeListings } from "@elves/listings";
import { FakeLLM } from "@elves/llm";
import { InMemoryBackend, MoveMemory } from "@elves/memory";
import { ScriptTransport } from "@elves/photon";
import { createLogger, MemoryStore } from "@elves/shared";
import { createService } from "../src/service.ts";

const quiet = createLogger("test", "error");
const owner = "+14255269066";

function boot(deals?: DealHooks) {
  const transport = new ScriptTransport();
  const store = new MemoryStore();
  const llm = new FakeLLM();
  const memory = new MoveMemory({ backend: new InMemoryBackend(), store, llm, logger: quiet });
  const service = createService({
    store,
    transport,
    llm,
    memory,
    listings: new FakeListings(),
    debounceMs: 30,
    publicUrl: null,
    logger: quiet,
    deals,
    lastCallMs: 0,
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
  return { transport, store, service, say, stop: () => ctrl.abort() };
}

async function moveWithTwoPricedItems(b: ReturnType<typeof boot>) {
  await b.say("moving out nov 1 and selling a couch and a lamp");
  await b.say("$80 for the couch");
  await b.say("$5 for the lamp");
  const move = (await b.store.listMoves())[0]!;
  return move;
}

describe("Stuff Elf through the service", () => {
  test("a yes covers only the item it answers, and the Deal Engine hook gets it with a code back", async () => {
    const opened: string[] = [];
    const b = boot({
      async listingApproved(item) {
        opened.push(item.name);
        return { code: "K7Q2" };
      },
      async priceChanged() {},
      async itemWithdrawn() {},
    });
    const move = await moveWithTwoPricedItems(b);
    const reply = await b.say("yes");
    expect(opened).toEqual(["lamp"]);
    expect(reply).toContain("K7Q2");
    const items = await b.store.listItems(move.id);
    expect(items.find((i) => i.name === "lamp")?.listingApproved).toBe(true);
    expect(items.find((i) => i.name === "couch")?.listingApproved).toBe(false);
    expect(reply).toContain("couch"); // asks about the one still waiting

    await b.say("yes, the couch too");
    expect(opened).toEqual(["lamp", "couch"]);
    b.stop();
  });

  test("donate, then picked up: the outcome is logged and the item leaves the truck estimate", async () => {
    const b = boot();
    const move = await moveWithTwoPricedItems(b);
    const r1 = await b.say("donate the lamp");
    expect(r1).toContain("donation");
    expect((await b.store.listItems(move.id)).find((i) => i.name === "lamp")?.intent).toBe("donate");

    const r2 = await b.say("the lamp got picked up");
    expect(r2).toContain("lamp donated");
    const lamp = (await b.store.listItems(move.id)).find((i) => i.name === "lamp")!;
    expect(lamp.outcome).toBe("donated");
    expect(lamp.leavesBeforeMoveDay).toBe(true);
    const types = (await b.store.listEvents(move.id)).map((e) => e.type);
    expect(types).toContain("item.leaving");

    const report = await b.say("move report");
    expect(report).toContain("lb off the curb");
    b.stop();
  });

  test("keep pulls an item from sale; Last Call texts the owner once per stage and skips kept items", async () => {
    const b = boot();
    const move = await moveWithTwoPricedItems(b);
    await b.say("yes list both");
    const keep = await b.say("keep the couch");
    expect(keep).toContain("Keeping the couch");
    expect((await b.store.listItems(move.id)).find((i) => i.name === "couch")?.outcome).toBe("kept");

    const t0 = bostonTime("2026-11-01", 18).getTime();
    const sentBefore = b.transport.sent.length;
    const run = await b.service.tickLastCall({ at: new Date(t0 - 47 * 3600_000) });
    expect(run).toEqual([{ moveId: move.id, stage: "dropped", sent: true }]);
    const msg = b.transport.sent[sentBefore]!;
    expect(msg.text).toContain("lamp");
    expect(msg.text).not.toContain("couch");
    expect(msg.spaceId).toBe(move.ownerSpaceId);

    const again = await b.service.tickLastCall({ at: new Date(t0 - 46 * 3600_000) });
    expect(again[0]!.sent).toBe(false);
    expect(b.transport.sent.length).toBe(sentBefore + 1);

    await b.service.tickLastCall({ at: new Date(t0 - 20 * 3600_000) });
    expect((await b.store.listItems(move.id)).find((i) => i.name === "lamp")?.listPriceCents).toBe(0);
    b.stop();
  });

  test("questions are not outcomes, and an unknown item falls through to selling", async () => {
    const b = boot();
    const move = await moveWithTwoPricedItems(b);
    await b.say("when does the lamp get picked up?");
    expect((await b.store.listItems(move.id)).every((i) => i.outcome === "listed")).toBe(true);
    b.stop();
  });
});

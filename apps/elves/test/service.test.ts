import { describe, expect, test } from "bun:test";
import { FakeLLM } from "@elves/llm";
import { ScriptTransport } from "@elves/photon";
import { createLogger, MemoryStore } from "@elves/shared";
import { createService } from "../src/service.ts";

const quiet = createLogger("test", "error");
const owner = "+14255269066";

function boot(publicUrl: string | null = "https://elves.example") {
  const transport = new ScriptTransport();
  const store = new MemoryStore();
  const llm = new FakeLLM();
  const service = createService({ store, transport, llm, debounceMs: 40, publicUrl, logger: quiet });
  const ctrl = new AbortController();
  void service.run(ctrl.signal);
  return { transport, store, service, llm, stop: () => ctrl.abort() };
}

const CHAIR = {
  items: [
    {
      name: "white plastic armchair",
      category: "chair",
      condition: "good",
      weightLb: 18,
      priceLowUsd: 25,
      priceHighUsd: 40,
      title: "White plastic armchair with navy seat",
      description: "Sturdy white armchair with a navy upholstered seat and casters. Good condition.",
    },
  ],
  notes: null,
};

describe("service end to end (script transport)", () => {
  test("first text creates a move and gets a reaction, typing and a threaded Crew Lead reply", async () => {
    const { transport, store, service, stop } = boot();
    const m = transport.push(owner, "Im moving out november 1 and i have a couch and a lamp to sell");
    await transport.waitForSends(1);
    await transport.settled();
    await service.pipeline.idle();
    expect(transport.reactions).toEqual([{ messageId: m.id, emoji: "👍" }]);
    expect(transport.typingEvents.map((t) => t.on)).toEqual([true, false]);
    expect(transport.reads).toEqual([m.id]);
    expect(transport.sent.length).toBe(1); // no link in a first message
    expect(transport.sent[0]!.parentMessageId).toBe(m.id);
    expect(transport.sent[0]!.senderId).toBe(m.agentId);
    expect(transport.sent[0]!.text).toContain("Nov 1");
    expect(transport.sent[0]!.text).toContain("couch");
    const move = (await store.listMoves())[0]!;
    expect(move.ownerHandle).toBe(owner);
    expect(move.moveOutAt).toBe("2026-11-01");
    expect((await store.listItems(move.id)).map((i) => i.name)).toEqual(["couch", "lamp"]);
    const board = await store.getBoard(move.id);
    expect(board.find((b) => b.elf === "sell")?.status).toBe("working");
    const types = (await store.listEvents(move.id)).map((e) => e.type);
    expect(types).toContain("move.created");
    expect(types).toContain("reply.sent");
    stop();
  });

  test("three rapid texts produce one reply, routed by content; the board link follows once", async () => {
    const { transport, store, service, stop } = boot();
    transport.push(owner, "hi");
    await transport.waitForSends(1);
    await transport.settled();
    await service.pipeline.idle();
    transport.push(owner, "also");
    transport.push(owner, "can you book storage");
    transport.push(owner, "for june to august");
    await transport.settled();
    await service.pipeline.idle();
    // second batch: one Haul reply (stub Elves don't send the board link)
    const haul = transport.sent.filter((s) => s.text.startsWith("Haul Elf"));
    expect(haul.length).toBe(1);
    expect(transport.sent.length).toBe(2);
    const move = (await store.listMoves())[0]!;
    expect((await store.getBoard(move.id)).find((b) => b.elf === "haul")?.status).toBe("working");
    // a reply inside the Haul thread stays with Haul
    transport.push(owner, "june 2 to aug 30", { parentMessageId: haul[0]!.id });
    await transport.settled();
    await service.pipeline.idle();
    expect(transport.sent[2]!.text.startsWith("Haul Elf")).toBe(true);
    stop();
  });

  test("the Crew Lead sends the board link once, on a later turn, when a public URL exists", async () => {
    const { transport, service, stop } = boot("https://elves.example");
    transport.push(owner, "hi");
    await transport.settled();
    await service.pipeline.idle();
    transport.push(owner, "what's the plan");
    await transport.settled();
    await service.pipeline.idle();
    const links = transport.sent.filter((s) => s.text.includes("https://elves.example/b/"));
    expect(links.length).toBe(1);
    transport.push(owner, "status?");
    await transport.settled();
    await service.pipeline.idle();
    expect(transport.sent.filter((s) => s.text.includes("/b/")).length).toBe(1);
    stop();
  });

  test("sends are idempotent per batch", async () => {
    const { transport, store, service, stop } = boot(null);
    const m = transport.push(owner, "hello");
    await transport.settled();
    await service.pipeline.idle();
    expect(transport.sent.length).toBe(1);
    // replaying the same batch does not double-post
    await service.handleBatch(
      { spaceId: m.spaceId, messages: [m], traceId: "replay", carried: 0 },
      { signal: new AbortController().signal },
    );
    expect(transport.sent.length).toBe(1);
    expect(await store.getSend(`reply:${m.id}:0`)).toBeDefined();
    stop();
  });
});

describe("photo intake and pricing", () => {
  test("a photo on first contact is identified by the Crew Lead; a later price sets the floor via the Sell Elf", async () => {
    const { transport, store, service, llm, stop } = boot(null);
    llm.visionResult = CHAIR;
    transport.addAttachment("att_chair", new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg", "IMG_1.jpg");
    transport.push(owner, null, { attachments: [{ id: "att_chair" }] });
    await transport.settled();
    await service.pipeline.idle();
    expect(transport.sent.length).toBe(1);
    expect(transport.sent[0]!.text).toContain("white plastic armchair");
    expect(transport.sent[0]!.text).toContain("$25–$40");
    const move = (await store.listMoves())[0]!;
    const items = await store.listItems(move.id);
    expect(items.length).toBe(1);
    expect(items[0]!.title).toBe("White plastic armchair with navy seat");
    expect(items[0]!.listPriceCents).toBe(3500);
    expect(items[0]!.photoAttachmentIds).toEqual(["att_chair"]);

    transport.push(owner, "4 dollars");
    await transport.settled();
    await service.pipeline.idle();
    expect(transport.sent.length).toBe(2);
    expect(transport.sent[1]!.text).toContain("Floor $4");
    expect(transport.sent[1]!.text).toContain("$35");
    const after = await store.listItems(move.id);
    expect(after[0]!.floorPriceCents).toBe(400);
    expect(after[0]!.listPriceCents).toBe(3500);
    const types = (await store.listEvents(move.id)).map((e) => e.type);
    expect(types).toContain("item.identified");
    expect(types).toContain("item.floor_set");
    expect((await store.getBoard(move.id)).find((b) => b.elf === "sell")?.lastUpdate).toContain("Floor $4");

    // approval inside the Sell thread marks it listed
    transport.push(owner, "yes go ahead", { parentMessageId: transport.sent[1]!.id });
    await transport.settled();
    await service.pipeline.idle();
    expect(transport.sent[2]!.text).toContain("Listed");
    expect((await store.listItems(move.id))[0]!.listingApproved).toBe(true);
    expect((await store.listEvents(move.id)).map((e) => e.type)).toContain("listing.approved");

    // the Crew Lead never re-asks for a photo or floor it already has
    transport.push(owner, "moving out nov 1");
    await transport.settled();
    await service.pipeline.idle();
    expect(transport.sent[3]!.text).not.toContain("photo");
    expect(transport.sent[3]!.text).not.toContain("lowest");
    stop();
  });

  test("an unreadable photo gets an honest ask instead of a crash", async () => {
    const { transport, service, stop } = boot(null);
    transport.push(owner, "hi");
    await transport.settled();
    await service.pipeline.idle();
    transport.push(owner, null, { attachments: [{ id: "missing" }] });
    await transport.settled();
    await service.pipeline.idle();
    expect(transport.sent.length).toBe(2);
    expect(transport.sent[1]!.text).toContain("couldn't read");
    stop();
  });
});

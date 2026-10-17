import { describe, expect, test } from "bun:test";
import { FakeListings, type ListingSource } from "@elves/listings";
import { FakeLLM } from "@elves/llm";
import { InMemoryBackend, type MemoryBackend, MoveMemory } from "@elves/memory";
import { ScriptTransport } from "@elves/photon";
import { createLogger, MemoryStore, type Store } from "@elves/shared";
import { createService } from "../src/service.ts";

const quiet = createLogger("test", "error");
const owner = "+14255269066";

/** A fresh service; pass the same store + backend twice to simulate a restart against durable storage. */
function boot(
  publicUrl: string | null = "https://elves.example",
  durable: {
    store?: Store;
    backend?: MemoryBackend | null;
    idPrefix?: string;
    listings?: ListingSource;
  } = {},
) {
  const transport = new ScriptTransport(undefined, undefined, durable.idPrefix);
  const store = durable.store ?? new MemoryStore();
  const llm = new FakeLLM();
  const backend = durable.backend === undefined ? new InMemoryBackend() : durable.backend;
  const memory = backend ? new MoveMemory({ backend, store, llm, logger: quiet }) : null;
  const listings = durable.listings ?? new FakeListings();
  const service = createService({
    store,
    transport,
    llm,
    memory,
    listings,
    debounceMs: 40,
    publicUrl,
    logger: quiet,
  });
  const ctrl = new AbortController();
  void service.run(ctrl.signal);
  return { transport, store, service, llm, memory, stop: () => ctrl.abort() };
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
    expect(board.find((b) => b.elf === "stuff")?.status).toBe("working");
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
    // second batch: one Move-day reply (stub Elves don't send the board link)
    const haul = transport.sent.filter((s) => s.text.startsWith("Move-day Elf"));
    expect(haul.length).toBe(1);
    expect(transport.sent.length).toBe(2);
    const move = (await store.listMoves())[0]!;
    expect((await store.getBoard(move.id)).find((b) => b.elf === "moveday")?.status).toBe("working");
    // a reply inside the Move-day thread stays with Move-day
    transport.push(owner, "june 2 to aug 30", { parentMessageId: haul[0]!.id });
    await transport.settled();
    await service.pipeline.idle();
    expect(transport.sent[2]!.text.startsWith("Move-day Elf")).toBe(true);
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
  test("a photo on first contact is identified by the Crew Lead; a later price sets the floor via the Stuff Elf", async () => {
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
    expect((await store.getBoard(move.id)).find((b) => b.elf === "stuff")?.lastUpdate).toContain("Floor $4");

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

describe("memory", () => {
  test("transcript, working memory and facts build up across turns; the next Elf sees them", async () => {
    const { transport, store, service, memory, stop } = boot(null);
    transport.push(owner, "moving out november 1, couch to sell");
    await transport.settled();
    await service.pipeline.idle();
    transport.push(owner, "lowest 80");
    await transport.settled();
    await service.pipeline.idle();
    transport.push(owner, "my roommate Sam can cover saturday pickups and I'd rather not do mornings");
    await transport.settled();
    await service.pipeline.idle();
    await memory!.flush();
    const move = (await store.listMoves())[0]!;
    const ctx = await memory!.context({
      threadId: transport.spaceFor(owner),
      moveId: move.id,
      role: "owner",
      query: "saturday",
    });
    expect(ctx.messageCount).toBe(6); // 3 owner texts + 3 replies
    expect(ctx.transcript.startsWith("Owner: moving out november 1")).toBe(true);
    expect(ctx.transcript).toContain("Crew Lead:");
    expect(ctx.transcript).toContain("Stuff Elf:");
    expect(ctx.workingMemory).toContain("Move-out date: 2026-11-01");
    expect(ctx.workingMemory).toContain("couch · floor $80");
    expect(ctx.facts.join("\n")).toContain("Roommate Sam");
    expect(ctx.facts.join("\n")).toContain("rather not do mornings");
    const stats = service.stats() as { memory: { factsCreated: number; kind: string } };
    expect(stats.memory.kind).toBe("memory");
    expect(stats.memory.factsCreated).toBeGreaterThanOrEqual(2);
    stop();
  });

  test("a restarted service on the same store and memory continues the move instead of greeting the owner as new", async () => {
    const store = new MemoryStore();
    const backend = new InMemoryBackend();
    const a = boot(null, { store, backend });
    a.transport.push(owner, "moving out november 1, couch to sell");
    await a.transport.settled();
    await a.service.pipeline.idle();
    await a.memory!.flush();
    const moveA = (await store.listMoves())[0]!;
    a.stop();

    // new process: same durable store and memory, same space (fresh Photon ids, as in production)
    const b = boot(null, { store, backend, idPrefix: "b_" });
    const m = b.transport.push(owner, "what's my move-out date?");
    await b.transport.settled();
    await b.service.pipeline.idle();
    const moveB = (await store.listMoves())[0]!;
    expect(moveB.id).toBe(moveA.id);
    expect(moveB.moveOutAt).toBe("2026-11-01");
    expect((await store.listItems(moveB.id)).map((i) => i.name)).toEqual(["couch"]);
    expect(b.transport.sent[0]!.text).not.toContain("this is your moving crew");
    expect(b.transport.sent[0]!.parentMessageId).toBe(m.id);
    const ctx = await b.memory!.context({ threadId: b.transport.spaceFor(owner), moveId: moveB.id });
    expect(ctx.messageCount).toBe(4);
    b.stop();
  });

  test("memory off: the service still answers and reports memory as off", async () => {
    const { transport, service, stop } = boot(null, { backend: null });
    transport.push(owner, "hi");
    await transport.settled();
    await service.pipeline.idle();
    expect(transport.sent.length).toBe(1);
    expect((service.stats() as { memory: { kind: string } }).memory.kind).toBe("off");
    stop();
  });
});

describe("housing hunt", () => {
  const ask = "looking for a room in allston under 1200 june 1 to aug 30";

  test("ack first, then the picks; follow-ups find their way back to the Home Elf", async () => {
    const { transport, store, service, memory, stop } = boot(null);
    transport.push(owner, "hi");
    await transport.settled();
    await service.pipeline.idle();
    const m = transport.push(owner, ask);
    await transport.settled();
    await service.pipeline.idle();
    expect(transport.sent.length).toBe(3);
    const [, ack, picks] = transport.sent;
    expect(ack!.text).toContain("Checking Craigslist");
    expect(ack!.parentMessageId).toBe(m.id);
    expect(picks!.text.startsWith("Top picks for a room in Allston")).toBe(true);
    expect(picks!.text).toContain("1. Sunny furnished room");
    expect(picks!.text).toContain("https://");
    expect(picks!.senderId).toBe(m.agentId);
    expect(transport.typingEvents[transport.typingEvents.length - 1]?.on).toBe(false);
    expect(await store.getThreadOwner(picks!.id)).toBe("home");
    expect(await store.getThreadOwner(`space:${m.spaceId}`)).toBe("home");
    const move = (await store.listMoves())[0]!;
    expect((await store.listListings(move.id)).filter((l) => l.rank != null).length).toBe(3);
    expect((await store.getBoard(move.id)).find((b) => b.elf === "home")?.status).toBe("working");
    const types = (await store.listEvents(move.id)).map((e) => e.type);
    expect(types).toContain("housing.search_started");
    expect(types).toContain("housing.search_done");
    expect(await store.getSend(`reply:${m.id}:1`)).toBeDefined();

    // "2" after a list of picks is pick 2, not a $2 floor for the Stuff Elf
    transport.push(owner, "2");
    await transport.settled();
    await service.pipeline.idle();
    expect(transport.sent[3]!.text).toContain("2. Allston Green");
    expect(
      (await store.listEvents(move.id)).find(
        (e) => e.type === "message.routed" && e.payload.via === "followup",
      ),
    ).toBeDefined();

    transport.push(owner, "more");
    await transport.settled();
    await service.pipeline.idle();
    expect(transport.sent[4]!.text).toContain("That's everything I found");

    const ctx = await memory!.context({
      threadId: transport.spaceFor(owner),
      moveId: move.id,
      role: "owner",
    });
    expect(ctx.workingMemory).toContain("## Housing search");
    expect(ctx.workingMemory).toContain("Allston");
    expect(ctx.workingMemory).toContain("1. Sunny furnished room");
    stop();
  });

  test("a text that arrives during the search waits for it instead of cancelling it", async () => {
    const { transport, service, stop } = boot(null, { listings: new FakeListings({ delayMs: 200 }) });
    transport.push(owner, "hi");
    await transport.settled();
    await service.pipeline.idle();
    transport.push(owner, ask);
    await transport.waitForSends(2); // greeting + ack; the search is running
    transport.push(owner, "thanks!");
    await transport.settled();
    await service.pipeline.idle();
    expect(service.pipeline.stats.cancelled).toBe(0);
    const texts = transport.sent.map((s) => s.text);
    expect(texts[2]!.startsWith("Top picks")).toBe(true);
    expect(texts.length).toBe(4);
    stop();
  });
});

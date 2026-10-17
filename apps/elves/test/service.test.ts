import { describe, expect, test } from "bun:test";
import { moveOutInstant } from "@elves/engine";
import { FakeListings, type ListingSource } from "@elves/listings";
import { FakeLLM } from "@elves/llm";
import { InMemoryBackend, type MemoryBackend, MoveMemory } from "@elves/memory";
import { ScriptTransport } from "@elves/photon";
import { createLogger, MemoryStore, type Store } from "@elves/shared";
import { createService } from "../src/service.ts";

const quiet = createLogger("test", "error");
const owner = "+14255269066";

/** A move-out date whose Boston midnight is inside the next `hours` hours (1–24). */
function moveOutWithin(hours: number): string {
  for (let delta = 0; delta <= 2; delta++) {
    const day = new Date(Date.now() + delta * 86_400_000);
    const iso = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(day);
    const instant = moveOutInstant(iso);
    if (!instant) continue;
    const left = (instant.getTime() - Date.now()) / 3_600_000;
    if (left > 0 && left <= hours) return iso;
  }
  throw new Error(`no move-out inside ${hours}h`);
}

/** A fresh service; pass the same store + backend twice to simulate a restart against durable storage. */
function boot(
  publicUrl: string | null = "https://elves.example",
  durable: {
    store?: Store;
    backend?: MemoryBackend | null;
    idPrefix?: string;
    listings?: ListingSource;
    now?: () => Date;
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
    now: durable.now,
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

    transport.push(owner, "search again");
    await transport.settled();
    await service.pipeline.idle();
    expect(transport.sent.at(-2)!.text).toContain("Checking Craigslist");
    expect(transport.sent.at(-1)!.text.startsWith("Top picks")).toBe(true);

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

  test("reach out to a pick with a phone: the dedicated line texts the lister and relays their reply through the deal", async () => {
    const { transport, store, service, memory, stop } = boot(null);
    const lister = "+16175550142"; // the number on pick 2 (Allston Green)
    transport.push(owner, "hi");
    await transport.settled();
    await service.pipeline.idle();
    transport.push(owner, ask);
    await transport.settled();
    await service.pipeline.idle();
    const ownerSpace = transport.spaceFor(owner);
    const before = transport.sent.length;

    const m = transport.push(owner, "reach out to 2");
    await transport.settled();
    await service.pipeline.idle();
    const out = transport.sent.slice(before);
    expect(out).toHaveLength(2);
    const [toLister, toOwner] = out;
    const listerSpace = transport.spaceFor(lister);
    expect(toLister!.spaceId).toBe(listerSpace);
    expect(toLister!.senderId).toBe(transport.dedicatedId);
    expect(toLister!.text).toStartWith("Hi, I saw your listing for Allston Green");
    expect(toLister!.text).not.toContain(owner);
    expect(toOwner!.spaceId).toBe(ownerSpace);
    expect(toOwner!.senderId).toBe(m.agentId);
    expect(toOwner!.parentMessageId).toBe(m.id);
    expect(toOwner!.text).toStartWith(`Texted them from ${transport.dedicatedHandle}:`);
    expect(toOwner!.text).toContain("I'll relay what they say");

    const move = (await store.listMoves())[0]!;
    const deal = (await store.listDeals(move.id)).find((d) => d.mode === "find_sublet")!;
    expect(deal.ownerThreadId).toBe(toOwner!.id);
    expect(toOwner!.text).toContain(`Ref ${deal.code}`);
    const party = (await store.listDealParties(deal.id))[0]!;
    expect(party).toMatchObject({ spaceId: listerSpace, handle: lister, role: "lister" });
    expect(await store.getParticipantBySpace(listerSpace)).toMatchObject({
      moveId: move.id,
      role: "lister",
      agentUserId: transport.dedicatedId,
    });
    expect(await store.getThreadOwner(`space:${listerSpace}`)).toBe("home");
    const types = (await store.listEvents(move.id)).map((e) => e.type);
    expect(types).toContain("housing.lister_texted");
    expect(types).toContain("deal.party_joined");
    expect(types).toContain("outbound.sent");

    // The lister answers the line: no new move, the engine handles it, the owner gets a threaded summary.
    const n = transport.sent.length;
    const reply = transport.push(lister, "Yes it's still available, $1250 a month");
    expect(reply.agentId).toBe(transport.dedicatedId);
    await transport.settled();
    await service.pipeline.idle();
    expect((await store.listMoves()).length).toBe(1);
    const after = transport.sent.slice(n);
    const back = after.find((s) => s.spaceId === listerSpace)!;
    expect(back.senderId).toBe(transport.dedicatedId);
    expect(back.text).toContain("$1,250/mo");
    const summary = after.find((s) => s.spaceId === ownerSpace)!;
    expect(summary.parentMessageId).toBe(toOwner!.id);
    expect(summary.senderId).toBe(m.agentId);
    expect(summary.text).toContain("Allston Green");
    expect(summary.text).toContain("$1,250/mo");
    expect((await store.getDeal(deal.id))?.state).toBe("negotiating");
    expect(
      (await store.listEvents(move.id)).find(
        (e) => e.type === "message.routed" && e.payload.via === "counterparty" && e.payload.elf === "home",
      ),
    ).toBeDefined();
    // The lister's thread memory never carries the owner's number.
    const ctx = await memory!.context({ threadId: listerSpace, moveId: move.id, role: "lister" });
    expect(ctx.transcript).toContain("Hi, I saw your listing");
    expect(ctx.transcript).not.toContain(owner);
    stop();
  });

  test("reach out to a pick with no phone: the owner sends the note, as before", async () => {
    const { transport, service, stop } = boot(null);
    transport.push(owner, "hi");
    await transport.settled();
    await service.pipeline.idle();
    transport.push(owner, ask);
    await transport.settled();
    await service.pipeline.idle();
    const before = transport.sent.length;
    transport.push(owner, "reach out to 1");
    await transport.settled();
    await service.pipeline.idle();
    const out = transport.sent.slice(before);
    expect(out).toHaveLength(1);
    expect(out[0]!.spaceId).toBe(transport.spaceFor(owner));
    expect(out[0]!.text).toContain("You send this; I won't contact them");
    expect(transport.opened.size).toBe(0);
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

describe("Deal Engine: buyers text the listing's number", () => {
  const buyerA = "+16175550101";
  const buyerB = "+16175550102";

  /** Owner sends a chair photo, sets a $28 floor and approves; returns the deal. */
  async function listChair(t: ReturnType<typeof boot>) {
    const { transport, store, service, llm } = t;
    llm.visionResult = CHAIR;
    transport.addAttachment("att_chair", new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg", "IMG_1.jpg");
    transport.push(owner, null, { attachments: [{ id: "att_chair" }] });
    await transport.settled();
    await service.pipeline.idle();
    transport.push(owner, "28 dollars");
    await transport.settled();
    await service.pipeline.idle();
    transport.push(owner, "yes list it", { parentMessageId: transport.sent[1]!.id });
    await transport.settled();
    await service.pipeline.idle();
    const move = (await store.listMoves())[0]!;
    const deal = (await store.listDeals(move.id))[0]!;
    return { move, deal, listedMsg: transport.sent[2]! };
  }

  async function say(t: ReturnType<typeof boot>, from: string, text: string, extra = {}) {
    const before = t.transport.sent.length;
    t.transport.push(from, text, extra);
    await t.transport.settled();
    await t.service.pipeline.idle();
    return t.transport.sent.slice(before);
  }

  test("approval opens a deal with a ref code and the post line; the deal threads under that message", async () => {
    const t = boot(null);
    const { deal, listedMsg } = await listChair(t);
    expect(deal).toMatchObject({ mode: "sell_item", state: "listed", askCents: 3500, limitCents: 2800 });
    expect(deal.code).toMatch(/^[A-Z][0-9][A-Z][0-9]$/);
    expect(listedMsg.text).toContain(deal.code);
    expect(listedMsg.text).toContain(t.transport.agentHandle);
    expect(deal.ownerThreadId).toBe(listedMsg.id);
    t.stop();
  });

  test("a buyer negotiates in their own space; the owner only sees threaded summaries and one question", async () => {
    const t = boot(null);
    const { move, deal, listedMsg } = await listChair(t);
    const ownerSpace = t.transport.spaceFor(owner);
    const buyerSpace = t.transport.spaceFor(buyerA);

    // First text quotes the code: the buyer joins the owner's move, no new move is created.
    let out = await say(t, buyerA, `hi is ${deal.code} still available?`);
    expect((await t.store.listMoves()).length).toBe(1);
    expect((await t.store.getParticipantBySpace(buyerSpace))?.role).toBe("buyer");
    expect(out.map((s) => s.spaceId)).toEqual([buyerSpace]);
    expect(out[0]!.text).toContain("$35");

    out = await say(t, buyerA, "would you take 20?");
    expect(out.map((s) => s.spaceId)).toEqual([buyerSpace]);
    expect(out[0]!.text).toBe("I can do $30.");

    // Past the floor and final: the buyer hears "checking", the owner gets one threaded question.
    out = await say(t, buyerA, "20 is my final offer");
    const toBuyer = out.filter((s) => s.spaceId === buyerSpace);
    const toOwner = out.filter((s) => s.spaceId === ownerSpace);
    expect(toBuyer.map((s) => s.text)).toEqual(["Let me check with the owner and get back to you."]);
    expect(toOwner.length).toBe(1);
    expect(toOwner[0]!.text).toContain("$20");
    expect(toOwner[0]!.text).toContain("floor $28");
    expect(toOwner[0]!.parentMessageId).toBe(listedMsg.id);

    // The owner answers in that thread: the buyer gets the yes and three pickup times.
    out = await say(t, owner, "yes", { parentMessageId: toOwner[0]!.id });
    expect(out.find((s) => s.spaceId === ownerSpace)?.text).toContain("Done: $20");
    const yes = out.find((s) => s.spaceId === buyerSpace)!;
    expect(yes.text).toStartWith("Good news: the owner said yes.");
    expect(yes.text).toContain("1)");

    out = await say(t, buyerA, "1");
    expect(out.find((s) => s.spaceId === buyerSpace)?.text).toStartWith("Booked:");
    expect(out.find((s) => s.spaceId === ownerSpace)?.text).toContain("picks up the white plastic armchair");
    expect((await t.store.getDeal(deal.id))?.state).toBe("scheduled");
    // The buyer's thread memory is the public listing only.
    const ctx = await t.memory!.context({
      threadId: buyerSpace,
      moveId: move.id,
      role: "buyer",
      query: "price",
    });
    expect(ctx.workingMemory).toContain("asking");
    expect(ctx.workingMemory).not.toContain("$28");
    expect(ctx.workingMemory).not.toContain(owner);

    // A second buyer (matched by the item word) is waitlisted while the booking holds.
    out = await say(t, buyerB, "is the armchair still for sale?");
    expect(out[0]!.spaceId).toBe(t.transport.spaceFor(buyerB));
    expect(out[0]!.text).toContain("I'll text you if it falls through");

    out = await say(t, buyerA, "picked it up, thanks!");
    const closed = (await t.store.getDeal(deal.id))!;
    expect(closed.state).toBe("handed_off");
    expect(closed.outcome).toBe("sold");
    expect((await t.store.listItems(move.id))[0]!.outcome).toBe("sold");
    expect(out.find((s) => s.spaceId === t.transport.spaceFor(buyerB))?.text).toContain(
      "went to someone else",
    );
    const types = (await t.store.listEvents(move.id)).map((e) => e.type);
    for (const ty of [
      "deal.party_joined",
      "deal.countered",
      "deal.owner_asked",
      "deal.agreed",
      "deal.scheduled",
      "deal.handed_off",
      "escrow.requested",
    ])
      expect(types).toContain(ty);

    // Nothing the buyer received carries the floor.
    for (const s of t.transport.sent.filter((s) => s.spaceId === buyerSpace))
      expect(s.text).not.toContain("$28");
    // The owner's working memory has the deal with its line.
    const own = await t.memory!.context({ threadId: ownerSpace, moveId: move.id, role: "owner" });
    expect(own.workingMemory).toContain(`ref ${deal.code}`);
    expect(own.workingMemory).toContain("line $28");
    const board = await t.store.getBoard(move.id);
    expect(board.find((b) => b.elf === "stuff")?.currentTask).toContain("Deals:");
    t.stop();
  });

  test("a stranger with no code and nothing to match still starts their own move", async () => {
    const t = boot(null);
    await listChair(t);
    await say(t, buyerA, "hi im moving out next week");
    expect((await t.store.listMoves()).length).toBe(2);
    t.stop();
  });

  test("Scam Shield stops a pay-outside-escrow buyer and tells the owner", async () => {
    const t = boot(null);
    const { deal } = await listChair(t);
    const out = await say(
      t,
      buyerA,
      `${deal.code} i'm overseas, my mover will pick it up and i'll send a cashier's check`,
    );
    expect(out.find((s) => s.spaceId === t.transport.spaceFor(buyerA))?.text).toContain("I'll pass");
    expect(out.find((s) => s.spaceId === t.transport.spaceFor(owner))?.text).toContain("Scam Shield");
    t.stop();
  });

  test("Last Call drops the price 48h out, and the owner can hold it", async () => {
    const now = new Date("2026-10-15T14:00:00Z");
    const t = boot(null, { now: () => now });
    const { move, deal } = await listChair(t);
    await say(t, buyerA, `${deal.code} would you take 10`);
    await t.store.updateMove(move.id, { moveOutAt: "2026-10-17" });
    const before = t.transport.sent.length;
    expect(await t.service.sweep()).toBe(2);
    const sent = t.transport.sent.slice(before);
    expect(sent.find((s) => s.spaceId === t.transport.spaceFor(owner))?.text).toContain("dropped to $21");
    expect(sent.find((s) => s.spaceId === t.transport.spaceFor(buyerA))?.text).toContain("$21");
    expect((await t.store.getDeal(deal.id))?.lastCallStage).toBe("dropped");
    expect(await t.service.sweep()).toBe(0);
    t.stop();

    const held = boot(null, { now: () => now });
    const listed = await listChair(held);
    await say(held, owner, "keep the armchair");
    await held.store.updateMove(listed.move.id, { moveOutAt: "2026-10-17" });
    expect(await held.service.sweep()).toBe(0);
    expect((await held.store.getDeal(listed.deal.id))?.lastCallOptOut).toBe(true);
    held.stop();
  });

  test("Last Call relists an unsold item free inside 24h of move-out, once", async () => {
    const t = boot(null);
    const { move, deal } = await listChair(t);
    await say(t, buyerA, `${deal.code} would you take 10`);
    await t.store.updateMove(move.id, { moveOutAt: moveOutWithin(24) });
    const before = t.transport.sent.length;
    expect(await t.service.sweep()).toBe(2);
    const sent = t.transport.sent.slice(before);
    expect(sent.find((s) => s.spaceId === t.transport.spaceFor(owner))?.text).toContain("Last Call");
    expect(sent.find((s) => s.spaceId === t.transport.spaceFor(buyerA))?.text).toContain("free now");
    expect((await t.store.getDeal(deal.id))?.state).toBe("relisted");
    expect(await t.service.sweep()).toBe(0);
    t.stop();
  });

  test("a thumbs-up on the owner's question counts as yes", async () => {
    const t = boot(null);
    const { deal } = await listChair(t);
    await say(t, buyerA, `${deal.code} would you take 20?`);
    await say(t, buyerA, "20 is my final offer");
    const ask = [...t.transport.sent]
      .reverse()
      .find((s) => s.spaceId === t.transport.spaceFor(owner) && s.text.includes("$20"));
    expect(ask).toBeTruthy();
    const out = await say(t, owner, "", {
      reaction: { emoji: "👍", action: "add" },
      parentMessageId: ask!.id,
    });
    expect(out.find((s) => s.spaceId === t.transport.spaceFor(buyerA))?.text).toContain("said yes");
    t.stop();
  });

  test("buy waits for yes, then opens a deal at the owner's ceiling", async () => {
    const t = boot(null);
    await listChair(t);
    const asked = await say(t, owner, "buy this https://craigslist.org/desk for $40");
    expect(asked[0]?.text).toContain("Say yes");
    expect(await t.store.listDeals((await t.store.listMoves())[0]!.id)).toHaveLength(1);
    const out = await say(t, owner, "yes");
    expect(out[0]?.text).toContain("Ceiling set at $40");
    const deals = await t.store.listDeals((await t.store.listMoves())[0]!.id);
    expect(deals.some((d) => d.mode === "buy_item" && d.limitCents === 4000)).toBe(true);
    t.stop();
  });

  test("donate waits for yes, then marks the item donated", async () => {
    const t = boot(null);
    const { move, deal } = await listChair(t);
    const asked = await say(t, owner, "donate the armchair");
    expect(asked[0]?.text).toContain("Say yes");
    expect((await t.store.getDeal(deal.id))?.state).toBe("listed");
    await say(t, owner, "yes");
    expect((await t.store.getDeal(deal.id))?.state).toBe("donated");
    expect((await t.store.listItems(move.id))[0]?.outcome).toBe("donated");
    t.stop();
  });

  test("subletting the owner's own room opens a sublet deal", async () => {
    const t = boot(null);
    const { move } = await listChair(t);
    const out = await say(t, owner, "I want to sublet my room for $1500");
    expect(out[0]?.text).toContain("Listed your room");
    const deals = await t.store.listDeals(move.id);
    expect(deals.some((d) => d.mode === "sublet_out" && d.limitCents === 150000)).toBe(true);
    t.stop();
  });
});

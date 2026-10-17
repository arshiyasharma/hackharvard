import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, migrate, PostgresStore } from "@elves/db";
import { FakeLLM } from "@elves/llm";
import {
  dedupeKey,
  heuristicFacts,
  InMemoryBackend,
  type MemoryBackend,
  MoveMemory,
  renderPreamble,
  renderWorkingMemory,
} from "@elves/memory";
import { createLogger, MemoryStore, newId, type Store } from "@elves/shared";

const quiet = createLogger("test", "error");
const pgUrl = process.env.TEST_DATABASE_URL;
const run = newId("t");

type Opened = { backend: MemoryBackend; store: Store; cleanup: () => Promise<void> };
const backends: [string, () => Promise<Opened>][] = [
  [
    "memory",
    async () => ({ backend: new InMemoryBackend(), store: new MemoryStore(), cleanup: async () => {} }),
  ],
];
if (pgUrl) {
  backends.push([
    "postgres",
    async () => {
      const db = createDb({ url: pgUrl, max: 2 });
      await migrate(db, quiet);
      return {
        backend: new (await import("@elves/memory")).PostgresBackend(db),
        store: new PostgresStore(db),
        cleanup: async () => {
          await db`delete from moves where owner_handle like ${`${run}:%`}`;
          await db`delete from memory_threads where id like ${`${run}:%`}`;
          await db`delete from memory_facts where move_id in (select id from moves where owner_handle like ${`${run}:%`}) or thread_id like ${`${run}:%`}`;
          await db`delete from memory_notes where elf = 'crew_lead' and key like ${`${run}:%`}`;
          await db.end();
        },
      };
    },
  ]);
}

let seq = 0;
const mid = () => `${run}:m${++seq}`;

describe.each(backends)("MoveMemory (%s)", (_name, open) => {
  let o: Opened;
  beforeAll(async () => {
    o = await open();
  });
  afterAll(async () => o.cleanup());

  const mem = (config?: ConstructorParameters<typeof MoveMemory>[0]["config"]) =>
    new MoveMemory({ backend: o.backend, store: o.store, llm: new FakeLLM(), logger: quiet, config });
  const newMove = () =>
    o.store.createMove({
      ownerHandle: `${run}:${newId("h")}`,
      ownerSpaceId: `${run}:${newId("s")}`,
      platform: "imessage",
    });

  test("transcript is per thread, ordered, idempotent on message id, and excludes nothing until summarized", async () => {
    const m = mem();
    const move = await newMove();
    const thread = move.ownerSpaceId;
    await m.ensureThread(thread, { moveId: move.id, role: "owner", handle: move.ownerHandle });
    await m.ensureThread(thread, { moveId: move.id }); // no-op
    const t0 = Date.now();
    const a = mid();
    const b = mid();
    expect(
      await m.remember({
        threadId: thread,
        moveId: move.id,
        role: "user",
        id: a,
        text: "moving out nov 1",
        createdAt: new Date(t0),
      }),
    ).toBe(true);
    expect(
      await m.remember({
        threadId: thread,
        moveId: move.id,
        role: "assistant",
        id: b,
        text: "Got it, Nov 1.",
        elf: "crew_lead",
      }),
    ).toBe(true);
    expect(
      await m.remember({ threadId: thread, moveId: move.id, role: "user", id: a, text: "moving out nov 1" }),
    ).toBe(false); // replay
    const ctx = await m.context({ threadId: thread, moveId: move.id, elf: "crew_lead", role: "owner" });
    expect(ctx.messageCount).toBe(2);
    expect(ctx.transcript.split("\n")).toEqual(["Owner: moving out nov 1", "Crew Lead: Got it, Nov 1."]);
    expect(ctx.summary).toBeNull();
    expect(ctx.workingMemory).toContain(`Owner: ${move.ownerHandle}`);
    expect(ctx.tokens).toBeGreaterThan(20);
    expect(renderPreamble(ctx)).toContain("Conversation so far");
  });

  test("working memory is a live view of the store", async () => {
    const m = mem();
    const move = await newMove();
    await o.store.updateMove(move.id, { moveOutAt: "2026-11-01" });
    await o.store.upsertItem({
      moveId: move.id,
      name: "couch",
      category: "couch",
      floorPriceCents: 8000,
      listPriceCents: 12000,
      photoAttachmentIds: ["a1"],
    });
    await o.store.patchBoard(move.id, "stuff", { status: "working", currentTask: "Listing couch" });
    await m.ensureThread(move.ownerSpaceId, { moveId: move.id, role: "owner" });
    const ctx = await m.context({ threadId: move.ownerSpaceId, moveId: move.id });
    expect(ctx.workingMemory).toContain("Move-out date: 2026-11-01");
    expect(ctx.workingMemory).toContain("couch · floor $80 · list $120 · awaiting approval");
    expect(ctx.workingMemory).toContain("Stuff Elf (working): Listing couch");
    // a buyer thread of the same move sees the same structured state
    await m.ensureThread(`${run}:buyer-${move.id}`, { moveId: move.id, role: "buyer" });
    expect(
      (await m.context({ threadId: `${run}:buyer-${move.id}`, moveId: move.id })).workingMemory,
    ).toContain("couch");
  });

  test("facts: extracted after a turn, deduplicated, ranked by relevance, scoped by audience", async () => {
    const m = mem();
    const move = await newMove();
    const thread = move.ownerSpaceId;
    await m.ensureThread(thread, { moveId: move.id, role: "owner" });
    m.afterTurn({
      threadId: thread,
      moveId: move.id,
      elf: "crew_lead",
      role: "owner",
      text: "my roommate Sam can cover saturday pickups. I'd rather not do mornings. I take venmo",
      reply: "ok",
    });
    m.afterTurn({
      threadId: thread,
      moveId: move.id,
      elf: "crew_lead",
      role: "owner",
      text: "I'd rather not do mornings. and honestly I need it gone asap",
      reply: "ok",
    });
    await m.flush();
    const facts = await m.listFacts(move.id);
    const texts = facts.map((f) => f.text);
    expect(texts.some((t) => t.startsWith("Roommate Sam is part of the move"))).toBe(true);
    expect(texts).toContain("Owner uses Venmo for payments");
    expect(texts.filter((t) => /rather not do mornings/.test(t)).length).toBe(1); // deduped across turns
    expect(facts.find((f) => /rather not do mornings/.test(f.text))?.timesSeen).toBe(2);
    expect(facts.find((f) => /hurry/.test(f.text))?.audience).toBe("owner_private");
    expect(m.stats().factsCreated).toBeGreaterThanOrEqual(4);
    expect(m.stats().factsReinforced).toBeGreaterThanOrEqual(1);

    const ranked = await m.recall(move.id, "who can do the saturday pickup");
    expect(ranked[0]?.text).toContain("Sam");

    const owner = await m.context({ threadId: thread, moveId: move.id, role: "owner", query: "payment" });
    expect(owner.facts.join("\n")).toContain("Venmo");
    expect(owner.facts.join("\n")).toContain("hurry");
    expect(owner.confidential).toEqual([]);

    const buyerThread = `${run}:buyer2-${move.id}`;
    await m.ensureThread(buyerThread, { moveId: move.id, role: "buyer" });
    const buyer = await m.context({ threadId: buyerThread, moveId: move.id, role: "buyer", query: "pickup" });
    expect(buyer.facts.join("\n")).not.toContain("hurry");
    expect(buyer.confidential.join("\n")).toContain("hurry");
    expect(renderPreamble(buyer)).toContain("Confidential");

    await m.resolveFact(facts.find((f) => /Sam/.test(f.text))!.id);
    expect((await m.recall(move.id, "saturday")).some((f) => /Sam/.test(f.text))).toBe(false);
  });

  test("short texts are not mined for facts; direct facts and notes round-trip", async () => {
    const m = mem();
    const move = await newMove();
    await m.ensureThread(move.ownerSpaceId, { moveId: move.id, role: "owner" });
    m.afterTurn({ threadId: move.ownerSpaceId, moveId: move.id, elf: "stuff", text: "$40", reply: "ok" });
    await m.flush();
    expect(m.stats().extractions).toBe(0);
    await m.addFact({
      moveId: move.id,
      subject: "person:Alex",
      kind: "open_loop",
      text: "Buyer Alex wants to pick up the couch Saturday at 5pm",
      confidence: 0.9,
    });
    await m.setNote(move.id, "crew_lead", `${run}:plan`, { step: 2 });
    const ctx = await m.context({
      threadId: move.ownerSpaceId,
      moveId: move.id,
      elf: "crew_lead",
      role: "owner",
      query: "",
    });
    expect(ctx.facts).toEqual(["- (open loop) Buyer Alex wants to pick up the couch Saturday at 5pm"]);
    expect(ctx.notes).toEqual({ [`${run}:plan`]: { step: 2 } });
    expect(await m.note(move.id, "crew_lead", `${run}:plan`)).toEqual({ step: 2 });
  });

  test("long threads get a rolling summary and the transcript window respects the token budget", async () => {
    const m = mem({ summarizeAfter: 6, summarizeKeep: 2, lastMessages: 10, budget: { transcript: 60 } });
    const move = await newMove();
    const thread = move.ownerSpaceId;
    await m.ensureThread(thread, { moveId: move.id, role: "owner" });
    for (let i = 1; i <= 7; i++) {
      await m.remember({
        threadId: thread,
        moveId: move.id,
        role: i % 2 ? "user" : "assistant",
        id: mid(),
        text: `message number ${i} about the couch and the lamp`,
        elf: i % 2 ? null : "stuff",
      });
    }
    m.afterTurn({
      threadId: thread,
      moveId: move.id,
      elf: "stuff",
      text: "message number 7 about the couch and the lamp",
      reply: "ok",
    });
    await m.flush();
    expect(m.stats().summaries).toBe(1);
    const thr = await m.backend.getThread(thread);
    expect(thr?.summaryMessageCount).toBe(5);
    expect(thr?.summary).toContain("message number 1");
    const ctx = await m.context({ threadId: thread, moveId: move.id, role: "owner" });
    expect(ctx.summary).toContain("message number 5");
    expect(ctx.transcript).not.toContain("message number 5");
    expect(ctx.transcript).toContain("message number 7");
    // budget of 60 tokens keeps roughly the newest 1-2 lines, never zero
    expect(ctx.transcript.split("\n").length).toBeLessThanOrEqual(2);
    expect(ctx.transcript.split("\n").length).toBeGreaterThanOrEqual(1);
  });
});

describe("pure helpers", () => {
  test("heuristicFacts finds roommates, payment apps, urgency and preferences", () => {
    const facts = heuristicFacts(
      "my roommate Sam can cover saturday. I'd rather not do mornings. I take venmo. need it gone asap",
    );
    expect(facts.map((f) => f.kind).sort()).toEqual(["constraint", "constraint", "person", "preference"]);
    expect(heuristicFacts("ok")).toEqual([]);
    expect(heuristicFacts("can you do mornings?")).toEqual([]);
  });
  test("dedupeKey ignores case, punctuation and stop words", () => {
    expect(dedupeKey("preference", "Owner: I'd rather not do mornings!")).toBe(
      dedupeKey("preference", "owner i'd rather not do mornings"),
    );
    expect(dedupeKey("preference", "no mornings")).not.toBe(dedupeKey("constraint", "no mornings"));
  });
  test("renderWorkingMemory shows stage per item", async () => {
    const store = new MemoryStore();
    const move = await store.createMove({ ownerHandle: "+1555", ownerSpaceId: "s", platform: "imessage" });
    await store.upsertItem({ moveId: move.id, name: "lamp", category: "small" });
    await store.upsertItem({
      moveId: move.id,
      name: "desk",
      category: "desk_table",
      photoAttachmentIds: ["a"],
      priceLowCents: 3000,
      priceHighCents: 6000,
      listPriceCents: 5000,
    });
    const md = renderWorkingMemory(move, await store.listItems(move.id), await store.getBoard(move.id));
    expect(md).toContain("- lamp · floor — · list — · needs photo");
    expect(md).toContain("- desk · floor — · list $50 · range $30-$60 · needs floor");
  });
});

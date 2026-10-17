import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { InMemoryStore, type MastraStorage } from "@mastra/core/storage";
import { createDb, migrate, PostgresStore } from "@elves/db";
import { FakeLLM } from "@elves/llm";
import { InMemoryBackend, MoveMemory } from "@elves/memory";
import { createLogger, type Item, MemoryStore, type Move, newId, type Participant, type Store } from "@elves/shared";
import { DealEngine, type Effects, type EngineStore, InMemoryEngineStore, PostgresEngineStore } from "@elves/workflows";

const quiet = createLogger("test", "error");
const pgUrl = process.env.TEST_DATABASE_URL;
const run = newId("t");

interface World {
  store: Store;
  engineStore: EngineStore;
  storage: MastraStorage;
  cleanup: () => Promise<void>;
}
const worlds: [string, () => Promise<World>][] = [
  [
    "memory",
    async () => ({ store: new MemoryStore(), engineStore: new InMemoryEngineStore(), storage: new InMemoryStore({ id: `wf-${run}` }), cleanup: async () => {} }),
  ],
];
if (pgUrl) {
  worlds.push([
    "postgres",
    async () => {
      const db = createDb({ url: pgUrl, max: 3 });
      await migrate(db, quiet);
      const { PostgresStore: MastraPg } = await import("@mastra/pg");
      const storage = new MastraPg({ id: `wf-${run}`, connectionString: pgUrl });
      return {
        store: new PostgresStore(db),
        engineStore: new PostgresEngineStore(db),
        storage,
        cleanup: async () => {
          await db`delete from deal_runs where move_id in (select id from moves where owner_handle like ${`${run}:%`})`;
          await db`delete from last_call_runs where move_id in (select id from moves where owner_handle like ${`${run}:%`})`;
          await db`delete from moves where owner_handle like ${`${run}:%`}`;
          await db.end();
        },
      };
    },
  ]);
}

describe.each(worlds)("DealEngine (%s)", (_name, open) => {
  let w: World;
  let clock = new Date("2026-10-15T14:00:00Z"); // Thu 10:00 EDT
  const now = () => clock;
  beforeAll(async () => {
    w = await open();
  });
  afterAll(async () => w.cleanup());

  const OWNER = `${run}:+14255269066`;
  const BUYER = `${run}:+14022176358`;
  const BUYER2 = `${run}:+16175550100`;

  async function seed(moveOutAt = "2026-10-20") {
    const move = await w.store.createMove({ ownerHandle: OWNER, ownerSpaceId: `${run}:spc_owner_${newId("x")}`, platform: "script" });
    await w.store.updateMove(move.id, { moveOutAt });
    await w.store.upsertParticipant({ moveId: move.id, handle: OWNER, role: "owner", spaceId: move.ownerSpaceId, platform: "script", agentUserId: "usr_agent_owner" });
    const couch = await w.store.upsertItem({ moveId: move.id, name: "couch", category: "couch", listPriceCents: 12000, floorPriceCents: 8000, listingApproved: true, photoAttachmentIds: ["a"] });
    const lamp = await w.store.upsertItem({ moveId: move.id, name: "lamp", category: "small", listPriceCents: 900, floorPriceCents: 500, listingApproved: true });
    return { move: (await w.store.getMove(move.id)) as Move, couch, lamp };
  }
  function buyer(move: Move, handle = BUYER): Participant {
    return { id: newId("pt"), moveId: move.id, handle, role: "buyer", spaceId: `${run}:spc_${move.id}_${handle.replace(/\W/g, "")}`, platform: "script", agentUserId: "usr_agent_buyer", createdAt: now().toISOString() };
  }
  const mk = (memory: MoveMemory | null = null) => new DealEngine({ store: w.store, engineStore: w.engineStore, storage: w.storage, memory, logger: quiet, now });
  const buyerLines = (e: Effects) => e.messages.filter((m) => m.audience === "buyer").map((m) => m.text);
  const ownerLines = (e: Effects) => e.messages.filter((m) => m.audience === "owner").map((m) => m.text);

  test("a stranger's DM negotiates to a price, books a slot, and the owner chat gets threaded summaries", async () => {
    const { move, couch } = await seed();
    const engine = mk();
    expect(await engine.identifyBuyer({ senderHandle: BUYER, text: "hey is the couch still available?" })).toMatchObject({ move: { id: move.id }, item: { id: couch.id } });
    const b = buyer(move);
    const e1 = await engine.handleBuyerMessage({ move, participant: b, text: "hey is the couch still available?" });
    expect(buyerLines(e1)).toEqual(["Yes, the couch is still available at $120. Want it? You can also make an offer."]);
    const e2 = await engine.handleBuyerMessage({ move, participant: b, text: "would you take 90" });
    expect(buyerLines(e2)).toEqual(["I can do $100 for the couch. Want it at that?"]);
    const e3 = await engine.handleBuyerMessage({ move, participant: b, text: "ok deal" });
    expect(buyerLines(e3)[0]).toContain("Deal, $100 for the couch. Pickup slots: 1) Thu Oct 15, 12pm–1pm");
    expect(ownerLines(e3)[0]).toContain(`Buyer ${BUYER} agreed to $100 for the couch`);
    expect(e3.messages.find((m) => m.audience === "owner")).toMatchObject({ spaceId: move.ownerSpaceId, senderId: "usr_agent_owner" });
    expect(e3.events.map((x) => x.type)).toEqual(expect.arrayContaining(["deal.agreed", "escrow.hold"]));
    const e4 = await engine.handleBuyerMessage({ move, participant: b, text: "thursday at 5:30pm works" });
    expect(buyerLines(e4)[0]).toContain("Booked: Thu Oct 15, 5:30pm–7pm");
    expect(ownerLines(e4)[0]).toContain("Confirmed 🎉");
    expect(e4.board[0]).toMatchObject({ elf: "stuff", currentTask: "Pickup booked: couch" });
    const deals = await engine.listDeals(move.id);
    expect(deals.length).toBe(1);
    expect(deals[0]).toMatchObject({ status: "scheduled", stage: "handoff", agreedCents: 10000, buyerHandle: BUYER });
    // the workflow run is suspended at the handoff step
    const state = await engine.mastra.getWorkflow("deal").getWorkflowRunById(deals[0]!.id);
    expect(state?.status).toBe("suspended");

    // owner says they handed it off; buyer confirms; escrow releases; item sold
    const o1 = await engine.handleOwnerMessage({ move, text: "handed off the couch" });
    expect(o1).not.toBeNull();
    expect(buyerLines(o1!)[0]).toContain('Reply "got it" to confirm and release $100');
    const e5 = await engine.handleBuyerMessage({ move, participant: b, text: "got it, thanks!" });
    expect(ownerLines(e5)[0]).toContain("$100 released from escrow");
    expect(e5.events.map((x) => x.type)).toContain("escrow.release");
    expect((await w.store.listItems(move.id)).find((i) => i.id === couch.id)?.outcome).toBe("sold");
    expect((await engine.mastra.getWorkflow("deal").getWorkflowRunById(deals[0]!.id))?.status).toBe("success");
    expect(await engine.handleOwnerMessage({ move, text: "what's next" })).toBeNull();
  });

  test("a deal waiting on the owner survives a restart: a new engine on the same storage resumes it", async () => {
    const { move } = await seed();
    const a = mk();
    const b = buyer(move);
    await a.handleBuyerMessage({ move, participant: b, text: "couch for $50?" });
    const e = await a.handleBuyerMessage({ move, participant: b, text: "60 is all I have" });
    expect(ownerLines(e)[0]).toContain("Take it? Reply yes or no.");
    expect((await a.listDeals(move.id))[0]?.status).toBe("awaiting_owner");

    const fresh = mk(); // new process: same Mastra storage, same rows
    const o = await fresh.handleOwnerMessage({ move, text: "yes take it" });
    expect(buyerLines(o!)[0]).toContain("Good news, the owner will take $60. Deal, $60 for the couch.");
    expect((await fresh.listDeals(move.id))[0]).toMatchObject({ status: "negotiating", stage: "scheduling", agreedCents: 6000 });
  });

  test("a second buyer waits in line and is promoted when the first walks", async () => {
    const { move } = await seed();
    const engine = mk();
    const b1 = buyer(move);
    const b2 = buyer(move, BUYER2);
    await engine.handleBuyerMessage({ move, participant: b1, text: "is the couch available" });
    const wait = await engine.handleBuyerMessage({ move, participant: b2, text: "I want the couch, 120?" });
    expect(buyerLines(wait)).toEqual(["Someone's ahead of you on the couch. I'll text you right away if it frees up."]);
    const walk = await engine.handleBuyerMessage({ move, participant: b1, text: "nah never mind" });
    const promoted = walk.messages.find((m) => m.spaceId === b2.spaceId);
    expect(promoted?.text).toBe("Good news, the couch is available again at $120. Want it?");
    const e = await engine.handleBuyerMessage({ move, participant: b2, text: "yes" });
    expect(buyerLines(e)[0]).toContain("Deal, $120 for the couch");
  });

  test("owner hooks: an approved listing opens a deal; 'pull the lamp' withdraws it; a buyer asking about nothing in particular gets the menu", async () => {
    const { move, lamp } = await seed();
    const engine = mk();
    await engine.onEvent(move, "listing.approved", { itemId: lamp.id });
    expect((await engine.listDeals(move.id)).map((d) => d.itemName)).toEqual(["lamp"]);
    const menu = await engine.handleBuyerMessage({ move, participant: buyer(move), text: "hi, what do you have?" });
    expect(buyerLines(menu)[0]).toContain("couch $120, lamp $9");
    const pulled = await engine.handleOwnerMessage({ move, text: "actually pull the lamp, my roommate wants it" });
    expect(ownerLines(pulled!)[0]).toContain("Pulled the lamp");
    expect((await engine.listDeals(move.id))[0]?.status).toBe("withdrawn");
  });

  test("Last Call: drop at T−48h, free at T−24h, dumped at move-out; opt-out holds a price; buyers in talks are told", async () => {
    clock = new Date("2026-10-15T14:00:00Z");
    const { move, couch, lamp } = await seed("2026-10-17"); // move-out treated as 16:00Z on the 17th → drop due 16:00Z on the 15th
    const engine = mk();
    const b = buyer(move);
    await engine.handleBuyerMessage({ move, participant: b, text: "is the lamp still around?" });
    await engine.onEvent(move, "move.date_captured", { kind: "move_out", date: move.moveOutAt });
    expect((await engine.lastCall(move.id))?.stage).toBe("drop");
    expect(await engine.tick(clock)).toEqual([]); // 2h early
    const held = await engine.handleOwnerMessage({ move, text: "keep the couch at full price through last call" });
    expect(ownerLines(held!)[0]).toBe("Got it: the couch stays at $120 through Last Call.");
    clock = new Date("2026-10-15T16:00:00Z");
    const fired = await engine.tick(clock);
    expect(fired.map((f) => f.stage)).toEqual(["drop"]);
    const drop = fired[0]!.effects;
    expect(ownerLines(drop)[0]).toContain("Last Call, 48 hours out");
    expect(ownerLines(drop)[0]).toContain("lamp $5");
    expect(buyerLines(drop)).toEqual(["Price drop: the lamp is now $5. Want it?"]);
    const items = await w.store.listItems(move.id);
    expect(items.find((i) => i.id === lamp.id)).toMatchObject({ listPriceCents: 500, floorPriceCents: 500 });
    expect(items.find((i) => i.id === couch.id)?.listPriceCents).toBe(12000); // held by the opt-out
    expect(ownerLines(drop)[0]).toContain("Holding price on couch");
    expect((await engine.lastCall(move.id))?.stage).toBe("free");

    clock = new Date("2026-10-16T16:00:00Z");
    const free = (await engine.tick(clock))[0]!;
    expect(free.stage).toBe("free");
    expect(ownerLines(free.effects)[0]).toContain("are now free");
    expect(free.effects.events.map((e) => e.type)).toContain("pickup.requested");
    expect(buyerLines(free.effects)).toEqual(["The lamp is now free; first to pick up gets it. Want it?"]);

    const close = await engine.forceLastCall(move);
    expect(close?.stage).toBe("close");
    expect(ownerLines(close!.effects)[0]).toContain("Move-out day. Outcomes:");
    expect((await w.store.listItems(move.id)).every((i) => i.outcome === "dumped")).toBe(true);
    expect((await engine.lastCall(move.id))?.status).toBe("done");
    expect((await engine.tick(new Date("2026-10-20T00:00:00Z"))).filter((f) => f.moveId === move.id)).toEqual([]);
  });

  test("owner constraints in memory shape the offered slots", async () => {
    clock = new Date("2026-10-15T14:00:00Z");
    const { move } = await seed();
    const memory = new MoveMemory({ backend: new InMemoryBackend(), store: w.store, llm: new FakeLLM(), logger: quiet });
    await memory.addFact({ moveId: move.id, subject: "owner", kind: "constraint", text: "Owner: weekends only, no weekdays", confidence: 0.9 });
    const engine = mk(memory);
    const b = buyer(move);
    const e = await engine.handleBuyerMessage({ move, participant: b, text: "I'll take the couch for 120" });
    expect(buyerLines(e)[0]).toContain("Pickup slots: 1) Sat Oct 17, 10am–12pm  2) Sat Oct 17, 2pm–4pm  3) Sun Oct 18, 10am–12pm");
  });
});

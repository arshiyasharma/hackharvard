import { describe, expect, test } from "bun:test";
import { openDeal } from "@elves/engine";
import { FakeListings } from "@elves/listings";
import { FakeLLM } from "@elves/llm";
import { ScriptTransport } from "@elves/photon";
import { createLogger, MemoryStore } from "@elves/shared";
import { createService } from "../src/service.ts";

const OWNER = "+19195357564";
const BUYER = "+16175550101";

/** An owner with one listing per title, floor 40% under the ask, then a stranger texting the same pool number. */
async function boot(titles: string[]) {
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
    sweepMs: 0,
  });
  const ctrl = new AbortController();
  void service.run(ctrl.signal);
  const say = async (handle: string, text: string) => {
    const before = transport.sent.length;
    transport.push(handle, text);
    await transport.settled();
    await service.pipeline.idle();
    return transport.sent.slice(before);
  };
  await say(OWNER, "moving out nov 1");
  const move = (await store.listMoves())[0]!;
  const deals = [];
  for (const [i, title] of titles.entries()) {
    const item = await store.upsertItem({
      moveId: move.id,
      name: title,
      category: "desk_table",
      listingApproved: true,
    });
    deals.push(
      await openDeal(store, {
        moveId: move.id,
        mode: "sell_item",
        subjectId: item.id,
        title,
        askCents: (100 + i * 50) * 100,
        limitCents: (60 + i * 30) * 100,
      }),
    );
  }
  const texts = (msgs: { text: string }[]) => msgs.map((m) => m.text).join("\n");
  return { transport, store, say, deals, move, texts, stop: () => ctrl.abort() };
}

describe("a stranger texting a pool number is treated as a buyer", () => {
  test("two tables, they say 'table': it asks which, naming only the two tables and no floors", async () => {
    const t = await boot(["coffee table", "dining table", "lamp"]);
    const out = await t.say(BUYER, "hi is the table still available?");
    const text = t.texts(out);
    expect(out.every((m) => m.spaceId === t.transport.spaceFor(BUYER))).toBe(true);
    expect(text).toContain("Which one");
    expect(text).toContain("1) coffee table, $100");
    expect(text).toContain("2) dining table, $150");
    expect(text).not.toContain("lamp");
    expect(text).not.toContain("$60"); // floors
    // not treated as an owner: no new move, no Crew Lead intro
    expect(await t.store.listMoves()).toHaveLength(1);
    expect(text).not.toContain("moving crew");
    t.stop();
  });

  test("they answer by name, then negotiate that listing", async () => {
    const t = await boot(["coffee table", "dining table"]);
    await t.say(BUYER, "is the table available?");
    await t.say(BUYER, "the dining one, would you take 90?");
    const parties = await t.store.listDealPartiesBySpace(t.transport.spaceFor(BUYER));
    expect(parties).toHaveLength(1);
    expect(parties[0]!.dealId).toBe(t.deals[1]!.id);
    expect(parties[0]!.lastOfferCents).toBe(9000);
    t.stop();
  });

  test("they answer by number, which indexes the list they were shown (just the matched two)", async () => {
    const t = await boot(["lamp", "coffee table", "dining table"]);
    await t.say(BUYER, "hi, the table?");
    const out = await t.say(BUYER, "2");
    const parties = await t.store.listDealPartiesBySpace(t.transport.spaceFor(BUYER));
    expect(parties[0]?.dealId).toBe(t.deals[2]!.id); // "2" was the dining table, not the coffee table
    // picking a listing is not an offer: they hear the listing, not a counter to "$2"
    expect(t.texts(out)).toContain("dining table is available, $200");
    expect(parties[0]?.lastOfferCents).toBeNull();
    t.stop();
  });

  test("a vague 'hi' with several listings gets all of them", async () => {
    const t = await boot(["lamp", "couch"]);
    const text = t.texts(await t.say(BUYER, "hi"));
    expect(text).toContain("1) lamp");
    expect(text).toContain("2) couch");
    t.stop();
  });

  test("a vague text with exactly one listing joins it straight away", async () => {
    const t = await boot(["couch"]);
    const out = await t.say(BUYER, "hi is this still available?");
    expect(t.texts(out)).toContain("couch");
    expect(t.texts(out)).not.toContain("Which one");
    const parties = await t.store.listDealPartiesBySpace(t.transport.spaceFor(BUYER));
    expect(parties).toHaveLength(1);
    t.stop();
  });

  test("the ref code still wins, and an unrelated word still asks", async () => {
    const t = await boot(["coffee table", "dining table"]);
    const out = await t.say(BUYER, `hey ${t.deals[0]!.code} available?`);
    expect(t.texts(out)).not.toContain("Which one");
    expect((await t.store.listDealPartiesBySpace(t.transport.spaceFor(BUYER)))[0]?.dealId).toBe(
      t.deals[0]!.id,
    );
    t.stop();
  });

  test("the owner is not treated as a buyer", async () => {
    const t = await boot(["couch"]);
    const out = await t.say(OWNER, "what's the plan");
    expect(t.texts(out)).not.toContain("Which one");
    expect(await t.store.listDealPartiesBySpace(t.transport.spaceFor(OWNER))).toHaveLength(0);
    t.stop();
  });
});

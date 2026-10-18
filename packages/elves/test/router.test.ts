import { describe, expect, test } from "bun:test";
import { allElves, keywordRoute, moveinAskKey, route, spaceOwnerKey } from "@elves/elves";
import { FakeLLM } from "@elves/llm";
import type { InboundMessage } from "@elves/photon";
import type { Batch } from "@elves/pipeline";
import { type ElfName, MemoryStore, subletPostDefaults } from "@elves/shared";

let seq = 0;
const batchOf = (
  text: string | null,
  parentMessageId: string | null = null,
  attachments: { id: string; mimeType?: string; name?: string }[] = [],
): Batch => {
  const m: InboundMessage = {
    id: `m${++seq}`,
    spaceId: "s1",
    spaceKind: "direct",
    platform: "script",
    senderId: "u1",
    senderHandle: "+15550001111",
    agentId: "a1",
    agentHandle: "+1628",
    text,
    attachments,
    reaction: null,
    parentMessageId,
    receivedAt: new Date().toISOString(),
  };
  return { spaceId: "s1", messages: [m], traceId: "t", carried: 0 };
};

/** 36 routing fixtures: message -> expected Elf via keywords (the no-LLM path). */
const FIXTURES: [string, ElfName][] = [
  ["hey there", "crew_lead"],
  ["what's the plan for the move", "crew_lead"],
  ["moving out november 1", "crew_lead"],
  ["my roommate Sam can cover saturday", "crew_lead"],
  ["status?", "crew_lead"],
  ["thanks!", "crew_lead"],
  ["I want to sell my couch", "stuff"],
  ["lowest I'd take for the desk is 60", "stuff"],
  ["here's a photo of the dresser", "stuff"],
  ["a buyer wants to come at 5", "stuff"],
  ["can you list the mattress", "stuff"],
  ["is this listing a fair price? forwarded link", "stuff"],
  ["should i get this table from marketplace", "stuff"],
  ["found a sofa on craigslist, worth it?", "stuff"],
  ["just donate the rest", "stuff"],
  ["can i put the chair on the curb", "stuff"],
  ["book a 311 pickup for the mattress", "stuff"],
  ["give away the lamp for free", "stuff"],
  ["he wants to pay on venmo", "money"],
  ["can we split the truck cost", "money"],
  ["is the deposit in escrow", "money"],
  ["this feels like a scam", "money"],
  ["book storage june to august", "home"],
  // Move-day is gone: trucks, movers and move-day logistics fall to the Crew Lead, which says the crew can't.
  ["need a u-haul for the 1st", "crew_lead"],
  ["hire movers for saturday", "crew_lead"],
  ["what's your eta", "crew_lead"],
  ["can i sublet my room", "home"],
  ["looking for a room in allston under 1200", "home"],
  ["need a place for the summer, budget 900", "home"],
  ["find me a sublet in somerville under 1500", "home"],
  ["is there a hotel for the gap between leases", "home"],
  ["set up internet at the new place", "home"],
  ["where can i leave luggage between leases", "home"],
  ["address change and renters insurance", "home"],
];

describe("keyword routing", () => {
  test.each(FIXTURES)("%p -> %p", (text, expected) => {
    const r = keywordRoute(text, allElves);
    expect(r?.elf ?? "crew_lead").toBe(expected);
  });
});

describe("route()", () => {
  const store = new MemoryStore();
  const deps = { store, llm: new FakeLLM(), elves: allElves };
  test("first contact always goes to the Crew Lead", async () => {
    const r = await route(batchOf("sell my couch"), deps, { firstContact: true });
    expect(r).toMatchObject({ elf: "crew_lead", via: "first_contact" });
  });
  test("a reply in an Elf's thread goes to that Elf", async () => {
    await store.setThreadOwner("out_stuff", "stuff");
    const r = await route(batchOf("ok lower it", "out_stuff"), deps, { firstContact: false });
    expect(r).toMatchObject({ elf: "stuff", via: "thread" });
  });
  test("'2' after the Home Elf sent picks is a pick; otherwise it is a price", async () => {
    const fresh = new MemoryStore();
    const d = { store: fresh, llm: new FakeLLM(), elves: allElves };
    const move = await fresh.createMove({ ownerHandle: "+1", ownerSpaceId: "s1", platform: "script" });
    const opts = { firstContact: false, moveId: move.id };
    expect(await route(batchOf("2"), d, opts)).toMatchObject({ elf: "stuff", via: "price" });
    await fresh.setThreadOwner(spaceOwnerKey("s1"), "home");
    // the Home Elf spoke last but has no picks yet
    expect(await route(batchOf("2"), d, opts)).toMatchObject({ elf: "stuff", via: "price" });
    await fresh.upsertListing({
      moveId: move.id,
      site: "craigslist",
      kind: "room",
      url: "https://boston.craigslist.org/x/1",
      title: "Room",
      rank: 1,
    });
    expect(await route(batchOf("2"), d, opts)).toMatchObject({ elf: "home", via: "followup" });
    expect(await route(batchOf("tell me about 1"), d, opts)).toMatchObject({ elf: "home", via: "followup" });
    expect(await route(batchOf("more"), d, opts)).toMatchObject({ elf: "home", via: "followup" });
    expect(await route(batchOf("search again"), d, opts)).toMatchObject({ elf: "home", via: "followup" });
    expect(
      await route(
        batchOf("what about https://boston.craigslist.org/gbs/roo/d/allston-garden-level-room/1.html"),
        d,
        opts,
      ),
    ).toMatchObject({ elf: "home", via: "followup" });
    await fresh.setThreadOwner(spaceOwnerKey("s1"), "crew_lead");
    expect(await route(batchOf("2"), d, opts)).toMatchObject({ elf: "stuff", via: "price" });
  });
  test("status is the Home Elf's from any thread; what can you do is the Crew Lead's", async () => {
    expect(await route(batchOf("status"), deps, { firstContact: false, moveId: "mv1" })).toMatchObject({
      elf: "home",
      via: "scope",
    });
    expect(
      await route(batchOf("what can you do?"), deps, { firstContact: false, moveId: "mv1" }),
    ).toMatchObject({
      elf: "crew_lead",
      via: "scope",
    });
  });
  test("one text that asks for Stuff and Home at once goes to the Crew Lead, which calls both", async () => {
    expect(
      await route(batchOf("sell my couch and find me a room in allston under 1200"), deps, {
        firstContact: false,
      }),
    ).toMatchObject({ elf: "crew_lead", via: "delegate" });
    // one Elf's work still goes straight to that Elf
    expect(
      await route(batchOf("find me a room in allston under 1200"), deps, { firstContact: false }),
    ).toMatchObject({
      elf: "home",
    });
  });
  test("'list it' with an item waiting on approval goes to Stuff, which opens the deal", async () => {
    const fresh = new MemoryStore();
    const d = { store: fresh, llm: new FakeLLM(), elves: allElves };
    const move = await fresh.createMove({ ownerHandle: "+1", ownerSpaceId: "s1", platform: "script" });
    await fresh.upsertItem({ moveId: move.id, name: "couch", category: "couch", floorPriceCents: 6000 });
    const opts = { firstContact: false, moveId: move.id };
    expect(await route(batchOf("list it"), d, opts)).toMatchObject({ elf: "stuff", via: "deal" });
    expect(await route(batchOf("yes"), d, opts)).toMatchObject({ elf: "stuff", via: "deal" });
    // nothing waiting: a bare yes is not Stuff's
    const none = await fresh.createMove({ ownerHandle: "+2", ownerSpaceId: "s2", platform: "script" });
    expect((await route(batchOf("list it"), d, { firstContact: false, moveId: none.id })).via).not.toBe(
      "deal",
    );
  });
  test("keyword fallback when there is no thread", async () => {
    const r = await route(batchOf("book storage for the summer"), deps, { firstContact: false });
    expect(r).toMatchObject({ elf: "home", via: "keyword" });
  });
  test("a room photo goes to Home while it is writing the owner's sublet post", async () => {
    const fresh = new MemoryStore();
    const d = { store: fresh, llm: new FakeLLM(), elves: allElves };
    const move = await fresh.createMove({ ownerHandle: "+1", ownerSpaceId: "s1", platform: "script" });
    const opts = { firstContact: false, moveId: move.id };
    const photo = () => batchOf(null, null, [{ id: "att1" }]);
    await fresh.setThreadOwner(spaceOwnerKey("s1"), "home");
    expect(await route(photo(), d, opts)).toMatchObject({ elf: "stuff", via: "photo" });
    await fresh.saveSubletPost({ ...subletPostDefaults(move.id), rentCents: 150000, status: "collecting" });
    expect(await route(photo(), d, opts)).toMatchObject({ elf: "home", via: "followup" });
    await fresh.saveSubletPost({ ...subletPostDefaults(move.id), status: "approved" });
    expect(await route(photo(), d, opts)).toMatchObject({ elf: "stuff", via: "photo" });
  });
  test("the answer to Home's move-in question, and checklist follow-ups, go back to Home", async () => {
    const fresh = new MemoryStore();
    const d = { store: fresh, llm: new FakeLLM(), elves: allElves };
    const move = await fresh.createMove({ ownerHandle: "+1", ownerSpaceId: "s1", platform: "script" });
    const opts = { firstContact: false, moveId: move.id };
    expect(await route(batchOf("june 1"), d, opts)).toMatchObject({ elf: "crew_lead" });
    await fresh.setThreadOwner(spaceOwnerKey("s1"), "home");
    expect(await route(batchOf("june 1"), d, opts)).toMatchObject({ elf: "crew_lead" });
    await fresh.setCursor(moveinAskKey(move.id), "date");
    expect(await route(batchOf("june 1"), d, opts)).toMatchObject({ elf: "home", via: "followup" });
    await fresh.setCursor(moveinAskKey(move.id), "address");
    expect(await route(batchOf("12 oak st, allston"), d, opts)).toMatchObject({
      elf: "home",
      via: "followup",
    });
    await fresh.setCursor(moveinAskKey(move.id), "");
    expect(await route(batchOf("what's left?"), d, opts)).toMatchObject({ elf: "crew_lead" });
    await fresh.upsertMoveinTask({
      moveId: move.id,
      key: "internet",
      label: "Internet",
      dueAt: "2026-05-22",
    });
    expect(await route(batchOf("what's left?"), d, opts)).toMatchObject({ elf: "home", via: "followup" });
    expect(await route(batchOf("got the keys"), d, opts)).toMatchObject({ elf: "home", via: "followup" });
    await fresh.setThreadOwner(spaceOwnerKey("s1"), "stuff");
    expect(await route(batchOf("what's left?"), d, opts)).toMatchObject({ elf: "crew_lead" });
  });
  test("a photo goes to the Stuff Elf unless it is first contact", async () => {
    expect(await route(batchOf(null, null, [{ id: "att1" }]), deps, { firstContact: false })).toMatchObject({
      elf: "stuff",
      via: "photo",
    });
    expect(await route(batchOf(null, null, [{ id: "att1" }]), deps, { firstContact: true })).toMatchObject({
      elf: "crew_lead",
      via: "first_contact",
    });
  });
  test("a bare price goes to the Stuff Elf", async () => {
    expect(await route(batchOf("4 dollars"), deps, { firstContact: false })).toMatchObject({
      elf: "stuff",
      via: "price",
    });
    expect(await route(batchOf("$60"), deps, { firstContact: false })).toMatchObject({
      elf: "stuff",
      via: "price",
    });
    expect(await route(batchOf("lowest I'd take is 80"), deps, { firstContact: false })).toMatchObject({
      elf: "stuff",
      via: "price",
    });
  });
  test("unknown text defaults to the Crew Lead", async () => {
    const r = await route(batchOf("zzzz qqqq"), deps, { firstContact: false });
    expect(r).toMatchObject({ elf: "crew_lead", via: "default" });
  });
});

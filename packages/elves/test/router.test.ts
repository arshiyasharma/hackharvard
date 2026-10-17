import { describe, expect, test } from "bun:test";
import { allElves, keywordRoute, route } from "@elves/elves";
import { FakeLLM } from "@elves/llm";
import type { InboundMessage } from "@elves/photon";
import type { Batch } from "@elves/pipeline";
import { type ElfName, MemoryStore } from "@elves/shared";

let seq = 0;
const batchOf = (
  text: string | null,
  parentMessageId: string | null = null,
  attachments: { id: string }[] = [],
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
  ["I want to sell my couch", "sell"],
  ["lowest I'd take for the desk is 60", "sell"],
  ["here's a photo of the dresser", "sell"],
  ["a buyer wants to come at 5", "sell"],
  ["can you list the mattress", "sell"],
  ["is this listing a fair price? forwarded link", "buy"],
  ["should i get this table from marketplace", "buy"],
  ["found a sofa on craigslist, worth it?", "buy"],
  ["just donate the rest", "green"],
  ["can i put the chair on the curb", "green"],
  ["book a 311 pickup for the mattress", "green"],
  ["give away the lamp for free", "green"],
  ["he wants to pay on venmo", "money"],
  ["can we split the truck cost", "money"],
  ["is the deposit in escrow", "money"],
  ["this feels like a scam", "money"],
  ["book storage june to august", "haul"],
  ["need a u-haul for the 1st", "haul"],
  ["do i need a moving permit", "haul"],
  ["hire movers for saturday", "haul"],
  ["what's your eta", "map"],
  ["where are you, i'm at the address", "map"],
  ["can i sublet my room", "lease"],
  ["my landlord needs 30 days notice", "lease"],
  ["check this clause in the lease", "lease"],
  ["looking for a room in allston under 1200", "hunt"],
  ["need a place for the summer, budget 900", "hunt"],
  ["set up internet at the new place", "movein"],
  ["where can i leave luggage between leases", "movein"],
  ["address change and renters insurance", "movein"],
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
    await store.setThreadOwner("out_sell", "sell");
    const r = await route(batchOf("ok lower it", "out_sell"), deps, { firstContact: false });
    expect(r).toMatchObject({ elf: "sell", via: "thread" });
  });
  test("keyword fallback when there is no thread", async () => {
    const r = await route(batchOf("book storage for the summer"), deps, { firstContact: false });
    expect(r).toMatchObject({ elf: "haul", via: "keyword" });
  });
  test("a photo goes to the Sell Elf unless it is first contact", async () => {
    expect(await route(batchOf(null, null, [{ id: "att1" }]), deps, { firstContact: false })).toMatchObject({
      elf: "sell",
      via: "photo",
    });
    expect(await route(batchOf(null, null, [{ id: "att1" }]), deps, { firstContact: true })).toMatchObject({
      elf: "crew_lead",
      via: "first_contact",
    });
  });
  test("a bare price goes to the Sell Elf", async () => {
    expect(await route(batchOf("4 dollars"), deps, { firstContact: false })).toMatchObject({
      elf: "sell",
      via: "price",
    });
    expect(await route(batchOf("$60"), deps, { firstContact: false })).toMatchObject({
      elf: "sell",
      via: "price",
    });
    expect(await route(batchOf("lowest I'd take is 80"), deps, { firstContact: false })).toMatchObject({
      elf: "sell",
      via: "price",
    });
  });
  test("unknown text defaults to the Crew Lead", async () => {
    const r = await route(batchOf("zzzz qqqq"), deps, { firstContact: false });
    expect(r).toMatchObject({ elf: "crew_lead", via: "default" });
  });
});

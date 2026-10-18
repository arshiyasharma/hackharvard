import { describe, expect, test } from "bun:test";
import {
  allElves,
  CREW_ABILITIES,
  clarifyKey,
  clarifyQuestion,
  type Elf,
  parseClarify,
  route,
  spaceOwnerKey,
} from "@elves/elves";
import { FakeListings } from "@elves/listings";
import { FakeLLM } from "@elves/llm";
import {
  createMoneyElf,
  FakeRails,
  MemoryMoneyStore,
  MONEY_CAPABILITIES,
  MONEY_DESCRIPTION,
  MONEY_KEYWORDS,
} from "@elves/money-elf";
import type { InboundMessage } from "@elves/photon";
import { ScriptTransport } from "@elves/photon";
import type { Batch } from "@elves/pipeline";
import { createLogger, type ElfName, MemoryStore } from "@elves/shared";
import { createService } from "../src/service.ts";

/**
 * Every text goes to the right Elf, and a text that could be two Elves' job is asked about, not guessed. This
 * runs the router on the keyword path (the model-less fallback) with the real Money Elf's description and
 * keywords in place of the stub, which is how the service wires it.
 */
const money = {
  name: "money",
  description: MONEY_DESCRIPTION,
  keywords: MONEY_KEYWORDS,
  handle: async () => ({ replies: [] }),
} as unknown as Elf;
const elves = allElves.map((e) => (e.name === "money" ? money : e));

let seq = 0;
const batchOf = (text: string): Batch => {
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
    attachments: [],
    reaction: null,
    parentMessageId: null,
    receivedAt: new Date().toISOString(),
  };
  return { spaceId: "s1", messages: [m], traceId: "t", carried: 0 };
};
const decide = async (text: string, store = new MemoryStore()) =>
  route(batchOf(text), { store, llm: new FakeLLM(), elves }, { firstContact: false, moveId: "mv1" });

/** [text, the Elf it goes to] */
const TABLE: [string, ElfName][] = [
  // Money: costs, who owes what, deposits, paying someone, escrow, the ledger
  ["split the $240 truck with Sam and Priya", "money"],
  ["split the cleaning with my roommates", "money"],
  ["can Sam pay the truck at $40 a month", "money"],
  ["can I do a payment plan", "money"],
  ["Sam paid me on venmo", "money"],
  ["pay Sam $40 for gas", "money"],
  ["I paid a $500 deposit on the sublet", "money"],
  ["I paid a $500 holding deposit, due back Dec 1", "money"],
  ["is anything in escrow", "money"],
  ["refund the buyer", "money"],
  ["release the escrow for the couch", "money"],
  ["who owes me", "money"],
  ["who hasn't paid me", "money"],
  ["how much have I spent", "money"],
  ["how much did I make", "money"],
  ["what's my balance", "money"],
  ["how's my money", "money"],
  ["show me my dashboard", "money"],
  ["DASHBOARD", "money"],
  ["dashboard", "money"],
  ["show me the ledger", "money"],
  ["the truck was actually $260", "money"],
  ["is this a scam", "money"],
  // Stuff: items to sell, buy or give away
  ["sell my couch", "stuff"],
  ["I have a lamp to sell for $20", "stuff"],
  ["lowest I'd take is $60 for the desk", "stuff"],
  ["donate the desk", "stuff"],
  ["keep the couch", "stuff"],
  ["no last call", "stuff"],
  ["how did we do on the move report", "stuff"],
  // Home: a place, storage, the checklist
  ["find me a room in allston under 1200", "home"],
  ["looking for a studio in somerville", "home"],
  ["sublet my room for $1500", "home"],
  ["set up internet at the new place", "home"],
  ["find storage for june to august", "home"],
  ["find a hotel for the gap", "home"],
  ["what do I need for move-in", "home"],
  // Crew Lead: small talk, dates, and the things the crew refuses
  ["hey there", "crew_lead"],
  ["thanks!", "crew_lead"],
  ["what's the plan for the move", "crew_lead"],
  ["can you book me a u-haul for saturday", "crew_lead"],
  ["hire movers for saturday", "crew_lead"],
  ["can you read my lease", "crew_lead"],
  ["email my landlord that I'm leaving", "crew_lead"],
];

describe("each kind of text goes to the Elf whose job it is", () => {
  test.each(TABLE)("%p → %p", async (text, expected) => {
    const d = await decide(text);
    expect(d.elf, `${text} (${d.via})`).toBe(expected);
    expect(d.via).not.toBe("clarify");
  });

  test("the rules that are not about words: status, what can you do, a pending yes", async () => {
    expect((await decide("status")).elf).toBe("home");
    expect((await decide("what can you do?")).elf).toBe("crew_lead");
  });
});

describe("a text that could be two Elves' job is asked about, not guessed", () => {
  const AMBIGUOUS: [string, ElfName[]][] = [
    ["my deposit for the apartment", ["money", "home"]],
    ["I owe the buyer", ["stuff", "money"]],
  ];
  test.each(AMBIGUOUS)("%p", async (text, options) => {
    const d = await decide(text);
    expect(d.via).toBe("clarify");
    expect(d.elf).toBe("crew_lead");
    expect([...(d.options ?? [])].sort()).toEqual([...options].sort() as NonNullable<typeof d.options>);
  });

  test("a clear text with one strongest Elf is not asked about", async () => {
    expect((await decide("sell my couch and get paid")).via).not.toBe("clarify");
  });
});

describe("the Money Elf's jobs and the Crew Lead's list agree", () => {
  const stateless: Record<string, ElfName> = Object.fromEntries(
    CREW_ABILITIES.flatMap((a) => (a.examples ?? []).map((e) => [e, a.elf] as const)),
  );

  test("every example text in the ability list goes to its own Elf", async () => {
    expect(Object.keys(stateless).length).toBeGreaterThanOrEqual(20);
    for (const [text, elf] of Object.entries(stateless)) {
      const d = await decide(text);
      expect(d.via === "clarify" ? `clarify:${d.options}` : d.elf, text).toBe(elf);
    }
  });

  test("the Money Elf answers each of its examples with an action, never with its 'not sure' menu", async () => {
    const OWNER = "+16175550100";
    const NOW = new Date("2026-10-18T15:00:00Z");
    for (const text of [
      ...CREW_ABILITIES.filter((a) => a.elf === "money").flatMap((a) => a.examples ?? []),
      ...MONEY_CAPABILITIES.map((c) => c.example),
    ]) {
      const elf = createMoneyElf({ store: new MemoryMoneyStore(), rails: new FakeRails(), now: () => NOW });
      const r = await elf.handle({
        llm: { name: "fake", extract: async () => Promise.reject(new Error("fake")) },
        move: { id: "mv_c", ownerHandle: OWNER, name: "Gavin" },
        participant: { handle: OWNER, role: "owner" },
        batch: { spaceId: "s", traceId: "t", messages: [{ id: "m1", text }] },
        traceId: "t",
        log: { debug() {}, info() {}, warn() {}, error() {} },
        now: () => NOW,
      });
      const types = (r.events ?? []).map((e) => e.type);
      expect(types, text).not.toContain("money.unclear");
      expect(types, text).not.toContain("money.help");
      expect(r.replies.length, text).toBe(1);
    }
  });
});

describe("through the real service: ask which, then hand the original text to the Elf chosen", () => {
  const owner = "+16175550100";
  function boot() {
    const transport = new ScriptTransport();
    const store = new MemoryStore();
    const moneyElf = createMoneyElf({ store: new MemoryMoneyStore(), rails: new FakeRails() });
    const service = createService({
      store,
      transport,
      llm: new FakeLLM(),
      memory: null,
      listings: new FakeListings(),
      debounceMs: 30,
      publicUrl: null,
      logger: createLogger("test", "error"),
      elves: allElves.map((e) =>
        e.name === "money" ? { ...moneyElf, handle: (c) => moneyElf.handle(c) } : e,
      ),
    });
    const ctrl = new AbortController();
    void service.run(ctrl.signal);
    const say = async (text: string) => {
      const before = transport.sent.length;
      transport.push(owner, text);
      await transport.settled();
      await service.pipeline.idle();
      return transport.sent.slice(before).map((s) => s.text);
    };
    return { store, say, stop: () => ctrl.abort(), transport };
  }

  test("'my deposit for the apartment' is asked about; '1' sends it to the Money Elf with the original words", async () => {
    const t = boot();
    await t.say("hi");
    const asked = (await t.say("my deposit for the apartment")).join("\n");
    expect(asked).toStartWith("🧭 Crew Lead\n\n");
    expect(asked).toContain(clarifyQuestion(["money", "home"]));
    expect((asked.match(/\p{Extended_Pictographic}/gu) ?? []).length).toBe(2); // the header and the one ❓
    const move = (await t.store.listMoves())[0];
    expect(parseClarify(await t.store.getCursor(clarifyKey(move!.id)))?.text).toBe(
      "my deposit for the apartment",
    );

    // option 1 is Money: the Money Elf now handles "my deposit for the apartment", under its own header
    const answered = (await t.say("1")).join("\n");
    expect(answered).toStartWith("💸 Money Elf\n\n");
    expect(await t.store.getCursor(clarifyKey(move!.id))).toBe("");
    t.stop();
  });

  test("an answer that picks nothing is dropped, and the text is taken at face value", async () => {
    const t = boot();
    await t.say("hi");
    await t.say("I owe the buyer");
    const out = (await t.say("sell my couch")).join("\n");
    expect(out).not.toContain("Which did you mean?");
    t.stop();
  });

  test("something the crew can't understand at all gets a question with the three jobs, not a guess", async () => {
    const t = boot();
    await t.say("hi");
    const out = (await t.say("blorp the frobnicator")).join("\n");
    expect(out).toContain("I can take that three ways:");
    expect(out).toContain("1. Home Elf:");
    expect(out).toContain("2. Stuff Elf:");
    expect(out).toContain("3. Money Elf:");
    // small talk and questions about the move are not "unclear"
    expect((await t.say("thanks!")).join("\n")).not.toContain("Which did you mean?");
    expect((await t.say("when is my move-out?")).join("\n")).not.toContain("Which did you mean?");
    t.stop();
  });

  test("the router leaves the pending question alone when the owner is not answering it", async () => {
    const store = new MemoryStore();
    await store.setCursor(
      clarifyKey("mv1"),
      JSON.stringify({ text: "my deposit", options: ["money", "home"], at: Date.now() - 31 * 60_000 }),
    );
    // too old: "1" is just "1"
    const d = await route(
      batchOf("1"),
      { store, llm: new FakeLLM(), elves },
      { firstContact: false, moveId: "mv1" },
    );
    expect(d.via).not.toBe("clarified");
    await store.setThreadOwner(spaceOwnerKey("s1"), "crew_lead");
  });
});

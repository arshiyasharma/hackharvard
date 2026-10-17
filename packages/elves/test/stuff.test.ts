import { describe, expect, test } from "bun:test";
import {
  bostonTime,
  buyDecision,
  buyScamFlags,
  type DealHooks,
  droppedAsk,
  dueStage,
  moveReport,
  noDealHooks,
  parseMaxCents,
  parseStuffAction,
  reportText,
  resolveTargets,
  runLastCall,
} from "@elves/elves";
import { type Item, MemoryStore } from "@elves/shared";

async function seed() {
  const store = new MemoryStore();
  const move = await store.createMove({
    ownerHandle: "+15550000001",
    ownerSpaceId: "s-owner",
    platform: "imessage",
  });
  await store.updateMove(move.id, { moveOutAt: "2026-10-25" });
  const couch = await store.upsertItem({
    moveId: move.id,
    name: "gray couch",
    category: "couch",
    weightLb: 150,
    floorPriceCents: 8000,
    listPriceCents: 12000,
    listingApproved: true,
  });
  const lamp = await store.upsertItem({
    moveId: move.id,
    name: "lamp",
    category: "small",
    weightLb: 10,
    floorPriceCents: 500,
    listPriceCents: 2000,
    listingApproved: true,
  });
  const mattress = await store.upsertItem({
    moveId: move.id,
    name: "mattress",
    category: "mattress",
    weightLb: 60,
  });
  return { store, move: (await store.getMove(move.id))!, couch, lamp, mattress };
}

function recordingHooks() {
  const calls: string[] = [];
  const hooks: DealHooks = {
    async listingApproved(i) {
      calls.push(`approved:${i.name}`);
      return undefined;
    },
    async priceChanged(i, reason) {
      calls.push(`price:${i.name}:${reason}:${i.listPriceCents}`);
    },
    async itemWithdrawn(i, reason) {
      calls.push(`withdrawn:${i.name}:${reason}`);
    },
  };
  return { calls, hooks };
}

describe("parseStuffAction", () => {
  test.each([
    ["donate the rest", { kind: "donate", targets: "rest" }],
    ["give away the lamp", { kind: "give", targets: "named" }],
    ["can the desk go on the curb", { kind: "give", targets: "named" }],
    ["I'm keeping the bed", { kind: "keep", targets: "named" }],
    ["sold the couch myself for 70", { kind: "gone", outcome: "sold" }],
    ["the lamp got picked up", { kind: "gone", outcome: "picked_up" }],
    ["donated the chair today", { kind: "gone", outcome: "donated" }],
    ["tossed the mattress", { kind: "gone", outcome: "dumped" }],
    ["send me the move report", { kind: "report" }],
    ["what's left?", { kind: "status" }],
  ])("%p", (text, want) => {
    expect(parseStuffAction(text)).toMatchObject(want);
  });
  test.each([["when does the couch get picked up?"], ["moving out nov 1"], ["$60"], ["list it"]])(
    "%p is not an action",
    (text) => {
      const a = parseStuffAction(text);
      expect(a === null || a.kind !== "gone").toBe(true);
      if (text !== "when does the couch get picked up?") expect(a).toBeNull();
    },
  );
});

describe("resolveTargets", () => {
  test("names several items in one phrase, or all open items for the rest", async () => {
    const { store, move } = await seed();
    const items = await store.listItems(move.id);
    expect(
      resolveTargets(items, ["give away the lamp and the couch"], false)
        .map((i) => i.name)
        .sort(),
    ).toEqual(["gray couch", "lamp"]);
    expect(resolveTargets(items, ["donate the rest"], true)).toHaveLength(3);
    expect(resolveTargets(items, ["keep me posted"], false)).toHaveLength(0);
  });
});

describe("Last Call", () => {
  test("anchored at 6 PM Boston time, EDT and EST", () => {
    expect(bostonTime("2026-10-25", 18).toISOString()).toBe("2026-10-25T22:00:00.000Z");
    expect(bostonTime("2026-12-01", 18).toISOString()).toBe("2026-12-01T23:00:00.000Z");
  });

  test("stage boundaries", () => {
    const t0 = bostonTime("2026-10-25", 18).getTime();
    const at = (h: number) => new Date(t0 - h * 3600_000);
    expect(dueStage("2026-10-25", at(49))).toBeNull();
    expect(dueStage("2026-10-25", at(48))).toBe("dropped");
    expect(dueStage("2026-10-25", at(24))).toBe("free");
    expect(dueStage("2026-10-25", at(0))).toBe("closed");
  });

  test("the drop never goes under the floor", () => {
    expect(droppedAsk(12000, 8000)).toBe(8000);
    expect(droppedAsk(12000, 5000)).toBe(7000);
    expect(droppedAsk(2000, 500)).toBe(1200);
  });

  test("walks dropped -> free -> closed, tells the engine, and is idempotent", async () => {
    const { store, move, couch, lamp, mattress } = await seed();
    const { calls, hooks } = recordingHooks();
    const t0 = bostonTime("2026-10-25", 18).getTime();

    const r1 = await runLastCall(store, hooks, move, new Date(t0 - 47 * 3600_000));
    expect(r1.stage).toBe("dropped");
    expect(r1.ownerText).toContain("haven't sold");
    expect(r1.ownerText).toContain("keep");
    const afterDrop = await store.listItems(move.id);
    expect(afterDrop.find((i) => i.id === couch.id)?.listPriceCents).toBe(8000); // 60% of 120 = 72 < floor 80
    expect(afterDrop.find((i) => i.id === lamp.id)?.listPriceCents).toBe(1200);
    expect(calls).toContain("price:gray couch:last_call_drop:8000");

    const again = await runLastCall(store, hooks, move, new Date(t0 - 46 * 3600_000));
    expect(again.stage).toBeNull();

    const r2 = await runLastCall(store, hooks, move, new Date(t0 - 23 * 3600_000));
    expect(r2.stage).toBe("free");
    expect(r2.ownerText).toContain("free");
    expect(r2.ownerText).toContain("311"); // the mattress gets a drafted pickup
    const freed = await store.listItems(move.id);
    expect(freed.every((i) => i.listPriceCents === 0 && i.intent === "give")).toBe(true);
    expect(freed.every((i) => i.floorPriceCents == null || i.floorPriceCents > 0)).toBe(true); // floor is never rewritten
    expect(calls).toContain(`approved:${mattress.name}`); // never listed before: the engine opens it free

    const r3 = await runLastCall(store, hooks, move, new Date(t0 + 60_000));
    expect(r3.stage).toBe("closed");
    expect((await store.listItems(move.id)).every((i) => i.outcome === "dumped")).toBe(true);
    expect(r3.events.filter((e) => e.type === "item.leaving")).toHaveLength(3);
  });

  test("kept items are left alone; a late start catches up in one message", async () => {
    const { store, move, couch } = await seed();
    await store.upsertItem({ ...couch, intent: "keep", outcome: "kept" });
    const t0 = bostonTime("2026-10-25", 18).getTime();
    const run = await runLastCall(store, noDealHooks, move, new Date(t0 - 10 * 3600_000));
    expect(run.stage).toBe("free");
    expect(run.ownerText).not.toContain("couch");
    expect((await store.listItems(move.id)).find((i) => i.id === couch.id)?.outcome).toBe("kept");
  });

  test("no move-out date, no Last Call", async () => {
    const { store, move } = await seed();
    const run = await runLastCall(store, noDealHooks, { ...move, moveOutAt: null }, new Date());
    expect(run.stage).toBeNull();
  });
});

describe("Move Report", () => {
  test("diverted counts sold, given and donated; dumped counts against; kept is neither", () => {
    const base = {
      moveId: "m",
      title: null,
      description: null,
      condition: null,
      priceLowCents: null,
      priceHighCents: null,
      floorPriceCents: null,
      photoAttachmentIds: [],
      listingApproved: true,
      intent: "sell" as const,
      outcomeAt: null,
      leavesBeforeMoveDay: true,
      lastCallStage: null,
      createdAt: "",
    };
    const items: Item[] = [
      {
        ...base,
        id: "a",
        name: "couch",
        category: "couch",
        weightLb: 150,
        listPriceCents: 9000,
        outcome: "sold",
      },
      {
        ...base,
        id: "b",
        name: "lamp",
        category: "small",
        weightLb: 10,
        listPriceCents: 0,
        outcome: "given",
      },
      {
        ...base,
        id: "c",
        name: "mattress",
        category: "mattress",
        weightLb: 60,
        listPriceCents: null,
        outcome: "dumped",
      },
      {
        ...base,
        id: "d",
        name: "bed",
        category: "mattress",
        weightLb: 60,
        listPriceCents: null,
        outcome: "kept",
      },
    ];
    const r = moveReport(items, [
      {
        id: "e",
        moveId: "m",
        type: "item.sold",
        payload: { itemId: "a", cents: 7000 },
        traceId: null,
        createdAt: "",
      },
    ]);
    expect(r.lbDiverted).toBe(160);
    expect(r.lbDumped).toBe(60);
    expect(r.kgCo2eAvoided).toBe(Math.round(150 * 1.915 + 10 * 1.01));
    expect(r.dollarsRecoveredCents).toBe(7000);
    expect(r.byOutcome.kept).toBe(1);
    const text = reportText(r);
    expect(text).toContain("160 lb");
    expect(text).toContain("approximate");
    expect(text).toContain("counts against");
  });
});

describe("Buy mode", () => {
  test("parseMaxCents", () => {
    expect(parseMaxCents("max 100")).toBe(10000);
    expect(parseMaxCents("up to $120 for it")).toBe(12000);
    expect(parseMaxCents("budget is 80")).toBe(8000);
    expect(parseMaxCents("is this a good deal")).toBeNull();
  });

  test("verdicts and offers never exceed the owner's max or the asking price", () => {
    expect(
      buyDecision({ askingCents: 5000, fairLowCents: 6000, fairHighCents: 9000, maxCents: 10000, flags: [] }),
    ).toEqual({
      verdict: "good_deal",
      offerCents: 5000,
      overMax: false,
    });
    const fair = buyDecision({
      askingCents: 8000,
      fairLowCents: 6000,
      fairHighCents: 9000,
      maxCents: null,
      flags: [],
    });
    expect(fair.verdict).toBe("fair");
    expect(fair.offerCents).toBe(7000);
    const over = buyDecision({
      askingCents: 15000,
      fairLowCents: 6000,
      fairHighCents: 9000,
      maxCents: 6000,
      flags: [],
    });
    expect(over.verdict).toBe("overpriced");
    expect(over.offerCents).toBe(6000);
    expect(over.overMax).toBe(true);
  });

  test("scam rules name themselves and kill the offer", () => {
    const flags = buyScamFlags({
      title: "Herman Miller chair",
      askingUsd: 60,
      fairLowUsd: 300,
      sellerText: "I'm out of the country, Zelle me a deposit first and a courier brings it",
    });
    expect(flags.length).toBeGreaterThanOrEqual(2);
    expect(flags.some((f) => f.includes("35%"))).toBe(true);
    expect(
      buyDecision({ askingCents: 6000, fairLowCents: 30000, fairHighCents: 50000, maxCents: 10000, flags }),
    ).toMatchObject({
      verdict: "likely_scam",
      offerCents: null,
    });
  });
});

import { describe, expect, test } from "bun:test";
import { readBooks } from "../src/books.ts";
import { MemoryMoneyStore } from "../src/ledger.ts";
import { createMoneyElf } from "../src/money-elf.ts";
import { parseRules } from "../src/parse.ts";
import { FakeRails } from "../src/rails.ts";
import type { MoneyContext, MoneyItem, MoneyResult } from "../src/types.ts";
import { fakeLLM, NOW, OWNER, reply } from "./helpers.ts";
import { ledgerPageHtml } from "../src/ledger-page.ts";
import { buildLedgerView } from "../src/ledger-view.ts";

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

function item(
  id: string,
  name: string,
  list: number,
  floor: number | null,
  extra: Partial<MoneyItem> = {},
): MoneyItem {
  return {
    id,
    name,
    category: "furniture",
    weightLb: 60,
    listPriceCents: list,
    floorPriceCents: floor,
    outcome: "listed",
    ...extra,
  };
}

function setup(opts: { items?: MoneyItem[] | null; moveOutAt?: string | null } = {}) {
  let offset = 0;
  const clock = () => new Date(NOW.getTime() + offset * 86_400_000);
  const store = new MemoryMoneyStore();
  const rails = new FakeRails();
  const elf = createMoneyElf({ store, rails, now: clock });
  const items =
    opts.items === undefined
      ? [
          item("it_couch", "couch", 12000, 8000),
          item("it_desk", "desk", 8000, 5000),
          item("it_lamp", "lamp", 2500, 1500, { category: "decor", weightLb: 8 }),
        ]
      : opts.items;
  const move = {
    id: "mv_plan",
    ownerHandle: OWNER,
    name: "Gavin",
    moveOutAt: opts.moveOutAt === undefined ? "2026-10-27" : opts.moveOutAt,
  };
  let n = 0;
  async function say(text: string | null, vote?: { id: string; text: string }): Promise<MoneyResult> {
    const ctx: MoneyContext = {
      llm: fakeLLM,
      move,
      participant: { handle: OWNER, role: "owner" },
      batch: {
        spaceId: "sp_owner",
        traceId: `t${++n}`,
        messages: [{ id: `m${n}`, text, pollVote: vote ? { selectedOptions: [vote] } : null }],
      },
      traceId: `t${n}`,
      log: quiet,
      now: clock,
      store: {
        listParticipants: async () => [{ handle: OWNER, spaceId: "sp_owner" }],
        ...(items ? { listItems: async () => items } : {}),
      },
    };
    return elf.handle(ctx);
  }
  return { store, rails, elf, move, items, say, ff: (d: number) => (offset += d) };
}

describe("move plans: parsing", () => {
  const p = (t: string) => parseRules(t, NOW).kind;
  test("plan texts", () => {
    expect(parseRules("plan my move under $300", NOW)).toEqual({ kind: "plan_draft", budgetCents: 30000 });
    expect(p("keep this move under $400")).toBe("plan_draft");
    expect(parseRules("go with B", NOW)).toEqual({ kind: "plan_choose", label: "B" });
    expect(parseRules("switch to plan a", NOW)).toEqual({ kind: "plan_choose", label: "A" });
    expect(parseRules("C", NOW)).toEqual({ kind: "plan_choose", label: "C" });
    expect(p("what plan am I on?")).toBe("plan_status");
    expect(p("drop the plan")).toBe("plan_cancel");
  });
  test("a payment plan is still a loan, and yes is still yes", () => {
    expect(p("can I do a payment plan, $20 a month?")).toBe("loan");
    expect(p("let Sam pay the truck at $40 a month")).toBe("loan");
    expect(p("yes")).toBe("approve");
    expect(p("show me the ledger")).toBe("ledger");
  });
});

describe("move plans: Nessie", () => {
  test("pending records never count toward the totals", async () => {
    const { store, rails, elf, move, say } = setup();
    await say("split the $360 storage unit with Sam");
    const before = await readBooks(store, rails, move.id);
    await say("plan my move under $300");
    await say("go with A");
    const after = await readBooks(store, rails, move.id);
    expect(after.planned.length).toBeGreaterThan(0);
    expect(after.planned.every((r) => r.status === "pending")).toBe(true);
    expect({ ...after, planned: [], records: 0 }).toEqual({ ...before, planned: [], records: 0 });
    expect(elf.service).toBeDefined();
  });

  test("drafting sends three plans, a picture and a poll; a tap writes future-dated pending records", async () => {
    const { store, rails, say } = setup();
    const r = await say("plan my move under $300");
    expect(reply(r)).toContain("A · best odds · ");
    expect(reply(r)).toContain("B · runner-up · ");
    expect(r.images?.[0]?.filename).toBe("plans.png");
    expect(r.poll?.options.map((o) => o.text)).toEqual(["Plan A", "Plan B", "Plan C", "Not now"]);
    const tap = await say(null, r.poll?.options[0]);
    expect(reply(tap)).toMatch(/^On plan A: /);
    expect(tap.events?.some((e) => e.type === "plan.chosen")).toBe(true);
    const lines = (await store.getPlans("mv_plan"))?.lines ?? [];
    expect(lines.some((l) => l.kind === "withdrawal" && l.date === "2026-10-27")).toBe(true);
    const settles = rails.calls
      .filter((c) => c.op === "moveMoney")
      .map((c) => (c.input as { status?: string }).status);
    expect(settles.every((s) => s === "pending")).toBe(true);
  });

  test("a switch cancels the old plan's pending records; a sale settles its record completed", async () => {
    const { store, rails, items, elf, move, say, ff } = setup();
    await say("plan my move under $300");
    await say("go with A");
    const first = (await store.getPlans(move.id))?.lines ?? [];
    ff(3);
    const desk = items?.find((i) => i.id === "it_desk");
    if (desk) desk.outcome = "sold";
    await elf.plans.sweep(move, items ?? []);
    const settledDesk = (await store.getPlans(move.id))?.lines.find((l) => l.itemId === "it_desk");
    if (settledDesk) expect(settledDesk.status).toBe("completed");
    await say("switch to plan B");
    const all = (await store.getPlans(move.id))?.lines ?? [];
    for (const l of first) {
      const now = all.find((x) => x.lineId === l.lineId);
      expect(now?.status).toBe(l.itemId === "it_desk" && settledDesk ? "completed" : "cancelled");
    }
    expect(rails.calls.some((c) => c.op === "settle")).toBe(true);
  });

  test("falling behind nudges the owner once, with a poll to switch", async () => {
    const { elf, move, items, say, ff } = setup();
    await say("split the $360 storage unit with Sam");
    await say("yes");
    await say("plan my move under $150");
    await say("go with A");
    ff(5);
    const r1 = await elf.plans.sweep(move, items ?? []);
    expect(r1.events.some((e) => e.type === "plan.drift")).toBe(true);
    expect(r1.outbound[0]?.text).toMatch(/^You're behind plan A: /);
    expect(r1.outbound[0]?.poll?.options[0]?.id).toMatch(/^money:plan:[a-z0-9]+:A$/);
    const r2 = await elf.plans.sweep(move, items ?? []);
    expect(r2.outbound).toHaveLength(0);
  });

  test("a tap on out-of-date drafts doesn't pick anything", async () => {
    const { store, say } = setup();
    const old = await say("plan my move under $300");
    await say("plan my move under $350");
    const r = await say(null, old.poll?.options[1]);
    expect(reply(r)).toMatch(/out of date/);
    expect((await store.getPlans("mv_plan"))?.chosen).toBeNull();
  });

  test("says why when it can't plan", async () => {
    expect(reply(await setup({ items: null }).say("plan my move under $300"))).toMatch(
      /can't see your items/,
    );
    expect(reply(await setup({ moveOutAt: null }).say("plan my move under $300"))).toMatch(/move-out date/);
    expect(reply(await setup({ items: [] }).say("plan my move under $300"))).toMatch(
      /^Couldn't draft plans: /,
    );
    expect(reply(await setup().say("plan my move"))).toMatch(/budget/);
    expect(reply(await setup().say("go with B"))).toMatch(/haven't drafted plans/);
  });
});

describe("the dashboard's middle section is the Smart Plan layer", () => {
  const page = async (steps: string[]) => {
    const { elf, move, say } = setup();
    for (const t of steps) await say(t);
    const v = await buildLedgerView(elf.service, move);
    return ledgerPageHtml(v, { imageUrl: "x.png", pageUrl: "x" });
  };
  const between = (html: string, a: string, b: string) => html.indexOf(a) < html.indexOf(b) && html.indexOf(a) > -1;

  test("before any plan it explains the layer and how to get a plan", async () => {
    const html = await page(["split the $360 storage unit with Sam", "yes"]);
    expect(html).toContain("Beyond the ledger");
    expect(html).toContain("Nessie records what happened. This plans what's next.");
    expect(html).toContain("Your odds of finishing under budget");
    expect(html).toContain('data-go="plan"');
    expect(html).toContain('data-copy="plan my move under $400"');
  });

  test("with drafts it shows the odds of each plan; picking one marks it", async () => {
    const drafts = await page(["plan my move under $300"]);
    expect(drafts).toContain("Three ways to finish the move, with the odds");
    expect(drafts).toContain("Reply A, B or C in Messages");
    expect((drafts.match(/class="sp-row[" ]/g) ?? []).length).toBe(3);
    const chosen = await page(["plan my move under $300", "go with A"]);
    expect(chosen).toContain("Plan A is running your move");
    expect(chosen).toContain("your pick");
    expect((chosen.match(/class="sp-row chosen"/g) ?? []).length).toBe(1);
  });

  test("it sits in the middle of Overview: after the hero and approvals, before the balances", async () => {
    const html = await page(["split the $360 storage unit with Sam", "yes", "plan my move under $300"]);
    expect(between(html, 'id="tab-overview"', 'class="smart"')).toBe(true);
    expect(between(html, 'class="smart"', 'class="stats"')).toBe(true);
    expect(html.indexOf('data-tab="plan"')).toBeLessThan(html.indexOf('data-tab="back"'));
  });
});

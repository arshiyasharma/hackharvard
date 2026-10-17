import { describe, expect, test } from "bun:test";
import type { Books } from "../src/books.ts";
import type { LedgerEntry } from "../src/ledger.ts";
import { clip } from "../src/ledger-card.ts";
import { ledgerPageHtml } from "../src/ledger-page.ts";
import { buildLedgerView } from "../src/ledger-view.ts";
import { ASSUMED_DAYS, netPhrase, projectMove } from "../src/projection.ts";
import { projectionChart } from "../src/projection-chart.ts";
import { NOW, setup } from "./helpers.ts";

const SAM = "+16175550101";

function books(over: Partial<Books> = {}): Books {
  return {
    fundCents: 0,
    escrowCents: 0,
    spentCents: 0,
    collectedCents: 0,
    salesCents: 0,
    depositsOutCents: 0,
    owes: [],
    recent: [],
    records: 0,
    ...over,
  };
}

function entry(over: Partial<LedgerEntry>): LedgerEntry {
  return {
    id: "le_x",
    moveId: "m",
    date: "2026-10-17",
    kind: "deposit",
    what: "sublet",
    paidBy: null,
    owedBy: null,
    paidTo: null,
    amountCents: 50000,
    status: "pending",
    escrow: null,
    dueBackAt: null,
    groupId: null,
    requested: false,
    notified: false,
    paidCents: 0,
    loanId: null,
    loanMonthlyCents: null,
    flagged: false,
    nessie: { withdrawalIds: [], depositIds: [], billId: null, purchaseIds: [] },
    createdAt: "",
    updatedAt: "",
    ...over,
  } as LedgerEntry;
}

describe("projectMove", () => {
  test("net cost now, what's expected back, and where it lands", () => {
    const p = projectMove({
      books: books({
        spentCents: 24000,
        depositsOutCents: 50000,
        collectedCents: 4000,
        owes: [
          { personId: "p1", name: "Priya", billCents: 8000, bills: [], loanCents: 0, loanMonthlyCents: null },
          { personId: "p2", name: "Sam", billCents: 0, bills: [], loanCents: 8000, loanMonthlyCents: 3000 },
        ],
      }),
      entries: [entry({ dueBackAt: "2026-12-01" })],
      names: new Map(),
      now: NOW,
    });
    expect(p).toMatchObject({ outCents: 74000, backCents: 4000, netNowCents: 70000, expectedCents: 66000 });
    expect(p.projectedNetCents).toBe(4000);
    // Sam's $80 loan at $30/month: $30, $30, then the last $20.
    expect(p.expected.filter((x) => x.kind === "loan").map((x) => [x.date, x.cents])).toEqual([
      ["2026-11-16", 3000],
      ["2026-12-16", 3000],
      ["2027-01-15", 2000],
    ]);
    expect(p.settledBy).toBe("2027-01-15");
    expect(p.points[0]).toEqual({ date: "2026-10-17", netCents: 70000 });
    expect(p.points.at(-1)?.netCents).toBe(4000);
  });

  test("dates nobody agreed to are estimates, and say so", () => {
    const p = projectMove({
      books: books({
        owes: [
          { personId: "p1", name: "Priya", billCents: 8000, bills: [], loanCents: 0, loanMonthlyCents: null },
        ],
      }),
      entries: [entry({ dueBackAt: null })],
      names: new Map(),
      now: NOW,
    });
    expect(p.hasEstimates).toBe(true);
    expect(p.expected.find((x) => x.kind === "share")).toMatchObject({
      date: "2026-10-24",
      certainty: "estimated",
    });
    expect(p.expected.find((x) => x.kind === "deposit")?.certainty).toBe("estimated");
    expect(ASSUMED_DAYS.share).toBe(7);
  });

  test("a held sale lands on its pickup date when one is set", () => {
    const p = projectMove({
      books: books(),
      entries: [
        entry({
          kind: "sale",
          what: "couch",
          escrow: "held",
          amountCents: 9000,
          paidBy: "b1",
          pickupAt: "2026-10-19T15:00:00Z",
        } as Partial<LedgerEntry>),
      ],
      names: new Map([["b1", "Alex"]]),
      now: NOW,
    });
    expect(p.expected).toEqual([
      { date: "2026-10-19", label: "couch sale (Alex)", cents: 9000, kind: "sale", certainty: "scheduled" },
    ]);
  });

  test("flagged and settled entries are left out; several on one day make one point", () => {
    const p = projectMove({
      books: books({ spentCents: 1000 }),
      entries: [
        entry({ flagged: true }),
        entry({ status: "refunded" }),
        entry({ id: "a", what: "truck", amountCents: 1500, dueBackAt: "2026-11-01" }),
        entry({ id: "b", what: "storage", amountCents: 500, dueBackAt: "2026-11-01" }),
      ],
      names: new Map(),
      now: NOW,
    });
    expect(p.expected).toHaveLength(2);
    expect(p.points).toEqual([
      { date: "2026-10-17", netCents: 1000 },
      { date: "2026-11-01", netCents: -1000 },
    ]);
  });

  test("a move that pays for itself reads as money ahead", () => {
    expect(netPhrase(8000)).toBe("$80");
    expect(netPhrase(-1000)).toBe("$10 ahead");
    expect(netPhrase(0)).toBe("$0");
  });
});

describe("the projection on the dashboard", () => {
  test("the live view carries a projection built from Nessie and the Ledger", async () => {
    const s = setup();
    await s.say(`Sam is ${SAM}`);
    await s.say("split the $240 truck with Sam and Priya");
    await s.say("yes");
    await s.say("I paid a $500 holding deposit on the sublet, due back Dec 1");
    const v = await buildLedgerView(s.elf.service, s.move);
    expect(v.projection.netNowCents).toBe(74000);
    expect(v.projection.expectedCents).toBe(66000);
    expect(v.projection.projectedNetCents).toBe(8000);
    expect(v.projection.settledBy).toBe("2026-12-01");
  });

  test("the chart draws a step line with hollow dots for estimates, and nothing when nothing is expected", () => {
    const p = projectMove({
      books: books({
        spentCents: 24000,
        owes: [
          { personId: "p1", name: "Priya", billCents: 8000, bills: [], loanCents: 0, loanMonthlyCents: null },
        ],
      }),
      entries: [entry({ dueBackAt: "2026-12-01" })],
      names: new Map(),
      now: NOW,
    });
    const c = { line: "#0a0", grid: "#999", text: "#000", muted: "#666", bg: "#fff" };
    const svg = projectionChart(p, { x: 0, y: 0, w: 500, h: 200 }, c, { size: 12, family: "Inter" });
    expect(svg).toContain("<path");
    expect(svg.match(/fill:#fff/g)?.length).toBe(1);
    expect(svg).toContain("Projected");
    const empty = projectMove({ books: books(), entries: [], names: new Map(), now: NOW });
    expect(projectionChart(empty, { x: 0, y: 0, w: 500, h: 200 }, c, { size: 12, family: "Inter" })).toBe("");
  });

  test("the page shows both headline numbers and labels estimates", async () => {
    const s = setup();
    await s.say("split the $240 truck with Sam and Priya");
    await s.say("yes");
    const v = await buildLedgerView(s.elf.service, s.move);
    const html = ledgerPageHtml(v, { imageUrl: "https://x/i.png", pageUrl: "https://x/p" });
    expect(html).toContain("Move cost projection");
    expect(html).toContain("Net cost so far");
    expect(html).toContain("Projected net cost");
    expect(html).toContain("estimated");
    expect(html).toContain('<svg class="chart"');
  });

  test("long banner text is clipped at a word boundary", () => {
    expect(clip("Waiting on your OK: move $90 from escrow to the Moving Fund for the couch", 54)).toBe(
      "Waiting on your OK: move $90 from escrow to the…",
    );
    expect(clip("short", 54)).toBe("short");
  });
});

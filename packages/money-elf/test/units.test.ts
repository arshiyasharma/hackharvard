import { describe, expect, test } from "bun:test";
import {
  amountAppearsIn,
  fmtUsd,
  normalizePhone,
  parseAmounts,
  parseDate,
  splitCents,
} from "../src/amounts.ts";
import { boardLine, ledgerTotals, MemoryMoneyStore } from "../src/ledger.ts";
import { parseIntent, parseRules } from "../src/parse.ts";
import { containsFinancialNumber, scamCheck } from "../src/scam.ts";
import { NOW } from "./helpers.ts";

describe("amounts", () => {
  test("parses dollar amounts as cents", () => {
    expect(parseAmounts("split the $240 truck")).toEqual([24000]);
    expect(parseAmounts("$1,200.50 and 80 bucks")).toEqual([120050, 8000]);
    expect(parseAmounts("Nov 1 at 3pm")).toEqual([]);
  });
  test("splits always add up to the total", () => {
    expect(splitCents(10000, [1, 1, 1])).toEqual([3334, 3333, 3333]);
    expect(splitCents(9000, [50, 25, 25])).toEqual([4500, 2250, 2250]);
    const parts = splitCents(12345, [2, 1, 1, 3]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(12345);
    expect(() => splitCents(100, [0, 0])).toThrow();
  });
  test("formats dollars", () => {
    expect(fmtUsd(8000)).toBe("$80");
    expect(fmtUsd(3333)).toBe("$33.33");
  });
  test("amountAppearsIn guards invented amounts", () => {
    expect(amountAppearsIn("split the 240 truck", 24000)).toBe(true);
    expect(amountAppearsIn("split the $240 truck", 25000)).toBe(false);
  });
  test("phones and dates", () => {
    expect(normalizePhone("Sam is (617) 555-0101")).toBe("+16175550101");
    expect(parseDate("due back Dec 1", NOW)).toBe("2026-12-01");
    expect(parseDate("back by 3/1", NOW)).toBe("2027-03-01");
    expect(parseDate("on 2026-11-02", NOW)).toBe("2026-11-02");
  });
});

describe("parseRules", () => {
  test("approvals and declines", () => {
    expect(parseRules("yes", NOW).kind).toBe("approve");
    expect(parseRules("go ahead", NOW).kind).toBe("approve");
    expect(parseRules("wait", NOW).kind).toBe("decline");
    expect(parseRules("no don't", NOW).kind).toBe("decline");
  });
  test("even split includes the owner", () => {
    expect(parseRules("split the $240 truck with Sam and Priya", NOW)).toEqual({
      kind: "split",
      amountCents: 24000,
      what: "truck",
      shares: [
        { name: "me", weight: 1 },
        { name: "Sam", weight: 1 },
        { name: "Priya", weight: 1 },
      ],
    });
  });
  test("split by share", () => {
    const i = parseRules("split $90 cleaning: me 50% Sam 25% Priya 25%", NOW);
    expect(i.kind === "split" && i.shares).toEqual([
      { name: "me", weight: 50 },
      { name: "Sam", weight: 25 },
      { name: "Priya", weight: 25 },
    ]);
  });
  test("split with my roommates uses the roster", () => {
    const i = parseRules("split the $120 storage with my roommates", NOW, ["Sam", "Priya"]);
    expect(i.kind === "split" && i.shares.map((s) => s.name)).toEqual(["me", "Sam", "Priya"]);
  });
  test("split excluding me", () => {
    const i = parseRules("Sam and Priya split the $60 pizza, not me. split between Sam and Priya", NOW);
    expect(i.kind === "split" && i.shares.map((s) => s.name)).toEqual(["Sam", "Priya"]);
  });
  test("deposits", () => {
    expect(parseRules("I paid a $500 holding deposit on the sublet, due back Dec 1", NOW)).toEqual({
      kind: "deposit_paid",
      amountCents: 50000,
      what: "sublet",
      dueBackAt: "2026-12-01",
    });
    expect(parseRules("got the truck deposit back", NOW)).toEqual({
      kind: "deposit_returned",
      what: "truck",
    });
  });
  test("pickups, payments, contacts, ledger", () => {
    expect(parseRules("the buyer picked up the couch", NOW)).toEqual({
      kind: "pickup_confirmed",
      item: "couch",
    });
    expect(parseRules("the desk pickup fell through", NOW)).toEqual({ kind: "pickup_failed", item: "desk" });
    expect(parseRules("Sam paid me on venmo", NOW)).toEqual({ kind: "mark_paid", person: "Sam", what: null });
    expect(parseRules("pay Sam $40 for gas", NOW)).toEqual({
      kind: "pay_person",
      person: "Sam",
      amountCents: 4000,
      what: "gas",
    });
    expect(parseRules("Sam's number is 617-555-0101", NOW)).toEqual({
      kind: "add_contact",
      name: "Sam",
      handle: "+16175550101",
    });
    expect(parseRules("who owes what?", NOW).kind).toBe("ledger");
  });
});

describe("parseIntent with an LLM", () => {
  test("rejects an amount the owner never wrote", async () => {
    const llm = {
      name: "claude",
      async extract() {
        return {
          kind: "split",
          amountDollars: 300,
          what: "truck",
          people: [
            { name: "me", weight: 1 },
            { name: "Sam", weight: 1 },
          ],
          person: null,
          phone: null,
          dueBack: null,
          item: null,
        } as never;
      },
    };
    const i = await parseIntent("split the $240 truck with Sam", { llm, now: NOW, roommates: [] });
    expect(i.kind === "split" && i.amountCents).toBe(24000);
  });
  test("uses the LLM result when the amount checks out", async () => {
    const llm = {
      name: "claude",
      async extract() {
        return {
          kind: "split",
          amountDollars: 240,
          what: "truck",
          people: [
            { name: "me", weight: 2 },
            { name: "sam", weight: 1 },
          ],
          person: null,
          phone: null,
          dueBack: null,
          item: null,
        } as never;
      },
    };
    const i = await parseIntent("can sam cover a third of the 240 truck", { llm, now: NOW, roommates: [] });
    expect(i).toEqual({
      kind: "split",
      amountCents: 24000,
      what: "truck",
      shares: [
        { name: "me", weight: 2 },
        { name: "Sam", weight: 1 },
      ],
    });
  });
  test("yes never goes to the LLM", async () => {
    const llm = {
      name: "claude",
      async extract(): Promise<never> {
        throw new Error("should not be called");
      },
    };
    expect((await parseIntent("yes", { llm, now: NOW, roommates: [] })).kind).toBe("approve");
  });
});

describe("scam check", () => {
  test("flags the known patterns", () => {
    const reasons = (t: string) => scamCheck(t).map((f) => f.reason);
    expect(reasons("I'll send a cashier's check for $500, just send back the difference")).toContain(
      "overpayment",
    );
    expect(reasons("my mover will pick it up, I'm out of town")).toContain("sends_mover");
    expect(reasons("pay with gift cards please")).toContain("off_platform");
    expect(reasons("send a $300 deposit before you see the apartment")).toContain("deposit_before_viewing");
    expect(reasons("what's your card number so I can pay")).toContain("asks_for_financial_info");
    expect(
      scamCheck("listing at $20", { priceCents: 2000, marketLowCents: 20000 }).map((f) => f.reason),
    ).toEqual(["below_market"]);
  });
  test("ordinary money talk is not flagged", () => {
    expect(scamCheck("split the $240 truck with Sam and Priya")).toEqual([]);
    expect(scamCheck("I paid the truck deposit on my credit card")).toEqual([]);
    expect(scamCheck("Sam paid me on venmo")).toEqual([]);
  });
  test("detects card and bank numbers but not phones", () => {
    expect(containsFinancialNumber("my card is 4111 1111 1111 1111")).toBe(true);
    expect(containsFinancialNumber("routing 021000021")).toBe(true);
    expect(containsFinancialNumber("Sam is 617-555-0101")).toBe(false);
  });
});

describe("ledger totals", () => {
  test("adds up by kind and ignores flagged rows", async () => {
    const s = new MemoryMoneyStore();
    const base = { moveId: "m", date: "2026-10-17" };
    await s.addEntry({
      ...base,
      kind: "expense",
      what: "truck",
      amountCents: 24000,
      paidBy: "o",
      status: "paid",
    });
    await s.addEntry({ ...base, kind: "split", what: "truck", amountCents: 8000, owedBy: "s" });
    await s.addEntry({
      ...base,
      kind: "split",
      what: "truck",
      amountCents: 8000,
      owedBy: "p",
      status: "paid",
    });
    await s.addEntry({ ...base, kind: "sale", what: "couch", amountCents: 9000, escrow: "held" });
    await s.addEntry({ ...base, kind: "deposit", what: "sublet", amountCents: 50000, paidBy: "o" });
    await s.addEntry({
      ...base,
      kind: "payment",
      what: "gift cards",
      amountCents: 30000,
      paidBy: "o",
      flagged: true,
    });
    const t = ledgerTotals(await s.listEntries("m"), "o");
    expect(t).toMatchObject({
      spentCents: 24000,
      owedToOwnerCents: 8000,
      collectedCents: 8000,
      inEscrowCents: 9000,
      depositsOutCents: 50000,
    });
    expect(boardLine(t)).toBe(
      "Ledger: $240 spent, $80 owed to you, $80 collected, $90 in escrow, $500 in deposits out",
    );
  });
  test("rejects non-integer or non-positive amounts", async () => {
    const s = new MemoryMoneyStore();
    await expect(
      s.addEntry({ moveId: "m", date: "d", kind: "expense", what: "x", amountCents: 12.5 }),
    ).rejects.toThrow();
    await expect(
      s.addEntry({ moveId: "m", date: "d", kind: "expense", what: "x", amountCents: 0 }),
    ).rejects.toThrow();
  });
});

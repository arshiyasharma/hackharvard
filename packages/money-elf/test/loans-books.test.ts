import { describe, expect, test } from "bun:test";
import { readTag } from "../src/books.ts";
import { NessieRails } from "../src/rails.ts";
import { defaultMonthly } from "../src/service.ts";
import { eventTypes, OWNER, reply, setup } from "./helpers.ts";

const SAM = "+16175550101";

async function samOwesTruck(s: ReturnType<typeof setup>) {
  await s.say(`Sam is ${SAM}`);
  await s.say("split the $240 truck with Sam and Priya");
  await s.say("yes");
}

describe("Moving Fund loans (roommate IOUs)", () => {
  test("a roommate asks, the owner approves, and the share becomes a Nessie loan", async () => {
    const s = setup();
    await samOwesTruck(s);

    const ask = await s.say("can I do a payment plan, $20 a month?", { from: SAM, role: "roommate" });
    expect(reply(ask)).toContain("I asked about a payment plan");
    expect(ask.outbound).toHaveLength(1);
    expect(ask.outbound?.[0]).toMatchObject({
      toHandle: OWNER,
      text: expect.stringContaining("Sam can pay the $80 truck share at $20 a month, 4 payments."),
      poll: { selectionMode: "single" },
    });
    expect(s.rails.loans.size).toBe(0);

    const ok = await s.say("yes");
    expect(reply(ok)).toContain("Sam's $80 is a Moving Fund loan at $20 a month.");
    expect(eventTypes(ok)).toContain("loan.created");
    expect(ok.outbound?.[0]).toMatchObject({ toHandle: SAM, text: expect.stringContaining("payment plan") });
    const [loan] = [...s.rails.loans.values()];
    expect(loan).toMatchObject({ amountCents: 8000, monthlyCents: 2000, status: "open" });
    // The loan replaces Sam's payment request.
    const samBill = [...s.rails.bills.values()].find((b) => b.status === "cancelled");
    expect(samBill?.amountCents).toBe(8000);
    expect(ok.boardPatch?.lastUpdate).toBe("Ledger: $240 spent, $160 owed to you");
  });

  test("each PAID is one monthly payment into the Moving Fund until the loan is paid off", async () => {
    const s = setup();
    await samOwesTruck(s);
    await s.say("let Sam pay the truck at $40 a month");
    await s.say("yes");

    const p1 = await s.say("paid", { from: SAM, role: "roommate" });
    expect(reply(p1)).toContain("Sam paid $40 toward the truck; $40 left on the loan.");
    expect(p1.outbound).toMatchObject([
      { toHandle: OWNER, text: "Sam paid $40 into the Moving Fund; $40 left." },
    ]);
    expect([...s.rails.loans.values()][0]?.amountCents).toBe(4000);

    const mine = await s.say("how much do I owe", { from: SAM, role: "roommate" });
    expect(reply(mine)).toContain("$40 left on your Moving Fund loan, $40 a month.");

    const p2 = await s.say("paid", { from: SAM, role: "roommate" });
    expect(reply(p2)).toContain("Sam paid $40 for the truck and the loan is paid off.");
    expect([...s.rails.loans.values()][0]).toMatchObject({ amountCents: 0, status: "paid off" });
    expect(p2.boardPatch?.lastUpdate).toBe("Ledger: $240 spent, $80 owed to you, $80 in the Moving Fund");
  });

  test("the owner can offer a plan without naming anyone when only one person owes", async () => {
    const s = setup();
    await s.say("split the $60 gas with Sam");
    await s.say("yes");
    const r = await s.say("put it on a payment plan");
    expect(reply(r)).toContain("Sam can pay the $30 gas share at $8 a month, 4 payments.");
  });

  test("a loan needs the owner's yes; no means no loan", async () => {
    const s = setup();
    await samOwesTruck(s);
    await s.say("can I pay it back later?", { from: SAM, role: "roommate" });
    const no = await s.say("no");
    expect(reply(no)).toContain("I won't put Sam's $80 truck share on a Moving Fund loan");
    expect(s.rails.loans.size).toBe(0);
  });

  test("default plan is about four monthly payments in whole dollars", () => {
    expect(defaultMonthly(8000)).toBe(2000);
    expect(defaultMonthly(3333)).toBe(900);
    expect(defaultMonthly(300)).toBe(300);
  });
});

describe("partial payments without a loan", () => {
  test("a partial PAID lowers the open bill in Nessie", async () => {
    const s = setup();
    await samOwesTruck(s);
    const r = await s.say("paid $50", { from: SAM, role: "roommate" });
    expect(reply(r)).toContain("Sam paid $50 toward the truck; $30 left.");
    const samBill = [...s.rails.bills.values()].find((b) => b.amountCents === 3000);
    expect(samBill?.status).toBe("pending");
    const over = await s.say("paid $100", { from: SAM, role: "roommate" });
    expect(reply(over)).toContain("Sam paid $30 for the truck.");
    expect(reply(over)).toContain("only counted $30");
  });
});

describe("the live Ledger is read back from Nessie", () => {
  test("every movement is tagged with what it was", async () => {
    const s = setup();
    await samOwesTruck(s);
    await s.say("paid", { from: SAM, role: "roommate" });
    await s.say("I paid a $500 holding deposit on the sublet, due back Dec 1");
    const tags = s.rails.calls
      .filter((c) => c.op === "moveMoney" || c.op === "purchase")
      .map((c) => `${c.op}:${readTag((c.input as { description: string }).description)?.tag}`);
    expect(tags).toEqual(["purchase:expense", "moveMoney:share_paid", "moveMoney:deposit_out"]);
  });

  test("ledger answers from Nessie records, including the Moving Fund", async () => {
    const s = setup();
    await samOwesTruck(s);
    await s.say("paid", { from: SAM, role: "roommate" });
    const r = await s.say("ledger");
    expect(reply(r)).toContain("Here's your Ledger, live from Nessie.");
    expect(reply(r)).toContain("$80 in the Moving Fund, $80 owed to you.");
    expect(r.images).toHaveLength(1);
  });

  test("paying someone comes out of the Moving Fund when it covers it", async () => {
    const s = setup();
    await samOwesTruck(s);
    await s.say("paid", { from: SAM, role: "roommate" });
    await s.say("pay Priya $30 for boxes");
    const r = await s.say("yes");
    expect(reply(r)).toContain("Sent Priya $30 from the Moving Fund.");
    expect(r.boardPatch?.lastUpdate).toContain("$50 in the Moving Fund");
  });
});

describe("NessieRails loans and reads", () => {
  function recorder(responses: unknown[] = []) {
    const calls: { method: string; url: string; body: unknown }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? "GET",
        url,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const next = responses.shift() ?? { code: 201, objectCreated: { _id: `id_${calls.length}` } };
      const status =
        typeof next === "object" && next && "httpStatus" in next
          ? Number((next as { httpStatus: number }).httpStatus)
          : 200;
      return new Response(JSON.stringify(next), { status });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  test("createLoan and updateLoan use the shapes verified live", async () => {
    const { calls, fetchImpl } = recorder();
    const p = new NessieRails({ apiKey: "k", baseUrl: "https://nessie.test", fetch: fetchImpl });
    await p.createLoan({ accountId: "A", amountCents: 8000, monthlyCents: 2000, description: "IOU" });
    expect(calls[0]).toMatchObject({
      method: "POST",
      body: {
        type: "Moving Fund IOU",
        status: "open",
        credit_score: 0,
        monthly_payment: 2000,
        amount: 8000,
        description: "IOU",
      },
    });
    expect(calls[0]?.url.split("?")[0]).toBe("https://nessie.test/accounts/A/loans");
    await p.updateLoan("L", { amountCents: 4000 });
    expect(calls[1]).toMatchObject({ method: "PUT", body: { amount: 4000 } });
  });

  test("a Savings account can open on an existing customer", async () => {
    const { calls, fetchImpl } = recorder();
    const p = new NessieRails({ apiKey: "k", baseUrl: "https://nessie.test", fetch: fetchImpl });
    const r = await p.openAccount({
      firstName: "G",
      lastName: "Moving Fund",
      nickname: "Moving Fund",
      type: "Savings",
      customerId: "C1",
    });
    expect(r.customerId).toBe("C1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.split("?")[0]).toBe("https://nessie.test/customers/C1/accounts");
    expect(calls[0]?.body).toMatchObject({ type: "Savings" });
  });

  test("readAccount maps records and treats Nessie's 404 'none found' as empty", async () => {
    const { fetchImpl } = recorder([
      [{ _id: "w1", amount: 9000, status: "completed", description: "x [elves:expense:le_1]" }],
      { httpStatus: 404, message: "No deposits found" },
      [{ _id: "p1", amount: 24000, status: "completed", purchase_date: "2026-10-17", description: "Truck" }],
      [{ _id: "b1", payment_amount: 8000.0, status: "pending", nickname: "truck share" }],
      [{ _id: "l1", amount: 4000, monthly_payment: 2000, status: "open", description: "IOU" }],
    ]);
    const p = new NessieRails({ apiKey: "k", baseUrl: "https://nessie.test", fetch: fetchImpl });
    const r = await p.readAccount("A");
    expect(r.withdrawals[0]).toMatchObject({ id: "w1", amountCents: 9000 });
    expect(r.deposits).toEqual([]);
    expect(r.purchases[0]).toMatchObject({ id: "p1", amountCents: 24000, date: "2026-10-17" });
    expect(r.bills[0]).toEqual({ id: "b1", amountCents: 8000, status: "pending", nickname: "truck share" });
    expect(r.loans[0]).toMatchObject({ amountCents: 4000, monthlyCents: 2000, status: "open" });
  });
});

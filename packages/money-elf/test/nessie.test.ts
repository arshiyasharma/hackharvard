import { describe, expect, test } from "bun:test";
import { NessiePayments, PaymentsError } from "../src/payments.ts";

function recorder(responses: unknown[]) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? "GET",
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const next = responses.shift() ?? { code: 201, objectCreated: { _id: `id_${calls.length}` } };
    const status =
      typeof next === "object" && next && "status" in next
        ? Number((next as { status: number }).status)
        : 201;
    return new Response(JSON.stringify(next), { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("NessiePayments request shapes (as verified live)", () => {
  test("openAccount creates a customer, then a $0 checking account", async () => {
    const { calls, fetchImpl } = recorder([]);
    const p = new NessiePayments({ apiKey: "k3y", baseUrl: "https://nessie.test", fetch: fetchImpl });
    const r = await p.openAccount({ firstName: "Sam", lastName: "roommate", nickname: "Sam (roommate)" });
    expect(r).toEqual({ customerId: "id_1", accountId: "id_2" });
    expect(calls[0]?.url).toBe("https://nessie.test/customers?key=k3y");
    expect(calls[0]?.body).toMatchObject({ first_name: "Sam", address: { city: "Cambridge" } });
    expect(calls[1]?.url).toBe("https://nessie.test/customers/id_1/accounts?key=k3y");
    expect(calls[1]?.body).toEqual({ type: "Checking", nickname: "Sam (roommate)", rewards: 0, balance: 0 });
  });

  test("moveMoney is a withdrawal on the payer plus a deposit on the payee, in cents", async () => {
    const { calls, fetchImpl } = recorder([]);
    const p = new NessiePayments({ apiKey: "k", baseUrl: "https://nessie.test", fetch: fetchImpl });
    const r = await p.moveMoney({
      fromAccountId: "A",
      toAccountId: "B",
      amountCents: 4550,
      description: "gas",
      date: "2026-10-17",
    });
    expect(r).toEqual({ withdrawalId: "id_1", depositId: "id_2" });
    const leg = {
      medium: "balance",
      amount: 4550,
      status: "completed",
      transaction_date: "2026-10-17",
      description: "gas",
    };
    expect(calls.map((c) => [c.method, c.url.split("?")[0], c.body])).toEqual([
      ["POST", "https://nessie.test/accounts/A/withdrawals", leg],
      ["POST", "https://nessie.test/accounts/B/deposits", leg],
    ]);
  });

  test("bills carry recurring_date so Nessie can read them back", async () => {
    const { calls, fetchImpl } = recorder([]);
    const p = new NessiePayments({ apiKey: "k", baseUrl: "https://nessie.test", fetch: fetchImpl });
    await p.createBill({
      accountId: "A",
      payee: "Gavin",
      nickname: "truck share",
      amountCents: 8000,
      dueDate: "2026-10-17",
    });
    expect(calls[0]?.body).toEqual({
      status: "pending",
      payee: "Gavin",
      nickname: "truck share",
      payment_date: "2026-10-17",
      recurring_date: 17,
      payment_amount: 8000,
    });
    await p.setBillStatus("bill1", "completed");
    expect(calls[1]).toMatchObject({ method: "PUT", body: { status: "completed" } });
  });

  test("errors surface as PaymentsError and never move on silently", async () => {
    const { fetchImpl } = recorder([{ status: 400, message: "bad" }]);
    const p = new NessiePayments({ apiKey: "k", baseUrl: "https://nessie.test", fetch: fetchImpl });
    await expect(p.openAccount({ firstName: "a", lastName: "b", nickname: "c" })).rejects.toBeInstanceOf(
      PaymentsError,
    );
    await expect(
      p.moveMoney({ fromAccountId: "A", toAccountId: null, amountCents: 1.5, description: "x", date: "d" }),
    ).rejects.toThrow();
  });
});

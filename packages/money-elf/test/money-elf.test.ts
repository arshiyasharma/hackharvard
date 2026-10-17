import { describe, expect, test } from "bun:test";
import { eventTypes, OWNER, reply, setup } from "./helpers.ts";

const SAM = "+16175550101";
const PRIYA = "+16175550102";

describe("splits / Moving Fund", () => {
  test("nothing is requested until the owner says yes; then each roommate gets a request", async () => {
    const { say, store, payments } = setup();
    await say(`Sam's number is ${SAM}`);
    await say(`Priya is ${PRIYA}`);

    const r1 = await say("split the $240 truck with Sam and Priya");
    expect(reply(r1)).toContain("Truck $240 split: you $80, Sam $80, Priya $80.");
    expect(reply(r1)).toContain("Reply yes");
    expect(r1.outbound ?? []).toEqual([]);
    expect(payments.calls.filter((c) => c.op === "createBill")).toHaveLength(0);
    expect(r1.boardPatch?.status).toBe("waiting");

    const r2 = await say("yes");
    expect(r2.outbound?.map((o) => o.toHandle)).toEqual([SAM, PRIYA]);
    expect(r2.outbound?.[0]?.text).toContain("Your share of the truck is $80");
    expect(eventTypes(r2).filter((t) => t === "payment.requested")).toHaveLength(2);
    expect(payments.calls.filter((c) => c.op === "createBill")).toHaveLength(2);
    expect(await store.listPending("mv_test")).toHaveLength(0);
    expect(r2.boardPatch?.lastUpdate).toBe("Ledger: $240 spent, $160 owed to you");
  });

  test("a roommate replying PAID moves the money on the Ledger and tells the owner", async () => {
    const { say, payments } = setup();
    await say(`Sam's number is ${SAM}`);
    await say("split the $90 cleaning: me 50% Sam 50%");
    await say("yes");
    const r = await say("paid", { from: SAM, role: "roommate" });
    expect(reply(r)).toContain("Sam paid $45 for the cleaning.");
    expect(r.outbound).toEqual([{ toHandle: OWNER, text: "Sam paid $45 into the Moving Fund." }]);
    expect(r.boardPatch?.lastUpdate).toBe("Ledger: $90 spent, $45 in the Moving Fund");
    const move = payments.calls.find(
      (c) =>
        c.op === "moveMoney" &&
        String((c.input as { description: string }).description).includes("share_paid"),
    );
    expect(move?.input).toMatchObject({ amountCents: 4500 });
    expect([...payments.bills.values()][0]?.status).toBe("completed");
  });

  test("a missing number is asked for once, and the request goes out when it arrives", async () => {
    const { say } = setup();
    await say("split the $100 storage with Sam and Priya");
    const r = await say("yes");
    expect(reply(r)).toContain("What's Sam's number");
    expect(r.outbound ?? []).toEqual([]);
    const r2 = await say(`Sam is ${SAM}`);
    expect(r2.outbound).toEqual([
      { toHandle: SAM, text: expect.stringContaining("Your share of the storage is $33.33") },
    ]);
    expect(reply(r2)).toContain("I just texted Sam the request for $33.33");
  });

  test("owner can mark an off-ledger payment; recorded as money arriving from outside", async () => {
    const { say, payments } = setup();
    await say("split the $60 gas with Sam");
    await say("yes");
    const before = payments.calls.filter((c) => c.op === "moveMoney").length;
    const r = await say("Sam paid me on venmo");
    expect(reply(r)).toContain("Sam paid $30 for the gas.");
    const moves = payments.calls.filter((c) => c.op === "moveMoney");
    expect(moves.length).toBe(before + 1);
    expect(moves.at(-1)?.input).toMatchObject({ fromAccountId: null, amountCents: 3000 });
    expect(eventTypes(r)).toContain("payment.received");
  });

  test("no ends the request without sending anything", async () => {
    const { say, payments } = setup();
    await say("split the $240 truck with Sam and Priya");
    const r = await say("hold off");
    expect(reply(r)).toContain("I won't send payment requests");
    expect(eventTypes(r)).toContain("approval.cancelled");
    expect(payments.calls.filter((c) => c.op === "createBill")).toHaveLength(0);
  });
});

describe("approvals", () => {
  test("one yes covers exactly one action, the most recent", async () => {
    const { say, elf, move } = setup();
    await say("split the $240 truck with Sam");
    await say("pay Sam $40 for gas");
    const r = await say("yes");
    expect(reply(r)).toContain("Sent Sam $40.");
    expect(reply(r)).toContain("Still waiting on your OK to send payment requests for the truck");
    expect(await elf.service.store.listPending(move.id)).toHaveLength(1);
  });

  test("yes with nothing pending moves nothing", async () => {
    const { say, payments } = setup();
    const r = await say("yes");
    expect(reply(r)).toContain("nothing waiting");
    expect(payments.calls).toHaveLength(0);
  });

  test("a payments failure moves nothing and keeps the approval for a retry", async () => {
    const { say, payments, store } = setup();
    await say("pay Sam $40 for gas");
    payments.failNext = new Error("nessie down");
    const r = await say("yes");
    expect(reply(r)).toContain("nothing moved");
    expect(r.boardPatch?.status).toBe("blocked");
    expect(await store.listPending("mv_test")).toHaveLength(1);
    const r2 = await say("yes");
    expect(reply(r2)).toContain("Sent Sam $40.");
  });
});

describe("deposits", () => {
  test("logs a deposit with its due-back date and marks it returned", async () => {
    const { say } = setup();
    const r = await say("I paid a $500 holding deposit on the sublet, due back Dec 1");
    expect(reply(r)).toContain("Logged your $500 sublet deposit.");
    expect(reply(r)).toContain("2026-12-01");
    expect(eventTypes(r)).toContain("deposit.recorded");
    const l = await say("ledger?");
    expect(reply(l)).toContain("$500 in deposits out.");
    expect(l.images?.[0]?.contentType).toBe("image/png");
    const back = await say("got the sublet deposit back");
    expect(reply(back)).toContain("$500 sublet deposit is back");
    expect(eventTypes(back)).toContain("deposit.returned");
  });

  test("asks when it's due back if not given", async () => {
    const { say } = setup();
    expect(reply(await say("I put down a $150 truck deposit"))).toContain("When is it due back?");
  });
});

describe("escrow for sales", () => {
  test("buyer pays into escrow; owner confirms pickup; release needs a yes", async () => {
    const { say, elf, move, payments } = setup();
    const opened = await elf.service.openEscrow(move, {
      item: "couch",
      buyerName: "Alex",
      buyerHandle: "+16175550199",
      amountCents: 9000,
    });
    expect(eventTypes({ replies: [], events: opened.events })).toEqual(["escrow.opened"]);
    expect(opened.outbound[0]).toEqual({ toHandle: OWNER, text: expect.stringContaining("held in escrow") });

    const r1 = await say("Alex picked up the couch");
    expect(reply(r1)).toContain("$90 is in escrow");
    expect(reply(r1)).toContain("Release it to you? Reply yes.");
    const movesBefore = payments.calls.filter((c) => c.op === "moveMoney").length;

    const r2 = await say("yes");
    expect(reply(r2)).toContain("Released $90 for the couch to you.");
    expect(eventTypes(r2)).toContain("escrow.released");
    expect(payments.calls.filter((c) => c.op === "moveMoney").length).toBe(movesBefore + 1);
    expect(r2.boardPatch?.lastUpdate).toBe("Ledger: $90 from sales");
  });

  test("pickup fell through: refund the buyer after the owner's yes", async () => {
    const { say, elf, move } = setup();
    await elf.service.openEscrow(move, {
      item: "desk",
      buyerName: "Jo",
      buyerHandle: "+16175550198",
      amountCents: 6000,
    });
    await say("the desk pickup fell through");
    const r = await say("yes");
    expect(reply(r)).toContain("Refunded Jo $60.");
    expect(r.outbound).toEqual([
      { toHandle: "+16175550198", text: "Your $60 for the desk has been refunded." },
    ]);
    expect(eventTypes(r)).toContain("escrow.refunded");
  });

  test("a second yes cannot release the same escrow twice", async () => {
    const { say, elf, move } = setup();
    await elf.service.openEscrow(move, {
      item: "lamp",
      buyerName: "Kim",
      buyerHandle: null,
      amountCents: 2000,
    });
    await say("Kim picked up the lamp");
    await say("yes");
    const again = await say("yes");
    expect(reply(again)).toContain("nothing waiting");
  });
});

describe("scam check and guardrails", () => {
  test("a flagged payment is never staged for approval", async () => {
    const { say, store, payments } = setup();
    const r = await say("pay Sam $300 in gift cards");
    expect(reply(r)).toContain("That looks like a scam");
    expect(eventTypes(r)).toContain("scam.flagged");
    expect(await store.listPending("mv_test")).toHaveLength(0);
    await say("yes");
    expect(payments.calls.filter((c) => c.op === "moveMoney")).toHaveLength(0);
    const flagged = (await store.listEntries("mv_test")).filter((e) => e.flagged);
    expect(flagged).toHaveLength(1);
  });

  test("forwarded scam text gets a plain warning", async () => {
    const { say } = setup();
    const r = await say(
      "buyer says: I'll mail a cashier's check for $900, my mover will pick up, send back the difference",
    );
    expect(reply(r)).toMatch(/scam/i);
    expect(eventTypes(r).filter((t) => t === "scam.flagged").length).toBeGreaterThanOrEqual(2);
  });

  test("card numbers are refused and never echoed", async () => {
    const { say } = setup();
    const r = await say("here's my card 4111 1111 1111 1111");
    expect(reply(r)).toContain("don't text card or bank numbers");
    expect(reply(r)).not.toContain("4111");
    expect(JSON.stringify(r.events)).not.toContain("4111");
  });

  test("replies stay within 3 lines and plain text", async () => {
    const { say } = setup();
    for (const t of ["hi money elf", "split the $240 truck with Sam and Priya", "ledger", "yes"]) {
      const r = await say(t);
      for (const x of r.replies) {
        expect(x.text.split("\n").length).toBeLessThanOrEqual(3);
        expect(x.text).not.toMatch(/[*#`]/);
      }
    }
  });

  test("a buyer can't trigger owner actions", async () => {
    const { say, store } = setup();
    await say("split the $240 truck with Sam");
    const r = await say("yes", { from: "+16175550199", role: "buyer" });
    expect(reply(r)).toContain("escrow on this number");
    expect(await store.listPending("mv_test")).toHaveLength(1);
  });

  test("a seller (the owner buying something) can't trigger owner actions either", async () => {
    const { say, store } = setup();
    await say("pay Sam $40 for gas");
    const r = await say("yes", { from: "+16175550198", role: "seller" });
    expect(reply(r)).toContain("escrow on this number");
    expect(await store.listPending("mv_test")).toHaveLength(1);
  });

  test("a roommate asking sees only their own balance", async () => {
    const { say } = setup();
    await say(`Sam is ${SAM}`);
    await say("split the $240 truck with Sam and Priya");
    await say("yes");
    const r = await say("how much do I owe", { from: SAM, role: "roommate" });
    expect(reply(r)).toContain("You owe $80: truck share $80.");
    expect(reply(r)).not.toContain("Priya");
  });
});

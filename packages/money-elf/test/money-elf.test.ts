import { describe, expect, test } from "bun:test";
import { isNoShow } from "../src/service.ts";
import { eventTypes, NOW, OWNER, reply, setup } from "./helpers.ts";

const SAM = "+16175550101";
const PRIYA = "+16175550102";

describe("splits / Moving Fund", () => {
  test("nothing is requested until the owner says yes; then each roommate gets a request", async () => {
    const { say, store, rails } = setup();
    await say(`Sam's number is ${SAM}`);
    await say(`Priya is ${PRIYA}`);

    const r1 = await say("split the $240 truck with Sam and Priya");
    expect(reply(r1)).toContain("Truck $240 split: you $80, Sam $80, Priya $80.");
    expect(reply(r1)).toContain("Reply yes");
    expect(r1.outbound ?? []).toEqual([]);
    expect(rails.calls.filter((c) => c.op === "createBill")).toHaveLength(0);
    expect(r1.boardPatch?.status).toBe("waiting");

    const r2 = await say("yes");
    expect(r2.outbound?.map((o) => o.toHandle)).toEqual([SAM, PRIYA]);
    expect(r2.outbound?.[0]?.text).toContain("Your share of the truck is $80");
    expect(eventTypes(r2).filter((t) => t === "payment.requested")).toHaveLength(2);
    expect(rails.calls.filter((c) => c.op === "createBill")).toHaveLength(2);
    expect(await store.listPending("mv_test")).toHaveLength(0);
    expect(r2.boardPatch?.lastUpdate).toBe("Ledger: $240 spent, $160 owed to you");
  });

  test("a roommate replying PAID moves the money on the Ledger and tells the owner", async () => {
    const { say, rails } = setup();
    await say(`Sam's number is ${SAM}`);
    await say("split the $90 cleaning: me 50% Sam 50%");
    await say("yes");
    const r = await say("paid", { from: SAM, role: "roommate" });
    expect(reply(r)).toContain("Sam paid $45 for the cleaning.");
    expect(r.outbound).toEqual([{ toHandle: OWNER, text: "Sam paid $45 into the Moving Fund." }]);
    expect(r.boardPatch?.lastUpdate).toBe("Ledger: $90 spent, $45 in the Moving Fund");
    const move = rails.calls.find(
      (c) =>
        c.op === "moveMoney" &&
        String((c.input as { description: string }).description).includes("share_paid"),
    );
    expect(move?.input).toMatchObject({ amountCents: 4500 });
    expect([...rails.bills.values()][0]?.status).toBe("completed");
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
    const { say, rails } = setup();
    await say("split the $60 gas with Sam");
    await say("yes");
    const before = rails.calls.filter((c) => c.op === "moveMoney").length;
    const r = await say("Sam paid me on venmo");
    expect(reply(r)).toContain("Sam paid $30 for the gas.");
    const moves = rails.calls.filter((c) => c.op === "moveMoney");
    expect(moves.length).toBe(before + 1);
    expect(moves.at(-1)?.input).toMatchObject({ fromAccountId: null, amountCents: 3000 });
    expect(eventTypes(r)).toContain("payment.received");
  });

  test("no ends the request without sending anything", async () => {
    const { say, rails } = setup();
    await say("split the $240 truck with Sam and Priya");
    const r = await say("hold off");
    expect(reply(r)).toContain("I won't send payment requests");
    expect(eventTypes(r)).toContain("approval.cancelled");
    expect(rails.calls.filter((c) => c.op === "createBill")).toHaveLength(0);
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
    const { say, rails } = setup();
    const r = await say("yes");
    expect(reply(r)).toContain("nothing waiting");
    expect(rails.calls).toHaveLength(0);
  });

  test("a payments failure moves nothing and keeps the approval for a retry", async () => {
    const { say, rails, store } = setup();
    await say("pay Sam $40 for gas");
    rails.failNext = new Error("nessie down");
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

const ALEX = "+16175550199";
const HOUR = 60 * 60 * 1000;

describe("escrow for sales (SPEC §4: two signals, release into the Moving Fund)", () => {
  async function couch(s: ReturnType<typeof setup>, pickupAt: string | null = null) {
    return s.elf.service.openEscrow(s.move, {
      item: "couch",
      buyerName: "Alex",
      buyerHandle: ALEX,
      amountCents: 9000,
      pickupAt,
    });
  }

  test("escrow is a Savings account and the Moving Fund a Checking account", async () => {
    const s = setup();
    await couch(s);
    await s.elf.service.fundAccount(s.move);
    const escrow = await s.store.getEscrowAccount(s.move.id);
    const fund = await s.store.getFundAccount(s.move.id);
    expect(s.rails.accounts.get(escrow ?? "")?.type).toBe("Savings");
    expect(s.rails.accounts.get(fund ?? "")?.type).toBe("Checking");
  });

  test("owner OKs first: nothing moves until the buyer confirms, then it lands in the Moving Fund", async () => {
    const s = setup();
    const opened = await couch(s);
    expect(eventTypes({ replies: [], events: opened.events })).toEqual(["escrow.opened"]);
    expect(opened.outbound[0]).toEqual({ toHandle: OWNER, text: expect.stringContaining("held in escrow") });
    expect(opened.outbound[1]).toEqual({ toHandle: ALEX, text: expect.stringContaining('Text "got it"') });

    const r1 = await s.say("Alex picked up the couch");
    expect(reply(r1)).toContain("$90 for the couch is in escrow");
    expect(reply(r1)).toContain("OK it now? Reply yes.");
    const movesBefore = s.rails.calls.filter((c) => c.op === "moveMoney").length;

    const r2 = await s.say("yes");
    expect(reply(r2)).toContain("as soon as Alex confirms pickup");
    expect(eventTypes(r2)).not.toContain("escrow.released");
    expect(r2.outbound).toEqual([
      { toHandle: ALEX, text: expect.stringContaining("Did you pick up the couch?") },
    ]);
    expect(s.rails.calls.filter((c) => c.op === "moveMoney").length).toBe(movesBefore);

    const r3 = await s.say("got it, thanks!", { from: ALEX, role: "buyer" });
    expect(reply(r3)).toContain("pickup of the couch is confirmed");
    expect(eventTypes(r3)).toContain("escrow.released");
    expect(r3.outbound).toEqual([
      { toHandle: OWNER, text: expect.stringContaining("$90 moved from escrow into the Moving Fund") },
    ]);
    const release = s.rails.calls.filter((c) => c.op === "moveMoney").at(-1)?.input as {
      fromAccountId: string;
      toAccountId: string;
    };
    expect(release.fromAccountId).toBe((await s.store.getEscrowAccount(s.move.id)) ?? "");
    expect(release.toAccountId).toBe((await s.store.getFundAccount(s.move.id)) ?? "");
    const books = await s.elf.service.books(s.move);
    expect(books).toMatchObject({ fundCents: 9000, salesCents: 9000, escrowCents: 0 });
  });

  test("buyer confirms first: the owner gets a poll, and the yes releases", async () => {
    const s = setup();
    await couch(s);
    const r1 = await s.say("I picked it up", { from: ALEX, role: "buyer" });
    expect(reply(r1)).toContain("The seller releases the payment next.");
    expect(r1.poll).toBeUndefined();
    const [ask] = r1.outbound ?? [];
    expect(ask?.toHandle).toBe(OWNER);
    expect(ask?.text).toContain("Alex confirmed they picked up the couch");
    expect(ask?.poll?.options.map((o) => o.text)).toEqual(["Yes", "Not now"]);
    const [pending] = await s.store.listPending(s.move.id);
    expect(ask?.poll?.options[0]?.id).toBe(`money:approve:${pending?.id}`);

    const r2 = await s.say("yes");
    expect(reply(r2)).toContain("Moved $90 for the couch from escrow into the Moving Fund.");
    expect(r2.boardPatch?.lastUpdate).toBe("Ledger: $90 in the Moving Fund, $90 from sales");
  });

  test("the Deal Engine can confirm for the buyer, and Map convergence stands in for the owner's OK", async () => {
    const s = setup();
    const { entry } = await couch(s);
    const viaEngine = await s.elf.service.confirmPickup(s.move, { via: "engine", entryId: entry.id });
    expect(eventTypes({ replies: [], events: viaEngine.events })).toContain("approval.requested");
    const map = await s.elf.service.mapConverged(s.move, entry.id);
    expect(eventTypes({ replies: [], events: map.events })).toEqual([
      "escrow.map_converged",
      "escrow.released",
    ]);
    expect(map.outbound[0]?.text).toContain("checked out on the Move Map");
    // The owner's open release question is closed: the money already moved.
    expect(await s.store.listPending(s.move.id)).toHaveLength(0);
    expect(reply(await s.say("yes"))).toContain("nothing waiting");
  });

  test("Map convergence alone moves nothing without the buyer's confirmation", async () => {
    const s = setup();
    const { entry } = await couch(s);
    const map = await s.elf.service.mapConverged(s.move, entry.id);
    expect(eventTypes({ replies: [], events: map.events })).toEqual(["escrow.map_converged"]);
    expect((await s.store.getEntry(entry.id))?.escrow).toBe("held");
  });

  test("a buyer with nothing in escrow can't confirm anything", async () => {
    const s = setup();
    await couch(s);
    const r = await s.say("got it", { from: "+16175550111", role: "buyer" });
    expect(reply(r)).not.toContain("confirmed");
    expect(await s.store.listPending(s.move.id)).toHaveLength(0);
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
    const { entry } = await elf.service.openEscrow(move, {
      item: "lamp",
      buyerName: "Kim",
      buyerHandle: null,
      amountCents: 2000,
    });
    await elf.service.confirmPickup(move, { via: "engine", entryId: entry.id });
    expect(reply(await say("yes"))).toContain("Moved $20 for the lamp");
    const again = await say("yes");
    expect(reply(again)).toContain("nothing waiting");
  });
});

describe("no-show sweep (SPEC §4: 24h past pickup refunds the buyer)", () => {
  test("isNoShow is true only for a held, unconfirmed sale more than 24h past pickup", async () => {
    const s = setup();
    const late = new Date(NOW.getTime() - 25 * HOUR).toISOString();
    const { entry } = await s.elf.service.openEscrow(s.move, {
      item: "couch",
      buyerName: "Alex",
      buyerHandle: ALEX,
      amountCents: 9000,
      pickupAt: late,
    });
    expect(isNoShow(entry, NOW)).toBe(true);
    expect(isNoShow({ ...entry, pickupAt: new Date(NOW.getTime() - 23 * HOUR).toISOString() }, NOW)).toBe(
      false,
    );
    expect(isNoShow({ ...entry, pickupAt: null }, NOW)).toBe(false);
    expect(isNoShow({ ...entry, buyerConfirmedAt: NOW.toISOString() }, NOW)).toBe(false);
    expect(isNoShow({ ...entry, escrow: "refunded" }, NOW)).toBe(false);
  });

  test("the sweep asks the owner once, with a poll, and refunds on yes", async () => {
    const s = setup();
    await s.elf.service.openEscrow(s.move, {
      item: "couch",
      buyerName: "Alex",
      buyerHandle: ALEX,
      amountCents: 9000,
      pickupAt: new Date(NOW.getTime() - 25 * HOUR).toISOString(),
    });
    const moves = s.rails.calls.filter((c) => c.op === "moveMoney").length;
    const swept = await s.elf.service.sweepNoShows(s.move);
    expect(eventTypes({ replies: [], events: swept.events })).toEqual([
      "escrow.no_show",
      "approval.requested",
    ]);
    expect(swept.outbound[0]?.toHandle).toBe(OWNER);
    expect(swept.outbound[0]?.text).toContain("Alex didn't pick up the couch");
    expect(swept.outbound[0]?.poll?.options[0]?.id).toMatch(/^money:approve:/);
    expect(s.rails.calls.filter((c) => c.op === "moveMoney").length).toBe(moves);

    expect((await s.elf.service.sweepNoShows(s.move)).outbound).toHaveLength(0);

    const r = await s.say("yes");
    expect(reply(r)).toContain("Refunded Alex $90.");
    expect(r.outbound).toEqual([{ toHandle: ALEX, text: "Your $90 for the couch has been refunded." }]);
  });

  test("a reschedule clears the no-show question; a pickup before the deadline is not a no-show", async () => {
    const s = setup();
    const { entry } = await s.elf.service.openEscrow(s.move, {
      item: "couch",
      buyerName: "Alex",
      buyerHandle: ALEX,
      amountCents: 9000,
      pickupAt: new Date(NOW.getTime() - 25 * HOUR).toISOString(),
    });
    await s.elf.service.sweepNoShows(s.move);
    await s.elf.service.setPickupTime(s.move, entry.id, new Date(NOW.getTime() + 2 * HOUR).toISOString());
    expect(await s.store.listPending(s.move.id)).toHaveLength(0);
    expect((await s.elf.service.sweepNoShows(s.move)).outbound).toHaveLength(0);
  });
});

describe("scam check and guardrails", () => {
  test("a flagged payment is never staged for approval", async () => {
    const { say, store, rails } = setup();
    const r = await say("pay Sam $300 in gift cards");
    expect(reply(r)).toContain("That looks like a scam");
    expect(eventTypes(r)).toContain("scam.flagged");
    expect(await store.listPending("mv_test")).toHaveLength(0);
    await say("yes");
    expect(rails.calls.filter((c) => c.op === "moveMoney")).toHaveLength(0);
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

import { buildLedgerView } from "../src/ledger-view.ts";
import { describe, expect, test } from "bun:test";
import { eventTypes, reply, setup } from "./helpers.ts";

const SAM = "+16175550101";
const EMOJI = /\p{Extended_Pictographic}/gu;

/** The Money Elf asks for the one detail that is missing, says what it can't do, and never just goes quiet or generic. */
describe("a missing detail is asked for, with an example", () => {
  test("a split with no amount, or no people", async () => {
    const { say } = setup();
    const bare = await say("split");
    expect(reply(bare)).toContain("Happy to split that.");
    expect(reply(bare)).toContain('Example: "split the $240 truck with Sam and Priya".');
    expect(reply(bare)).toContain("How much was it, and who's in on it?");
    expect(eventTypes(bare)).toContain("money.clarify");

    const truck = await say("split the truck");
    expect(reply(truck)).toContain("Happy to split the truck.");

    // when the people are known, only the amount is missing
    const named = await say("split the cleaning with Sam and Priya");
    expect(reply(named)).toContain("I'll split it with Sam and Priya. How much was it?");
    expect(named.replies[0]?.text.endsWith("How much was it?")).toBe(true);
    expect(named.replies[0]?.text).toContain("❓ I'll split it with Sam and Priya.");
  });

  test("paying someone: the amount, or the person, whichever is missing", async () => {
    const { say } = setup();
    expect(reply(await say("pay Sam"))).toContain("How much should I pay Sam?");
    expect(reply(await say("pay $40"))).toContain("Who should I pay the $40 to?");
    expect(reply(await say("pay"))).toContain("Who should I pay, and how much?");
    expect(reply(await say("pay Sam"))).toContain("through Nessie, after your yes");
  });

  test("a deposit with no amount", async () => {
    const { say } = setup();
    const r = await say("I paid a deposit");
    expect(reply(r)).toContain("How much was it, and when is it due back?");
    expect(reply(r)).toContain('Example: "I paid a $500 sublet deposit, due back Dec 1".');
  });

  test("refund and release with nothing in escrow say so", async () => {
    const { say } = setup();
    expect(reply(await say("refund the buyer"))).toContain("Nothing is held in escrow right now.");
    expect(reply(await say("release the escrow for the couch"))).toContain(
      "Nothing is held in escrow right now.",
    );
  });

  test("'Sam paid' for someone not on the Ledger says how to add them", async () => {
    const { say } = setup();
    const r = await say("Sam paid");
    expect(reply(r)).toContain("I don't have Sam on the Ledger yet.");
    expect(reply(r)).toContain('Add their number ("Sam is 617-555-0101")');
  });
});

describe("what it can't do is said plainly, with what it can do instead", () => {
  const CASES: [string, string][] = [
    ["pay my rent", "I can't pay rent, bills or a landlord."],
    ["send money to my landlord", "I can't pay rent, bills or a landlord."],
    ["transfer money to my bank", "I can't move money to or from a bank account."],
    ["withdraw the moving fund", "I can't move money to or from a bank account."],
    ["invest the moving fund", "I can't invest money."],
    ["can you do my taxes", "I can't do taxes."],
  ];
  test.each(CASES)("%p", async (text, said) => {
    const { say } = setup();
    const r = await say(text);
    expect(reply(r)).toContain(said);
    expect(reply(r)).toContain(
      "I can split a cost, pay a roommate from the Moving Fund, log a deposit, or hold sale money in escrow",
    );
    expect(r.replies[0]?.text.startsWith("🚫 ")).toBe(true);
    expect(eventTypes(r)).toContain("money.out_of_scope");
  });

  test("'venmo Sam $40' pays through the Ledger and says it isn't Venmo", async () => {
    const { say } = setup();
    const r = await say("can you venmo Sam $40");
    expect(reply(r)).toContain("Pay Sam $40?");
    expect(reply(r)).not.toContain("$40 ?");
    expect(reply(r)).toContain("I pay through the Ledger in Nessie, not Venmo.");
    expect(reply(r)).toContain("Reply yes to send it.");
  });
});

describe("asked what it does, or what it can't place, it offers the real options", () => {
  test.each(["help", "hello", "what can you do", "what do you do?", "how does this work"])(
    "%p → the menu",
    async (text) => {
      const { say } = setup();
      const r = await say(text);
      expect(reply(r)).toContain("nothing moves without your yes");
      for (const w of [
        "Split a cost",
        "Set up a payment plan",
        "Log a deposit",
        "Pay a roommate",
        "See your money",
        "Plan the rest of the move",
        "escrow",
      ])
        expect(reply(r)).toContain(w);
      expect(r.replies[0]?.text.endsWith("What would you like to do?")).toBe(true);
      expect(eventTypes(r)).toContain("money.help");
    },
  );

  test("something it can't place gets a question with the likeliest things, not a lecture", async () => {
    const { say } = setup();
    const r = await say("asdf qwerty");
    expect(reply(r)).toContain("I'm not sure what you'd like me to do with that.");
    expect(reply(r)).toContain("Which of those did you mean?");
    expect(eventTypes(r)).toContain("money.unclear");
    expect(r.replies[0]?.text.split("\n\n")).toHaveLength(3);
  });

  test("every one of those replies has at most one emoji, at the start of a line", async () => {
    const { say } = setup();
    for (const t of [
      "help",
      "split",
      "pay Sam",
      "I paid a deposit",
      "pay my rent",
      "asdf qwerty",
      "refund",
    ]) {
      const r = await say(t);
      for (const x of r.replies) {
        expect((x.text.match(EMOJI) ?? []).length, `${t}: ${x.text}`).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("a question about the money is answered first, from the live ledger", () => {
  test("who owes me, in escrow, spent, made, balance", async () => {
    const { say, elf, move } = setup();
    await say(`Sam is ${SAM}`);
    await say("split the $240 truck with Sam and Priya");
    await say("yes");
    await elf.service.openEscrow(move, {
      item: "couch",
      buyerName: "Alex",
      buyerHandle: null,
      amountCents: 9000,
    });

    expect(reply(await say("who owes me?"))).toContain("Sam owes $80");
    expect(reply(await say("is anything in escrow?"))).toContain("In escrow: $90 for the couch (Alex).");
    expect(reply(await say("how much have I spent?"))).toContain("You've spent $240 on the move so far.");
    expect(reply(await say("how much did I make?"))).toContain("$90 still in escrow");
    expect(reply(await say("what's my balance?"))).toContain("The Moving Fund has $");
    // the answer leads, then the usual ledger lines
    const r = await say("who owes me?");
    expect(r.replies[0]?.text.startsWith("📋 Sam owes")).toBe(true);
    expect(r.images?.length ?? 0).toBeLessThanOrEqual(1);
  });
});

describe("a deposit is counted once, however it is said", () => {
  const totals = async (t: ReturnType<typeof setup>) => {
    const entries = (await t.elf.service.store.listEntries(t.move.id)).filter((e) => e.kind === "deposit");
    return { n: entries.length, cents: entries.reduce((s, e) => s + e.amountCents, 0), due: entries[0]?.dueBackAt };
  };

  test("with or without the dollar sign", async () => {
    for (const text of ["i paid 400 for a sublet deposit", "I paid $400 for a sublet deposit", "i put down 400 deposit for the sublet"]) {
      const t = setup();
      await t.say(text);
      expect((await totals(t)).cents, text).toBe(40000);
    }
  });

  test("answering 'when is it due back?' with a date sets the date and adds nothing", async () => {
    const t = setup();
    await t.say("I paid $400 for a sublet deposit");
    const r = await t.say("Dec 1");
    expect(reply(r)).toContain("Got it: your $400 sublet deposit is due back 2026-12-01.");
    expect(await totals(t)).toEqual({ n: 1, cents: 40000, due: "2026-12-01" });
  });

  test("saying the whole thing again with a date updates the first one instead of adding a second", async () => {
    const t = setup();
    await t.say("I paid $400 for a sublet deposit");
    const r = await t.say("I paid $400 for a sublet deposit, due back Dec 1");
    expect(reply(r)).toContain("is already on the Ledger, so I didn't add it again.");
    expect(await totals(t)).toEqual({ n: 1, cents: 40000, due: "2026-12-01" });
    const dup = await t.say("I paid $400 for a sublet deposit");
    expect(reply(dup)).toContain('say "another $400 sublet deposit"');
    expect((await totals(t)).n).toBe(1);
  });

  test("a second, different deposit, or one said to be another, is counted", async () => {
    const t = setup();
    await t.say("I paid $400 for a sublet deposit");
    await t.say("I paid a $150 storage deposit");
    await t.say("I paid another $400 sublet deposit");
    expect((await totals(t)).cents).toBe(95000);
  });

  test("the dashboard and the card say the same number the Ledger holds", async () => {
    const t = setup();
    await t.say("I paid $400 for a sublet deposit, due back Dec 1");
    const v = await buildLedgerView(t.elf.service, t.move);
    expect(v.depositsOutCents).toBe(40000);
    expect(v.projection.outCents).toBe(40000);
    expect(v.projection.projectedNetCents).toBe(0);
  });

  test("a date alone with no deposit waiting is not a deposit", async () => {
    const t = setup();
    expect(reply(await t.say("Dec 1"))).toContain("not sure");
  });
});

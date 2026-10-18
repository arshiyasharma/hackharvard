import { describe, expect, test } from "bun:test";
import { formatLines, formatOutbound, toneOf } from "../src/format.ts";
import { createMoneyElf } from "../src/money-elf.ts";
import { FakeRails } from "../src/rails.ts";
import { ledgerToken } from "../src/ledger-http.ts";
import type { MoneyContext, Role } from "../src/types.ts";
import { fakeLLM, NOW, OWNER, testStore } from "./helpers.ts";

const SAM = "+16175550101";
const PRIYA = "+16175550102";
const ALEX = "+16175550103";
const LINKS = { publicUrl: "https://elves.test", secret: "s3cret" };
const LINK = `https://elves.test/ledger/mv_test?t=${ledgerToken("s3cret", "mv_test")}`;
const EMOJI = /\p{Extended_Pictographic}/gu;

describe("how a Money Elf text is laid out", () => {
  test("blocks with a blank line between, one emoji, the question alone, the link last", () => {
    expect(
      formatLines(["Truck $240 split: you $80, Sam $80, Priya $80.", "Send each person their share? Reply yes."], {
        events: [{ type: "ledger.entry_added" }],
        link: LINK,
      }),
    ).toBe(
      `Truck $240 split: you $80, Sam $80, Priya $80.\n\n❓ Send each person their share? Reply yes.\n\nDashboard: ${LINK}`,
    );
    expect(formatLines(["Done: $60 for the chair is held in escrow."], { events: [{ type: "approval.granted" }] })).toBe(
      "✅ Done: $60 for the chair is held in escrow.",
    );
    expect(
      formatLines(["Moved $90 for the couch from escrow into the Moving Fund.", "Anything else is on the Ledger.", "Say ledger to see it."], {
        events: [{ type: "escrow.released" }],
      }),
    ).toBe(
      "✅ Moved $90 for the couch from escrow into the Moving Fund.\n\nAnything else is on the Ledger.\nSay ledger to see it.",
    );
    expect(formatLines(["Please don't text card or bank numbers here; I never need them.", "Payments run through the Ledger."], { events: [{ type: "money.sensitive_blocked" }] })).toBe(
      "🚫 Please don't text card or bank numbers here; I never need them.\n\nPayments run through the Ledger.",
    );
    expect(formatLines(["Your money, live from Nessie: $40 in the Moving Fund."], { events: [{ type: "ledger.shown" }], link: LINK })).toBe(
      `📋 Your money, live from Nessie: $40 in the Moving Fund.\n\nDashboard: ${LINK}`,
    );
    expect(formatLines([])).toBe("");
    expect(toneOf(["Hello."], [])).toBe("plain");
  });

  test("outgoing texts: the news first, the question alone, one emoji, nothing twice", () => {
    expect(formatOutbound("Your share of the truck is $80. Reply PAID when you've sent it.")).toBe(
      "Your share of the truck is $80.\n\n❓ Reply PAID when you've sent it.",
    );
    expect(formatOutbound("Sam paid $45 into the Moving Fund.", { link: LINK })).toBe(
      `✅ Sam paid $45 into the Moving Fund.\n\nDashboard: ${LINK}`,
    );
    const once = formatOutbound("Your $60 for the desk has been refunded.");
    expect(once).toBe("✅ Your $60 for the desk has been refunded.");
    expect(formatOutbound(once)).toBe(once);
    const lines = formatLines(["Truck split.", "OK? Reply yes."]);
    expect(formatLines([lines])).toBe(lines);
  });
});

/** Every text of a long, realistic run: the owner, a roommate, a buyer, a scammer, card numbers, the dashboard. */
describe("every Money Elf text follows the layout", () => {
  test("a full run through splits, loans, deposits, escrow, refusals and the dashboard", async () => {
    const store = testStore();
    const elf = createMoneyElf({ store, rails: new FakeRails(), now: () => NOW, links: LINKS });
    const move = { id: "mv_test", ownerHandle: OWNER, name: "Gavin" };
    const texts: string[] = [];
    let n = 0;
    const say = async (text: string, opts: { from?: string; role?: Role } = {}) => {
      const ctx: MoneyContext = {
        llm: fakeLLM,
        move,
        participant: { handle: opts.from ?? OWNER, role: opts.role ?? "owner" },
        batch: { spaceId: "sp", traceId: `t${++n}`, messages: [{ id: `m${n}`, text }] },
        traceId: `t${n}`,
        log: { debug() {}, info() {}, warn() {}, error() {} },
        now: () => NOW,
      };
      const r = await elf.handle(ctx);
      texts.push(...r.replies.map((x) => x.text), ...(r.outbound ?? []).map((o) => o.text));
      return r;
    };

    await say(`Sam is ${SAM}`);
    await say(`Priya is ${PRIYA}`);
    await say("split the $240 truck with Sam and Priya");
    await say("yes");
    await say("paid", { from: SAM, role: "roommate" });
    await say("can I do a payment plan, $40 a month?", { from: PRIYA, role: "roommate" });
    await say("yes");
    await say("paid", { from: PRIYA, role: "roommate" });
    await say("how much do I owe", { from: PRIYA, role: "roommate" });
    await say("I paid a $500 sublet deposit, due back Dec 1");
    await say("the sublet deposit came back");
    await say("Sam paid me $20 on venmo");
    await elf.service.openEscrow(move, { item: "couch", buyerName: "Alex", buyerHandle: ALEX, amountCents: 9000 });
    await say("got it, thanks", { from: ALEX, role: "buyer" });
    await say("yes");
    await elf.service.openEscrow(move, { item: "desk", buyerName: "Jo", buyerHandle: null, amountCents: 6000 });
    await say("the desk pickup fell through");
    await say("yes");
    await say("my card is 4242 4242 4242 4242");
    await say("send me a cashier's check and I'll mail the rest");
    await say("Venmo me the deposit before you see the place, I'm abroad");
    await say("show me the ledger");
    await say("dashboard");
    await say("hello there");
    await say("how's my money", { from: SAM, role: "roommate" });
    await say("what did I do wrong", { from: ALEX, role: "buyer" });
    await say("fix the truck entry");
    await say("yes");
    await say("no");

    expect(texts.length).toBeGreaterThan(25);
    for (const t of texts) {
      // one emoji at most, and only at the start of a line
      const marks = t.match(EMOJI) ?? [];
      expect(marks.length, t).toBeLessThanOrEqual(1);
      if (marks.length) expect(t.split("\n").some((l) => /^\p{Extended_Pictographic}/u.test(l)), t).toBe(true);
      // the service adds the Elf's header, so the body never names itself, and never calls the rails anything but Nessie
      expect(t, t).not.toMatch(/Money Elf here|simulat/i);
      // no long wall of text: more than two sentences means blank-line separated blocks
      const sentences = t.split(/(?<=[.!?])\s+/).length;
      if (sentences > 2 || t.split("\n").length > 2) expect(t.includes("\n\n"), t).toBe(true);
      // never trailing whitespace or three blank lines in a row
      expect(t, t).not.toMatch(/\n{3,}|[ \t]+\n|\s$/);
    }
  });

  test("the dashboard link closes every reply that changed the Ledger, and only those", async () => {
    const store = testStore();
    const elf = createMoneyElf({ store, rails: new FakeRails(), now: () => NOW, links: LINKS });
    const move = { id: "mv_test", ownerHandle: OWNER, name: "Gavin" };
    let n = 0;
    const say = (text: string, opts: { from?: string; role?: Role } = {}) =>
      elf.handle({
        llm: fakeLLM,
        move,
        participant: { handle: opts.from ?? OWNER, role: opts.role ?? "owner" },
        batch: { spaceId: "sp", traceId: `t${++n}`, messages: [{ id: `m${n}`, text }] },
        traceId: `t${n}`,
        log: { debug() {}, info() {}, warn() {}, error() {} },
        now: () => NOW,
      });
    const body = (r: Awaited<ReturnType<typeof say>>) => r.replies.map((x) => x.text).join("\n\n");

    // adding a contact doesn't touch the Ledger: no link
    expect(body(await say(`Sam is ${SAM}`))).not.toContain("Dashboard:");
    // a split does (it goes on the Ledger as it asks for the yes)
    const split = await say("split the $90 cleaning: me 50% Sam 50%");
    expect(body(split).endsWith(`\n\nDashboard: ${LINK}`)).toBe(true);
    expect(split.miniApp).toBeUndefined();
    const yes = await say("yes");
    expect(body(yes)).toContain(`Dashboard: ${LINK}`);
    // asking for the dashboard returns the photo and the link, and no Spectrum card
    const asked = await say("show me my dashboard");
    expect(body(asked)).toContain(`Dashboard: ${LINK}`);
    expect(asked.images?.length).toBe(1);
    expect(asked.miniApp).toBeUndefined();
    // a roommate's payment tells the owner, with the link on that note
    const paid = await say("paid", { from: SAM, role: "roommate" });
    const toOwner = (paid.outbound ?? []).find((o) => o.toHandle === OWNER);
    expect(toOwner?.text).toBe(`✅ Sam paid $45 into the Moving Fund.\n\nDashboard: ${LINK}`);
    // the roommate's own reply has no link (it is the owner's dashboard)
    expect(body(paid)).not.toContain("Dashboard:");
  });
});

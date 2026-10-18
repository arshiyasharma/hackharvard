import { describe, expect, test } from "bun:test";
import { MemoryMoneyStore } from "../src/ledger.ts";
import { ledgerCardSvg, renderLedgerPng } from "../src/ledger-card.ts";
import { createLedgerHandler, ledgerToken, ledgerUrl } from "../src/ledger-http.ts";
import { ledgerPageHtml } from "../src/ledger-page.ts";
import { buildLedgerView, type LedgerView } from "../src/ledger-view.ts";
import { createMoneyElf } from "../src/money-elf.ts";
import { FakeRails } from "../src/rails.ts";
import type { MoneyContext, Role } from "../src/types.ts";
import { testStore, eventTypes, fakeLLM, NOW, OWNER, reply, setup } from "./helpers.ts";

const SAM = "+16175550101";
const LINKS = { publicUrl: "https://elves.test", secret: "s3cret" };

/** `cards: true` is the shelved Spectrum mini app path (ELVES_MINIAPP=1); the default is the web link only. */
function linkedSetup(opts: { cards?: boolean } = { cards: true }) {
  const store = testStore();
  const rails = new FakeRails();
  const elf = createMoneyElf({ store, rails, now: () => NOW, links: LINKS, cards: opts.cards === true });
  const move = { id: "mv_test", ownerHandle: OWNER, name: "Gavin" };
  let n = 0;
  const say = (
    text: string | null,
    opts: { from?: string; role?: Role; vote?: { id: string; text: string } } = {},
  ) =>
    elf.handle({
      llm: fakeLLM,
      move,
      participant: { handle: opts.from ?? OWNER, role: opts.role ?? "owner" },
      batch: {
        spaceId: "s",
        traceId: `t${++n}`,
        messages: [{ id: `m${n}`, text, pollVote: opts.vote ? { selectedOptions: [opts.vote] } : null }],
      },
      traceId: `t${n}`,
      log: { debug() {}, info() {}, warn() {}, error() {} },
      now: () => NOW,
    } as MoneyContext);
  return { store, rails, elf, move, say };
}

async function demo(s: ReturnType<typeof linkedSetup>) {
  await s.say(`Sam is ${SAM}`);
  await s.say("split the $240 truck with Sam and Priya");
  await s.say("yes");
  await s.say("can I do a payment plan, $40 a month?", { from: SAM, role: "roommate" });
  await s.say("yes");
  await s.say("paid", { from: SAM, role: "roommate" });
  await s.elf.service.openEscrow(s.move, {
    item: "couch",
    buyerName: "Alex",
    buyerHandle: null,
    amountCents: 9000,
  });
}

describe("show me the ledger", () => {
  test("the owner gets the card image, a one-line summary and a signed live link", async () => {
    const s = linkedSetup();
    await demo(s);
    const r = await s.say("show me the ledger");
    const png = r.images?.[0];
    expect(png?.contentType).toBe("image/png");
    expect([...(png?.bytes.slice(0, 4) ?? [])]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(reply(r)).toContain("Your money, live from Nessie: $40 in the Moving Fund");
    // The link and the card both open the Moving Ledger dashboard (the read-only page, decision #60).
    const dashboard = `https://elves.test/ledger/mv_test?t=${ledgerToken("s3cret", "mv_test")}`;
    expect(reply(r)).toContain("Tap the Elves Ledger card to open your dashboard");
    expect(reply(r)).toContain(dashboard);
    expect(r.miniApp?.url).toBe(dashboard);
    expect(r.replies[0]?.text.split("\n").length).toBeLessThanOrEqual(3);
    expect(eventTypes(r)).toContain("ledger.shown");
  });

  test("without links configured the card still goes, with no URL", async () => {
    const { say } = setup();
    const r = await say("show me the books");
    expect(r.images).toHaveLength(1);
    expect(reply(r)).not.toContain("http");
  });

  test("a roommate asking gets only their own balance in text, never the card", async () => {
    const s = linkedSetup();
    await demo(s);
    const r = await s.say("show me the ledger", { from: SAM, role: "roommate" });
    expect(r.images).toBeUndefined();
    expect(reply(r)).not.toContain("http");
  });
});

describe("corrections by text", () => {
  test("a correction says it can't edit past entries and links the dashboard, with no card", async () => {
    const s = linkedSetup();
    await demo(s);
    const r = await s.say("the truck was actually $260");
    expect(reply(r)).toContain("I can't change a past Ledger entry by text yet.");
    expect(reply(r)).toContain(`https://elves.test/ledger/mv_test?t=${ledgerToken("s3cret", "mv_test")}`);
    expect(r.miniApp).toBeUndefined();
    expect(eventTypes(r)).toContain("ledger.fix_declined");
  });
});

describe("the Ledger view, card and page", () => {
  test("the view is built from Nessie and shows loan progress", async () => {
    const s = linkedSetup();
    await demo(s);
    const v = await buildLedgerView(s.elf.service, s.move);
    expect(v).toMatchObject({ fundCents: 4000, owedCents: 12000, escrowCents: 9000, ownerName: "Gavin's" });
    expect(v.owes.find((o) => o.name === "Sam")?.loan).toEqual({
      totalCents: 8000,
      monthlyCents: 4000,
      paidCents: 4000,
    });
    expect(v.recent[0]?.label).toBe("Escrow: couch");
  });

  const hostile: LedgerView = {
    moveId: "mv_x",
    ownerName: "<b>Eve</b>'s",
    asOf: "2026-10-17T00:00:00Z",
    fundCents: 0,
    owedCents: 100,
    escrowCents: 0,
    spentCents: 0,
    salesCents: 0,
    depositsOutCents: 0,
    owes: [{ name: '<script>alert("x")</script>', owedCents: 100, loan: null, bills: [] }],
    escrow: [],
    deposits: [],
    recent: [],
    pending: ["pay </script><script>alert(1)</script> $1"],
    pendingActions: [
      { id: "pa_1", kind: "pay_person", summary: "pay </script><script>alert(1)</script> $1" },
    ],
    records: 1,
    projection: {
      outCents: 0,
      backCents: 0,
      netNowCents: 0,
      expected: [],
      expectedCents: 0,
      projectedNetCents: 0,
      settledBy: null,
      hasEstimates: false,
      points: [{ date: "2026-10-17", netCents: 0 }],
    },
    plans: null,
  };

  test("names are escaped in the SVG card and the HTML page", () => {
    expect(ledgerCardSvg(hostile)).not.toContain("<script>");
    const html = ledgerPageHtml(hostile, { imageUrl: "https://x/i.png", pageUrl: "https://x/p" });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<b>Eve</b>");
    // Names also travel in the page's JSON data block; none may close the script tag early.
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html.match(/<\/script>/g)?.length).toBe(2);
  });

  test("the page carries Open Graph tags so iMessage previews it with the card", () => {
    const html = ledgerPageHtml(hostile, { imageUrl: "https://x/i.png", pageUrl: "https://x/p" });
    expect(html).toContain('<meta property="og:image" content="https://x/i.png">');
    expect(html).toContain('property="og:title"');
    expect(html).toContain("prefers-color-scheme:dark");
  });

  test("an empty Ledger still renders", async () => {
    const png = await renderLedgerPng({ ...hostile, owes: [], owedCents: 0 });
    expect(png.length).toBeGreaterThan(1000);
  });
});

describe("live Ledger routes", () => {
  async function routes() {
    const s = linkedSetup();
    await demo(s);
    return { ...s, handle: createLedgerHandler({ service: s.elf.service, links: LINKS }) };
  }

  test("signed links serve the page, both PNGs and the JSON", async () => {
    const { handle } = await routes();
    const page = await handle(new Request(ledgerUrl(LINKS, "mv_test")));
    expect(page?.status).toBe(200);
    expect(page?.headers.get("content-type")).toContain("text/html");
    const html = (await page?.text()) ?? "";
    expect(html).toContain("Move Money");
    // The bubble shows the 3:2 preview, not the tall thread image.
    expect(html).toContain(`content="${ledgerUrl(LINKS, "mv_test", ".preview.png")}"`);
    const png = await handle(new Request(ledgerUrl(LINKS, "mv_test", ".png")));
    expect(png?.headers.get("content-type")).toBe("image/png");
    const preview = await handle(new Request(ledgerUrl(LINKS, "mv_test", ".preview.png")));
    expect(preview?.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array((await preview?.arrayBuffer()) ?? new ArrayBuffer(0));
    const dims = new DataView(bytes.buffer, 16, 8);
    expect([dims.getUint32(0), dims.getUint32(4)]).toEqual([1200, 800]);
    expect((await handle(new Request("https://elves.test/ledger/mv_test.preview.png")))?.status).toBe(404);
    const json = await handle(new Request(ledgerUrl(LINKS, "mv_test", ".json")));
    if (!json) throw new Error("no response");
    expect(((await json.json()) as { fundCents: number }).fundCents).toBe(4000);
  });

  test("a missing or wrong token, or an unknown move, is a 404", async () => {
    const { handle } = await routes();
    expect((await handle(new Request("https://elves.test/ledger/mv_test")))?.status).toBe(404);
    expect((await handle(new Request("https://elves.test/ledger/mv_test?t=nope")))?.status).toBe(404);
    const other = `https://elves.test/ledger/mv_other?t=${ledgerToken("s3cret", "mv_other")}`;
    expect((await handle(new Request(other)))?.status).toBe(404);
  });

  test("the old editor routes are gone", async () => {
    const { handle } = await routes();
    const t = ledgerToken("s3cret", "mv_test");
    expect(await handle(new Request(`https://elves.test/ledger/mv_test/app?t=${t}`))).toBeNull();
    expect(
      await handle(
        new Request(`https://elves.test/ledger/mv_test/edit?t=${t}`, { method: "POST", body: "{}" }),
      ),
    ).toBeNull();
    const post = await handle(new Request(ledgerUrl(LINKS, "mv_test"), { method: "POST", body: "{}" }));
    expect(post?.status).toBe(405);
  });

  test("other paths fall through to the caller's routes", async () => {
    const { handle } = await routes();
    expect(await handle(new Request("https://elves.test/health"))).toBeNull();
  });
});

describe("approval polls", () => {
  test("anything that needs the owner's yes also sends a poll naming that action", async () => {
    const s = linkedSetup();
    await s.say(`Sam is ${SAM}`);
    const r = await s.say("split the $240 truck with Sam");
    const [pending] = await s.store.listPending("mv_test");
    expect(r.poll).toEqual({
      question: "Send payment requests for the truck: Sam $120?",
      options: [
        { id: `money:approve:${pending?.id}`, text: "Yes" },
        { id: `money:decline:${pending?.id}`, text: "Not now" },
      ],
      selectionMode: "single",
    });
    expect(reply(r)).toContain("Reply yes");
  });

  test("a vote approves the exact action it names, not just the latest", async () => {
    const s = linkedSetup();
    await s.say(`Sam is ${SAM}`);
    const first = await s.say("split the $240 truck with Sam");
    await s.say("pay Sam $40 for gas");
    const yesTruck = first.poll?.options[0];
    const r = await s.say(null, { vote: yesTruck ?? { id: "", text: "" } });
    expect(eventTypes(r)).toContain("payment.requested");
    expect(eventTypes(r)).toContain("poll.voted");
    expect(reply(r)).toContain("Still waiting on your OK to pay Sam $40 for gas");
  });

  test("Not now declines that action; a second tap is harmless", async () => {
    const s = linkedSetup();
    const r = await s.say("pay Sam $40 for gas");
    const no = r.poll?.options[1] ?? { id: "", text: "" };
    expect(reply(await s.say(null, { vote: no }))).toContain("I won't pay Sam $40");
    expect(reply(await s.say(null, { vote: no }))).toContain("already been handled");
    expect(s.rails.calls.filter((c) => c.op === "moveMoney")).toHaveLength(0);
  });

  test("only the owner's taps count", async () => {
    const s = linkedSetup();
    const r = await s.say("pay Sam $40 for gas");
    const yes = r.poll?.options[0] ?? { id: "", text: "" };
    const tap = await s.say(null, { vote: yes, from: SAM, role: "roommate" });
    expect(reply(tap)).toContain("Only the move's owner");
    expect(await s.store.listPending("mv_test")).toHaveLength(1);
  });

  test("if the platform drops our option ids, Yes falls back to the latest action", async () => {
    const s = linkedSetup();
    await s.say("pay Sam $40 for gas");
    const r = await s.say(null, { vote: { id: "opt_1", text: "Yes" } });
    expect(reply(r)).toContain("Sent Sam $40.");
  });

  test("a roommate's plan request reaches the owner with a poll", async () => {
    const s = linkedSetup();
    await s.say(`Sam is ${SAM}`);
    await s.say("split the $240 truck with Sam");
    await s.say("yes");
    const ask = await s.say("can I pay it back later?", { from: SAM, role: "roommate" });
    expect(ask.poll).toBeUndefined();
    const toOwner = ask.outbound?.find((o) => o.toHandle === OWNER);
    expect(toOwner?.poll?.options[0]?.id).toMatch(/^money:approve:pa_/);
    const r = await s.say(null, { vote: toOwner?.poll?.options[0] ?? { id: "", text: "" } });
    expect(eventTypes(r)).toContain("loan.created");
  });
});

describe("dashboard phrases", () => {
  for (const phrase of ["show me my dashboard", "dashboard", "how's my money", "where do I stand"]) {
    test(`"${phrase}" opens the dashboard`, async () => {
      const s = linkedSetup();
      await demo(s);
      const r = await s.say(phrase);
      expect(r.miniApp?.url).toBe(`https://elves.test/ledger/mv_test?t=${ledgerToken("s3cret", "mv_test")}`);
      expect(reply(r)).toContain("Tap the Elves Ledger card to open your dashboard");
    });
  }
});

describe("the dashboard card comes unasked", () => {
  test("an owner turn that changes the Ledger brings the card, without asking for it", async () => {
    const s = linkedSetup();
    const dashboard = `https://elves.test/ledger/mv_test?t=${ledgerToken("s3cret", "mv_test")}`;
    // Adding a contact doesn't touch the Ledger.
    expect((await s.say(`Sam is ${SAM}`)).miniApp).toBeUndefined();
    // The split goes on the Ledger as it asks for an OK (the dashboard shows Approve / Not now for it).
    expect((await s.say("split the $240 truck with Sam and Priya")).miniApp?.url).toBe(dashboard);
    expect((await s.say("yes")).miniApp?.url).toBe(dashboard);
  });

  test("a roommate's payment doesn't send the roommate the owner's dashboard", async () => {
    const s = linkedSetup();
    await demo(s);
    const r = await s.say("paid", { from: SAM, role: "roommate" });
    expect(r.miniApp).toBeUndefined();
  });
});

describe("approving from the dashboard", () => {
  async function withPending() {
    const s = linkedSetup();
    await s.say(`Sam is ${SAM}`);
    await s.say("split the $240 truck with Sam");
    await s.say("pay Sam $40 for gas");
    const pending = await s.store.listPending("mv_test");
    const split = pending.find((p) => p.kind === "send_split_requests");
    const pay = pending.find((p) => p.kind === "pay_person");
    const decided: { moveId: string; lines: string[]; outbound: number }[] = [];
    const handle = createLedgerHandler({
      service: s.elf.service,
      links: LINKS,
      onDecided: async (moveId, result) => {
        decided.push({ moveId, lines: result.lines, outbound: result.outbound.length });
      },
    });
    const post = (body: unknown, url = ledgerUrl(LINKS, "mv_test", "/decide")) =>
      handle(new Request(url, { method: "POST", body: JSON.stringify(body) }));
    return { s, split, pay, decided, post };
  }

  test("Approve runs exactly the action it names and hands its texts to the crew service", async () => {
    const { s, split, decided, post } = await withPending();
    const res = await post({ pendingId: split?.id, choice: "approve" });
    const body = (await res?.json()) as { ok: boolean; message: string; view: { pendingActions: unknown[] } };
    expect(res?.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.message).toContain("Sent the request");
    // The newer pay_person action is still waiting: the tap named the split, not "the latest".
    expect(body.view.pendingActions).toHaveLength(1);
    expect(decided).toEqual([{ moveId: "mv_test", lines: expect.any(Array), outbound: 1 }]);
    expect((await s.store.listPending("mv_test")).map((p) => p.kind)).toEqual(["pay_person"]);
  });

  test("Not now declines it; a second tap is harmless", async () => {
    const { s, pay, post, decided } = await withPending();
    const first = (await (await post({ pendingId: pay?.id, choice: "decline" }))?.json()) as {
      ok: boolean;
      message: string;
    };
    expect(first.ok).toBe(true);
    expect(first.message).toContain("I won't pay Sam $40");
    const again = (await (await post({ pendingId: pay?.id, choice: "approve" }))?.json()) as {
      ok: boolean;
      message: string;
    };
    expect(again.ok).toBe(false);
    expect(again.message).toContain("already been handled");
    expect(decided).toHaveLength(1);
    expect(s.rails.calls.filter((c) => c.op === "moveMoney")).toHaveLength(0);
  });

  test("bad bodies, wrong methods and wrong tokens are refused", async () => {
    const { post } = await withPending();
    expect((await post({ pendingId: "x y", choice: "approve" }))?.status).toBe(400);
    expect((await post({ pendingId: "pa_1", choice: "maybe" }))?.status).toBe(400);
    expect((await post("{not json"))?.status).toBe(400);
    expect(
      (
        await post(
          { pendingId: "pa_1", choice: "approve" },
          "https://elves.test/ledger/mv_test/decide?t=nope",
        )
      )?.status,
    ).toBe(404);
    const { s } = await withPending();
    const handle = createLedgerHandler({ service: s.elf.service, links: LINKS });
    expect((await handle(new Request(ledgerUrl(LINKS, "mv_test", "/decide"))))?.status).toBe(405);
  });

  test("the dashboard shows Approve / Not now for each pending action, wired to /decide", async () => {
    const { s } = await withPending();
    const handle = createLedgerHandler({ service: s.elf.service, links: LINKS });
    const html = (await (await handle(new Request(ledgerUrl(LINKS, "mv_test"))))?.text()) ?? "";
    expect(html).toContain("Needs your OK");
    expect(html.match(/data-decide="approve"/g)?.length).toBe(2);
    expect(html.match(/data-decide="decline"/g)?.length).toBe(2);
    expect(html).toContain(ledgerUrl(LINKS, "mv_test", "/decide"));
    expect(html).toContain('id="tab-back"');
    expect(html).toContain("2 waiting");
    // Once the requests go out, Sam's share is coming back, so the what-if appears.
    const [split] = (await s.store.listPending("mv_test")).filter((p) => p.kind === "send_split_requests");
    await s.elf.service.approve(s.move, split?.id);
    const after = (await (await handle(new Request(ledgerUrl(LINKS, "mv_test"))))?.text()) ?? "";
    expect(after).toContain('id="wi-late"');
    expect(after).toContain('data-count="0"');
  });
});

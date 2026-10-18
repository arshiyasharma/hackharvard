import { describe, expect, test } from "bun:test";
import { allElves, type Elf } from "@elves/elves";
import { FakeListings } from "@elves/listings";
import { FakeLLM } from "@elves/llm";
import {
  createMoneyElf,
  FakeRails,
  LEDGER_CHANGING_EVENTS,
  ledgerToken,
  MemoryMoneyStore,
} from "@elves/money-elf";
import { ScriptTransport } from "@elves/photon";
import { createLogger, MemoryStore } from "@elves/shared";
import { createService } from "../src/service.ts";

function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error("expected a value");
  return v;
}

const quiet = createLogger("test", "error");
const OWNER = "+14155550100";

/** Records mini app cards the service would send through Spectrum. */
class FakeMiniApps {
  sent: { handle: string; url: string }[] = [];
  refreshed: string[] = [];
  async send(handle: string, url: string) {
    this.sent.push({ handle, url });
  }
  async refresh(handle: string) {
    this.refreshed.push(handle);
  }
}

/** The real service, with the Money Elf in place of the stub (as apps/elves/src/index.ts wires it). */
function boot(opts: { miniApps?: FakeMiniApps } = {}) {
  const transport = new ScriptTransport();
  const store = new MemoryStore();
  const money = createMoneyElf({
    store: new MemoryMoneyStore(),
    rails: new FakeRails(),
    links: opts.miniApps ? { publicUrl: "https://elves.test", secret: "s3cret" } : undefined,
  });
  const moneyElf: Elf = { ...money, handle: (ctx) => money.handle(ctx) };
  const service = createService({
    store,
    transport,
    llm: new FakeLLM(),
    memory: null,
    listings: new FakeListings(),
    debounceMs: 30,
    publicUrl: null,
    logger: quiet,
    elves: allElves.map((e) => (e.name === "money" ? moneyElf : e)),
    miniApps: opts.miniApps ?? null,
    refreshCardOn: LEDGER_CHANGING_EVENTS,
  });
  const ctrl = new AbortController();
  void service.run(ctrl.signal);
  return { transport, store, stop: () => ctrl.abort() };
}

async function say(
  t: ScriptTransport,
  text: string | null,
  extra: Parameters<ScriptTransport["push"]>[2] = {},
) {
  const before = t.sent.length + t.polls.length + t.images.length;
  t.push(OWNER, text, extra);
  const t0 = Date.now();
  while (t.sent.length + t.polls.length + t.images.length === before && Date.now() - t0 < 3000)
    await new Promise((r) => setTimeout(r, 20));
  await t.settled();
  await new Promise((r) => setTimeout(r, 60));
}

describe("Money Elf through the crew service", () => {
  test("the mini app card opens the dashboard, and comes back whenever the owner changes the Ledger", async () => {
    const miniApps = new FakeMiniApps();
    const { transport, stop } = boot({ miniApps });
    try {
      await say(transport, "hi im moving nov 1");
      await say(transport, "show me the ledger");
      expect(miniApps.sent).toHaveLength(1);
      const url = miniApps.sent[0]?.url ?? "";
      expect(url).toMatch(/^https:\/\/elves\.test\/ledger\/[A-Za-z0-9_-]+\?t=/);
      expect(url).not.toContain("/app");
      const moveId = url.split("/ledger/")[1]?.split("?")[0] ?? "";
      expect(url).toBe(`https://elves.test/ledger/${moveId}?t=${ledgerToken("s3cret", moveId)}`);
      expect(transport.sent.at(-1)?.text ?? "").toContain("Tap the Elves Ledger card to open your dashboard");

      // A deposit changes the Ledger: the dashboard card comes with the reply, unasked (the real sender
      // updates the card the owner already has in place rather than stacking a second one).
      await say(transport, "I paid a $500 holding deposit on the sublet, due back Dec 1");
      expect(miniApps.sent).toHaveLength(2);
      expect(miniApps.sent[1]).toEqual({ handle: OWNER, url });
      expect(miniApps.refreshed).toEqual([]);

      // Small talk doesn't touch the Ledger, so no card.
      await say(transport, "thanks!");
      expect(miniApps.sent).toHaveLength(2);
      expect(miniApps.refreshed).toEqual([]);
    } finally {
      stop();
    }
  });

  test("a split asks in text and with a poll; tapping Yes approves exactly that action", async () => {
    const { transport, store, stop } = boot();
    try {
      await say(transport, "hi im moving nov 1");
      await say(transport, "split the $240 truck with Sam");
      const ask = transport.sent.at(-1)?.text ?? "";
      expect(ask).toContain("Truck $240 split: you $120, Sam $120.");
      expect(ask).toContain("Reply yes");
      expect(transport.polls).toHaveLength(1);
      const poll = must(transport.polls[0]);
      expect(poll.poll.options.map((o) => o.text)).toEqual(["Yes", "Not now"]);
      expect(poll.spaceId).toBe(transport.sent.at(-1)?.spaceId ?? "");

      // The tap has no text; the router sends it back to the Money Elf by its option id.
      const yes = must(poll.poll.options[0]);
      await say(transport, null, { pollVote: { selectedOptions: [yes] } });
      const after = transport.sent.at(-1)?.text ?? "";
      expect(after).toContain("What's Sam's number");
      const move = must((await store.listMoves())[0]);
      const types = (await store.listEvents(move.id)).map((e) => e.type);
      expect(types).toContain("poll.sent");
      expect(types).toContain("approval.granted");
      expect(types).toContain("poll.voted");
    } finally {
      stop();
    }
  });

  test("show me the ledger sends the Ledger card as an image after the text", async () => {
    const { transport, store, stop } = boot();
    try {
      await say(transport, "hi im moving nov 1");
      await say(transport, "I paid a $500 holding deposit on the sublet, due back Dec 1");
      await say(transport, "show me the ledger");
      expect(transport.sent.at(-1)?.text).toContain("Here's your money, live from Nessie.");
      expect(transport.images).toHaveLength(1);
      const img = must(transport.images[0]).image;
      expect(img.contentType).toBe("image/png");
      expect([...img.bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
      const move = must((await store.listMoves())[0]);
      expect((await store.listEvents(move.id)).map((e) => e.type)).toContain("image.sent");
    } finally {
      stop();
    }
  });
});

describe("delivering texts from outside a batch", () => {
  test("deliverOutbound sends each note to its space once per key", async () => {
    const transport = new ScriptTransport();
    const store = new MemoryStore();
    const service = createService({
      store,
      transport,
      llm: new FakeLLM(),
      memory: null,
      listings: new FakeListings(),
      debounceMs: 30,
      publicUrl: null,
      logger: quiet,
      elves: allElves,
    });
    const ctrl = new AbortController();
    void service.run(ctrl.signal);
    try {
      await say(transport, "hi im moving nov 1");
      const move = (await store.listMoves())[0];
      if (!move) throw new Error("no move");
      const before = transport.sent.length;
      const notes = [{ spaceId: move.ownerSpaceId, text: "From your dashboard: Sent the request." }];
      expect(await service.deliverOutbound(move.id, "money", notes, "dashboard:pa_1")).toBe(1);
      expect(await service.deliverOutbound(move.id, "money", notes, "dashboard:pa_1")).toBe(0);
      expect(transport.sent.length).toBe(before + 1);
      // Every crew text opens with its Elf's name.
      expect(transport.sent.at(-1)?.text).toEndWith("From your dashboard: Sent the request.");
    } finally {
      ctrl.abort();
    }
  });
});

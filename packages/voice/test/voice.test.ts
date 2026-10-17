import { describe, expect, test } from "bun:test";
import { FakeLLM } from "@elves/llm";
import { InMemoryBackend, MoveMemory } from "@elves/memory";
import { createLogger, MemoryStore } from "@elves/shared";
import {
  handleRetellWebhook,
  ingestCall,
  RetellEvent,
  signRetell,
  verifyRetellSignature,
} from "../src/index.ts";

const quiet = createLogger("test", "error");
const KEY = "key_test";
const NOW = new Date("2026-10-17T15:00:00Z");

async function setup() {
  const store = new MemoryStore();
  const llm = new FakeLLM();
  const memory = new MoveMemory({ backend: new InMemoryBackend(), store, llm, logger: quiet });
  const move = await store.createMove({
    ownerHandle: "+14255269066",
    ownerSpaceId: "sp-owner",
    platform: "imessage",
  });
  return { store, llm, memory, move, deps: { store, llm, memory, logger: quiet, now: () => NOW } };
}

function evt(over: Record<string, unknown> = {}, event = "call_ended") {
  return RetellEvent.parse({
    event,
    call: {
      call_id: "call_1",
      from_number: "+14255269066",
      to_number: "+17402558982",
      direction: "inbound",
      transcript: "Agent: Hi!\nUser: I'm moving out August 29 and I want to sell my couch and my desk.",
      transcript_object: [
        { role: "agent", content: "Hi!" },
        { role: "user", content: "I'm moving out August 29 and I want to sell my couch and my desk." },
      ],
      start_timestamp: 1_000_000,
      end_timestamp: 1_000_000 + 4 * 60_000,
      ...over,
    },
  });
}

describe("signature", () => {
  const body = '{"event":"call_ended"}';
  test("accepts a fresh signature, rejects tampering, replay and a wrong key", () => {
    const sig = signRetell(body, KEY, NOW.getTime());
    expect(verifyRetellSignature(body, sig, KEY, NOW.getTime())).toBe(true);
    expect(verifyRetellSignature(body + " ", sig, KEY, NOW.getTime())).toBe(false);
    expect(verifyRetellSignature(body, sig, "other", NOW.getTime())).toBe(false);
    expect(verifyRetellSignature(body, sig, KEY, NOW.getTime() + 6 * 60_000)).toBe(false);
    expect(verifyRetellSignature(body, null, KEY, NOW.getTime())).toBe(false);
    expect(verifyRetellSignature(body, "garbage", KEY, NOW.getTime())).toBe(false);
  });
});

describe("ingestCall", () => {
  test("stores dates, items, facts, a transcript and a brief for every Elf, and asks one thing", async () => {
    const { deps, store, memory, move } = await setup();
    const r = await ingestCall(deps, evt());
    expect(r.status).toBe("ingested");
    expect(r.recap).toContain("Thanks for the call");
    expect(r.recap!.split("\n")).toHaveLength(2);

    const m = await store.getMove(move.id);
    expect(m?.moveOutAt).toBe("2027-08-29");
    const items = await store.listItems(move.id);
    expect(items.map((i) => i.name).sort()).toEqual(["couch", "desk"]);

    const facts = (await memory.listFacts(move.id)).map((f) => f.text);
    expect(facts.some((t) => t.includes("couch"))).toBe(true);
    for (const elf of ["crew_lead", "stuff", "home", "moveday", "money"] as const)
      expect(await memory.note(move.id, elf, "call_brief")).toBeTruthy();
    const stuff = (await memory.note(move.id, "stuff", "call_brief")) as { toSell: string[] };
    expect(stuff.toSell.sort()).toEqual(["couch", "desk"]);

    const ctx = await memory.context({ threadId: "sp-owner", moveId: move.id, elf: "stuff", role: "owner" });
    expect(ctx.transcript).toContain("[Phone call, 4 min]");
    expect(ctx.notes?.call_brief).toBeTruthy();
    expect((await store.listEvents(move.id)).some((e) => e.type === "call.completed")).toBe(true);
  });

  test("is idempotent on the call id, across both Retell events", async () => {
    const { deps, store, move } = await setup();
    expect((await ingestCall(deps, evt())).status).toBe("ingested");
    expect((await ingestCall(deps, evt())).status).toBe("duplicate");
    expect((await ingestCall(deps, evt({}, "call_analyzed"))).status).toBe("duplicate");
    expect((await store.listItems(move.id)).length).toBe(2);
  });

  test("a different date on the call never overwrites the move; it becomes a question", async () => {
    const { deps, store, move, memory } = await setup();
    await store.updateMove(move.id, { moveOutAt: "2026-08-31" });
    const r = await ingestCall(deps, evt());
    expect((await store.getMove(move.id))?.moveOutAt).toBe("2026-08-31");
    expect(r.recap).toContain("One thing to confirm");
    expect(
      (await memory.listFacts(move.id)).some((f) => f.kind === "open_loop" && f.text.includes("unclear")),
    ).toBe(true);
  });

  test("an unknown caller, a short call and other event types change nothing", async () => {
    const { deps, store, move } = await setup();
    expect((await ingestCall(deps, evt({ from_number: "+19999999999" }))).status).toBe("unknown_caller");
    expect((await ingestCall(deps, evt({ transcript: "hi", transcript_object: null }))).status).toBe(
      "ignored",
    );
    expect((await ingestCall(deps, evt({}, "call_started"))).status).toBe("ignored");
    expect(await store.listItems(move.id)).toHaveLength(0);
  });

  test("works with memory off", async () => {
    const { deps, store, move } = await setup();
    const r = await ingestCall({ ...deps, memory: null }, evt());
    expect(r.status).toBe("ingested");
    expect((await store.getMove(move.id))?.moveOutAt).toBe("2027-08-29");
  });
});

describe("handleRetellWebhook", () => {
  const payload = (c = "call_9") =>
    JSON.stringify({ event: "call_ended", call: { ...evt().call, call_id: c } });

  test("401 on a bad signature, 503 without a key, 400 on junk, 200 and one recap on a good call", async () => {
    const { deps } = await setup();
    const sent: string[] = [];
    const d = { ...deps, apiKey: KEY, sendRecap: async (_m: string, t: string) => void sent.push(t) };
    const body = payload();
    expect((await handleRetellWebhook({ ...d, apiKey: null }, body, "x")).status).toBe(503);
    expect((await handleRetellWebhook(d, body, "v=1,d=ab")).status).toBe(401);
    const junk = "not json";
    expect((await handleRetellWebhook(d, junk, signRetell(junk, KEY))).status).toBe(400);
    const ok = await handleRetellWebhook(d, body, signRetell(body, KEY));
    expect(ok).toEqual({ status: 200, body: { ok: true, status: "ingested" } });
    expect(sent).toHaveLength(1);
    const again = await handleRetellWebhook(d, body, signRetell(body, KEY));
    expect(again.body.status).toBe("duplicate");
    expect(sent).toHaveLength(1);
  });
});

describe("inbound-call webhook (the phone number's setting, not the agent's)", () => {
  test("answers 200 with string variables for a known caller, nothing for strangers or unsigned requests", async () => {
    const { deps, store, move } = await setup();
    await store.updateMove(move.id, { moveOutAt: "2027-08-29" });
    const d = { ...deps, apiKey: KEY };
    const body = JSON.stringify({
      event: "call_inbound",
      call_inbound: { from_number: "+14255269066", to_number: "+1740" },
    });
    const ok = await handleRetellWebhook(d, body, signRetell(body, KEY));
    expect(ok.status).toBe(200);
    const vars = (ok.body.call_inbound as { dynamic_variables: Record<string, string> }).dynamic_variables;
    expect(vars.known_caller).toBe("yes");
    expect(vars.known_move_out).toContain("29");
    expect(Object.values(vars).every((v) => typeof v === "string")).toBe(true);

    const stranger = JSON.stringify({ event: "call_inbound", call_inbound: { from_number: "+19999999999" } });
    const s = await handleRetellWebhook(d, stranger, signRetell(stranger, KEY));
    expect((s.body.call_inbound as { dynamic_variables: Record<string, string> }).dynamic_variables).toEqual({
      known_caller: "no",
    });

    const unsigned = await handleRetellWebhook(d, body, null);
    expect(unsigned.status).toBe(200);
    expect(unsigned.body).toEqual({ call_inbound: { dynamic_variables: {} } });
  });
});

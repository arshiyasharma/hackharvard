import { describe, expect, test } from "bun:test";
import { FakeLLM } from "@elves/llm";
import { ScriptTransport } from "@elves/photon";
import { createLogger, MemoryStore } from "@elves/shared";
import { createService } from "../src/service.ts";

const quiet = createLogger("test", "error");
const owner = "+14255269066";

function boot(publicUrl: string | null = "https://elves.example") {
  const transport = new ScriptTransport();
  const store = new MemoryStore();
  const service = createService({
    store,
    transport,
    llm: new FakeLLM(),
    debounceMs: 40,
    publicUrl,
    logger: quiet,
  });
  const ctrl = new AbortController();
  void service.run(ctrl.signal);
  return { transport, store, service, stop: () => ctrl.abort() };
}

describe("service end to end (script transport)", () => {
  test("first text creates a move and gets a reaction, typing and a threaded Crew Lead reply", async () => {
    const { transport, store, service, stop } = boot();
    const m = transport.push(owner, "Im moving out november 1 and i have a couch and a lamp to sell");
    await transport.waitForSends(1);
    await transport.settled();
    await service.pipeline.idle();
    expect(transport.reactions).toEqual([{ messageId: m.id, emoji: "👍" }]);
    expect(transport.typingEvents.map((t) => t.on)).toEqual([true, false]);
    expect(transport.reads).toEqual([m.id]);
    expect(transport.sent.length).toBe(1); // no link in a first message
    expect(transport.sent[0]!.parentMessageId).toBe(m.id);
    expect(transport.sent[0]!.senderId).toBe(m.agentId);
    expect(transport.sent[0]!.text).toContain("Nov 1");
    expect(transport.sent[0]!.text).toContain("couch");
    const move = (await store.listMoves())[0]!;
    expect(move.ownerHandle).toBe(owner);
    expect(move.moveOutAt).toBe("2026-11-01");
    expect((await store.listItems(move.id)).map((i) => i.name)).toEqual(["couch", "lamp"]);
    const board = await store.getBoard(move.id);
    expect(board.find((b) => b.elf === "sell")?.status).toBe("working");
    const types = (await store.listEvents(move.id)).map((e) => e.type);
    expect(types).toContain("move.created");
    expect(types).toContain("reply.sent");
    stop();
  });

  test("three rapid texts produce one reply, routed by content; the board link follows once", async () => {
    const { transport, store, service, stop } = boot();
    transport.push(owner, "hi");
    await transport.waitForSends(1);
    await transport.settled();
    await service.pipeline.idle();
    transport.push(owner, "also");
    transport.push(owner, "can you book storage");
    transport.push(owner, "for june to august");
    await transport.settled();
    await service.pipeline.idle();
    // second batch: one Haul reply (stub Elves don't send the board link)
    const haul = transport.sent.filter((s) => s.text.startsWith("Haul Elf"));
    expect(haul.length).toBe(1);
    expect(transport.sent.length).toBe(2);
    const move = (await store.listMoves())[0]!;
    expect((await store.getBoard(move.id)).find((b) => b.elf === "haul")?.status).toBe("working");
    // a reply inside the Haul thread stays with Haul
    transport.push(owner, "june 2 to aug 30", { parentMessageId: haul[0]!.id });
    await transport.settled();
    await service.pipeline.idle();
    expect(transport.sent[2]!.text.startsWith("Haul Elf")).toBe(true);
    stop();
  });

  test("the Crew Lead sends the board link once, on a later turn, when a public URL exists", async () => {
    const { transport, service, stop } = boot("https://elves.example");
    transport.push(owner, "hi");
    await transport.settled();
    await service.pipeline.idle();
    transport.push(owner, "what's the plan");
    await transport.settled();
    await service.pipeline.idle();
    const links = transport.sent.filter((s) => s.text.includes("https://elves.example/b/"));
    expect(links.length).toBe(1);
    transport.push(owner, "status?");
    await transport.settled();
    await service.pipeline.idle();
    expect(transport.sent.filter((s) => s.text.includes("/b/")).length).toBe(1);
    stop();
  });

  test("sends are idempotent per batch", async () => {
    const { transport, store, service, stop } = boot(null);
    const m = transport.push(owner, "hello");
    await transport.settled();
    await service.pipeline.idle();
    expect(transport.sent.length).toBe(1);
    // replaying the same batch does not double-post
    await service.handleBatch(
      { spaceId: m.spaceId, messages: [m], traceId: "replay", carried: 0 },
      { signal: new AbortController().signal },
    );
    expect(transport.sent.length).toBe(1);
    expect(await store.getSend(`reply:${m.id}:0`)).toBeDefined();
    stop();
  });
});

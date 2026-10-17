import { describe, expect, test } from "bun:test";
import type { InboundMessage } from "@elves/photon";
import { type Batch, Pipeline, sendKey } from "@elves/pipeline";
import { createLogger } from "@elves/shared";

let seq = 0;
const msg = (spaceId: string, text: string): InboundMessage => ({
  id: `m${++seq}`,
  spaceId,
  spaceKind: "direct",
  platform: "script",
  senderId: "u1",
  senderHandle: "+15550001111",
  agentId: "a1",
  agentHandle: "+16280000000",
  text,
  attachments: [],
  reaction: null,
  parentMessageId: null,
  receivedAt: new Date(Date.now() + seq).toISOString(),
});
const quiet = createLogger("test", "error");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Pipeline", () => {
  test("three rapid messages become one batch", async () => {
    const batches: Batch[] = [];
    const p = new Pipeline({ debounceMs: 60, handle: async (b) => void batches.push(b), logger: quiet });
    p.enqueue(msg("s1", "a"));
    await sleep(20);
    p.enqueue(msg("s1", "b"));
    await sleep(20);
    p.enqueue(msg("s1", "c"));
    await p.idle();
    expect(batches.length).toBe(1);
    expect(batches[0]!.messages.map((m) => m.text)).toEqual(["a", "b", "c"]);
    expect(p.stats.batches).toBe(1);
  });

  test("spaces are independent", async () => {
    const batches: Batch[] = [];
    const p = new Pipeline({ debounceMs: 30, handle: async (b) => void batches.push(b), logger: quiet });
    p.enqueue(msg("s1", "a"));
    p.enqueue(msg("s2", "b"));
    await p.idle();
    expect(batches.map((b) => b.spaceId).sort()).toEqual(["s1", "s2"]);
  });

  test("a message mid-flight cancels the job and carries its messages forward", async () => {
    const handled: { texts: string[]; aborted: boolean }[] = [];
    const p = new Pipeline({
      debounceMs: 20,
      handle: async (b, { signal }) => {
        await sleep(80); // slow "LLM"
        handled.push({ texts: b.messages.map((m) => m.text!), aborted: signal.aborted });
      },
      logger: quiet,
    });
    p.enqueue(msg("s1", "first"));
    await sleep(50); // first batch is now in flight
    p.enqueue(msg("s1", "second"));
    await p.idle();
    expect(p.stats.cancelled).toBe(1);
    const final = handled.find((h) => !h.aborted);
    expect(final?.texts).toEqual(["first", "second"]);
  });

  test("handler errors are counted and do not stop later batches", async () => {
    let calls = 0;
    const p = new Pipeline({
      debounceMs: 10,
      handle: async () => {
        calls++;
        if (calls === 1) throw new Error("boom");
      },
      logger: quiet,
    });
    p.enqueue(msg("s1", "a"));
    await p.idle();
    p.enqueue(msg("s1", "b"));
    await p.idle();
    expect(calls).toBe(2);
    expect(p.stats.errors).toBe(1);
  });

  test("send keys are deterministic", () => {
    expect(sendKey("reply", "m1", 0)).toBe("reply:m1:0");
    expect(sendKey("reply", "m1", 0)).toBe(sendKey("reply", "m1"));
  });
});

import type { AttachmentFile, InboundMessage, OutboundReply, Transport } from "./transport.ts";

export interface ScriptSend extends OutboundReply {
  id: string;
  key: string;
  at: number;
}

/**
 * In-memory transport for tests and the demo: push human messages in, read agent replies out.
 * Space ids are derived from the sender handle so a phone always lands in the same DM.
 */
export class ScriptTransport implements Transport {
  readonly name = "script";
  readonly sent: ScriptSend[] = [];
  readonly reactions: { messageId: string; emoji: string }[] = [];
  readonly typingEvents: { spaceId: string; on: boolean }[] = [];
  readonly reads: string[] = [];
  readonly attachments = new Map<string, AttachmentFile>();
  private queue: InboundMessage[] = [];
  private waiters: ((m: InboundMessage | null) => void)[] = [];
  private sendWaiters: { n: number; resolve: () => void }[] = [];
  private seq = 0;
  private closed = false;

  constructor(
    readonly agentId = "usr_agent",
    readonly agentHandle = "+16280000000",
  ) {}

  spaceFor(handle: string) {
    return `spc_${handle.replace(/[^0-9a-z]/gi, "")}`;
  }

  /** Simulate a human text. Returns the inbound message so tests can thread replies. */
  push(
    handle: string,
    text: string | null,
    extra: Partial<Pick<InboundMessage, "attachments" | "reaction" | "parentMessageId" | "spaceKind">> = {},
  ): InboundMessage {
    const msg: InboundMessage = {
      id: `msg_${++this.seq}`,
      spaceId: this.spaceFor(handle),
      spaceKind: extra.spaceKind ?? "direct",
      platform: "script",
      senderId: `usr_${handle.replace(/[^0-9a-z]/gi, "")}`,
      senderHandle: handle,
      agentId: this.agentId,
      agentHandle: this.agentHandle,
      text,
      attachments: extra.attachments ?? [],
      reaction: extra.reaction ?? null,
      parentMessageId: extra.parentMessageId ?? null,
      receivedAt: new Date().toISOString(),
    };
    const w = this.waiters.shift();
    if (w) w(msg);
    else this.queue.push(msg);
    return msg;
  }

  close() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w(null);
  }

  async *inbound(signal: AbortSignal): AsyncIterable<InboundMessage> {
    signal.addEventListener("abort", () => this.close());
    while (!signal.aborted && !this.closed) {
      const next =
        this.queue.shift() ?? (await new Promise<InboundMessage | null>((r) => this.waiters.push(r)));
      if (!next) return;
      yield next;
    }
  }

  async send(reply: OutboundReply, key: string) {
    const id = `out_${++this.seq}`;
    this.sent.push({ ...reply, id, key, at: Date.now() });
    this.sendWaiters = this.sendWaiters.filter((w) => {
      if (this.sent.length >= w.n) {
        w.resolve();
        return false;
      }
      return true;
    });
    return { id };
  }
  async react(target: { messageId: string }, emoji: string) {
    this.reactions.push({ messageId: target.messageId, emoji });
  }
  async typing(spaceId: string, _senderId: string, on: boolean) {
    this.typingEvents.push({ spaceId, on });
  }
  async read(messageId: string) {
    this.reads.push(messageId);
  }
  /** Register bytes for an attachment id so `push(handle, null, { attachments: [{ id }] })` can be fetched. */
  addAttachment(id: string, bytes: Uint8Array, contentType: string, filename?: string) {
    this.attachments.set(id, { id, bytes, contentType, filename });
  }
  async fetchAttachment(id: string) {
    return this.attachments.get(id) ?? null;
  }

  /** Resolve once the inbound loop has consumed every pushed message and is waiting for more. */
  async settled(timeoutMs = 2000) {
    const t0 = Date.now();
    while (this.queue.length > 0 || this.waiters.length === 0) {
      if (Date.now() - t0 > timeoutMs) throw new Error("inbound loop did not drain the script queue");
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  /** Resolve once at least n replies have been sent (or reject after timeoutMs). */
  waitForSends(n: number, timeoutMs = 5000) {
    if (this.sent.length >= n) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error(`timed out waiting for ${n} sends (have ${this.sent.length})`)),
        timeoutMs,
      );
      this.sendWaiters.push({
        n,
        resolve: () => {
          clearTimeout(t);
          resolve();
        },
      });
    });
  }
}

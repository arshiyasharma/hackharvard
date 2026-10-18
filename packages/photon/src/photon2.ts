import { createLogger, type Logger } from "@elves/shared";
import { PhotonApiError, type PhotonClient } from "./client.ts";
import {
  type AttachmentFile,
  type InboundMessage,
  normalizePhotonMessage,
  type OpenedSpace,
  type OutboundReply,
  type Transport,
} from "./transport.ts";
import type { MessageEventData, PhotonEvent, PhotonMessage, PhotonUserSnapshot } from "./types.ts";

export interface Photon2TransportOptions {
  client: PhotonClient;
  /** poll = GET /messages on an interval (works anywhere); socket = Socket.IO event stream plus a slow poll as a safety net. */
  inbound?: "poll" | "socket";
  pollMs?: number;
  /** Only handle messages created at/after this time (ISO). Defaults to boot time minus 5 s. */
  since?: string;
  /** Persisted cursors so restarts don't lose or repeat work. */
  cursor?: {
    get(name: string): Promise<string | undefined>;
    set(name: string, value: string): Promise<void>;
  };
  platform?: string;
  /**
   * The agent user id of the project's dedicated line (PHOTON_DEDICATED_AGENT_ID), which `openSpace` sends as.
   * Unset: discovered once from the project's agent users (`details.type === "dedicated"`) and its resources.
   */
  dedicatedAgentId?: string;
  logger?: Logger;
}

/** An async queue that an iterator drains; push from any callback. */
class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: ((v: IteratorResult<T>) => void)[] = [];
  private closed = false;
  push(item: T) {
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }
  close() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }
  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.items.length) {
        yield this.items.shift() as T;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      if (next.done) return;
      yield next.value;
    }
  }
}

/** Transport over the Photon 2.0 API. */
export class Photon2Transport implements Transport {
  readonly name = "photon2";
  private readonly client: PhotonClient;
  private readonly mode: "poll" | "socket";
  private readonly pollMs: number;
  private readonly since: string;
  private readonly cursor: Photon2TransportOptions["cursor"];
  private readonly platform?: string;
  private readonly dedicatedAgentId?: string;
  private dedicated?: Promise<{ id: string; handle: string | null }>;
  private readonly log: Logger;
  /** Spaces where Photon refused a threaded reply (409 SPACE_NOT_SENDABLE); later sends go flat. */
  readonly noThreads = new Set<string>();
  /** Spaces where Photon refused a reaction (the shared pool does); they are not asked again. */
  readonly noReactions = new Set<string>();
  /** Bounded set of handled message ids so overlapping polls or replays are idempotent. */
  private seen = new Set<string>();
  private seenOrder: string[] = [];

  constructor(opts: Photon2TransportOptions) {
    this.client = opts.client;
    this.mode = opts.inbound ?? "poll";
    this.pollMs = opts.pollMs ?? 1500;
    this.since = opts.since ?? new Date(Date.now() - 5_000).toISOString();
    this.cursor = opts.cursor;
    this.platform = opts.platform;
    this.dedicatedAgentId = opts.dedicatedAgentId;
    this.log = opts.logger ?? createLogger("photon2");
  }

  private remember(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > 5000) {
      const drop = this.seenOrder.splice(0, 1000);
      for (const d of drop) this.seen.delete(d);
    }
    return true;
  }

  inbound(signal: AbortSignal): AsyncIterable<InboundMessage> {
    if (this.mode !== "socket") return this.inboundPoll(signal, this.pollMs);
    // Socket for latency, a slow poll so nothing is lost if the stream hiccups; the seen-set dedups.
    const queue = new AsyncQueue<InboundMessage>();
    const pump = async (src: AsyncIterable<InboundMessage>, name: string) => {
      try {
        for await (const m of src) queue.push(m);
      } catch (err) {
        this.log.error(`${name} inbound stopped`, { error: String(err) });
      }
    };
    void Promise.all([
      pump(this.inboundSocket(signal), "socket"),
      pump(this.inboundPoll(signal, Math.max(this.pollMs * 5, 10_000)), "poll"),
    ]).finally(() => queue.close());
    return queue;
  }

  async fetchAttachment(id: string): Promise<AttachmentFile | null> {
    try {
      const { bytes, contentType, filename } = await this.client.downloadAttachment(id);
      return { id, bytes, contentType, filename };
    } catch (err) {
      this.log.warn("attachment download failed", { id, error: String(err) });
      return null;
    }
  }

  private async *inboundPoll(signal: AbortSignal, pollMs: number): AsyncIterable<InboundMessage> {
    let createdSince = (await this.cursor?.get("photon2:poll:createdSince")) ?? this.since;
    if (createdSince < this.since) createdSince = this.since;
    this.log.info("polling for inbound messages", { createdSince, pollMs });
    let failures = 0;
    while (!signal.aborted) {
      try {
        let pageToken: string | undefined;
        let newest = createdSince;
        do {
          const page = await this.client.listMessages({
            createdSince,
            direction: "received",
            order: "asc",
            pageSize: 100,
            platform: this.platform,
            pageToken,
          });
          for (const m of page.items) {
            if (m.createdAt > newest) newest = m.createdAt;
            if (!this.remember(m.id)) continue;
            const n = normalizePhotonMessage(m);
            if (n) yield n;
          }
          pageToken = page.nextPageToken;
        } while (pageToken && !signal.aborted);
        if (newest !== createdSince) {
          createdSince = newest; // inclusive bound; the seen-set drops the repeat
          await this.cursor?.set("photon2:poll:createdSince", createdSince);
        }
        failures = 0;
      } catch (err) {
        failures++;
        this.log.warn("poll failed", { attempt: failures, error: String(err) });
      }
      const wait = Math.min(pollMs * 2 ** Math.min(failures, 5), 30_000);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, failures ? wait : pollMs);
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  private async *inboundSocket(signal: AbortSignal): AsyncIterable<InboundMessage> {
    const { io } = await import("socket.io-client");
    const queue = new AsyncQueue<InboundMessage>();
    let cursor = Number((await this.cursor?.get("photon2:socket:seq")) ?? 0) || 0;
    const base = this.client.projectPath.replace(/\/v1\/projects\/.*$/, "");
    const socket = io(base, {
      path: `/v1/projects/${this.client.projectId}/events/ws`,
      addTrailingSlash: false,
      transports: ["websocket"],
      extraHeaders: { Authorization: `Bearer ${(this.client as unknown as { apiKey: string }).apiKey}` },
      autoConnect: false,
    });
    socket.on("connect", () => {
      socket
        .timeout(10_000)
        .emit(
          "subscribe",
          { startSeq: cursor, apiVersion: "2026-07-01" },
          (err: unknown, result: { ok: boolean; error?: { code: string }; connectionId?: string }) => {
            if (err) {
              this.log.warn("subscribe timed out; reconnecting");
              socket.io.engine.close();
              return;
            }
            if (!result?.ok) this.log.error("subscribe rejected", { code: result?.error?.code });
            else this.log.info("subscribed to event stream", { connectionId: result.connectionId, cursor });
          },
        );
    });
    socket.on("delivery", (event: PhotonEvent<MessageEventData>, meta: { seq: number }) => {
      void (async () => {
        try {
          if (meta.seq > cursor) {
            if (event.type === "message.received" && event.data?.object) {
              const m = event.data.object as PhotonMessage;
              if (m.createdAt >= this.since && this.remember(m.id)) {
                const n = normalizePhotonMessage(m);
                if (n) queue.push(n);
              }
            }
            cursor = meta.seq;
            await this.cursor?.set("photon2:socket:seq", String(cursor));
          }
        } catch (err) {
          this.log.error("event handling failed", { error: String(err) });
        }
      })();
    });
    socket.on("delivery_error", (e: { code: string }) => this.log.warn("delivery_error", { code: e.code }));
    socket.on("connect_error", (e: Error) => this.log.warn("connect_error", { message: e.message }));
    socket.on("disconnect", (reason: string) => this.log.info("socket disconnected", { reason }));
    signal.addEventListener("abort", () => {
      socket.close();
      queue.close();
    });
    socket.connect();
    yield* queue;
  }

  async send(reply: OutboundReply, idempotencyKey: string) {
    const threaded = !!reply.parentMessageId && !this.noThreads.has(reply.spaceId);
    const attempt = (parentMessageId: string | undefined, key: string) =>
      this.client.sendText(
        {
          spaceId: reply.spaceId,
          senderId: reply.senderId,
          text: reply.text,
          parentMessageId,
          format: reply.format ?? "plain",
        },
        key,
      );
    try {
      const res = await attempt(threaded ? (reply.parentMessageId as string) : undefined, idempotencyKey);
      return { id: res.id };
    } catch (err) {
      // Shared iMessage lines (and some spaces) refuse threaded replies: fall back to a flat send once.
      if (
        threaded &&
        err instanceof PhotonApiError &&
        err.status === 409 &&
        err.code === "SPACE_NOT_SENDABLE"
      ) {
        this.noThreads.add(reply.spaceId);
        this.log.warn("threaded reply refused; resending flat", {
          spaceId: reply.spaceId,
          detail: err.message,
        });
        const res = await attempt(undefined, `${idempotencyKey}:flat`);
        return { id: res.id };
      }
      throw err;
    }
  }
  /** The dedicated line's agent user, resolved once; a failed lookup is retried on the next call. */
  private dedicatedLine(): Promise<{ id: string; handle: string | null }> {
    if (!this.dedicated) {
      this.dedicated = this.resolveDedicatedLine().catch((err) => {
        this.dedicated = undefined;
        throw err;
      });
    }
    return this.dedicated;
  }

  private async resolveDedicatedLine(): Promise<{ id: string; handle: string | null }> {
    const agents = await this.client.listUsers({ kind: "agent", pageSize: 100 });
    const byId = (id: string) => agents.items.find((u) => u.id === id);
    if (this.dedicatedAgentId) {
      return { id: this.dedicatedAgentId, handle: byId(this.dedicatedAgentId)?.handle ?? null };
    }
    const dedicated = agents.items.filter((u) => u.details?.type === "dedicated");
    let pick: PhotonUserSnapshot | undefined = dedicated.length === 1 ? dedicated[0] : undefined;
    if (!pick && dedicated.length > 1) {
      // Several dedicated agents: the one whose line resource is active.
      const { resources } = await this.client.listResources();
      const active = new Set(
        resources
          .filter(
            (r) =>
              /dedicated/i.test(`${r.type} ${JSON.stringify(r.detail)}`) && /active|ready/i.test(r.state),
          )
          .map((r) => r.resourceId),
      );
      pick = dedicated.find((u) => u.details?.resourceId && active.has(u.details.resourceId)) ?? dedicated[0];
    }
    if (!pick) {
      throw new Error(
        "no dedicated Photon line: set PHOTON_DEDICATED_AGENT_ID or provision one (bun run photon provision-dedicated); the shared pool cannot text first",
      );
    }
    this.log.info("dedicated line resolved", { agentId: pick.id, handle: pick.handle });
    return { id: pick.id, handle: pick.handle ?? null };
  }

  async openSpace(handle: string, platform: string): Promise<OpenedSpace> {
    const line = await this.dedicatedLine();
    const user = await this.client.createOrGetUser(handle, platform);
    const space = await this.client.createOrGetSpace(
      [line.id, user.id],
      platform,
      `space:${line.id}:${user.id}`,
    );
    return { spaceId: space.id, senderId: line.id, senderHandle: line.handle };
  }

  async react(target: { spaceId: string; senderId: string; messageId: string }, emoji: string, key: string) {
    if (this.noReactions.has(target.spaceId)) throw new Error(`reactions refused in ${target.spaceId}`);
    try {
      await this.client.react({ ...target, reaction: emoji }, key);
    } catch (err) {
      if (err instanceof PhotonApiError && err.status === 409 && err.code === "SPACE_NOT_SENDABLE")
        this.noReactions.add(target.spaceId);
      throw err;
    }
  }
  async typing(spaceId: string, senderId: string, on: boolean) {
    await this.client.setTyping(spaceId, senderId, on);
  }
  async read(messageId: string, key: string) {
    await this.client.markRead(messageId, key);
  }
}

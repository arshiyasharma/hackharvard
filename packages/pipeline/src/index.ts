import type { InboundMessage } from "@elves/photon";
import { createLogger, type Logger } from "@elves/shared";

export interface Batch {
  spaceId: string;
  messages: InboundMessage[];
  traceId: string;
  /** How many messages were carried forward from a cancelled in-flight batch. */
  carried: number;
}

export interface HandleContext {
  signal: AbortSignal;
  /**
   * Call once the batch has been answered and is now doing slow follow-up work (a search): from then on a new
   * message no longer cancels it, it simply queues behind it.
   */
  settle: () => void;
}

export interface PipelineOptions {
  debounceMs: number;
  handle: (batch: Batch, ctx: HandleContext) => Promise<void>;
  onError?: (error: unknown, batch: Batch) => void;
  logger?: Logger;
}

interface SpaceState {
  pending: InboundMessage[];
  timer: ReturnType<typeof setTimeout> | null;
  inflight: { batch: Batch; ctrl: AbortController; done: Promise<void>; settled: boolean } | null;
}

/**
 * Per-space debounce queue, Photon's documented inbound pipeline:
 * messages for a space are batched after a quiet window; a message that arrives while a batch is being
 * handled cancels that job and carries its messages into the next batch, so one reply covers the burst.
 */
export class Pipeline {
  private spaces = new Map<string, SpaceState>();
  private readonly log: Logger;
  stats = { batches: 0, cancelled: 0, messages: 0, errors: 0 };

  constructor(private readonly opts: PipelineOptions) {
    this.log = opts.logger ?? createLogger("pipeline");
  }

  private state(spaceId: string): SpaceState {
    let s = this.spaces.get(spaceId);
    if (!s) {
      s = { pending: [], timer: null, inflight: null };
      this.spaces.set(spaceId, s);
    }
    return s;
  }

  enqueue(msg: InboundMessage) {
    const s = this.state(msg.spaceId);
    this.stats.messages++;
    s.pending.push(msg);
    if (s.inflight && !s.inflight.ctrl.signal.aborted && !s.inflight.settled) {
      // Cancel the running job; its messages ride into this batch.
      s.inflight.ctrl.abort();
      this.stats.cancelled++;
      const carried = s.inflight.batch.messages.filter((m) => !s.pending.some((p) => p.id === m.id));
      s.pending.unshift(...carried);
      this.log.debug("cancelled in-flight batch; carrying forward", {
        spaceId: msg.spaceId,
        carried: carried.length,
      });
    }
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => void this.flush(msg.spaceId), this.opts.debounceMs);
  }

  async flush(spaceId: string) {
    const s = this.state(spaceId);
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }
    if (s.inflight) {
      // Wait for the cancelled job to unwind before starting the next one.
      await s.inflight.done.catch(() => {});
      s.inflight = null;
    }
    if (s.pending.length === 0) return;
    const messages = s.pending.splice(0).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
    const carried = this.stats.cancelled
      ? messages.filter((m) => m.receivedAt < messages[messages.length - 1]!.receivedAt).length
      : 0;
    const batch: Batch = { spaceId, messages, traceId: crypto.randomUUID(), carried };
    const ctrl = new AbortController();
    this.stats.batches++;
    // Registered before the handler runs, so a synchronous settle() lands on this batch.
    const inflight = { batch, ctrl, done: Promise.resolve(), settled: false };
    s.inflight = inflight;
    const settle = () => {
      inflight.settled = true;
    };
    inflight.done = this.opts
      .handle(batch, { signal: ctrl.signal, settle })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        this.stats.errors++;
        this.log.error("batch handler failed", { spaceId, traceId: batch.traceId, error: String(err) });
        this.opts.onError?.(err, batch);
      })
      .finally(() => {
        if (s.inflight === inflight) s.inflight = null;
      });
    await inflight.done;
  }

  /** Resolve when nothing is pending or in flight (tests). */
  async idle(pollMs = 10) {
    while (true) {
      const busy = [...this.spaces.values()].some((s) => s.pending.length || s.timer || s.inflight);
      if (!busy) return;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}

/** Deterministic idempotency keys so a retried send never double-posts. */
export function sendKey(kind: string, batchOrMessageId: string, n = 0) {
  return `${kind}:${batchOrMessageId}:${n}`;
}

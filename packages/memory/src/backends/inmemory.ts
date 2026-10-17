import { newId, nowIso } from "@elves/shared";
import {
  type Fact,
  type FactInput,
  type FactStatus,
  type MemoryBackend,
  type MessageRow,
  type NoteRow,
  queryTerms,
  type RankedFact,
  type ThreadRow,
} from "../types.ts";

/** Everything in Maps; shared across service instances in tests to simulate a restart. */
export class InMemoryBackend implements MemoryBackend {
  readonly kind = "memory" as const;
  private threads = new Map<string, ThreadRow>();
  private messages = new Map<string, MessageRow>();
  private facts = new Map<string, Fact>();
  private factKeys = new Map<string, string>();
  private notes = new Map<string, NoteRow>();
  private seq = 0;

  async ensureThread(input: {
    id: string;
    moveId: string;
    role?: string | null;
    handle?: string | null;
    title?: string | null;
  }) {
    const existing = this.threads.get(input.id);
    if (existing) return existing;
    const ts = nowIso();
    const t: ThreadRow = {
      id: input.id,
      moveId: input.moveId,
      role: input.role ?? null,
      handle: input.handle ?? null,
      title: input.title ?? null,
      summary: null,
      summaryThroughSeq: 0,
      summaryMessageCount: 0,
      messageCount: 0,
      metadata: {},
      createdAt: ts,
      updatedAt: ts,
    };
    this.threads.set(t.id, t);
    return t;
  }
  async getThread(id: string) {
    return this.threads.get(id) ?? null;
  }
  async listThreads(moveId: string) {
    return [...this.threads.values()].filter((t) => t.moveId === moveId);
  }

  async appendMessage(msg: Omit<MessageRow, "seq">) {
    if (this.messages.has(msg.id)) return false;
    const thread = this.threads.get(msg.threadId);
    if (!thread) throw new Error(`thread ${msg.threadId} not found`);
    this.messages.set(msg.id, { ...msg, seq: ++this.seq });
    thread.messageCount++;
    thread.updatedAt = nowIso();
    return true;
  }
  private ofThread(threadId: string) {
    return [...this.messages.values()].filter((m) => m.threadId === threadId).sort((a, b) => a.seq - b.seq);
  }
  async recentMessages(threadId: string, limit: number) {
    return this.ofThread(threadId).slice(-limit);
  }
  async messagesAfter(threadId: string, afterSeq: number, limit: number) {
    return this.ofThread(threadId)
      .filter((m) => m.seq > afterSeq)
      .slice(0, limit);
  }
  async setSummary(threadId: string, summary: string, throughSeq: number, messageCount: number) {
    const t = this.threads.get(threadId);
    if (!t) return;
    t.summary = summary;
    t.summaryThroughSeq = throughSeq;
    t.summaryMessageCount = messageCount;
    t.updatedAt = nowIso();
  }

  async upsertFact(input: FactInput & { dedupeKey: string }) {
    const key = `${input.moveId}|${input.dedupeKey}`;
    const existingId = this.factKeys.get(key);
    const ts = nowIso();
    if (existingId) {
      const f = this.facts.get(existingId)!;
      const next: Fact = {
        ...f,
        text: input.text,
        subject: input.subject,
        audience: input.audience ?? f.audience,
        confidence: Math.max(f.confidence, input.confidence ?? 0.7),
        status: "active",
        timesSeen: f.timesSeen + 1,
        lastSeenAt: ts,
        sourceMessageId: input.sourceMessageId ?? f.sourceMessageId,
      };
      this.facts.set(f.id, next);
      return { fact: next, created: false };
    }
    const fact: Fact = {
      id: newId("fc"),
      moveId: input.moveId,
      threadId: input.threadId ?? null,
      subject: input.subject,
      kind: input.kind,
      text: input.text,
      audience: input.audience ?? "crew",
      confidence: input.confidence ?? 0.7,
      elf: input.elf ?? null,
      sourceMessageId: input.sourceMessageId ?? null,
      status: "active",
      timesSeen: 1,
      lastSeenAt: ts,
      createdAt: ts,
    };
    this.facts.set(fact.id, fact);
    this.factKeys.set(key, fact.id);
    return { fact, created: true };
  }
  async searchFacts(moveId: string, opts: { query: string; limit: number }) {
    const terms = queryTerms(opts.query);
    const now = Date.now();
    const ranked: RankedFact[] = [];
    for (const f of this.facts.values()) {
      if (f.moveId !== moveId || f.status !== "active") continue;
      ranked.push({ ...f, score: scoreFact(f, terms, now) });
    }
    ranked.sort((a, b) => b.score - a.score || b.lastSeenAt.localeCompare(a.lastSeenAt));
    return ranked.slice(0, opts.limit);
  }
  async listFacts(moveId: string, status?: FactStatus) {
    return [...this.facts.values()]
      .filter((f) => f.moveId === moveId && (!status || f.status === status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async setFactStatus(id: string, status: FactStatus) {
    const f = this.facts.get(id);
    if (f) this.facts.set(id, { ...f, status });
  }

  async getNote(moveId: string, elf: string, key: string) {
    return this.notes.get(`${moveId}|${elf}|${key}`)?.value;
  }
  async setNote(moveId: string, elf: string, key: string, value: unknown) {
    this.notes.set(`${moveId}|${elf}|${key}`, { moveId, elf, key, value, updatedAt: nowIso() });
  }
  async listNotes(moveId: string, elf?: string) {
    return [...this.notes.values()].filter((n) => n.moveId === moveId && (!elf || n.elf === elf));
  }
}

/** Same shape as the SQL ranking: relevance to the query, confidence, recency, and a bump for things that must not drop. */
export function scoreFact(f: Fact, terms: string[], now: number): number {
  const hay = `${f.subject} ${f.text}`.toLowerCase();
  const hits = terms.filter((t) => hay.includes(t)).length;
  const relevance = terms.length ? hits / terms.length : 0;
  const ageDays = Math.max(0, now - new Date(f.lastSeenAt).getTime()) / 86_400_000;
  const recency = 1 / (1 + ageDays);
  const urgent = f.kind === "open_loop" || f.kind === "commitment" || f.kind === "constraint" ? 0.3 : 0;
  return relevance * 2 + f.confidence * 0.5 + recency * 0.5 + urgent;
}

/**
 * @elves/memory — what the crew remembers between texts.
 *
 * Three layers, one facade:
 *   working memory   a view rendered from the structured Store on every turn (move, items, board): never stale
 *   transcript       append-only per Photon space, keyed by Photon message id (replays never duplicate), with a
 *                    rolling summary once a thread grows past a threshold
 *   facts            durable, deduplicated statements extracted after each turn (preferences, constraints,
 *                    commitments, open loops, people), recalled by relevance + recency + confidence, with an
 *                    audience flag so a buyer thread never gets the owner's floor price
 * plus a per-Elf scratchpad (notes). Context assembly is token-budgeted; consolidation runs after the reply is
 * sent, serialized per thread, and never blocks a text.
 */

import type { LLM } from "@elves/llm";
import { createLogger, ELF_LABELS, type ElfName, type Logger, type Store } from "@elves/shared";
import type { SQL } from "bun";
import { InMemoryBackend } from "./backends/inmemory.ts";
import { PostgresBackend } from "./backends/postgres.ts";
import { extractFacts, summarize } from "./consolidate.ts";
import {
  clipToTokens,
  dedupeKey,
  estimateTokens,
  type Fact,
  type FactInput,
  type MemoryBackend,
  type MemoryRole,
  type MessageRow,
  type RankedFact,
} from "./types.ts";
import { renderWorkingMemory } from "./working.ts";

export { InMemoryBackend } from "./backends/inmemory.ts";
export { PostgresBackend } from "./backends/postgres.ts";
export { type ExtractedFact, FactExtraction, heuristicFacts } from "./consolidate.ts";
export * from "./types.ts";
export {
  type HousingView,
  housingLines,
  itemLine,
  publicItemLine,
  renderPublicWorkingMemory,
  renderWorkingMemory,
} from "./working.ts";

export interface MemoryBudget {
  /** Tokens for the verbatim transcript window. */
  transcript: number;
  facts: number;
  summary: number;
  working: number;
}

export interface MemoryConfig {
  /** Newest messages considered for the transcript window (before the token budget trims it). */
  lastMessages: number;
  maxFacts: number;
  budget: MemoryBudget;
  /** Summarize once this many messages sit outside the summary... */
  summarizeAfter: number;
  /** ...keeping this many of the newest verbatim. */
  summarizeKeep: number;
  /** Skip fact extraction for texts shorter than this ("ok", "$40"). */
  minExtractChars: number;
}

export const DEFAULT_CONFIG: MemoryConfig = {
  lastMessages: 24,
  maxFacts: 12,
  budget: { transcript: 1400, facts: 500, summary: 250, working: 500 },
  summarizeAfter: 40,
  summarizeKeep: 16,
  minExtractChars: 12,
};

export interface ConversationContext {
  /** Verbatim recent messages, oldest first, one line each. Empty at the start of a conversation. */
  transcript: string;
  /** Summary of messages older than the transcript window, when the thread has one. */
  summary: string | null;
  workingMemory: string | null;
  /** Ranked fact lines for this thread's audience. */
  facts: string[];
  /** Facts this thread's person must never hear (non-owner threads only). */
  confidential: string[];
  /** The handling Elf's own notes for this move. */
  notes: Record<string, unknown> | null;
  messageCount: number;
  /** Estimated tokens of the rendered preamble. */
  tokens: number;
}

export const EMPTY_CONVERSATION: ConversationContext = {
  transcript: "",
  summary: null,
  workingMemory: null,
  facts: [],
  confidential: [],
  notes: null,
  messageCount: 0,
  tokens: 0,
};

export interface RememberInput {
  threadId: string;
  moveId: string;
  role: MemoryRole;
  /** Stable id (the Photon message id) so replays never duplicate. */
  id: string;
  text: string;
  elf?: ElfName | null;
  createdAt?: Date | string;
  metadata?: Record<string, unknown>;
}

export interface ContextInput {
  threadId: string;
  moveId: string;
  /** The Elf about to answer; selects the notes. */
  elf?: ElfName;
  /** The participant role of this thread's person; owner sees everything. */
  role?: string | null;
  /** The incoming text, used to rank facts. */
  query?: string;
}

export interface TurnInput {
  threadId: string;
  moveId: string;
  elf: ElfName;
  role?: string | null;
  text: string;
  reply: string;
  sourceMessageId?: string | null;
}

export interface MoveMemoryOptions {
  backend: MemoryBackend;
  store: Store;
  llm: LLM;
  logger?: Logger;
  config?: Partial<Omit<MemoryConfig, "budget">> & { budget?: Partial<MemoryBudget> };
}

export interface MemoryStats {
  kind: "memory" | "postgres";
  factsCreated: number;
  factsReinforced: number;
  extractions: number;
  summaries: number;
  failures: number;
  pending: number;
}

export class MoveMemory {
  readonly backend: MemoryBackend;
  readonly kind: "memory" | "postgres";
  readonly config: MemoryConfig;
  private readonly store: Store;
  private readonly llm: LLM;
  private readonly log: Logger;
  private readonly chains = new Map<string, Promise<void>>();
  private readonly counters = {
    factsCreated: 0,
    factsReinforced: 0,
    extractions: 0,
    summaries: 0,
    failures: 0,
  };

  constructor(opts: MoveMemoryOptions) {
    this.backend = opts.backend;
    this.kind = opts.backend.kind;
    this.store = opts.store;
    this.llm = opts.llm;
    this.log = opts.logger ?? createLogger("memory");
    const { budget, ...rest } = opts.config ?? {};
    this.config = { ...DEFAULT_CONFIG, ...rest, budget: { ...DEFAULT_CONFIG.budget, ...(budget ?? {}) } };
  }

  /**
   * ELVES_MEMORY=off disables memory. With a database handle the Postgres backend is used; otherwise memory
   * lives in-process (lost on restart, fine for tests and the demo).
   */
  static fromEnv(
    env: NodeJS.ProcessEnv,
    deps: { sql?: SQL | null; store: Store; llm: LLM; logger?: Logger },
  ): MoveMemory | null {
    if (env.ELVES_MEMORY === "off" || env.ELVES_MEMORY === "0" || env.ELVES_MEMORY === "false") return null;
    const backend = deps.sql ? new PostgresBackend(deps.sql) : new InMemoryBackend();
    const config: MoveMemoryOptions["config"] = {};
    if (env.ELVES_MEMORY_MESSAGES) config.lastMessages = Number(env.ELVES_MEMORY_MESSAGES);
    if (env.ELVES_MEMORY_BUDGET) config.budget = { transcript: Number(env.ELVES_MEMORY_BUDGET) };
    return new MoveMemory({ backend, store: deps.store, llm: deps.llm, logger: deps.logger, config });
  }

  async ensureThread(
    threadId: string,
    input: { moveId: string; role?: string | null; handle?: string | null; title?: string | null },
  ) {
    return this.backend.ensureThread({ id: threadId, ...input });
  }

  /** Append one message; idempotent on id. Returns false when it was already stored. */
  async remember(input: RememberInput): Promise<boolean> {
    const text = input.text.trim() || "[empty]";
    const createdAt =
      input.createdAt instanceof Date
        ? input.createdAt.toISOString()
        : typeof input.createdAt === "string"
          ? input.createdAt
          : new Date().toISOString();
    return this.backend.appendMessage({
      id: input.id,
      threadId: input.threadId,
      moveId: input.moveId,
      role: input.role,
      elf: input.elf ?? null,
      text,
      tokens: estimateTokens(text),
      metadata: input.metadata ?? {},
      createdAt,
    });
  }

  /** Everything an Elf should see before it answers, within the token budget. */
  async context(input: ContextInput): Promise<ConversationContext> {
    const cfg = this.config;
    const [thread, recent, ranked, notes, move, items, board, participants, search, listings] =
      await Promise.all([
        this.backend.getThread(input.threadId),
        this.backend.recentMessages(input.threadId, cfg.lastMessages),
        this.backend.searchFacts(input.moveId, { query: input.query ?? "", limit: cfg.maxFacts * 2 }),
        input.elf ? this.backend.listNotes(input.moveId, input.elf) : Promise.resolve([]),
        this.store.getMove(input.moveId),
        this.store.listItems(input.moveId),
        this.store.getBoard(input.moveId),
        this.store.listParticipants(input.moveId),
        this.store.getSearch(input.moveId),
        this.store.listListings(input.moveId),
      ]);
    const role = input.role ?? thread?.role ?? "owner";

    // Transcript: the newest messages outside the summary, trimmed from the oldest end to the budget.
    const through = thread?.summaryThroughSeq ?? 0;
    let window = recent.filter((m) => m.seq > through);
    let used = window.reduce((n, m) => n + m.tokens, 0);
    while (window.length > 1 && used > cfg.budget.transcript) {
      used -= window[0]!.tokens;
      window = window.slice(1);
    }
    const transcript = window
      .map((m) => `${this.speaker(m, role)}: ${m.text.replace(/\s+/g, " ")}`)
      .join("\n");

    // Facts: owner threads see everything; anyone else gets owner_private facts under a do-not-repeat header.
    const isOwner = role === "owner";
    const facts: string[] = [];
    const confidential: string[] = [];
    let factTokens = 0;
    for (const f of ranked) {
      const line = factLine(f);
      const t = estimateTokens(line);
      if (facts.length + confidential.length >= cfg.maxFacts || factTokens + t > cfg.budget.facts) break;
      factTokens += t;
      if (!isOwner && f.audience === "owner_private") confidential.push(line);
      else facts.push(line);
    }

    const summary = thread?.summary ? clipToTokens(thread.summary, cfg.budget.summary) : null;
    const housing = search || listings.length ? { search: search ?? null, listings } : null;
    const workingMemory = move
      ? clipToTokens(
          renderWorkingMemory(move, items, board, participants, housing, isOwner ? "owner" : "public"),
          cfg.budget.working,
        )
      : null;
    // An Elf's notes are its private scratchpad for the move (may hold floors, budgets): owner threads only.
    const noteMap = isOwner && notes.length ? Object.fromEntries(notes.map((n) => [n.key, n.value])) : null;
    const ctx: ConversationContext = {
      transcript,
      summary,
      workingMemory,
      facts,
      confidential,
      notes: noteMap,
      messageCount: thread?.messageCount ?? 0,
      tokens: 0,
    };
    ctx.tokens = estimateTokens(renderPreamble(ctx));
    return ctx;
  }

  private speaker(m: MessageRow, threadRole: string): string {
    if (m.role === "assistant") return m.elf ? (ELF_LABELS[m.elf as ElfName] ?? m.elf) : "Elf";
    if (m.role === "system") return "System";
    return threadRole === "owner" ? "Owner" : threadRole.charAt(0).toUpperCase() + threadRole.slice(1);
  }

  /**
   * After a reply is sent: extract facts from the exchange and fold old messages into the summary.
   * Fire-and-forget, serialized per thread; await flush() to wait for it (tests, shutdown).
   */
  afterTurn(input: TurnInput): void {
    const prev = this.chains.get(input.threadId) ?? Promise.resolve();
    const next = prev
      .then(() => this.consolidate(input))
      .catch((err) => {
        this.counters.failures++;
        this.log.warn("memory consolidation failed", { threadId: input.threadId, error: String(err) });
      })
      .finally(() => {
        if (this.chains.get(input.threadId) === next) this.chains.delete(input.threadId);
      });
    this.chains.set(input.threadId, next);
  }

  /** Resolve when every scheduled consolidation has finished. */
  async flush(): Promise<void> {
    while (this.chains.size) await Promise.all([...this.chains.values()]);
  }

  private async consolidate(input: TurnInput): Promise<void> {
    const cfg = this.config;
    const role = input.role ?? "owner";
    if (input.text.trim().length >= cfg.minExtractChars) {
      const [move, items, board] = await Promise.all([
        this.store.getMove(input.moveId),
        this.store.listItems(input.moveId),
        this.store.getBoard(input.moveId),
      ]);
      const working = move ? renderWorkingMemory(move, items, board) : null;
      const extracted = await extractFacts(this.llm, {
        role,
        text: input.text,
        reply: input.reply,
        elfLabel: ELF_LABELS[input.elf] ?? input.elf,
        working,
      });
      this.counters.extractions++;
      for (const f of extracted) {
        const { created } = await this.backend.upsertFact({
          moveId: input.moveId,
          threadId: input.threadId,
          subject: f.subject,
          kind: f.kind,
          text: f.text,
          audience: f.audience,
          confidence: f.confidence,
          elf: input.elf,
          sourceMessageId: input.sourceMessageId ?? null,
          dedupeKey: dedupeKey(f.kind, f.text),
        });
        if (created) this.counters.factsCreated++;
        else this.counters.factsReinforced++;
      }
    }

    const thread = await this.backend.getThread(input.threadId);
    if (!thread) return;
    const unsummarized = thread.messageCount - thread.summaryMessageCount;
    if (unsummarized >= cfg.summarizeAfter) {
      const take = unsummarized - cfg.summarizeKeep;
      const batch = await this.backend.messagesAfter(input.threadId, thread.summaryThroughSeq, take);
      if (batch.length) {
        const summary = await summarize(this.llm, thread.summary, batch, (m) =>
          this.speaker(m, thread.role ?? role),
        );
        await this.backend.setSummary(
          input.threadId,
          summary,
          batch[batch.length - 1]!.seq,
          thread.summaryMessageCount + batch.length,
        );
        this.counters.summaries++;
      }
    }
  }

  /** Record a fact directly (an Elf learned something structured, e.g. a buyer's pickup window). */
  async addFact(input: FactInput): Promise<Fact> {
    const { fact, created } = await this.backend.upsertFact({
      ...input,
      dedupeKey: dedupeKey(input.kind, input.text),
    });
    if (created) this.counters.factsCreated++;
    else this.counters.factsReinforced++;
    return fact;
  }
  listFacts(moveId: string) {
    return this.backend.listFacts(moveId);
  }
  recall(moveId: string, query: string, limit = this.config.maxFacts): Promise<RankedFact[]> {
    return this.backend.searchFacts(moveId, { query, limit });
  }
  resolveFact(id: string) {
    return this.backend.setFactStatus(id, "resolved");
  }
  note(moveId: string, elf: ElfName, key: string) {
    return this.backend.getNote(moveId, elf, key);
  }
  setNote(moveId: string, elf: ElfName, key: string, value: unknown) {
    return this.backend.setNote(moveId, elf, key, value);
  }
  threads(moveId: string) {
    return this.backend.listThreads(moveId);
  }
  notes(moveId: string) {
    return this.backend.listNotes(moveId);
  }

  stats(): MemoryStats {
    return { kind: this.kind, ...this.counters, pending: this.chains.size };
  }
}

function factLine(f: Fact): string {
  const tag =
    f.kind === "open_loop"
      ? "(open loop) "
      : f.kind === "commitment"
        ? "(we promised) "
        : f.kind === "constraint"
          ? "(constraint) "
          : "";
  return `- ${tag}${f.text}`;
}

/** The memory preamble every Elf prompt starts with. */
export function renderPreamble(c: ConversationContext): string {
  const parts: string[] = [];
  parts.push(
    `Working memory (what the crew already knows about this move):\n${c.workingMemory?.trim() || "(nothing recorded yet)"}`,
  );
  parts.push(
    `What the crew has learned, most relevant first:\n${c.facts.length ? c.facts.join("\n") : "(nothing yet)"}`,
  );
  if (c.confidential.length)
    parts.push(
      `Confidential. Never repeat any of this to the person you are texting:\n${c.confidential.join("\n")}`,
    );
  if (c.notes && Object.keys(c.notes).length)
    parts.push(`Your own notes on this move (JSON):\n${JSON.stringify(c.notes)}`);
  if (c.summary) parts.push(`Earlier in this conversation, summarized:\n${c.summary}`);
  parts.push(
    `Conversation so far, oldest first (the latest message follows separately):\n${c.transcript || "(no earlier messages; this is the start of the conversation)"}`,
  );
  return parts.join("\n\n");
}

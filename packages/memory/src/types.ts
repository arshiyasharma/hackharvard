export type MemoryRole = "user" | "assistant" | "system";
export type FactKind = "preference" | "constraint" | "commitment" | "open_loop" | "person" | "fact";
export type FactAudience = "crew" | "owner_private";
export type FactStatus = "active" | "resolved" | "superseded";

export interface ThreadRow {
  /** The Photon space id. */
  id: string;
  moveId: string;
  role: string | null;
  handle: string | null;
  title: string | null;
  /** Rolling summary of the first `summaryMessageCount` messages (seq <= summaryThroughSeq). */
  summary: string | null;
  summaryThroughSeq: number;
  summaryMessageCount: number;
  messageCount: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRow {
  /** Stable id: the Photon message id inbound, the reply id outbound. */
  id: string;
  seq: number;
  threadId: string;
  moveId: string;
  role: MemoryRole;
  elf: string | null;
  text: string;
  tokens: number;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface Fact {
  id: string;
  moveId: string;
  threadId: string | null;
  /** owner | move | item:<name> | person:<name> */
  subject: string;
  kind: FactKind;
  text: string;
  audience: FactAudience;
  confidence: number;
  elf: string | null;
  sourceMessageId: string | null;
  status: FactStatus;
  timesSeen: number;
  lastSeenAt: string;
  createdAt: string;
}

export interface NoteRow {
  moveId: string;
  elf: string;
  key: string;
  value: unknown;
  updatedAt: string;
}

export interface FactInput {
  moveId: string;
  threadId?: string | null;
  subject: string;
  kind: FactKind;
  text: string;
  audience?: FactAudience;
  confidence?: number;
  elf?: string | null;
  sourceMessageId?: string | null;
}

export type RankedFact = Fact & { score: number };

/** Storage for memory. Two implementations: in-process (tests, demo) and Postgres (production). */
export interface MemoryBackend {
  readonly kind: "memory" | "postgres";
  ensureThread(input: {
    id: string;
    moveId: string;
    role?: string | null;
    handle?: string | null;
    title?: string | null;
  }): Promise<ThreadRow>;
  getThread(id: string): Promise<ThreadRow | null>;
  listThreads(moveId: string): Promise<ThreadRow[]>;
  /** Insert a message; false when that id is already stored (replay). */
  appendMessage(msg: Omit<MessageRow, "seq">): Promise<boolean>;
  /** The newest `limit` messages of a thread, oldest first. */
  recentMessages(threadId: string, limit: number): Promise<MessageRow[]>;
  /** The oldest `limit` messages with seq > afterSeq, oldest first (summarization). */
  messagesAfter(threadId: string, afterSeq: number, limit: number): Promise<MessageRow[]>;
  setSummary(threadId: string, summary: string, throughSeq: number, messageCount: number): Promise<void>;
  upsertFact(input: FactInput & { dedupeKey: string }): Promise<{ fact: Fact; created: boolean }>;
  searchFacts(moveId: string, opts: { query: string; limit: number }): Promise<RankedFact[]>;
  listFacts(moveId: string, status?: FactStatus): Promise<Fact[]>;
  setFactStatus(id: string, status: FactStatus): Promise<void>;
  getNote(moveId: string, elf: string, key: string): Promise<unknown>;
  setNote(moveId: string, elf: string, key: string, value: unknown): Promise<void>;
  listNotes(moveId: string, elf?: string): Promise<NoteRow[]>;
}

/** Cheap, model-agnostic token estimate (about 4 characters per token for English text). */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Cut text to roughly `tokens` tokens, keeping whole lines where possible. */
export function clipToTokens(text: string, tokens: number): string {
  const max = tokens * 4;
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const nl = cut.lastIndexOf("\n");
  return `${nl > max * 0.5 ? cut.slice(0, nl) : cut}…`;
}

const STOP = new Set(
  "a an and are as at be by for from has have i im is it its my of on or so that the this to was we you your".split(
    " ",
  ),
);
/** Postgres' english stop list, so query terms match what to_tsvector keeps. Not used for dedupe (keeps "not"). */
const QUERY_STOP = new Set(
  `i me my myself we our ours ourselves you your yours yourself yourselves he him his himself she her hers herself it its itself they them their theirs themselves what which who whom this that these those am is are was were be been being have has had having do does did doing a an the and but if or because as until while of at by for with about against between into through during before after above below to from up down in out on off over under again further then once here there when where why how all any both each few more most other some such no nor not only own same so than too very s t can will just don should now`.split(
    /\s+/,
  ),
);
export function queryTerms(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[a-z][a-z0-9']{1,}/g) ?? [])].filter(
    (w) => !STOP.has(w) && !QUERY_STOP.has(w),
  );
}

/** Facts that say the same thing collapse onto one row: same kind, same words. */
export function dedupeKey(kind: string, text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9$ ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w));
  return `${kind}:${words.join(" ")}`.slice(0, 300);
}

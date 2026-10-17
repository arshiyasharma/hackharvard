/**
 * Minimal context and result types for the Money Elf.
 *
 * These are structural subsets of the foundation contract (packages/elves/src/contract.ts and
 * packages/shared/src/index.ts on phase-1-foundation), so a foundation ElfContext can be passed straight in
 * and the returned MoneyResult is a valid ElfResult plus the new `outbound` field.
 */
import type { z } from "zod";

export type Role = "owner" | "roommate" | "buyer" | "applicant" | "lister";
export type ElfStatus = "idle" | "working" | "waiting" | "done" | "blocked";

export interface MoneyMessage {
  id: string;
  text: string | null;
  parentMessageId?: string | null;
}

export interface MoneyBatch {
  spaceId: string;
  messages: MoneyMessage[];
  traceId: string;
}

export interface MoneyMove {
  id: string;
  ownerHandle: string;
  name: string | null;
}

export interface MoneyParticipant {
  handle: string;
  role: Role;
}

/** The slice of the foundation LLM the Money Elf uses. */
export interface MoneyLLM {
  readonly name: string;
  extract<T>(schema: z.ZodType<T>, input: { system: string; user: string }): Promise<T>;
}

export interface MoneyLogger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface MoneyContext {
  llm: MoneyLLM;
  move: MoneyMove;
  participant: MoneyParticipant;
  batch: MoneyBatch;
  traceId: string;
  log: MoneyLogger;
  now: () => Date;
}

export interface MoneyReply {
  text: string;
  parentMessageId?: string | null;
}

/** A message for someone other than the sender (a roommate's payment request, a note to the owner). */
export interface OutboundMessage {
  toHandle: string;
  text: string;
}

export interface MoneyEvent {
  type: string;
  payload: Record<string, unknown>;
}

export interface MoneyResult {
  replies: MoneyReply[];
  boardPatch?: { status?: ElfStatus; currentTask?: string; lastUpdate?: string };
  events?: MoneyEvent[];
  /** New: messages the service sends to other participants by handle. */
  outbound?: OutboundMessage[];
}

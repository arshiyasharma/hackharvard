/**
 * Minimal context and result types for the Money Elf.
 *
 * These are structural subsets of the crew's contract (packages/elves/src/contract.ts and
 * packages/shared/src/index.ts), so the crew's ElfContext can be passed straight in and the returned
 * MoneyResult is a valid ElfResult plus new fields (outbound, images, poll). test/foundation-compat.ts
 * makes the typecheck prove it.
 */
import type { z } from "zod";

export type Role = "owner" | "roommate" | "buyer" | "seller" | "applicant" | "lister";
export type ElfStatus = "idle" | "working" | "waiting" | "done" | "blocked";

export interface MoneyMessage {
  id: string;
  text: string | null;
  parentMessageId?: string | null;
  /** A Photon 2.0 `poll.vote`: the options the sender picked (ids are ours, see MoneyPoll). */
  pollVote?: { selectedOptions: { id: string; text: string }[] } | null;
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

/** An image to upload as a Photon attachment and send after the reply text. */
export interface MoneyImage {
  contentType: "image/png";
  filename: string;
  bytes: Uint8Array;
  /** What the image shows, for logs and platforms that can't show images. */
  alt: string;
}

/**
 * A Photon 2.0 poll (`{type:"poll", question, options, selectionMode}`), sent after the reply text.
 * Option ids are `money:approve:<pendingId>` / `money:decline:<pendingId>`, so a vote names the exact action.
 */
export interface MoneyPoll {
  question: string;
  options: { id: string; text: string }[];
  selectionMode: "single";
}

/** A message for someone other than the sender (a roommate's payment request, a note to the owner). */
export interface OutboundMessage {
  toHandle: string;
  text: string;
  poll?: MoneyPoll;
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
  /** New: images sent in the sender's chat after the reply text (the Ledger card). */
  images?: MoneyImage[];
  /** New: a poll sent in the sender's chat after the reply (approvals). */
  poll?: MoneyPoll;
}

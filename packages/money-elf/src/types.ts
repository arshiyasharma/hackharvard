/**
 * Minimal context and result types for the Money Elf.
 *
 * These are structural subsets of the crew's contract (packages/elves/src/contract.ts and
 * packages/shared/src/index.ts), so the crew's ElfContext can be passed straight in and the returned
 * MoneyResult is a valid ElfResult plus new fields (images, poll; outbound carries the handle too). test/foundation-compat.ts
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
  /** The owner's chat (the crew's Move has it), for outbound texts to the owner. */
  ownerSpaceId?: string;
  /** Move-out (the crew's Move has it), ISO date or time. Move Plans plans up to this day. */
  moveOutAt?: string | null;
}

/** The slice of the crew's Item that Move Plans reads (packages/shared/src/index.ts Item). */
export interface MoneyItem {
  id: string;
  name: string;
  category: string;
  weightLb: number;
  listPriceCents: number | null;
  floorPriceCents: number | null;
  outcome: "listed" | "sold" | "given" | "donated" | "dumped";
  /** The owner is keeping it (always hauled). Not on the crew Item yet; the local chat sets it. */
  keep?: boolean;
}

/** The slice of the crew Store the Money Elf reads: who is in the move and which space each one texts from. */
export interface MoneySpaces {
  listParticipants(moveId: string): Promise<{ handle: string; spaceId: string }[]>;
  /** The move's items (Move Plans). Optional so callers without items still type-check. */
  listItems?(moveId: string): Promise<MoneyItem[]>;
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
  /**
   * The crew Store, used to address outbound texts to a space. Without it (tests, local chat, smoke test) each
   * outbound text's spaceId is just the person's handle.
   */
  store?: MoneySpaces;
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
  /** Who it's for and what it's about, in a few words ("the $30 gas share"), for telling the owner to pass it on. */
  toName?: string;
  about?: string;
}

/** An outbound message addressed for the crew service, which sends texts into a space (ElfOutbound). */
export interface MoneyOutbound extends OutboundMessage {
  spaceId: string;
}

export interface MoneyEvent {
  type: string;
  payload: Record<string, unknown>;
}

export interface MoneyResult {
  replies: MoneyReply[];
  boardPatch?: { status?: ElfStatus; currentTask?: string; lastUpdate?: string };
  events?: MoneyEvent[];
  /**
   * Texts for other people's chats (the crew's ElfOutbound), plus the handle each was meant for. A handle with
   * no space yet (they've never texted, so the shared pool can't reach them) is left out and logged as an
   * `outbound.unreachable` event.
   */
  outbound?: MoneyOutbound[];
  /** New: images sent in the sender's chat after the reply text (the Ledger card). */
  images?: MoneyImage[];
  /** New: a poll sent in the sender's chat after the reply (approvals). */
  poll?: MoneyPoll;
  /** New: an iMessage mini app card to send the sender (the Moving Ledger dashboard), via Spectrum. */
  miniApp?: { url: string };
}

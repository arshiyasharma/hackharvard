import type { ListingSource } from "@elves/listings";
import type { LLM } from "@elves/llm";
import { type ConversationContext, EMPTY_CONVERSATION, renderPreamble } from "@elves/memory";
import type { AttachmentFile } from "@elves/photon";
import type { Batch } from "@elves/pipeline";
import type { ElfName, ElfStatusRow, Logger, Move, Participant, Store } from "@elves/shared";

export interface ElfContext {
  store: Store;
  llm: LLM;
  move: Move;
  participant: Participant;
  batch: Batch;
  traceId: string;
  log: Logger;
  signal: AbortSignal;
  /** Public HTTPS origin for mini-app links, or null when the service has no public URL. */
  publicUrl: string | null;
  firstContact: boolean;
  now: () => Date;
  fetchAttachment: (id: string) => Promise<AttachmentFile | null>;
  /** Working memory, learned facts, summary and recent transcript (EMPTY_CONVERSATION when memory is off). */
  conversation: ConversationContext;
  /** Where the Home Elf searches for housing, hotels and storage. */
  listings: ListingSource;
}

export type { ConversationContext };
export { EMPTY_CONVERSATION };

/** The memory preamble every Elf prompt starts with: working memory, learned facts, summary, transcript. */
export function memoryPreamble(c: ConversationContext): string {
  return renderPreamble(c);
}

export function hasPhotos(batch: Batch): boolean {
  return batch.messages.some((m) => m.attachments.length > 0);
}

export interface ElfReply {
  text: string;
  parentMessageId?: string | null;
  format?: "plain" | "markdown";
  /** Called with the sent message id (a deal anchors its owner-chat thread on it). */
  onSent?: (messageId: string) => Promise<void>;
}

/** A text for a space other than the one being answered: a buyer's DM, or the owner chat from a buyer's turn. */
export interface ElfOutbound extends ElfReply {
  spaceId: string;
  /** Optional native poll sent right after this text (e.g. an approval for the owner). */
  poll?: ElfPoll;
}

/** A native poll; option ids are the Elf's own and come back on a later message's `pollVote`. */
export interface ElfPoll {
  question: string;
  options: { id: string; text: string }[];
  selectionMode: "single" | "multiple";
}

/** An image sent in the sender's chat after the reply text (the Money Elf's Ledger card). */
export interface ElfImage {
  contentType: string;
  filename: string;
  bytes: Uint8Array;
  /** What it shows, for logs and the event trail. */
  alt: string;
}

export interface ElfResult {
  replies: ElfReply[];
  boardPatch?: Partial<Pick<ElfStatusRow, "status" | "currentTask" | "lastUpdate">>;
  events?: { type: string; payload: Record<string, unknown> }[];
  movePatch?: Partial<Omit<Move, "id" | "createdAt">>;
  /** Texts for other spaces, sent after `replies`. */
  outbound?: ElfOutbound[];
  /** Images for the sender's chat, sent after `replies` (skipped on transports that can't send images). */
  images?: ElfImage[];
  /** A poll for the sender's chat, sent after the images (skipped on transports without polls). */
  poll?: ElfPoll;
  /**
   * An iMessage mini app card (a web app that opens inside Messages) for the sender, sent through the
   * service's mini app sender when it has one (Spectrum); skipped otherwise.
   */
  miniApp?: { url: string };
  /**
   * Slow follow-up work (a web search) the service runs after `replies` are sent, then sends what it returns.
   * The batch is settled by then, so it is never cancelled by a newer text.
   */
  later?: () => Promise<Pick<ElfResult, "replies" | "boardPatch" | "events" | "outbound">>;
}

export interface Elf {
  readonly name: ElfName;
  readonly description: string;
  readonly keywords: string[];
  handle(ctx: ElfContext): Promise<ElfResult>;
}

/** The batch as one block of text; attachments become [photo]/[file] markers so the LLM knows they exist. */
export function batchText(batch: Batch): string {
  return batch.messages
    .map((m) => {
      const parts: string[] = [];
      if (m.text?.trim()) parts.push(m.text);
      else if (m.reaction && m.reaction.action !== "remove" && /^(?:👍|❤|♥|✅)/.test(m.reaction.emoji))
        parts.push("yes");
      for (const a of m.attachments) parts.push(a.mimeType?.startsWith("image/") ? "[photo]" : "[file]");
      if (m.reaction && parts[0] !== "yes") parts.push(`[reaction ${m.reaction.emoji}]`);
      return parts.join(" ");
    })
    .filter(Boolean)
    .join("\n");
}

export function lastMessageId(batch: Batch): string {
  return batch.messages[batch.messages.length - 1]?.id ?? "";
}

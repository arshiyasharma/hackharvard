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

/** An attachment with no mime type is taken for a photo (older Photon payloads did not carry one). */
export function isImageAttachment(a: { mimeType?: string }): boolean {
  return !a.mimeType || a.mimeType.startsWith("image/");
}

export function isDocumentAttachment(a: { mimeType?: string; name?: string }): boolean {
  return a.mimeType === "application/pdf" || /\.pdf$/i.test(a.name ?? "");
}

/** Photos in the batch (PDFs are documents, not photos). */
export function hasPhotos(batch: Batch): boolean {
  return batch.messages.some((m) => m.attachments.some(isImageAttachment));
}

/** PDFs in the batch: a lease for the Home Elf. */
export function hasDocuments(batch: Batch): boolean {
  return batch.messages.some((m) => m.attachments.some(isDocumentAttachment));
}

export interface SentInfo {
  /** The handle the text went out from (the dedicated line's number), when the transport knows it. */
  line: string | null;
}

export interface ElfReply {
  text: string;
  parentMessageId?: string | null;
  format?: "plain" | "markdown";
  /** Called with the sent message id (a deal anchors its owner-chat thread on it). */
  onSent?: (messageId: string, info: SentInfo) => Promise<void>;
}

/** A text for a space other than the one being answered: a buyer's DM, or the owner chat from a buyer's turn. */
export interface ElfOutboundToSpace extends ElfReply {
  spaceId: string;
}

/**
 * A first text to someone who has never written in (a lister whose number was on the listing). The service opens
 * the space from the dedicated line, joins them to `dealId` as its counterparty, then sends. Dropped, with
 * `onSent` never called, when the project has no dedicated line.
 */
export interface ElfOutboundToHandle extends ElfReply {
  to: { handle: string; platform: string };
  dealId: string;
}

export type ElfOutbound = ElfOutboundToSpace | ElfOutboundToHandle;

export function isAddressedOutbound(note: ElfOutbound): note is ElfOutboundToHandle {
  return "to" in note;
}

export interface ElfResult {
  replies: ElfReply[];
  boardPatch?: Partial<Pick<ElfStatusRow, "status" | "currentTask" | "lastUpdate">>;
  events?: { type: string; payload: Record<string, unknown> }[];
  movePatch?: Partial<Omit<Move, "id" | "createdAt">>;
  /** Texts for other spaces, sent after `replies`. */
  outbound?: ElfOutbound[];
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

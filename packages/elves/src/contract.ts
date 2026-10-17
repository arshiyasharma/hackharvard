import type { LLM } from "@elves/llm";
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
}

export function hasPhotos(batch: Batch): boolean {
  return batch.messages.some((m) => m.attachments.length > 0);
}

export interface ElfReply {
  text: string;
  parentMessageId?: string | null;
  format?: "plain" | "markdown";
}

export interface ElfResult {
  replies: ElfReply[];
  boardPatch?: Partial<Pick<ElfStatusRow, "status" | "currentTask" | "lastUpdate">>;
  events?: { type: string; payload: Record<string, unknown> }[];
  movePatch?: Partial<Omit<Move, "id" | "createdAt">>;
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
      if (m.text) parts.push(m.text);
      for (const a of m.attachments) parts.push(a.mimeType?.startsWith("image/") ? "[photo]" : "[file]");
      if (m.reaction) parts.push(`[reaction ${m.reaction.emoji}]`);
      return parts.join(" ");
    })
    .filter(Boolean)
    .join("\n");
}

export function lastMessageId(batch: Batch): string {
  return batch.messages[batch.messages.length - 1]?.id ?? "";
}

import type { PhotonContent, PhotonMessage } from "./types.ts";

/** A normalized inbound message, independent of channel. */
export interface InboundMessage {
  id: string;
  spaceId: string;
  spaceKind: string;
  platform: string;
  senderId: string;
  senderHandle: string;
  /** The agent identity this message was addressed to; replies are sent as this user. */
  agentId: string;
  agentHandle: string;
  text: string | null;
  attachments: { id: string; mimeType?: string; name?: string }[];
  reaction: { emoji: string; action: string } | null;
  parentMessageId: string | null;
  receivedAt: string;
  raw?: unknown;
}

export interface OutboundReply {
  spaceId: string;
  senderId: string;
  text: string;
  parentMessageId?: string | null;
  format?: "plain" | "markdown";
}

export interface AttachmentFile {
  id: string;
  bytes: Uint8Array;
  contentType: string;
  filename?: string;
}

/** A space the service opened itself (nobody texted in): where a dedicated line can message someone first. */
export interface OpenedSpace {
  spaceId: string;
  /** The agent user to send as in that space: the dedicated line. */
  senderId: string;
  /** The dedicated line's own handle (its phone number), when the transport knows it. */
  senderHandle: string | null;
}

export interface Transport {
  readonly name: string;
  /** Yields inbound messages until the signal aborts. Implementations must be restart-safe. */
  inbound(signal: AbortSignal): AsyncIterable<InboundMessage>;
  send(reply: OutboundReply, idempotencyKey: string): Promise<{ id: string }>;
  /**
   * Open (or find) the direct space between the dedicated line and `handle` on `platform`, so the crew can text
   * someone who has never written in. Rejects when the project has no dedicated line: the shared pool only
   * answers people who texted first.
   */
  openSpace(handle: string, platform: string): Promise<OpenedSpace>;
  react(
    target: { spaceId: string; senderId: string; messageId: string },
    emoji: string,
    key: string,
  ): Promise<void>;
  typing(spaceId: string, senderId: string, on: boolean): Promise<void>;
  read(messageId: string, key: string): Promise<void>;
  /** Download an inbound attachment's bytes, or null when the provider no longer has it. */
  fetchAttachment(id: string): Promise<AttachmentFile | null>;
}

function flattenContent(c: PhotonContent): PhotonContent[] {
  if (c.type === "group" && Array.isArray((c as { parts?: PhotonContent[] }).parts)) {
    return (c as { parts: PhotonContent[] }).parts.flatMap(flattenContent);
  }
  return [c];
}

/** Convert a Photon 2.0 received message into the normalized inbound shape; null when it carries nothing to handle. */
export function normalizePhotonMessage(m: PhotonMessage): InboundMessage | null {
  if (m.status !== "received") return null;
  if (!m.receivedBy) return null;
  if (m.sentBy.kind === "agent") return null;
  if (m.sentBy.id === m.receivedBy.id) return null;
  const parts = flattenContent(m.content);
  const texts: string[] = [];
  const attachments: InboundMessage["attachments"] = [];
  let reaction: InboundMessage["reaction"] = null;
  for (const p of parts) {
    if (p.type === "text" && typeof (p as { text?: unknown }).text === "string") {
      texts.push((p as { text: string }).text);
    } else if (
      p.type === "attachment" &&
      typeof (p as { attachmentId?: unknown }).attachmentId === "string"
    ) {
      const meta = ((p as { metadata?: Record<string, unknown> }).metadata ?? {}) as Record<string, unknown>;
      attachments.push({
        id: (p as { attachmentId: string }).attachmentId,
        mimeType: typeof meta.mimeType === "string" ? meta.mimeType : undefined,
        name: typeof meta.name === "string" ? meta.name : undefined,
      });
    } else if (p.type === "reaction") {
      const r = p as { reaction: string; action: string };
      reaction = { emoji: r.reaction, action: r.action };
    }
    // message.read / space.typing.update / unknown: nothing to handle
  }
  if (texts.length === 0 && attachments.length === 0 && !reaction) return null;
  return {
    id: m.id,
    spaceId: m.space.id,
    spaceKind: m.space.kind,
    platform: m.platform,
    senderId: m.sentBy.id,
    senderHandle: m.sentBy.handle,
    agentId: m.receivedBy.id,
    agentHandle: m.receivedBy.handle,
    text: texts.length ? texts.join("\n") : null,
    attachments,
    reaction,
    parentMessageId: m.parentMessageId ?? null,
    receivedAt: m.timestamps?.receivedAt ?? m.createdAt,
    raw: m,
  };
}

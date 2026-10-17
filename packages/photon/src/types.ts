/** Photon 2.0 API shapes (apiVersion 2026-07-01), trimmed to what the service reads. */

export type PhotonPlatform =
  | "imessage"
  | "sms"
  | "email"
  | "telegram"
  | "whatsapp"
  | "whatsapp_business"
  | "voice";

export interface PhotonUserSnapshot {
  id: string;
  projectId?: string;
  platform: string;
  handle: string;
  kind: "human" | "agent" | string;
  details?: { type?: "shared" | "dedicated"; resourceId?: string; managedBy?: string };
  metadata?: Record<string, unknown> & { displayName?: string };
}

export interface PhotonSpaceSnapshot {
  id: string;
  projectId?: string;
  platform: string;
  kind: "direct" | "group" | string;
  participantIds: string[];
  metadata?: Record<string, unknown> & { displayName?: string };
}

export type PhotonContent =
  | { type: "text"; format: string; text: string; metadata?: Record<string, unknown> }
  | { type: "attachment"; attachmentId: string; metadata?: Record<string, unknown> }
  | { type: "reaction"; reaction: string; action: "add" | "remove"; metadata?: Record<string, unknown> }
  | { type: "group"; parts: PhotonContent[]; metadata?: Record<string, unknown> }
  | { type: "message.read"; metadata?: Record<string, unknown> }
  | { type: "space.typing.update"; typing: boolean; metadata?: Record<string, unknown> }
  | { type: "poll"; question: string; options: { id: string; text: string }[]; selectionMode: string }
  | { type: string; [k: string]: unknown };

export type PhotonMessageStatus = "received" | "dispatched" | "accepted" | "delivered" | "failed";

export interface PhotonMessage {
  id: string;
  projectId: string;
  platform: string;
  status: PhotonMessageStatus;
  createdAt: string;
  updatedAt: string;
  space: PhotonSpaceSnapshot;
  sentBy: PhotonUserSnapshot;
  receivedBy?: PhotonUserSnapshot;
  addressedTo?: PhotonUserSnapshot;
  content: PhotonContent;
  parentMessageId?: string;
  timestamps?: Record<string, string | undefined>;
  failure?: unknown;
  metadata?: Record<string, unknown>;
}

export type SendContent =
  | { type: "text"; format: "plain" | "markdown" | string; text: string }
  | { type: "text.update"; format: string; text: string }
  | { type: "attachment"; attachmentId: string; metadata?: { caption?: unknown } }
  | { type: "reaction"; reaction: string; action: "add" | "remove" }
  | { type: "message.read" }
  | { type: "space.typing.update"; typing: boolean }
  | {
      type: "poll";
      question: string;
      options: { id: string; text: string }[];
      selectionMode: "single" | "multiple";
    }
  | { type: "group"; parts: SendContent[] };

export interface SendMessageRequest {
  spaceId: string;
  senderId: string;
  content: SendContent;
  parentMessageId?: string;
}

export interface Page<T> {
  items: T[];
  nextPageToken?: string;
}

export interface SharedLineAssignment {
  assignmentId: string;
  handle: string;
  assignedPhoneNumber: string;
  platform: string;
  createdAt: string;
  releasedAt?: string | null;
}

export interface PhotonResource {
  resourceId: string;
  type: string;
  state: string;
  abilities: string[];
  detail: Record<string, unknown>;
}

/** Public event envelope delivered over Socket.IO and webhooks. */
export interface PhotonEvent<T = unknown> {
  id: string;
  type: string;
  apiVersion: string;
  source: string;
  timestamp: string;
  data: T;
}
export interface MessageEventData {
  projectId: string;
  object: PhotonMessage;
}

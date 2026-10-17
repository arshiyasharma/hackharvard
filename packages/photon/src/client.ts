import type {
  Page,
  PhotonMessage,
  PhotonResource,
  SendMessageRequest,
  SharedLineAssignment,
} from "./types.ts";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface PhotonClientOptions {
  projectId: string;
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export class PhotonApiError extends Error {
  constructor(
    public status: number,
    public code: string | undefined,
    message: string,
    public requestId?: string,
    public body?: unknown,
  ) {
    super(message);
    this.name = "PhotonApiError";
  }
}

type Query = Record<string, string | number | boolean | undefined>;

/** Thin typed wrapper over the Photon 2.0 REST API, scoped to one project. */
export class PhotonClient {
  readonly projectId: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(opts: PhotonClientOptions) {
    this.projectId = opts.projectId;
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://api.photon.codes").replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  get projectPath() {
    return `${this.baseUrl}/v1/projects/${this.projectId}`;
  }

  async request<T>(
    method: string,
    path: string,
    opts: { query?: Query; body?: unknown; idempotencyKey?: string } = {},
  ): Promise<T> {
    const url = new URL(`${this.projectPath}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      accept: "application/json",
    };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let json: unknown;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = { raw: text };
        }
      }
      if (!res.ok) {
        const p = (json ?? {}) as Record<string, unknown>;
        const code = (p.code ?? p.type ?? p.error) as string | undefined;
        const detail = (p.detail ?? p.message ?? p.title ?? text) as string;
        throw new PhotonApiError(
          res.status,
          code,
          `Photon ${method} ${path} -> ${res.status} ${code ?? ""} ${detail}`.trim(),
          res.headers.get("x-request-id") ?? undefined,
          json,
        );
      }
      return json as T;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- messages ----
  listMessages(query: Query = {}) {
    return this.request<Page<PhotonMessage>>("GET", "/messages", { query });
  }
  getMessage(messageId: string) {
    return this.request<PhotonMessage>("GET", `/messages/${messageId}`);
  }
  sendMessage(body: SendMessageRequest, idempotencyKey: string) {
    return this.request<PhotonMessage>("POST", "/messages", { body, idempotencyKey });
  }
  sendText(
    args: { spaceId: string; senderId: string; text: string; parentMessageId?: string; format?: string },
    idempotencyKey: string,
  ) {
    return this.sendMessage(
      {
        spaceId: args.spaceId,
        senderId: args.senderId,
        parentMessageId: args.parentMessageId,
        content: { type: "text", format: args.format ?? "plain", text: args.text },
      },
      idempotencyKey,
    );
  }
  react(
    args: {
      spaceId: string;
      senderId: string;
      messageId: string;
      reaction: string;
      action?: "add" | "remove";
    },
    idempotencyKey: string,
  ) {
    return this.sendMessage(
      {
        spaceId: args.spaceId,
        senderId: args.senderId,
        parentMessageId: args.messageId,
        content: { type: "reaction", reaction: args.reaction, action: args.action ?? "add" },
      },
      idempotencyKey,
    );
  }
  markRead(messageId: string, idempotencyKey: string) {
    return this.request<PhotonMessage>("POST", `/messages/${messageId}/read`, { idempotencyKey });
  }
  setTyping(spaceId: string, senderId: string, typing: boolean) {
    return this.request<unknown>("POST", `/spaces/${spaceId}/typing`, { body: { senderId, typing } });
  }

  // ---- users & spaces ----
  createOrGetUser(handle: string, platform: string) {
    return this.request<{ id: string; handle: string; kind: string; platform: string }>("POST", "/users", {
      body: { handle, platform },
    });
  }
  listUsers(query: Query = {}) {
    return this.request<Page<{ id: string; handle: string; kind: string; platform: string }>>(
      "GET",
      "/users",
      {
        query,
      },
    );
  }
  createOrGetSpace(participantIds: string[], platform: string, idempotencyKey: string) {
    return this.request<{ id: string; kind: string; participantIds: string[]; platform: string }>(
      "POST",
      "/spaces",
      {
        body: { participantIds, platform },
        idempotencyKey,
      },
    );
  }
  listSpaces(query: Query = {}) {
    return this.request<Page<{ id: string; kind: string; participantIds: string[]; platform: string }>>(
      "GET",
      "/spaces",
      { query },
    );
  }

  // ---- platforms ----
  getImessagePlatform() {
    return this.request<{ mode: string; dedicatedLineAvailableNow: boolean; maxUserAssignments?: number }>(
      "GET",
      "/platforms/imessage",
    );
  }
  listAssignments(includeReleased = false) {
    return this.request<{ assignments: SharedLineAssignment[]; nextPageToken?: string }>(
      "GET",
      "/platforms/imessage/assignments",
      { query: { includeReleased } },
    );
  }
  createAssignment(
    handle: string,
    idempotencyKey: string,
    names?: { firstName?: string; lastName?: string },
  ) {
    return this.request<SharedLineAssignment>("POST", "/platforms/imessage/assignments", {
      body: { handle, ...names },
      idempotencyKey,
    });
  }
  provisionDedicatedLine(idempotencyKey: string, body: Record<string, unknown> = {}) {
    return this.request<unknown>("POST", "/platforms/imessage/dedicated", { body, idempotencyKey });
  }
  listResources() {
    return this.request<{ resources: PhotonResource[] }>("GET", "/platforms/resources");
  }
  listPlatforms() {
    return this.request<{ platforms: { type: string; displayName: string }[] }>("GET", "/platforms");
  }
  listWebhookEventTypes() {
    return this.request<unknown>("GET", "/webhooks/event-types");
  }
}

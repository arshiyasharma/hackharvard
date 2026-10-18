import { describe, expect, test } from "bun:test";
import {
  type FetchLike,
  normalizePhotonMessage,
  Photon2Transport,
  PhotonApiError,
  PhotonClient,
  type PhotonMessage,
} from "@elves/photon";
import { createLogger } from "@elves/shared";

const base = (over: Partial<PhotonMessage> = {}): PhotonMessage => ({
  id: "pho_msg_1",
  projectId: "pho_prj_1",
  platform: "imessage",
  status: "received",
  createdAt: "2026-10-17T08:38:58.705Z",
  updatedAt: "2026-10-17T08:38:58.705Z",
  space: {
    id: "pho_spc_1",
    platform: "imessage",
    kind: "direct",
    participantIds: ["pho_usr_h", "pho_usr_a"],
  },
  sentBy: { id: "pho_usr_h", platform: "imessage", handle: "+14255269066", kind: "human" },
  receivedBy: {
    id: "pho_usr_a",
    platform: "imessage",
    handle: "+16289979661",
    kind: "agent",
    details: { type: "shared" },
  },
  content: { type: "text", format: "plain", text: "Im moving out november 1" },
  timestamps: { receivedAt: "2026-10-17T08:38:58.000Z" },
  ...over,
});

describe("normalizePhotonMessage", () => {
  test("text from a human to the agent", () => {
    const n = normalizePhotonMessage(base());
    expect(n).not.toBeNull();
    expect(n!.text).toBe("Im moving out november 1");
    expect(n!.agentId).toBe("pho_usr_a");
    expect(n!.senderHandle).toBe("+14255269066");
    expect(n!.spaceId).toBe("pho_spc_1");
    expect(n!.receivedAt).toBe("2026-10-17T08:38:58.000Z");
  });
  test("agent-sent and non-received messages are ignored", () => {
    expect(
      normalizePhotonMessage(
        base({ sentBy: { id: "pho_usr_a", platform: "imessage", handle: "+1628", kind: "agent" } }),
      ),
    ).toBeNull();
    expect(normalizePhotonMessage(base({ status: "delivered" }))).toBeNull();
  });
  test("typing and read receipts carry nothing to handle", () => {
    expect(
      normalizePhotonMessage(base({ content: { type: "space.typing.update", typing: true } })),
    ).toBeNull();
    expect(normalizePhotonMessage(base({ content: { type: "message.read" } }))).toBeNull();
  });
  test("group content is flattened; attachments and text both survive", () => {
    const n = normalizePhotonMessage(
      base({
        content: {
          type: "group",
          parts: [
            { type: "attachment", attachmentId: "pho_att_1", metadata: { mimeType: "image/heic" } },
            { type: "text", format: "plain", text: "couch" },
          ],
        },
      }),
    );
    expect(n!.attachments).toEqual([{ id: "pho_att_1", mimeType: "image/heic", name: undefined }]);
    expect(n!.text).toBe("couch");
  });
  test("reactions are surfaced", () => {
    const n = normalizePhotonMessage(
      base({ content: { type: "reaction", reaction: "👍", action: "add" }, parentMessageId: "pho_msg_0" }),
    );
    expect(n!.reaction).toEqual({ emoji: "👍", action: "add" });
    expect(n!.parentMessageId).toBe("pho_msg_0");
  });
});

describe("PhotonClient", () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch: FetchLike = async (input, init) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if (url.includes("/messages?") || url.endsWith("/messages")) {
      if ((init?.method ?? "GET") === "POST") {
        return new Response(
          JSON.stringify({ id: "pho_msg_sent", status: "accepted", platform: "imessage" }),
          { status: 202 },
        );
      }
      return new Response(JSON.stringify({ items: [base()], nextPageToken: undefined }), { status: 200 });
    }
    if (url.includes("/spaces/pho_spc_1/typing")) return new Response("{}", { status: 202 });
    return new Response(JSON.stringify({ status: 403, code: "FORBIDDEN", detail: "nope" }), {
      status: 403,
      headers: { "x-request-id": "req_1", "content-type": "application/problem+json" },
    });
  };
  const client = new PhotonClient({ projectId: "pho_prj_1", apiKey: "pho_sk_test", fetch: fakeFetch });

  test("lists messages with query params and bearer auth", async () => {
    calls.length = 0;
    const page = await client.listMessages({
      direction: "received",
      order: "asc",
      pageSize: 100,
      createdSince: "2026-10-17T00:00:00.000Z",
      platform: undefined,
    });
    expect(page.items[0]!.id).toBe("pho_msg_1");
    const u = new URL(calls[0]!.url);
    expect(u.pathname).toBe("/v1/projects/pho_prj_1/messages");
    expect(u.searchParams.get("direction")).toBe("received");
    expect(u.searchParams.has("platform")).toBe(false);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer pho_sk_test");
  });

  test("sends a threaded text with an idempotency key", async () => {
    calls.length = 0;
    const res = await client.sendText(
      { spaceId: "pho_spc_1", senderId: "pho_usr_a", text: "hi", parentMessageId: "pho_msg_1" },
      "reply:pho_msg_1:0",
    );
    expect(res.id).toBe("pho_msg_sent");
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h["idempotency-key"]).toBe("reply:pho_msg_1:0");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      spaceId: "pho_spc_1",
      senderId: "pho_usr_a",
      parentMessageId: "pho_msg_1",
      content: { type: "text", format: "plain", text: "hi" },
    });
  });

  test("typing posts to the space", async () => {
    calls.length = 0;
    await client.setTyping("pho_spc_1", "pho_usr_a", true);
    expect(calls[0]!.url).toContain("/spaces/pho_spc_1/typing");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ senderId: "pho_usr_a", typing: true });
  });

  test("errors become PhotonApiError with status, code and request id", async () => {
    await expect(client.listResources()).rejects.toBeInstanceOf(PhotonApiError);
    try {
      await client.listResources();
    } catch (e) {
      const err = e as PhotonApiError;
      expect(err.status).toBe(403);
      expect(err.code).toBe("FORBIDDEN");
      expect(err.requestId).toBe("req_1");
    }
  });
});

describe("Photon2Transport.send", () => {
  test("falls back to a flat send when the space refuses threaded replies, and remembers it", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fakeFetch: FetchLike = async (_input, init) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      bodies.push(body);
      if (body.parentMessageId) {
        return new Response(
          JSON.stringify({
            code: "SPACE_NOT_SENDABLE",
            status: 409,
            detail: "Replies are not supported for this Space",
          }),
          { status: 409 },
        );
      }
      return new Response(JSON.stringify({ id: `sent_${bodies.length}`, status: "accepted" }), {
        status: 202,
      });
    };
    const client = new PhotonClient({ projectId: "p", apiKey: "k", fetch: fakeFetch });
    const t = new Photon2Transport({ client, logger: createLogger("t", "error") });
    const r1 = await t.send(
      { spaceId: "s1", senderId: "a", text: "hi", parentMessageId: "m1" },
      "reply:m1:0",
    );
    expect(r1.id).toBe("sent_2");
    expect(bodies.map((b) => b.parentMessageId)).toEqual(["m1", undefined]);
    expect(t.noThreads.has("s1")).toBe(true);
    // next send to the same space goes flat straight away
    await t.send({ spaceId: "s1", senderId: "a", text: "again", parentMessageId: "m2" }, "reply:m2:0");
    expect(bodies.length).toBe(3);
    expect(bodies[2]!.parentMessageId).toBeUndefined();
  });
});

describe("Transport.openSpace: texting someone who never wrote in", () => {
  test("ScriptTransport records the opened space; a reply pushed into it arrives on the dedicated line", async () => {
    const { ScriptTransport } = await import("@elves/photon");
    const t = new ScriptTransport();
    const opened = await t.openSpace("+16175550142", "script");
    expect(opened).toEqual({
      spaceId: t.spaceFor("+16175550142"),
      senderId: t.dedicatedId,
      senderHandle: t.dedicatedHandle,
    });
    expect(t.opened.get(opened.spaceId)).toEqual({
      handle: "+16175550142",
      platform: "script",
      senderId: t.dedicatedId,
    });
    const reply = t.push("+16175550142", "yes it's available");
    expect(reply.spaceId).toBe(opened.spaceId);
    expect(reply.agentId).toBe(t.dedicatedId);
    expect(reply.agentHandle).toBe(t.dedicatedHandle);
    // the owner's own space is untouched
    expect(t.push("+14255269066", "hi").agentId).toBe(t.agentId);
  });

  function photonFake(opts: { agents: Record<string, unknown>[] }) {
    const calls: { method: string; path: string; body?: Record<string, unknown>; key?: string }[] = [];
    const fakeFetch: FetchLike = async (input, init) => {
      const u = new URL(String(input));
      const method = init?.method ?? "GET";
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
      calls.push({ method, path: u.pathname + u.search, body, key: headers["idempotency-key"] });
      if (u.pathname.endsWith("/users") && method === "GET")
        return new Response(JSON.stringify({ items: opts.agents }), { status: 200 });
      if (u.pathname.endsWith("/users") && method === "POST")
        return new Response(
          JSON.stringify({
            id: "pho_usr_lister",
            handle: body?.handle,
            kind: "human",
            platform: body?.platform,
          }),
          { status: 200 },
        );
      if (u.pathname.endsWith("/spaces") && method === "POST")
        return new Response(
          JSON.stringify({
            id: "pho_spc_new",
            kind: "direct",
            participantIds: body?.participantIds,
            platform: "imessage",
          }),
          { status: 201 },
        );
      if (u.pathname.endsWith("/platforms/resources"))
        return new Response(
          JSON.stringify({
            resources: [
              {
                resourceId: "res_ded",
                type: "imessage_dedicated",
                state: "active",
                abilities: [],
                detail: {},
              },
            ],
          }),
          { status: 200 },
        );
      return new Response(JSON.stringify({ code: "NOT_FOUND" }), { status: 404 });
    };
    return { calls, client: new PhotonClient({ projectId: "p", apiKey: "k", fetch: fakeFetch }) };
  }
  const shared = {
    id: "pho_usr_pool",
    handle: "+16289979661",
    kind: "agent",
    platform: "imessage",
    details: { type: "shared" },
  };
  const dedicated = {
    id: "pho_usr_line",
    handle: "+16285550100",
    kind: "agent",
    platform: "imessage",
    details: { type: "dedicated", resourceId: "res_ded" },
  };

  test("Photon2Transport discovers the dedicated agent once, creates the user and the space, and sends as the line", async () => {
    const { calls, client } = photonFake({ agents: [shared, dedicated] });
    const t = new Photon2Transport({ client, logger: createLogger("t", "error") });
    const opened = await t.openSpace("+16175550142", "imessage");
    expect(opened).toEqual({
      spaceId: "pho_spc_new",
      senderId: "pho_usr_line",
      senderHandle: "+16285550100",
    });
    expect(calls.map((c) => `${c.method} ${c.path.split("?")[0]}`)).toEqual([
      "GET /v1/projects/p/users",
      "POST /v1/projects/p/users",
      "POST /v1/projects/p/spaces",
    ]);
    expect(calls[1]!.body).toEqual({ handle: "+16175550142", platform: "imessage" });
    expect(calls[2]!.body).toEqual({
      participantIds: ["pho_usr_line", "pho_usr_lister"],
      platform: "imessage",
    });
    expect(calls[2]!.key).toBe("space:pho_usr_line:pho_usr_lister");
    // the second space reuses the resolved line: no second discovery call
    await t.openSpace("+16175550199", "imessage");
    expect(calls.filter((c) => c.method === "GET").length).toBe(1);
  });

  test("a configured PHOTON_DEDICATED_AGENT_ID wins over discovery and still learns the line's handle", async () => {
    const { calls, client } = photonFake({ agents: [shared, dedicated] });
    const t = new Photon2Transport({
      client,
      dedicatedAgentId: "pho_usr_line",
      logger: createLogger("t", "error"),
    });
    const opened = await t.openSpace("+16175550142", "imessage");
    expect(opened.senderId).toBe("pho_usr_line");
    expect(opened.senderHandle).toBe("+16285550100");
    expect(calls[2]!.body).toEqual({
      participantIds: ["pho_usr_line", "pho_usr_lister"],
      platform: "imessage",
    });
  });

  test("with only the shared pool, openSpace rejects and says why", async () => {
    const { calls, client } = photonFake({ agents: [shared] });
    const t = new Photon2Transport({ client, logger: createLogger("t", "error") });
    await expect(t.openSpace("+16175550142", "imessage")).rejects.toThrow(/no dedicated Photon line/);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});

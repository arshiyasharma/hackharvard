import { describe, expect, test } from "bun:test";
import { type FetchLike, normalizePhotonMessage, Photon2Transport, PhotonApiError, PhotonClient, type PhotonMessage } from "@elves/photon";
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
        return new Response(JSON.stringify({ code: "SPACE_NOT_SENDABLE", status: 409, detail: "Replies are not supported for this Space" }), { status: 409 });
      }
      return new Response(JSON.stringify({ id: `sent_${bodies.length}`, status: "accepted" }), { status: 202 });
    };
    const client = new PhotonClient({ projectId: "p", apiKey: "k", fetch: fakeFetch });
    const t = new Photon2Transport({ client, logger: createLogger("t", "error") });
    const r1 = await t.send({ spaceId: "s1", senderId: "a", text: "hi", parentMessageId: "m1" }, "reply:m1:0");
    expect(r1.id).toBe("sent_2");
    expect(bodies.map((b) => b.parentMessageId)).toEqual(["m1", undefined]);
    expect(t.noThreads.has("s1")).toBe(true);
    // next send to the same space goes flat straight away
    await t.send({ spaceId: "s1", senderId: "a", text: "again", parentMessageId: "m2" }, "reply:m2:0");
    expect(bodies.length).toBe(3);
    expect(bodies[2]!.parentMessageId).toBeUndefined();
  });
});

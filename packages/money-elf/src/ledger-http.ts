/**
 * HTTP routes for the live Ledger, as a plain fetch handler so any server can mount it
 * (the foundation's Hono app: `app.get("/ledger/*", (c) => ledger(c.req.raw))`; locally: Bun.serve).
 *
 *   GET /ledger/<moveId>?t=<token>       the page
 *   GET /ledger/<moveId>.png?t=<token>   the tall card image (sent in the Photon 2.0 thread)
 *   GET /ledger/<moveId>.preview.png?t=<token>  the 3:2 preview: the page's og:image, shown in the mini app
 *                                          card's bubble
 *   GET /ledger/<moveId>.json?t=<token>  the view model
 *   POST /ledger/<moveId>/decide?t=<token>  {pendingId, choice: "approve"|"decline"}: the owner's tap on a
 *                                          pending money move in the dashboard (decision #62)
 *
 * The page names who owes what, so links are signed: t = HMAC-SHA256(secret, moveId), truncated.
 *
 * Links never expire: the token is a function of the secret and the move only, with no timestamp, so the demo-day
 * link works as long as LEDGER_LINK_SECRET is unchanged. Rotating the secret is the only way to revoke them.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { renderLedgerPng, renderLedgerPreviewPng } from "./ledger-card.ts";
import { ledgerPageHtml } from "./ledger-page.ts";
import { buildLedgerView } from "./ledger-view.ts";
import type { MoneyService, OpResult } from "./service.ts";

export interface LedgerLinks {
  /** Public HTTPS origin of the service, e.g. https://elves-production.up.railway.app */
  publicUrl: string;
  /** Secret for signing links (LEDGER_LINK_SECRET). */
  secret: string;
}

export function ledgerToken(secret: string, moveId: string): string {
  return createHmac("sha256", secret).update(`ledger:${moveId}`).digest("base64url").slice(0, 22);
}

export function ledgerUrl(
  links: LedgerLinks,
  moveId: string,
  ext: "" | ".png" | ".preview.png" | ".json" | "/decide" = "",
): string {
  const base = links.publicUrl.replace(/\/$/, "");
  return `${base}/ledger/${encodeURIComponent(moveId)}${ext}?t=${ledgerToken(links.secret, moveId)}`;
}

function validToken(secret: string, moveId: string, t: string | null): boolean {
  if (!t) return false;
  const want = Buffer.from(ledgerToken(secret, moveId));
  const got = Buffer.from(t);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Returns a Response for /ledger/... paths, or null so the caller can try its other routes. */
/** A dashboard tap: approve or decline one pending action by id. Returns null for anything malformed. */
export function parseDecision(body: unknown): { pendingId: string; choice: "approve" | "decline" } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.pendingId !== "string" || !/^[A-Za-z0-9_]{1,64}$/.test(b.pendingId)) return null;
  if (b.choice !== "approve" && b.choice !== "decline") return null;
  return { pendingId: b.pendingId, choice: b.choice };
}

export function createLedgerHandler(deps: {
  service: MoneyService;
  links: LedgerLinks;
  /**
   * After a dashboard approval or decline: the crew service sends the texts it produced (requests to
   * roommates), confirms to the owner in their chat, records the events and refreshes the card. Without it the
   * decision still applies, but its texts aren't sent (tests, local chat).
   */
  onDecided?: (moveId: string, result: OpResult) => Promise<void>;
}) {
  return async (req: Request): Promise<Response | null> => {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/ledger\/([A-Za-z0-9_-]+?)(\.preview\.png|\.png|\.json|\/decide)?$/);
    if (!m?.[1]) return null;
    const isDecide = m[2] === "/decide";
    if (req.method !== (isDecide ? "POST" : "GET"))
      return new Response("method not allowed", { status: 405 });
    const moveId = m[1];
    if (!validToken(deps.links.secret, moveId, url.searchParams.get("t")))
      return new Response("not found", { status: 404 });
    const move = await deps.service.moveFromStore(moveId);
    if (!move) return new Response("not found", { status: 404 });
    const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
    if (isDecide) {
      const raw = await req.text();
      if (raw.length > 500)
        return Response.json({ ok: false, message: "Too large." }, { status: 413, headers });
      let body: unknown = null;
      try {
        body = JSON.parse(raw);
      } catch {
        // falls through to the validation error
      }
      const d = parseDecision(body);
      if (!d)
        return Response.json({ ok: false, message: "That didn't make sense." }, { status: 400, headers });
      // The same approve/decline a typed "yes"/"no" or a poll tap runs: one action, named by its id.
      const result =
        d.choice === "approve"
          ? await deps.service.approve(move, d.pendingId)
          : await deps.service.decline(move, d.pendingId);
      const ok = result.events.some((e) => e.type === "approval.granted" || e.type === "approval.cancelled");
      if (ok) {
        result.events.push({
          type: "dashboard.decided",
          payload: { pendingId: d.pendingId, choice: d.choice },
        });
        if (deps.onDecided) await deps.onDecided(moveId, result).catch(() => {});
      }
      return Response.json(
        { ok, message: result.lines.join(" "), view: await buildLedgerView(deps.service, move) },
        { headers },
      );
    }
    const view = await buildLedgerView(deps.service, move);
    if (m[2] === ".json") return Response.json(view, { headers });
    if (m[2] === ".png" || m[2] === ".preview.png")
      return new Response(await (m[2] === ".png" ? renderLedgerPng(view) : renderLedgerPreviewPng(view)), {
        headers: { ...headers, "Content-Type": "image/png" },
      });
    return new Response(
      ledgerPageHtml(view, {
        imageUrl: ledgerUrl(deps.links, moveId, ".preview.png"),
        pageUrl: ledgerUrl(deps.links, moveId),
        decideUrl: ledgerUrl(deps.links, moveId, "/decide"),
      }),
      { headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } },
    );
  };
}

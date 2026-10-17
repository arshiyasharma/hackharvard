/**
 * HTTP routes for the live Ledger, as a plain fetch handler so any server can mount it
 * (the foundation's Hono app: `app.get("/ledger/*", (c) => ledger(c.req.raw))`; locally: Bun.serve).
 *
 *   GET /ledger/<moveId>?t=<token>       the page
 *   GET /ledger/<moveId>.png?t=<token>   the card image (also the page's og:image)
 *   GET /ledger/<moveId>.json?t=<token>  the view model
 *
 * The page names who owes what, so links are signed: t = HMAC-SHA256(secret, moveId), truncated.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { renderLedgerPng } from "./ledger-card.ts";
import { ledgerPageHtml } from "./ledger-page.ts";
import { buildLedgerView } from "./ledger-view.ts";
import type { MoneyService } from "./service.ts";

export interface LedgerLinks {
  /** Public HTTPS origin of the service, e.g. https://elves-production.up.railway.app */
  publicUrl: string;
  /** Secret for signing links (LEDGER_LINK_SECRET). */
  secret: string;
}

export function ledgerToken(secret: string, moveId: string): string {
  return createHmac("sha256", secret).update(`ledger:${moveId}`).digest("base64url").slice(0, 22);
}

export function ledgerUrl(links: LedgerLinks, moveId: string, ext: "" | ".png" | ".json" = ""): string {
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
export function createLedgerHandler(deps: { service: MoneyService; links: LedgerLinks }) {
  return async (req: Request): Promise<Response | null> => {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/ledger\/([A-Za-z0-9_-]+?)(\.png|\.json)?$/);
    if (!m?.[1]) return null;
    if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
    const moveId = m[1];
    if (!validToken(deps.links.secret, moveId, url.searchParams.get("t")))
      return new Response("not found", { status: 404 });
    const move = await deps.service.moveFromStore(moveId);
    if (!move) return new Response("not found", { status: 404 });
    const view = await buildLedgerView(deps.service, move);
    const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
    if (m[2] === ".json") return Response.json(view, { headers });
    if (m[2] === ".png")
      return new Response(await renderLedgerPng(view), {
        headers: { ...headers, "Content-Type": "image/png" },
      });
    return new Response(
      ledgerPageHtml(view, {
        imageUrl: ledgerUrl(deps.links, moveId, ".png"),
        pageUrl: ledgerUrl(deps.links, moveId),
      }),
      { headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } },
    );
  };
}

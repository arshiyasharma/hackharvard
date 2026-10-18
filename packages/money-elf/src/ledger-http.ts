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
 *   POST /ledger/<moveId>/plan?t=<token>    {action: "choose", label: "A"|"B"|"C"} | {action: "budget", cents} |
 *                                          {action: "drop"}: pick, switch or redo the Smart Plan from the dashboard
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
import type { PlanService } from "./plan-service.ts";
import type { MoneyService, OpResult } from "./service.ts";
import type { MoneyItem } from "./types.ts";

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
  ext: "" | ".png" | ".preview.png" | ".json" | "/decide" | "/plan" = "",
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

/** A dashboard Smart Plan tap, or null when malformed. */
export function parsePlanAction(
  body: unknown,
): { action: "choose"; label: "A" | "B" | "C" } | { action: "budget"; cents: number } | { action: "drop" } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.action === "drop") return { action: "drop" };
  if (b.action === "choose" && (b.label === "A" || b.label === "B" || b.label === "C"))
    return { action: "choose", label: b.label };
  if (b.action === "budget" && typeof b.cents === "number" && Number.isInteger(b.cents) && b.cents >= 1000 && b.cents <= 100_000_00)
    return { action: "budget", cents: b.cents };
  return null;
}

export function createLedgerHandler(deps: {
  service: MoneyService;
  links: LedgerLinks;
  /** The Smart Plan, and where the move's items and move-out come from (the crew store), for plan taps and for
   * drafting the plans to choose from the first time the page is opened with something on the Ledger. */
  plans?: PlanService;
  planContext?: (moveId: string) => Promise<{ items: MoneyItem[] | null; moveOutAt: string | null }>;
  /**
   * After a dashboard approval or decline: the crew service sends the texts it produced (requests to
   * roommates), confirms to the owner in their chat, records the events and refreshes the card. Without it the
   * decision still applies, but its texts aren't sent (tests, local chat).
   */
  onDecided?: (moveId: string, result: OpResult) => Promise<void>;
}) {
  return async (req: Request): Promise<Response | null> => {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/ledger\/([A-Za-z0-9_-]+?)(\.preview\.png|\.png|\.json|\/decide|\/plan)?$/);
    if (!m?.[1]) return null;
    const isDecide = m[2] === "/decide";
    const isPlan = m[2] === "/plan";
    if (req.method !== (isDecide || isPlan ? "POST" : "GET"))
      return new Response("method not allowed", { status: 405 });
    const moveId = m[1];
    if (!validToken(deps.links.secret, moveId, url.searchParams.get("t")))
      return new Response("not found", { status: 404 });
    const move = await deps.service.moveFromStore(moveId);
    if (!move) return new Response("not found", { status: 404 });
    const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
    const ctx = deps.planContext ? await deps.planContext(moveId).catch(() => null) : null;
    const planMove = { ...move, moveOutAt: ctx?.moveOutAt ?? null };
    if (isPlan) {
      if (!deps.plans) return Response.json({ ok: false, message: "Plans aren't set up here." }, { status: 404, headers });
      const raw = await req.text();
      let body: unknown = null;
      try {
        body = JSON.parse(raw.length > 500 ? "" : raw);
      } catch {
        // falls through to the validation error
      }
      const a = parsePlanAction(body);
      if (!a) return Response.json({ ok: false, message: "That didn't make sense." }, { status: 400, headers });
      const items = ctx?.items ?? null;
      const result =
        a.action === "choose"
          ? await deps.plans.choose(planMove, items, a.label)
          : a.action === "budget"
            ? await deps.plans.draft(planMove, items, a.cents)
            : await deps.plans.cancel(planMove);
      const ok = result.events.some((e) => /^plan\.(chosen|switched|drafted|cancelled)$/.test(e.type));
      if (ok && deps.onDecided) {
        result.events.push({ type: "dashboard.decided", payload: { pendingId: `plan_${a.action}`, choice: a.action } });
        await deps.onDecided(moveId, result).catch(() => {});
      }
      return Response.json(
        { ok, message: result.lines.join(" "), view: await buildLedgerView(deps.service, move) },
        { headers },
      );
    }
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
    // The first time the page is opened with something on the Ledger and no plans yet, draft the options to choose from.
    if (deps.plans && ctx && !m[2] && !(await deps.service.store.getPlans(moveId)))
      await deps.plans.offer(planMove, ctx.items).catch(() => null);
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
        planUrl: deps.plans ? ledgerUrl(deps.links, moveId, "/plan") : undefined,
      }),
      { headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } },
    );
  };
}

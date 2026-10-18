import { type Db, pingDb } from "@elves/db";
import { moveReport } from "@elves/elves";
import type { MoveMemory } from "@elves/memory";
import { ELF_LABELS, type Store } from "@elves/shared";
import { Hono } from "hono";
import type { Service } from "./service.ts";

export function createServer(deps: {
  store: Store;
  service: Service;
  memory?: MoveMemory | null;
  db?: Db | null;
  /** Retell delivery handler; the route is off (404) when unset. Gets the raw body, which the signature covers. */
  retell?: (
    rawBody: string,
    signature: string | null,
  ) => Promise<{ status: number; body: Record<string, unknown> }>;
  info: Record<string, unknown>;
}) {
  const app = new Hono();
  const started = Date.now();

  app.get("/", (c) =>
    c.text("Elves: a moving crew you text. /health, /moves, /board/:moveId, /events/:moveId, /b/:moveId"),
  );
  app.get("/health", async (c) => {
    const db = deps.db ? await pingDb(deps.db, 2000) : null;
    return c.json({
      ok: db ? db.ok : true,
      uptimeS: Math.round((Date.now() - started) / 1000),
      ...deps.info,
      db,
      stats: deps.service.stats(),
    });
  });
  app.post("/webhooks/retell", async (c) => {
    if (!deps.retell) return c.json({ error: "voice is not configured" }, 404);
    const raw = await c.req.text();
    const res = await deps.retell(raw, c.req.header("x-retell-signature") ?? null);
    return c.json(res.body, res.status as 200);
  });
  app.get("/moves", async (c) => c.json(await deps.store.listMoves()));
  app.get("/board/:moveId", async (c) => {
    const move = await deps.store.getMove(c.req.param("moveId"));
    if (!move) return c.json({ error: "not found" }, 404);
    return c.json({
      move,
      board: await deps.store.getBoard(move.id),
      items: await deps.store.listItems(move.id),
      search: (await deps.store.getSearch(move.id)) ?? null,
      listings: await deps.store.listListings(move.id),
      // Never the owner's line or who is talking: the board link gets shared with roommates.
      deals: (await deps.store.listDeals(move.id)).map((d) => ({
        id: d.id,
        mode: d.mode,
        title: d.title,
        code: d.code,
        state: d.state,
        askCents: d.askCents,
        agreedCents: d.agreedCents,
        slot: d.slot?.label ?? null,
        outcome: d.outcome,
      })),
    });
  });
  app.get("/events/:moveId", async (c) => c.json(await deps.store.listEvents(c.req.param("moveId"))));
  /** What the crew remembers about a move: threads (with summaries), facts and Elf notes. */
  app.get("/memory/:moveId", async (c) => {
    if (!deps.memory) return c.json({ error: "memory is off" }, 404);
    const moveId = c.req.param("moveId");
    const [threads, facts, notes] = await Promise.all([
      deps.memory.threads(moveId),
      deps.memory.listFacts(moveId),
      deps.memory.notes(moveId),
    ]);
    return c.json({ kind: deps.memory.kind, threads, facts, notes });
  });
  /** The Move Report, rebuilt from items and deals on every request. */
  app.get("/report/:moveId", async (c) => {
    const move = await deps.store.getMove(c.req.param("moveId"));
    if (!move) return c.json({ error: "not found" }, 404);
    return c.json(moveReport(await deps.store.listItems(move.id), await deps.store.listDeals(move.id)));
  });
  app.get("/b/:moveId", async (c) => {
    const move = await deps.store.getMove(c.req.param("moveId"));
    if (!move) return c.text("Not found", 404);
    return c.html(boardPage(move.id));
  });
  return app;
}

function boardPage(moveId: string) {
  const labels = JSON.stringify(ELF_LABELS);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Crew Board</title>
<style>
:root{--bg:#0f1115;--card:#171a21;--fg:#e8e8ea;--muted:#9aa0ab;--ok:#3ddc84;--work:#ffb347;--wait:#7aa2ff;--blk:#ff6b6b}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.4 -apple-system,system-ui,sans-serif;padding:16px}
h1{font-size:20px;margin:0 0 4px}.sub{color:var(--muted);margin-bottom:14px;font-size:13px}
.row{background:var(--card);border-radius:12px;padding:12px 14px;margin-bottom:10px;display:flex;gap:12px;align-items:flex-start}
.dot{width:10px;height:10px;border-radius:50%;margin-top:6px;flex:none;background:var(--muted)}
.dot.working{background:var(--work)}.dot.waiting{background:var(--wait)}.dot.done{background:var(--ok)}.dot.blocked{background:var(--blk)}
.name{font-weight:600}.task{color:var(--fg)}.last{color:var(--muted);font-size:13px}
.items{margin-top:16px;color:var(--muted);font-size:13px}
</style></head><body>
<h1>Crew Board</h1><div class="sub" id="sub">Loading…</div>
<div id="rows"></div><div class="items" id="deals"></div><div class="items" id="items"></div>
<script>
const L=${labels};const id=${JSON.stringify(moveId)};
async function tick(){try{const r=await fetch('/board/'+id);if(!r.ok)return;const d=await r.json();
document.getElementById('sub').textContent=(d.move.moveOutAt?'Move-out '+d.move.moveOutAt:'Move-out date not set')+' · '+d.board.filter(b=>b.status==='working').length+' Elves working';
document.getElementById('rows').innerHTML=d.board.map(b=>'<div class="row"><div class="dot '+b.status+'"></div><div><div class="name">'+L[b.elf]+' <span class="last">· '+b.status+'</span></div><div class="task">'+(b.currentTask||'')+'</div>'+(b.lastUpdate?'<div class="last">'+b.lastUpdate+'</div>':'')+'</div></div>').join('');
const $=x=>x==null?'':(x===0?'free':'$'+(x/100).toFixed(x%100?2:0));
document.getElementById('deals').textContent=(d.deals||[]).length?('Deals: '+d.deals.map(x=>x.title+' · '+x.state.replace('_',' ')+(x.slot?' '+x.slot:'')+(x.agreedCents!=null?' · '+$(x.agreedCents):(x.askCents!=null?' · asking '+$(x.askCents):''))).join(' | ')):'';
document.getElementById('items').textContent=d.items.length?('Items: '+d.items.map(i=>i.name+' ('+i.outcome+', ~'+i.weightLb+' lb)').join(', ')):'';
}catch(e){}}
tick();setInterval(tick,3000);
</script></body></html>`;
}

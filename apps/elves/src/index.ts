import { allElves, type Elf } from "@elves/elves";
import { createListings } from "@elves/listings";
import { createLLM } from "@elves/llm";
import {
  createLedgerHandler,
  LEDGER_CHANGING_EVENTS,
  moneyElfFromEnv,
  SpectrumMiniApps,
} from "@elves/money-elf";
import { Photon2Transport, PhotonClient, ScriptTransport, type Transport } from "@elves/photon";
import { createLogger } from "@elves/shared";
import { handleRetellWebhook } from "@elves/voice";
import { openMemory, openStore } from "./boot.ts";
import { loadConfig } from "./config.ts";
import { createServer } from "./server.ts";
import { createService } from "./service.ts";

const log = createLogger("elves");
const config = loadConfig();
const opened = await openStore(config, createLogger("db"));
const store = opened.store;
const llm = createLLM();
const memory = openMemory(opened, { llm, logger: createLogger("memory") });
const listings = createListings(process.env, createLogger("listings"));

let transport: Transport;
if (config.transport === "script") {
  transport = new ScriptTransport();
} else {
  const client = new PhotonClient({
    projectId: config.photon.projectId,
    apiKey: config.photon.apiKey,
    baseUrl: config.photon.origin,
  });
  transport = new Photon2Transport({
    client,
    inbound: config.photon.inbound,
    pollMs: config.photon.pollMs,
    since: config.photon.since,
    dedicatedAgentId: config.photon.dedicatedAgentId,
    cursor: { get: (n) => store.getCursor(n), set: (n, v) => store.setCursor(n, v) },
    logger: createLogger("photon2"),
  });
}

// The Money Elf replaces the canned "money" stub: Nessie ledger, splits, loans, escrow, the Ledger card.
const money = moneyElfFromEnv(process.env);
const moneyElf: Elf = { ...money, handle: (ctx) => money.handle(ctx) };
const elves = allElves.map((e) => (e.name === "money" ? moneyElf : e));
const ledgerSecret = process.env.LEDGER_LINK_SECRET?.trim();
// The Moving Ledger dashboard as an iMessage mini app card, sent from the Spectrum (Photon 1.0) project when configured.
const miniApps = await SpectrumMiniApps.fromEnv(process.env, createLogger("spectrum")).catch((err) => {
  log.warn("spectrum unavailable; no mini app cards", { error: String(err).slice(0, 200) });
  return null;
});
const ledger =
  config.publicUrl && ledgerSecret
    ? createLedgerHandler({
        service: money.service,
        links: { publicUrl: config.publicUrl, secret: ledgerSecret },
        // A tap on Approve / Not now in the dashboard: deliver what it produced, confirm in the owner's chat,
        // and refresh the card. Runs at request time, after `service` below exists.
        onDecided: async (moveId, result) => {
          for (const ev of result.events)
            await store.appendEvent({
              moveId,
              type: ev.type,
              payload: { ...ev.payload, elf: "money" },
              traceId: null,
            });
          const decided = result.events.find((e) => e.type === "dashboard.decided");
          const key = `dashboard:${String(decided?.payload.pendingId ?? Date.now())}`;
          const people = await store.listParticipants(moveId);
          const notes = [];
          const missed: string[] = [];
          for (const o of result.outbound) {
            const spaceId = people.find((p) => p.handle === o.toHandle)?.spaceId;
            if (spaceId) notes.push({ spaceId, text: o.text, ...(o.poll ? { poll: o.poll } : {}) });
            else missed.push(o.toName ?? o.toHandle);
          }
          if (notes.length) await service.deliverOutbound(moveId, "money", notes, key);
          const tail = missed.length
            ? ` I can't text ${missed.join(" or ")} until they've texted Elves once.`
            : "";
          await service.notifyOwner(
            moveId,
            "money",
            `From your dashboard: ${result.lines.join(" ")}${tail}`,
            key,
          );
          const move = await money.service.moveFromStore(moveId);
          if (move) await miniApps?.refresh(move.ownerHandle);
        },
      })
    : undefined;

const service = createService({
  store,
  transport,
  miniApps,
  refreshCardOn: LEDGER_CHANGING_EVENTS,
  elves,
  llm,
  memory,
  listings,
  debounceMs: config.debounceMs,
  publicUrl: config.publicUrl,
  logger: log,
});
const retellKey = process.env.RETELL_API_KEY?.trim() || null;
const app = createServer({
  store,
  service,
  ledger,
  retell: retellKey
    ? (raw, signature) =>
        handleRetellWebhook(
          {
            store,
            llm,
            memory,
            apiKey: retellKey,
            logger: createLogger("voice"),
            sendRecap: (moveId, text, callId) => service.notifyOwner(moveId, "crew_lead", text, callId),
          },
          raw,
          signature,
        )
    : undefined,
  memory,
  db: opened.db,
  info: {
    transport: transport.name,
    inbound: config.transport === "photon2" ? config.photon.inbound : "n/a",
    llm: llm.name,
    store: opened.storeKind,
    memory: memory?.kind ?? "off",
    listings: listings.name,
    database: opened.dbTarget,
    degraded: opened.degraded,
    publicUrl: config.publicUrl,
  },
});

const server = Bun.serve({ port: config.port, fetch: app.fetch });
log.info("http listening", {
  port: server.port,
  publicUrl: config.publicUrl,
  transport: transport.name,
  llm: llm.name,
  store: opened.storeKind,
  memory: memory?.kind ?? "off",
});

const ctrl = new AbortController();
let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    log.info("shutting down", { signal: sig });
    ctrl.abort();
    const done = (async () => {
      // Let background consolidation land, then close the pool.
      await Promise.race([memory?.flush() ?? Promise.resolve(), new Promise((r) => setTimeout(r, 2500))]);
      await opened.db?.end().catch(() => {});
    })();
    done.finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 4000);
  });
}
service.run(ctrl.signal).catch((err) => {
  log.error("inbound loop crashed", { error: String(err) });
  process.exit(1);
});

import { createListings } from "@elves/listings";
import { createLLM } from "@elves/llm";
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
    cursor: { get: (n) => store.getCursor(n), set: (n, v) => store.setCursor(n, v) },
    logger: createLogger("photon2"),
  });
}

const service = createService({
  store,
  transport,
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
  retell: retellKey
    ? (raw, signature) =>
        handleRetellWebhook(
          {
            store,
            llm,
            memory,
            apiKey: retellKey,
            logger: createLogger("voice"),
            sendRecap: async (moveId, text, callId) => {
              await service.notifyOwner(moveId, "crew_lead", text, callId);
            },
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

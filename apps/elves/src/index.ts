import { createLLM } from "@elves/llm";
import { Photon2Transport, PhotonClient, ScriptTransport, type Transport } from "@elves/photon";
import { createLogger, MemoryStore } from "@elves/shared";
import { loadConfig } from "./config.ts";
import { createServer } from "./server.ts";
import { createService } from "./service.ts";

const log = createLogger("elves");
const config = loadConfig();
const store = new MemoryStore();
const llm = createLLM();

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
  debounceMs: config.debounceMs,
  publicUrl: config.publicUrl,
  logger: log,
});
const app = createServer({
  store,
  service,
  info: {
    transport: transport.name,
    inbound: config.transport === "photon2" ? config.photon.inbound : "n/a",
    llm: llm.name,
    store: "memory",
    publicUrl: config.publicUrl,
  },
});

const server = Bun.serve({ port: config.port, fetch: app.fetch });
log.info("http listening", {
  port: server.port,
  publicUrl: config.publicUrl,
  transport: transport.name,
  llm: llm.name,
});

const ctrl = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log.info("shutting down", { signal: sig });
    ctrl.abort();
    setTimeout(() => process.exit(0), 500);
  });
}
service.run(ctrl.signal).catch((err) => {
  log.error("inbound loop crashed", { error: String(err) });
  process.exit(1);
});

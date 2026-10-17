export interface Config {
  port: number;
  publicUrl: string | null;
  transport: "photon2" | "script";
  /** auto: Postgres when a database URL is set and reachable, else in-memory. postgres: fail fast without it. */
  store: "auto" | "postgres" | "memory";
  databaseUrl: string | null;
  dbPoolMax: number;
  debounceMs: number;
  photon: {
    projectId: string;
    apiKey: string;
    origin: string;
    inbound: "poll" | "socket";
    pollMs: number;
    /** Replay inbound messages created at/after this ISO time on boot (default: boot time). */
    since: string | undefined;
  };
  ownerPhone: string | null;
  buyerPhone: string | null;
}

function bool(v: string | undefined) {
  return v === "1" || v === "true" || v === "yes";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const publicRaw = env.PUBLIC_URL ?? env.HOST_PUBLIC_URL ?? "";
  const publicUrl = /^https:\/\//.test(publicRaw) ? publicRaw.replace(/\/$/, "") : null;
  const transport = (env.ELVES_TRANSPORT as Config["transport"]) || "photon2";
  if (transport === "photon2" && (!env.PHOTON_PROJECT_ID || !env.PHOTON_API_KEY)) {
    throw new Error(
      "PHOTON_PROJECT_ID and PHOTON_API_KEY are required for the photon2 transport (or set ELVES_TRANSPORT=script)",
    );
  }
  const storeRaw = env.ELVES_STORE ?? "auto";
  const store: Config["store"] =
    storeRaw === "postgres" || storeRaw === "pg" ? "postgres" : storeRaw === "memory" ? "memory" : "auto";
  const databaseUrl = env.ELVES_DATABASE_URL || env.DATABASE_URL || null;
  if (store === "postgres" && !databaseUrl) {
    throw new Error("ELVES_STORE=postgres needs ELVES_DATABASE_URL or DATABASE_URL");
  }
  return {
    port: Number(env.PORT ?? 8787),
    publicUrl,
    transport,
    store,
    databaseUrl,
    dbPoolMax: Number(env.ELVES_DB_POOL ?? 5),
    debounceMs: Number(env.ELVES_DEBOUNCE_MS ?? 1200),
    photon: {
      projectId: env.PHOTON_PROJECT_ID ?? "",
      apiKey: env.PHOTON_API_KEY ?? "",
      origin: env.PHOTON_API_ORIGIN ?? "https://api.photon.codes",
      inbound: env.PHOTON_INBOUND === "socket" ? "socket" : "poll",
      pollMs: Number(env.PHOTON_POLL_MS ?? 1500),
      since: env.PHOTON_SINCE || undefined,
    },
    ownerPhone: env.OWNER_PHONE || null,
    buyerPhone: env.BUYER_PHONE || null,
  };
}
export { bool };

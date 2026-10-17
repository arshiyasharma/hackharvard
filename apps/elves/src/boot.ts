import { createDb, type Db, describeDbUrl, migrate, PostgresStore, pingDb } from "@elves/db";
import type { LLM } from "@elves/llm";
import { MoveMemory } from "@elves/memory";
import { type Logger, MemoryStore, type Store } from "@elves/shared";
import type { Config } from "./config.ts";

export interface Opened {
  store: Store;
  storeKind: "postgres" | "memory";
  db: Db | null;
  /** host:port/db, for logs and /health; never credentials. */
  dbTarget: string | null;
  /** Why the service is not on Postgres, when it should have been. */
  degraded: string | null;
}

/**
 * Open the durable store. In `auto` mode an unreachable database degrades to in-memory with a loud log line
 * and a flag on /health, so the number keeps answering; `postgres` mode fails fast instead.
 */
export async function openStore(
  config: Config,
  log: Logger,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Opened> {
  if (config.store !== "memory" && config.databaseUrl) {
    const dbTarget = describeDbUrl(config.databaseUrl);
    const db = createDb({ url: config.databaseUrl, max: config.dbPoolMax });
    try {
      const ping = await pingDb(db, 8000);
      if (!ping.ok) throw new Error(ping.error ?? "ping failed");
      const skipMigrate = env.ELVES_DB_MIGRATE === "0" || env.ELVES_DB_MIGRATE === "false";
      if (!skipMigrate) {
        const res = await migrate(db, log);
        log.info("database ready", { target: dbTarget, applied: res.applied, latencyMs: ping.latencyMs });
      } else {
        log.info("database ready (migrations skipped)", { target: dbTarget, latencyMs: ping.latencyMs });
      }
      return { store: new PostgresStore(db), storeKind: "postgres", db, dbTarget, degraded: null };
    } catch (err) {
      await db.end().catch(() => {});
      if (config.store === "postgres")
        throw new Error(`postgres store unavailable (${dbTarget}): ${String(err)}`);
      const why = `postgres unreachable at ${dbTarget}: ${String(err).slice(0, 200)}`;
      log.error("falling back to the in-memory store; state will NOT survive a restart", { error: why });
      return { store: new MemoryStore(), storeKind: "memory", db: null, dbTarget, degraded: why };
    }
  }
  if (config.store === "postgres") throw new Error("ELVES_STORE=postgres but no database URL is set");
  return { store: new MemoryStore(), storeKind: "memory", db: null, dbTarget: null, degraded: null };
}

export function openMemory(
  opened: Opened,
  deps: { llm: LLM; logger: Logger },
  env: NodeJS.ProcessEnv = process.env,
): MoveMemory | null {
  return MoveMemory.fromEnv(env, { sql: opened.db, store: opened.store, llm: deps.llm, logger: deps.logger });
}

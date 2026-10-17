/**
 * @elves/db — one Postgres connection (Bun's native client), idempotent migrations, and the PostgresStore.
 *
 * Works with any Postgres and with Supabase through its IPv4 session pooler
 * (postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres).
 * There is no driver dependency: Bun.sql speaks the wire protocol itself.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createLogger, type Logger } from "@elves/shared";
import { SQL } from "bun";

export { PostgresStore } from "./store.ts";
export type Db = SQL;

export interface DbOptions {
  url: string;
  /** Pool size; the service needs few connections (default 5). */
  max?: number;
  connectionTimeoutS?: number;
  idleTimeoutS?: number;
  /** Named prepared statements break transaction-mode poolers; off by default. */
  prepare?: boolean;
}

export function createDb(opts: DbOptions): Db {
  return new SQL({
    url: opts.url,
    max: opts.max ?? 5,
    connectionTimeout: opts.connectionTimeoutS ?? 10,
    idleTimeout: opts.idleTimeoutS ?? 120,
    maxLifetime: 1800,
    prepare: opts.prepare ?? false,
  });
}

/** host:port/db of a connection string, never the credentials. */
export function describeDbUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return "(unparseable url)";
  }
}

export interface DbPing {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export async function pingDb(db: Db, timeoutMs = 3000): Promise<DbPing> {
  const t0 = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      db`select 1`,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`ping timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - t0, error: String(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface Migration {
  name: string;
  sql: string;
}

const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");
/** Session-level advisory lock so two replicas never migrate at once. */
const MIGRATE_LOCK = 72431_5001;

export async function listMigrations(dir = MIGRATIONS_DIR): Promise<Migration[]> {
  const names = (await readdir(dir)).filter((n) => /^\d{4}_[a-z0-9_]+\.sql$/.test(n)).sort();
  const out: Migration[] = [];
  for (const name of names)
    out.push({ name: name.replace(/\.sql$/, ""), sql: await Bun.file(join(dir, name)).text() });
  return out;
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

/**
 * Apply every migration file not yet recorded in schema_migrations, each in its own transaction, under an
 * advisory lock. Safe to run on every boot.
 */
export async function migrate(db: Db, log: Logger = createLogger("db")): Promise<MigrateResult> {
  const migrations = await listMigrations();
  const conn = await db.reserve();
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    await conn.unsafe(`select pg_advisory_lock(${MIGRATE_LOCK})`);
    await conn.unsafe(
      "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    const done = new Set(
      (await conn`select name from schema_migrations`).map((r: { name: string }) => r.name),
    );
    for (const m of migrations) {
      if (done.has(m.name)) {
        skipped.push(m.name);
        continue;
      }
      const t0 = Date.now();
      try {
        await conn.unsafe(
          `begin;\n${m.sql}\ninsert into schema_migrations (name) values ('${m.name}');\ncommit;`,
        );
      } catch (err) {
        await conn.unsafe("rollback").catch(() => {});
        throw new Error(`migration ${m.name} failed: ${String(err)}`);
      }
      applied.push(m.name);
      log.info("migration applied", { name: m.name, ms: Date.now() - t0 });
    }
  } finally {
    await conn.unsafe(`select pg_advisory_unlock(${MIGRATE_LOCK})`).catch(() => {});
    conn.release();
  }
  return { applied, skipped };
}

/** Names recorded in schema_migrations (empty when the table does not exist yet). */
export async function appliedMigrations(db: Db): Promise<string[]> {
  try {
    const rows = await db`select name from schema_migrations order by name`;
    return rows.map((r: { name: string }) => r.name);
  } catch {
    return [];
  }
}

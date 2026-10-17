/**
 * Database operator CLI.
 *   bun run db status            ping, applied + pending migrations, row counts
 *   bun run db migrate           apply pending migrations (the service also does this on boot)
 *   bun run db memory <moveId>   threads, facts and notes the crew remembers for a move
 *   bun run db facts <moveId> "<query>"   ranked recall for a query
 * Reads ELVES_DATABASE_URL, then DATABASE_URL.
 */
import {
  appliedMigrations,
  createDb,
  describeDbUrl,
  listMigrations,
  migrate,
  PostgresStore,
  pingDb,
} from "@elves/db";
import { FakeLLM } from "@elves/llm";
import { MoveMemory, PostgresBackend } from "@elves/memory";
import { createLogger } from "@elves/shared";

const url = process.env.ELVES_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error("set ELVES_DATABASE_URL or DATABASE_URL");
  process.exit(2);
}
const [cmd = "status", ...rest] = process.argv.slice(2);
const db = createDb({ url, max: 2 });
const log = createLogger("db", "info");

try {
  if (cmd === "status") {
    const ping = await pingDb(db, 10_000);
    console.log(`target   ${describeDbUrl(url)}`);
    console.log(`ping     ${ping.ok ? `ok ${ping.latencyMs}ms` : `FAILED ${ping.error}`}`);
    if (!ping.ok) process.exit(1);
    const applied = new Set(await appliedMigrations(db));
    for (const m of await listMigrations())
      console.log(`${applied.has(m.name) ? "applied " : "PENDING "} ${m.name}`);
    if (applied.size) {
      const counts = await db`
        select (select count(*) from moves) as moves, (select count(*) from items) as items,
               (select count(*) from events) as events, (select count(*) from memory_threads) as threads,
               (select count(*) from memory_messages) as messages, (select count(*) from memory_facts) as facts`;
      console.log("rows    ", JSON.stringify(counts[0]));
    }
  } else if (cmd === "migrate") {
    const res = await migrate(db, log);
    console.log(
      `applied: ${res.applied.join(", ") || "(nothing pending)"}; already there: ${res.skipped.join(", ") || "-"}`,
    );
  } else if (cmd === "memory" || cmd === "facts") {
    const moveId = rest[0];
    if (!moveId) throw new Error(`usage: bun run db ${cmd} <moveId>${cmd === "facts" ? ' "<query>"' : ""}`);
    const memory = new MoveMemory({
      backend: new PostgresBackend(db),
      store: new PostgresStore(db),
      llm: new FakeLLM(),
    });
    if (cmd === "facts") {
      const q = rest.slice(1).join(" ");
      for (const f of await memory.recall(moveId, q, 20))
        console.log(`${f.score.toFixed(2)}  [${f.kind}/${f.audience}] ${f.text}`);
    } else {
      const [threads, facts, notes] = await Promise.all([
        memory.threads(moveId),
        memory.listFacts(moveId),
        memory.notes(moveId),
      ]);
      console.log(JSON.stringify({ threads, facts, notes }, null, 2));
    }
  } else {
    throw new Error(`unknown command ${cmd}`);
  }
} finally {
  await db.end();
}

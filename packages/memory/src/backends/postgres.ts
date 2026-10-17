import { newId } from "@elves/shared";
import type { SQL } from "bun";
import {
  type Fact,
  type FactInput,
  type FactStatus,
  type MemoryBackend,
  type MessageRow,
  type NoteRow,
  queryTerms,
  type RankedFact,
  type ThreadRow,
} from "../types.ts";

type Row = Record<string, unknown>;
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const str = (v: unknown): string | null => (v == null ? null : String(v));
const json = (v: unknown): unknown => (typeof v === "string" ? JSON.parse(v) : v);

function threadRow(r: Row): ThreadRow {
  return {
    id: r.id as string,
    moveId: r.move_id as string,
    role: str(r.role),
    handle: str(r.handle),
    title: str(r.title),
    summary: str(r.summary),
    summaryThroughSeq: Number(r.summary_through_seq ?? 0),
    summaryMessageCount: Number(r.summary_message_count ?? 0),
    messageCount: Number(r.message_count ?? 0),
    metadata: (json(r.metadata) ?? {}) as Record<string, unknown>,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}
function messageRow(r: Row): MessageRow {
  return {
    id: r.id as string,
    seq: Number(r.seq),
    threadId: r.thread_id as string,
    moveId: r.move_id as string,
    role: r.role as MessageRow["role"],
    elf: str(r.elf),
    text: r.text as string,
    tokens: Number(r.tokens),
    metadata: (json(r.metadata) ?? {}) as Record<string, unknown>,
    createdAt: iso(r.created_at),
  };
}
function factRow(r: Row): Fact {
  return {
    id: r.id as string,
    moveId: r.move_id as string,
    threadId: str(r.thread_id),
    subject: r.subject as string,
    kind: r.kind as Fact["kind"],
    text: r.text as string,
    audience: r.audience as Fact["audience"],
    confidence: Number(r.confidence),
    elf: str(r.elf),
    sourceMessageId: str(r.source_message_id),
    status: r.status as Fact["status"],
    timesSeen: Number(r.times_seen),
    lastSeenAt: iso(r.last_seen_at),
    createdAt: iso(r.created_at),
  };
}

/** Memory on the service's Postgres (tables from @elves/db migration 0002_memory). */
export class PostgresBackend implements MemoryBackend {
  readonly kind = "postgres" as const;
  constructor(private readonly sql: SQL) {}

  async ensureThread(input: {
    id: string;
    moveId: string;
    role?: string | null;
    handle?: string | null;
    title?: string | null;
  }) {
    const rows = await this.sql`
      insert into memory_threads (id, move_id, role, handle, title)
      values (${input.id}, ${input.moveId}, ${input.role ?? null}, ${input.handle ?? null}, ${input.title ?? null})
      on conflict (id) do update set updated_at = memory_threads.updated_at
      returning *`;
    return threadRow(rows[0] as Row);
  }
  async getThread(id: string) {
    const rows = await this.sql`select * from memory_threads where id = ${id}`;
    return rows[0] ? threadRow(rows[0]) : null;
  }
  async listThreads(moveId: string) {
    return (await this.sql`select * from memory_threads where move_id = ${moveId} order by created_at`).map(
      threadRow,
    );
  }

  async appendMessage(msg: Omit<MessageRow, "seq">) {
    return this.sql.begin(async (tx) => {
      const rows = await tx`
        insert into memory_messages (id, thread_id, move_id, role, elf, text, tokens, metadata, created_at)
        values (${msg.id}, ${msg.threadId}, ${msg.moveId}, ${msg.role}, ${msg.elf}, ${msg.text}, ${msg.tokens},
          ${JSON.stringify(msg.metadata ?? {})}::jsonb, ${msg.createdAt}::timestamptz)
        on conflict (id) do nothing
        returning id`;
      if (rows.length === 0) return false;
      await tx`update memory_threads set message_count = message_count + 1, updated_at = now() where id = ${msg.threadId}`;
      return true;
    });
  }
  async recentMessages(threadId: string, limit: number) {
    const rows = await this.sql`
      select * from (select * from memory_messages where thread_id = ${threadId} order by seq desc limit ${limit}) t
      order by seq asc`;
    return rows.map(messageRow);
  }
  async messagesAfter(threadId: string, afterSeq: number, limit: number) {
    const rows = await this.sql`
      select * from memory_messages where thread_id = ${threadId} and seq > ${afterSeq} order by seq asc limit ${limit}`;
    return rows.map(messageRow);
  }
  async setSummary(threadId: string, summary: string, throughSeq: number, messageCount: number) {
    await this.sql`
      update memory_threads set summary = ${summary}, summary_through_seq = ${throughSeq},
        summary_message_count = ${messageCount}, updated_at = now()
      where id = ${threadId}`;
  }

  async upsertFact(input: FactInput & { dedupeKey: string }) {
    const rows = await this.sql`
      insert into memory_facts (id, move_id, thread_id, subject, kind, text, audience, confidence, elf, source_message_id, dedupe_key)
      values (${newId("fc")}, ${input.moveId}, ${input.threadId ?? null}, ${input.subject}, ${input.kind}, ${input.text},
        ${input.audience ?? "crew"}, ${input.confidence ?? 0.7}, ${input.elf ?? null}, ${input.sourceMessageId ?? null}, ${input.dedupeKey})
      on conflict (move_id, dedupe_key) do update set
        text = excluded.text, subject = excluded.subject, audience = excluded.audience,
        confidence = greatest(memory_facts.confidence, excluded.confidence),
        source_message_id = coalesce(excluded.source_message_id, memory_facts.source_message_id),
        status = 'active', times_seen = memory_facts.times_seen + 1, last_seen_at = now(), updated_at = now()
      returning *, (xmax = 0) as inserted`;
    const r = rows[0] as Row;
    return { fact: factRow(r), created: Boolean(r.inserted) };
  }
  async searchFacts(moveId: string, opts: { query: string; limit: number }) {
    // Relevance = share of the query's terms the fact matches (stemmed), as in the in-memory backend; then
    // confidence, recency, and a bump for the kinds that must not drop.
    const terms = queryTerms(opts.query)
      .map((t) => t.replace(/[^a-z0-9]/g, ""))
      .filter((t) => t.length > 1)
      .slice(0, 24);
    const rows = await this.sql`
      with q as (select ${JSON.stringify(terms)}::jsonb as terms),
      hits as (
        select f.id,
          (select count(*) from jsonb_array_elements_text(q.terms) t where f.search @@ plainto_tsquery('english', t)) as n
        from memory_facts f, q
        where f.move_id = ${moveId} and f.status = 'active'
      )
      select f.*,
        ((case when jsonb_array_length(q.terms) = 0 then 0 else h.n::float / jsonb_array_length(q.terms) end) * 2
         + f.confidence * 0.5
         + (1.0 / (1 + extract(epoch from (now() - f.last_seen_at)) / 86400.0)) * 0.5
         + case when f.kind in ('open_loop', 'commitment', 'constraint') then 0.3 else 0 end) as score
      from memory_facts f
      join hits h on h.id = f.id, q
      where f.move_id = ${moveId} and f.status = 'active'
      order by score desc, f.last_seen_at desc
      limit ${opts.limit}`;
    return rows.map((r: Row): RankedFact => ({ ...factRow(r), score: Number(r.score) }));
  }
  async listFacts(moveId: string, status?: FactStatus) {
    const rows = status
      ? await this
          .sql`select * from memory_facts where move_id = ${moveId} and status = ${status} order by created_at`
      : await this.sql`select * from memory_facts where move_id = ${moveId} order by created_at`;
    return rows.map(factRow);
  }
  async setFactStatus(id: string, status: FactStatus) {
    await this.sql`update memory_facts set status = ${status}, updated_at = now() where id = ${id}`;
  }

  async getNote(moveId: string, elf: string, key: string) {
    const rows = await this
      .sql`select value from memory_notes where move_id = ${moveId} and elf = ${elf} and key = ${key}`;
    return rows[0] ? json(rows[0].value) : undefined;
  }
  async setNote(moveId: string, elf: string, key: string, value: unknown) {
    await this.sql`
      insert into memory_notes (move_id, elf, key, value) values (${moveId}, ${elf}, ${key}, ${JSON.stringify(value)}::jsonb)
      on conflict (move_id, elf, key) do update set value = excluded.value, updated_at = now()`;
  }
  async listNotes(moveId: string, elf?: string) {
    const rows = elf
      ? await this.sql`select * from memory_notes where move_id = ${moveId} and elf = ${elf} order by key`
      : await this.sql`select * from memory_notes where move_id = ${moveId} order by elf, key`;
    return rows.map(
      (r: Row): NoteRow => ({
        moveId: r.move_id as string,
        elf: r.elf as string,
        key: r.key as string,
        value: json(r.value),
        updatedAt: iso(r.updated_at),
      }),
    );
  }
}

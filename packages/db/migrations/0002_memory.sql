-- Conversational memory: one thread per Photon space, an append-only transcript with a rolling summary,
-- durable facts with full-text recall, and a per-Elf scratchpad. Owned by @elves/memory.

create table if not exists memory_threads (
  id                     text primary key,            -- the Photon space id
  move_id                text not null,
  role                   text,                        -- participant role: owner, buyer, roommate...
  handle                 text,
  title                  text,
  summary                text,                        -- rolling summary of the first summary_message_count messages
  summary_through_seq    bigint not null default 0,
  summary_message_count  integer not null default 0,
  message_count          integer not null default 0,
  metadata               jsonb not null default '{}'::jsonb,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index if not exists memory_threads_move_idx on memory_threads (move_id);

create table if not exists memory_messages (
  id          text primary key,                       -- Photon message id in, reply id out: replays never duplicate
  seq         bigserial,
  thread_id   text not null references memory_threads (id) on delete cascade,
  move_id     text not null,
  role        text not null,                          -- user | assistant | system
  elf         text,
  text        text not null,
  tokens      integer not null,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null
);
create index if not exists memory_messages_thread_seq_idx on memory_messages (thread_id, seq);
create index if not exists memory_messages_move_idx on memory_messages (move_id, seq);

create table if not exists memory_facts (
  id                 text primary key,
  move_id            text not null,
  thread_id          text,
  subject            text not null,                   -- owner | move | item:<name> | person:<name>
  kind               text not null,                   -- preference | constraint | commitment | open_loop | person | fact
  text               text not null,
  audience           text not null default 'crew',    -- crew | owner_private
  confidence         real not null default 0.7,
  elf                text,
  source_message_id  text,
  status             text not null default 'active',  -- active | resolved | superseded
  dedupe_key         text not null,
  times_seen         integer not null default 1,
  last_seen_at       timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  search             tsvector generated always as (to_tsvector('english', subject || ' ' || text)) stored
);
create unique index if not exists memory_facts_dedupe_idx on memory_facts (move_id, dedupe_key);
create index if not exists memory_facts_move_status_idx on memory_facts (move_id, status, last_seen_at desc);
create index if not exists memory_facts_search_idx on memory_facts using gin (search);

create table if not exists memory_notes (
  move_id     text not null,
  elf         text not null,
  key         text not null,
  value       jsonb not null,
  updated_at  timestamptz not null default now(),
  primary key (move_id, elf, key)
);

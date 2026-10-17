-- Elves durable state: moves, participants, the Crew Board, events, items, thread ownership,
-- send idempotency and inbound cursors. Mirrors the Store contract in @elves/shared.
-- Every table carries a bigserial seq so listings are stable even when created_at ties.

create table if not exists moves (
  id               text primary key,
  seq              bigserial,
  owner_handle     text not null,
  owner_space_id   text not null,
  platform         text not null,
  name             text,
  move_out_at      text,
  move_in_at       text,
  from_address     text,
  to_address       text,
  board_link_sent  boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists moves_owner_handle_idx on moves (owner_handle);
create index if not exists moves_owner_space_idx on moves (owner_space_id);

create table if not exists participants (
  id             text primary key,
  seq            bigserial,
  move_id        text not null references moves (id) on delete cascade,
  handle         text not null,
  role           text not null,
  space_id       text not null unique,
  platform       text not null,
  agent_user_id  text,
  created_at     timestamptz not null default now()
);
create index if not exists participants_move_idx on participants (move_id);

create table if not exists elf_status (
  move_id       text not null references moves (id) on delete cascade,
  elf           text not null,
  status        text not null,
  current_task  text not null default '',
  last_update   text not null default '',
  updated_at    timestamptz not null default now(),
  primary key (move_id, elf)
);

create table if not exists events (
  id          text primary key,
  seq         bigserial,
  move_id     text,
  type        text not null,
  payload     jsonb not null default '{}'::jsonb,
  trace_id    text,
  created_at  timestamptz not null default now()
);
create index if not exists events_move_seq_idx on events (move_id, seq);

create table if not exists items (
  id                    text primary key,
  seq                   bigserial,
  move_id               text not null references moves (id) on delete cascade,
  name                  text not null,
  category              text not null,
  weight_lb             integer not null default 25,
  title                 text,
  description           text,
  condition             text,
  price_low_cents       integer,
  price_high_cents      integer,
  list_price_cents      integer,
  floor_price_cents     integer,
  photo_attachment_ids  jsonb not null default '[]'::jsonb,
  listing_approved      boolean not null default false,
  outcome               text not null default 'listed',
  created_at            timestamptz not null default now()
);
create index if not exists items_move_seq_idx on items (move_id, seq);

create table if not exists thread_owners (
  message_id  text primary key,
  elf         text not null,
  created_at  timestamptz not null default now()
);

create table if not exists sends (
  key         text primary key,
  message_id  text,
  created_at  timestamptz not null default now()
);

create table if not exists cursors (
  name        text primary key,
  value       text not null,
  updated_at  timestamptz not null default now()
);

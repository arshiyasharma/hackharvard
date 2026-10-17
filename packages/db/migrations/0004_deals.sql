-- Deal Engine: one row per deal (sell an item, buy one, sublet out, find a sublet) and one per counterparty in it.
-- State: listed → negotiating → scheduled → handed_off → paid | relisted | donated | dumped.

create table if not exists deals (
  id                text primary key,
  seq               bigserial,
  move_id           text not null references moves (id) on delete cascade,
  mode              text not null,
  subject_id        text,
  title             text not null,
  code              text not null unique,
  state             text not null default 'listed',
  ask_cents         integer,
  limit_cents       integer,
  unit              text not null default 'each',
  owner_thread_id   text,
  winner_party_id   text,
  agreed_cents      integer,
  slot              jsonb,
  outcome           text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists deals_move_idx on deals (move_id, seq);
create index if not exists deals_open_idx on deals (state) where state in ('listed', 'negotiating', 'scheduled', 'relisted');

create table if not exists deal_parties (
  id                    text primary key,
  seq                   bigserial,
  deal_id               text not null references deals (id) on delete cascade,
  move_id               text not null references moves (id) on delete cascade,
  space_id              text not null,
  handle                text not null,
  role                  text not null,
  status                text not null default 'talking',
  last_offer_cents      integer,
  last_counter_cents    integer,
  agreed_cents          integer,
  rounds                integer not null default 0,
  offered_slots         jsonb not null default '[]'::jsonb,
  slot                  jsonb,
  owner_ask_message_id  text,
  owner_approved_cents  integer,
  scam_flags            jsonb not null default '[]'::jsonb,
  no_shows              integer not null default 0,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (deal_id, space_id)
);
create index if not exists deal_parties_space_idx on deal_parties (space_id);

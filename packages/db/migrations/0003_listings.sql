-- Home Elf housing search: the owner's saved requirements (one row per move) and every listing the crew found.

create table if not exists housing_searches (
  move_id                 text primary key references moves (id) on delete cascade,
  kinds                   jsonb not null default '[]'::jsonb,
  city                    text,
  neighborhoods           jsonb not null default '[]'::jsonb,
  budget_max_cents        integer,
  hotel_nightly_max_cents integer,
  move_in                 text,
  move_out                text,
  bedrooms                integer,
  furnished               boolean,
  must_haves              jsonb not null default '[]'::jsonb,
  notes                   jsonb not null default '[]'::jsonb,
  last_searched_at        text,
  last_search_key         text,
  shown_count             integer not null default 0,
  updated_at              timestamptz not null default now()
);

create table if not exists listings (
  id              text primary key,
  seq             bigserial,
  move_id         text not null references moves (id) on delete cascade,
  site            text not null,
  kind            text not null,
  url             text not null,
  title           text not null,
  price_cents     integer,
  price_unit      text not null default 'month',
  location        text,
  available_from  text,
  bedrooms        integer,
  snippet         text,
  posted_at       text,
  photo_count     integer,
  contact         jsonb not null default '{}'::jsonb,
  scam_flags      jsonb not null default '[]'::jsonb,
  score           integer not null default 0,
  reason          text not null default '',
  rank            integer,
  status          text not null default 'found',
  found_at        timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  unique (move_id, url)
);
create index if not exists listings_move_idx on listings (move_id);

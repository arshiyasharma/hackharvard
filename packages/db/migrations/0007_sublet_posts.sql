-- The owner's own room written up as a sublet post (one per move). The rent line lives on the sublet_out deal.

create table if not exists sublet_posts (
  move_id              text primary key references moves (id) on delete cascade,
  deal_id              text,
  rent_cents           integer,
  available_from       text,
  available_until      text,
  area                 text,
  furnished            boolean,
  room_type            text,
  details              jsonb not null default '[]'::jsonb,
  photo_attachment_ids jsonb not null default '[]'::jsonb,
  photo_notes          text,
  title                text,
  body                 text,
  status               text not null default 'collecting',
  updated_at           timestamptz not null default now()
);

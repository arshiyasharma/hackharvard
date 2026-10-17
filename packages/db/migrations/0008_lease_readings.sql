-- What the Home Elf read out of the owner's lease PDF (one per move; a new PDF replaces it).

create table if not exists lease_readings (
  move_id        text primary key references moves (id) on delete cascade,
  attachment_id  text not null,
  filename       text,
  reading        jsonb not null default '{}'::jsonb,
  read_at        timestamptz not null default now()
);

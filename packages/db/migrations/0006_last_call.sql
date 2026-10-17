-- Last Call stages on the live deal: none → dropped (T−48h) → free (T−24h) → closed (move-out).
-- last_call_opt_out holds a price when the owner says "keep the couch".

alter table deals add column if not exists last_call_stage text not null default 'none';
alter table deals add column if not exists last_call_opt_out boolean not null default false;

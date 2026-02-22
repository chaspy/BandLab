create extension if not exists pgcrypto;

create type asset_type as enum ('audio_preview', 'audio_source', 'midi');
create type asset_status as enum ('pending', 'uploaded', 'ready', 'failed');

create table if not exists bands (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  invite_code text not null unique,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists band_members (
  band_id uuid not null references bands(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member',
  joined_at timestamptz not null default now(),
  primary key (band_id, user_id)
);

create table if not exists songs (
  id uuid primary key default gen_random_uuid(),
  band_id uuid not null references bands(id) on delete cascade,
  title text not null,
  bpm integer,
  musical_key text,
  time_signature text,
  description text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_songs_band_id on songs(band_id);

create table if not exists tracks (
  id uuid primary key default gen_random_uuid(),
  song_id uuid not null references songs(id) on delete cascade,
  name text not null,
  instrument_type text,
  sort_order integer not null default 1,
  active_revision_id uuid,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_tracks_song_id on tracks(song_id);

create table if not exists track_revision_counters (
  track_id uuid primary key references tracks(id) on delete cascade,
  next_revision_number integer not null default 1,
  updated_at timestamptz not null default now()
);

create table if not exists track_revisions (
  id uuid primary key default gen_random_uuid(),
  track_id uuid not null references tracks(id) on delete cascade,
  revision_number integer not null,
  title text,
  memo text,
  idempotency_key text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique(track_id, revision_number),
  unique(track_id, idempotency_key)
);
create index if not exists idx_track_revisions_track_id on track_revisions(track_id);

alter table tracks
  add constraint tracks_active_revision_fk
  foreign key (active_revision_id)
  references track_revisions(id)
  on delete set null;

create table if not exists track_assets (
  id uuid primary key default gen_random_uuid(),
  track_revision_id uuid not null references track_revisions(id) on delete cascade,
  asset_type asset_type not null,
  format text not null,
  s3_key text not null unique,
  content_type text not null,
  byte_size bigint,
  duration_sec numeric,
  sample_rate integer,
  channels integer,
  status asset_status not null default 'pending',
  created_at timestamptz not null default now(),
  unique(track_revision_id, asset_type)
);
create index if not exists idx_track_assets_revision_id on track_assets(track_revision_id);

create table if not exists mix_sessions (
  id uuid primary key default gen_random_uuid(),
  song_id uuid not null references songs(id) on delete cascade,
  name text not null,
  is_default boolean not null default false,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists idx_mix_sessions_song_id on mix_sessions(song_id);

create table if not exists mix_session_tracks (
  mix_session_id uuid not null references mix_sessions(id) on delete cascade,
  track_id uuid not null references tracks(id) on delete cascade,
  track_revision_id uuid references track_revisions(id) on delete set null,
  gain_db numeric not null default 0,
  pan numeric not null default 0,
  mute boolean not null default false,
  start_offset_ms integer not null default 0,
  primary key (mix_session_id, track_id)
);

create table if not exists notes (
  id uuid primary key default gen_random_uuid(),
  song_id uuid not null references songs(id) on delete cascade,
  content text not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_notes_song_id on notes(song_id);

create table if not exists decisions (
  id uuid primary key default gen_random_uuid(),
  song_id uuid not null references songs(id) on delete cascade,
  title text not null,
  decision_text text not null,
  reasoning text,
  related_track_id uuid references tracks(id) on delete set null,
  related_track_revision_id uuid references track_revisions(id) on delete set null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists idx_decisions_song_id on decisions(song_id);

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger songs_set_updated_at
before update on songs
for each row execute function set_updated_at();

create trigger tracks_set_updated_at
before update on tracks
for each row execute function set_updated_at();

create trigger notes_set_updated_at
before update on notes
for each row execute function set_updated_at();

create or replace function allocate_track_revision_number(p_track_id uuid)
returns integer
language plpgsql
as $$
declare
  next_num integer;
begin
  insert into track_revision_counters (track_id, next_revision_number)
  values (p_track_id, 1)
  on conflict (track_id)
  do update set
    next_revision_number = track_revision_counters.next_revision_number + 1,
    updated_at = now()
  returning next_revision_number into next_num;

  return next_num;
end;
$$;

comment on function allocate_track_revision_number(uuid)
is 'Counter-based revision allocation (Approach A): atomic and collision-safe.';

alter table bands enable row level security;
alter table band_members enable row level security;
alter table songs enable row level security;
alter table tracks enable row level security;
alter table track_revisions enable row level security;
alter table track_assets enable row level security;
alter table mix_sessions enable row level security;
alter table mix_session_tracks enable row level security;
alter table notes enable row level security;
alter table decisions enable row level security;

create policy bands_member_rw on bands
for all
using (
  exists (
    select 1 from band_members bm
    where bm.band_id = bands.id and bm.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from band_members bm
    where bm.band_id = bands.id and bm.user_id = auth.uid()
  )
);

create policy band_members_rw on band_members
for all
using (
  user_id = auth.uid()
  or exists (
    select 1 from band_members bm
    where bm.band_id = band_members.band_id and bm.user_id = auth.uid()
  )
)
with check (
  user_id = auth.uid()
  or exists (
    select 1 from band_members bm
    where bm.band_id = band_members.band_id and bm.user_id = auth.uid()
  )
);

create policy songs_member_rw on songs
for all
using (
  exists (
    select 1 from band_members bm
    where bm.band_id = songs.band_id and bm.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from band_members bm
    where bm.band_id = songs.band_id and bm.user_id = auth.uid()
  )
);

create policy tracks_member_rw on tracks
for all
using (
  exists (
    select 1 from songs s
    join band_members bm on bm.band_id = s.band_id
    where s.id = tracks.song_id and bm.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from songs s
    join band_members bm on bm.band_id = s.band_id
    where s.id = tracks.song_id and bm.user_id = auth.uid()
  )
);

create policy track_revisions_member_rw on track_revisions
for all
using (
  exists (
    select 1 from tracks t
    join songs s on s.id = t.song_id
    join band_members bm on bm.band_id = s.band_id
    where t.id = track_revisions.track_id and bm.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from tracks t
    join songs s on s.id = t.song_id
    join band_members bm on bm.band_id = s.band_id
    where t.id = track_revisions.track_id and bm.user_id = auth.uid()
  )
);

create policy track_assets_member_rw on track_assets
for all
using (
  exists (
    select 1 from track_revisions tr
    join tracks t on t.id = tr.track_id
    join songs s on s.id = t.song_id
    join band_members bm on bm.band_id = s.band_id
    where tr.id = track_assets.track_revision_id and bm.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from track_revisions tr
    join tracks t on t.id = tr.track_id
    join songs s on s.id = t.song_id
    join band_members bm on bm.band_id = s.band_id
    where tr.id = track_assets.track_revision_id and bm.user_id = auth.uid()
  )
);

create policy mix_sessions_member_rw on mix_sessions
for all
using (
  exists (
    select 1 from songs s
    join band_members bm on bm.band_id = s.band_id
    where s.id = mix_sessions.song_id and bm.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from songs s
    join band_members bm on bm.band_id = s.band_id
    where s.id = mix_sessions.song_id and bm.user_id = auth.uid()
  )
);

create policy mix_session_tracks_member_rw on mix_session_tracks
for all
using (
  exists (
    select 1 from mix_sessions ms
    join songs s on s.id = ms.song_id
    join band_members bm on bm.band_id = s.band_id
    where ms.id = mix_session_tracks.mix_session_id and bm.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from mix_sessions ms
    join songs s on s.id = ms.song_id
    join band_members bm on bm.band_id = s.band_id
    where ms.id = mix_session_tracks.mix_session_id and bm.user_id = auth.uid()
  )
);

create policy notes_member_rw on notes
for all
using (
  exists (
    select 1 from songs s
    join band_members bm on bm.band_id = s.band_id
    where s.id = notes.song_id and bm.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from songs s
    join band_members bm on bm.band_id = s.band_id
    where s.id = notes.song_id and bm.user_id = auth.uid()
  )
);

create policy decisions_member_rw on decisions
for all
using (
  exists (
    select 1 from songs s
    join band_members bm on bm.band_id = s.band_id
    where s.id = decisions.song_id and bm.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from songs s
    join band_members bm on bm.band_id = s.band_id
    where s.id = decisions.song_id and bm.user_id = auth.uid()
  )
);

-- Soccer Flow bot: initial schema (port of the lowdb JSON store).
-- The edge functions use the service role key, which bypasses RLS.
-- RLS is enabled with NO policies so the anon key cannot read anything.

create table conversations (
  channel text not null,
  phone text not null,
  messages jsonb not null default '[]',
  updated_at timestamptz default now(),
  primary key (channel, phone)
);

create table leads (
  id uuid primary key default gen_random_uuid(),
  channel text not null,
  phone text not null,
  parent_name text,
  child_name text,
  child_age text,
  program text,
  preferred_time text,
  state text default 'LEAD_IN_PROGRESS',
  owner_notified boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (channel, phone)
);

create table takeovers (
  channel text not null,
  phone text not null,
  "by" text default 'owner',
  at timestamptz default now(),
  primary key (channel, phone)
);

create table kb_entries (
  id text primary key,
  category text not null,
  text text not null,
  source text default 'admin',
  created_at timestamptz default now()
);

alter table conversations enable row level security;
alter table leads enable row level security;
alter table takeovers enable row level security;
alter table kb_entries enable row level security;

-- RAG upgrade for the owner-fed knowledge base.
-- Keeps the existing `kb_entries` table (owner-authored source documents) and
-- adds `kb_chunks` with vector embeddings so retrieval can serve only the
-- few hundred relevant characters per request instead of dumping the whole KB.

create extension if not exists vector;

-- Each kb_entries row is split into N ~500-char chunks; the vector column
-- stores an OpenAI text-embedding-3-small embedding (1536 dims).
create table if not exists kb_chunks (
  id bigserial primary key,
  entry_id text not null references kb_entries(id) on delete cascade,
  category text not null,
  text text not null,
  chunk_index integer not null,
  embedding vector(1536) not null,
  created_at timestamptz default now()
);

create index if not exists kb_chunks_embedding_hnsw
  on kb_chunks using hnsw (embedding vector_cosine_ops);
create index if not exists kb_chunks_category_idx on kb_chunks(category);
create index if not exists kb_chunks_entry_idx on kb_chunks(entry_id);

alter table kb_chunks enable row level security;

-- Similarity search RPC. Returns the top N most-similar chunks to the query
-- embedding, filtered by minimum similarity to avoid injecting irrelevant junk.
create or replace function match_kb_chunks(
  query_embedding vector(1536),
  match_count integer default 8,
  min_similarity float default 0.25
)
returns table (
  id bigint,
  entry_id text,
  category text,
  text text,
  similarity float
)
language sql stable
as $$
  select
    c.id,
    c.entry_id,
    c.category,
    c.text,
    1 - (c.embedding <=> query_embedding) as similarity
  from kb_chunks c
  where 1 - (c.embedding <=> query_embedding) >= min_similarity
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

-- --- OPT-OUT ---------------------------------------------------------------
-- Hard permanent silence for a customer. Different from `takeovers`:
--   takeovers = owner is handling this convo now, auto-expires after TTL
--   opt_outs  = customer explicitly asked to stop; never auto-expires
-- Owner can clear manually via SQL or a future admin UI.
create table if not exists opt_outs (
  channel text not null,
  phone text not null,
  reason text default 'customer_keyword',
  at timestamptz default now(),
  primary key (channel, phone)
);
alter table opt_outs enable row level security;

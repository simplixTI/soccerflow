#!/usr/bin/env node
/**
 * One-off backfill: reads every row from `kb_entries`, splits each `text` into
 * ~500-char chunks (100-char overlap), embeds each chunk with OpenAI
 * `text-embedding-3-small`, and inserts them into `kb_chunks`.
 *
 * Idempotent: wipes any existing chunks for an entry before re-inserting, so
 * you can re-run after editing entries.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... \
 *   SUPABASE_URL=https://<ref>.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=... \
 *   node scripts/backfill-kb-embeddings.mjs [--dry-run] [--entry <id>]
 */

const {
  OPENAI_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  OPENAI_EMBED_MODEL = 'text-embedding-3-small',
} = process.env;

const DRY_RUN = process.argv.includes('--dry-run');
const entryArgIdx = process.argv.indexOf('--entry');
const ONLY_ENTRY = entryArgIdx >= 0 ? process.argv[entryArgIdx + 1] : null;

const CHUNK_SIZE = 500;
const CHUNK_OVERLAP = 100;
const EMBED_BATCH = 32; // OpenAI accepts up to 2048 inputs per request

function need(name, value) {
  if (!value) { console.error(`Missing env: ${name}`); process.exit(1); }
}
need('OPENAI_API_KEY', OPENAI_API_KEY);
need('SUPABASE_URL', SUPABASE_URL);
need('SUPABASE_SERVICE_ROLE_KEY', SUPABASE_SERVICE_ROLE_KEY);

const supabaseBase = SUPABASE_URL.replace(/\/$/, '');

async function supabase(path, init = {}) {
  const res = await fetch(`${supabaseBase}/rest/v1${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`supabase ${path} → ${res.status}: ${t.slice(0, 300)}`);
  }
  const body = await res.text();
  return body.trim() ? JSON.parse(body) : null;
}

async function embedBatch(inputs) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: OPENAI_EMBED_MODEL, input: inputs }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`OpenAI embeddings ${res.status}: ${t.slice(0, 400)}`);
  }
  const data = await res.json();
  // Preserve order: data.data[i].embedding matches inputs[i].
  return data.data.map((d) => d.embedding);
}

/**
 * Split `text` into overlapping chunks of ~CHUNK_SIZE chars. Chunk boundaries
 * prefer paragraph breaks, then sentence endings, then whitespace — never
 * mid-word. The goal is semantic coherence inside each chunk.
 */
function chunkText(text) {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (clean.length <= CHUNK_SIZE) return [clean];
  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    const end = Math.min(start + CHUNK_SIZE, clean.length);
    let slice = clean.slice(start, end);
    // Snap backward to a nice boundary if we're not at the very end.
    if (end < clean.length) {
      const paragraphBreak = slice.lastIndexOf('\n\n');
      const newlineBreak = slice.lastIndexOf('\n');
      const sentenceBreak = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
      const whitespace = slice.lastIndexOf(' ');
      const boundary =
        paragraphBreak >= CHUNK_SIZE * 0.4 ? paragraphBreak + 2
        : newlineBreak  >= CHUNK_SIZE * 0.4 ? newlineBreak + 1
        : sentenceBreak >= CHUNK_SIZE * 0.4 ? sentenceBreak + 2
        : whitespace    >= CHUNK_SIZE * 0.4 ? whitespace + 1
        : slice.length;
      slice = slice.slice(0, boundary);
    }
    chunks.push(slice.trim());
    // Advance by at least half the target size, so a small boundary snap
    // doesn't make us creep forward 1 char at a time (bug on first version).
    const minAdvance = Math.floor(CHUNK_SIZE / 2);
    start += Math.max(slice.length - CHUNK_OVERLAP, minAdvance);
  }
  return chunks.filter((c) => c.length > 20); // drop junk fragments
}

async function listEntries() {
  const query = ONLY_ENTRY
    ? `/kb_entries?select=id,category,text&id=eq.${encodeURIComponent(ONLY_ENTRY)}`
    : `/kb_entries?select=id,category,text&order=created_at.asc`;
  return supabase(query);
}

async function wipeChunksFor(entryId) {
  await supabase(`/kb_chunks?entry_id=eq.${encodeURIComponent(entryId)}`, { method: 'DELETE' });
}

async function insertChunks(rows) {
  await supabase('/kb_chunks', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(rows),
  });
}

async function main() {
  console.log(`[backfill] model=${OPENAI_EMBED_MODEL} dry-run=${DRY_RUN} only-entry=${ONLY_ENTRY || '(all)'}`);
  const entries = await listEntries();
  if (!entries || entries.length === 0) {
    console.log('[backfill] no entries to process');
    return;
  }
  console.log(`[backfill] ${entries.length} source entries`);

  let totalChunks = 0;
  let totalChars = 0;
  let totalEmbeds = 0;

  for (const entry of entries) {
    const chunks = chunkText(entry.text);
    totalChunks += chunks.length;
    totalChars += chunks.reduce((s, c) => s + c.length, 0);
    console.log(`  [${entry.category}] ${entry.id}: ${entry.text.length} chars → ${chunks.length} chunks`);

    if (DRY_RUN) continue;

    // Fresh indexing: drop any previous chunks for this entry.
    await wipeChunksFor(entry.id);

    // Embed in batches to keep requests small.
    const rows = [];
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const batch = chunks.slice(i, i + EMBED_BATCH);
      const vectors = await embedBatch(batch);
      totalEmbeds += batch.length;
      batch.forEach((text, j) => {
        rows.push({
          entry_id: entry.id,
          category: entry.category,
          text,
          chunk_index: i + j,
          embedding: vectors[j],
        });
      });
    }
    await insertChunks(rows);
  }

  console.log('');
  console.log(`[backfill] done. entries=${entries.length} chunks=${totalChunks} chars=${totalChars} embeds=${totalEmbeds}`);
  if (!DRY_RUN) {
    // Rough cost estimate: text-embedding-3-small is $0.02 per 1M tokens; ~4 chars/token.
    const estTokens = Math.ceil(totalChars / 4);
    const estCost = (estTokens / 1_000_000) * 0.02;
    console.log(`[backfill] approx tokens embedded: ${estTokens.toLocaleString()} ≈ $${estCost.toFixed(4)} USD`);
  }
}

main().catch((err) => { console.error('[backfill] fatal:', err); process.exit(1); });

#!/usr/bin/env node
/**
 * Seed kb_entries from scripts/kb-seed.json. Does NOT embed; run
 * scripts/backfill-kb-embeddings.mjs right after to index everything.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/seed-kb.mjs [--wipe]
 *
 * --wipe deletes every existing kb_entries row (and, via FK cascade, every
 * kb_chunks row) before inserting. Without it, entries are appended.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const WIPE = process.argv.includes('--wipe');
const base = SUPABASE_URL.replace(/\/$/, '');
const headers = {
  'Content-Type': 'application/json',
  apikey: SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
};

async function rest(path, init = {}) {
  const res = await fetch(`${base}/rest/v1${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const text = await res.text();
  return text.trim() ? JSON.parse(text) : null;
}

const here = dirname(fileURLToPath(import.meta.url));
const seed = JSON.parse(readFileSync(join(here, 'kb-seed.json'), 'utf8'));

if (WIPE) {
  await rest('/kb_chunks?id=gte.0', { method: 'DELETE' });
  await rest('/kb_entries?id=neq.__none__', { method: 'DELETE' });
  console.log('[seed] wiped kb_entries + kb_chunks');
}

const rows = seed.map((e, i) => ({
  // Same id scheme store.ts uses, with an index so ordering is stable.
  id: Date.now().toString(36) + i.toString(36).padStart(2, '0') + Math.random().toString(36).slice(2, 6),
  category: e.category,
  text: e.text.trim(),
  source: 'seed',
}));
await rest('/kb_entries', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(rows) });

const byCat = rows.reduce((m, r) => ((m[r.category] = (m[r.category] || 0) + 1), m), {});
const chars = rows.reduce((s, r) => s + r.text.length, 0);
console.log(`[seed] inserted ${rows.length} entries (${chars.toLocaleString()} chars):`, byCat);
console.log('[seed] now run: node scripts/backfill-kb-embeddings.mjs');

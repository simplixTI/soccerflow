/**
 * Postgres data access (replaces the lowdb JSON store).
 * Uses the service role key (auto-injected by Supabase Edge Functions),
 * which bypasses RLS — intended for this backend.
 *
 * All functions keep the exact semantics of bot/src/store.js.
 * camelCase JS fields map to snake_case columns.
 */
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

export interface ChatMessage {
  role: string;
  content: string;
  /** Set on customer messages by the webhook so burst debouncing can tell which invocation holds the latest one. */
  id?: string;
}

export interface Lead {
  channel: string;
  phone: string;
  parentName: string | null;
  childName: string | null;
  childAge: string | null;
  program: string | null;
  preferredTime: string | null;
  state: string;
  ownerNotified: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface KbEntry {
  id: string;
  category: string;
  text: string;
  source: string;
  createdAt: string;
}

let client: SupabaseClient | null = null;

function db(): SupabaseClient {
  if (!client) {
    const url = Deno.env.get('SUPABASE_URL');
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
    client = createClient(url, key);
  }
  return client;
}

// How many past messages we keep per conversation. Advanced conversations
// often run 30-50 turns before booking — cap too low = the bot loses the
// beginning of the conversation and starts re-asking answered questions.
// DeepSeek supports 64K tokens, so 60 messages (~15K chars) is well within budget.
const MAX_HISTORY = 60;

// deno-lint-ignore no-explicit-any
function rowToLead(row: any): Lead {
  return {
    channel: row.channel,
    phone: row.phone,
    parentName: row.parent_name,
    childName: row.child_name,
    childAge: row.child_age,
    program: row.program,
    preferredTime: row.preferred_time,
    state: row.state,
    ownerNotified: row.owner_notified,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// deno-lint-ignore no-explicit-any
function rowToKbEntry(row: any): KbEntry {
  return {
    id: row.id,
    category: row.category,
    text: row.text,
    source: row.source,
    createdAt: row.created_at,
  };
}

export async function getHistory(channel: string, phone: string): Promise<ChatMessage[]> {
  const { data, error } = await db()
    .from('conversations')
    .select('messages')
    .eq('channel', channel)
    .eq('phone', phone)
    .maybeSingle();
  if (error) throw error;
  return (data?.messages as ChatMessage[]) || [];
}

export async function appendMessages(channel: string, phone: string, messages: ChatMessage[]): Promise<void> {
  const existing = await getHistory(channel, phone);
  const merged = [...existing, ...messages].slice(-MAX_HISTORY);
  const { error } = await db()
    .from('conversations')
    .upsert({ channel, phone, messages: merged, updated_at: new Date().toISOString() });
  if (error) throw error;
}

export async function findLead(channel: string, phone: string): Promise<Lead | null> {
  const { data, error } = await db()
    .from('leads')
    .select('*')
    .eq('channel', channel)
    .eq('phone', phone)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToLead(data) : null;
}

/**
 * Merge newly extracted lead fields into the stored lead record.
 * Creates the record on first call. Returns the updated lead.
 */
export async function upsertLead(
  channel: string,
  phone: string,
  fields: Partial<Record<'parentName' | 'childName' | 'childAge' | 'program' | 'preferredTime', string | null>> = {},
  state: string | null = null,
): Promise<Lead> {
  const now = new Date().toISOString();
  const existing = await findLead(channel, phone);

  const mergeField = (cur: string | null, next: string | null | undefined) =>
    next != null && next !== '' ? next : cur;

  if (!existing) {
    const row = {
      channel,
      phone,
      parent_name: mergeField(null, fields.parentName),
      child_name: mergeField(null, fields.childName),
      child_age: mergeField(null, fields.childAge),
      program: mergeField(null, fields.program),
      preferred_time: mergeField(null, fields.preferredTime),
      state: state || 'LEAD_IN_PROGRESS',
      updated_at: now,
    };
    const { error } = await db().from('leads').insert(row);
    if (error) throw error;
    return (await findLead(channel, phone))!;
  }

  const updates = {
    parent_name: mergeField(existing.parentName, fields.parentName),
    child_name: mergeField(existing.childName, fields.childName),
    child_age: mergeField(existing.childAge, fields.childAge),
    program: mergeField(existing.program, fields.program),
    preferred_time: mergeField(existing.preferredTime, fields.preferredTime),
    state: state || existing.state,
    updated_at: now,
  };
  const { error } = await db()
    .from('leads')
    .update(updates)
    .eq('channel', channel)
    .eq('phone', phone);
  if (error) throw error;
  return (await findLead(channel, phone))!;
}

export async function markLeadNotified(channel: string, phone: string): Promise<void> {
  const { error } = await db()
    .from('leads')
    .update({ owner_notified: true, updated_at: new Date().toISOString() })
    .eq('channel', channel)
    .eq('phone', phone);
  if (error) throw error;
}

// --- Customer opt-out (STOP keyword) ------------------------------------------

/** True if the customer has explicitly opted out — bot must stay silent. */
export async function isOptedOut(channel: string, phone: string): Promise<boolean> {
  const { data, error } = await db()
    .from('opt_outs')
    .select('phone')
    .eq('channel', channel)
    .eq('phone', phone)
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

/** Persist opt-out. Idempotent — repeated STOPs don't error. */
export async function setOptOut(
  channel: string,
  phone: string,
  reason = 'customer_keyword',
): Promise<void> {
  const { error } = await db()
    .from('opt_outs')
    .upsert({ channel, phone, reason, at: new Date().toISOString() });
  if (error) throw error;
}

/** Owner-only: bring a customer back from opt-out. */
export async function clearOptOut(channel: string, phone: string): Promise<void> {
  const { error } = await db()
    .from('opt_outs')
    .delete()
    .eq('channel', channel)
    .eq('phone', phone);
  if (error) throw error;
}

// --- Human takeover (/assumir + auto-takeover) ---------------------------------

/** Owner takes over a conversation: the AI goes silent for this channel+phone. */
export async function setTakeover(channel: string, phone: string, by = 'owner'): Promise<void> {
  const { error } = await db()
    .from('takeovers')
    .upsert({ channel, phone, by, at: new Date().toISOString() });
  if (error) throw error;
}

/** AI resumes control of the conversation. */
export async function clearTakeover(channel: string, phone: string): Promise<void> {
  const { error } = await db()
    .from('takeovers')
    .delete()
    .eq('channel', channel)
    .eq('phone', phone);
  if (error) throw error;
}

function takeoverTtlMs(): number {
  const hours = Number(Deno.env.get('TAKEOVER_TTL_HOURS') || '4');
  return (Number.isFinite(hours) && hours > 0 ? hours : 4) * 60 * 60 * 1000;
}

/**
 * True when a human is in control of this conversation.
 * Takeovers expire automatically after TAKEOVER_TTL_HOURS (default 24h) of
 * owner inactivity — the AI never stays silent forever by accident.
 */
export async function isTakeover(channel: string, phone: string): Promise<boolean> {
  const { data, error } = await db()
    .from('takeovers')
    .select('at')
    .eq('channel', channel)
    .eq('phone', phone)
    .maybeSingle();
  if (error) throw error;
  if (!data) return false;
  const age = Date.now() - new Date(data.at).getTime();
  if (age > takeoverTtlMs()) {
    await clearTakeover(channel, phone);
    console.log(`[store] takeover expired for ${channel}:${phone} — AI resumes`);
    return false;
  }
  return true;
}

// --- Living knowledge base (owner-fed RAG) -------------------------------------

export const KB_CATEGORIES = ['business', 'faq', 'style', 'correction'];

/** Add a knowledge entry. Categories: business | faq | style | correction. */
export async function addKbEntry(
  { category, text, source = 'admin' }: { category: string; text: string; source?: string },
): Promise<KbEntry> {
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    category: KB_CATEGORIES.includes(category) ? category : 'business',
    text: String(text || '').trim(),
    source,
  };
  const { error } = await db().from('kb_entries').insert(entry);
  if (error) throw error;
  return { ...entry, createdAt: new Date().toISOString() };
}

export async function listKb(): Promise<KbEntry[]> {
  const { data, error } = await db()
    .from('kb_entries')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data || []).map(rowToKbEntry);
}

export async function deleteKbEntry(id: string): Promise<number> {
  const { error } = await db().from('kb_entries').delete().eq('id', id);
  if (error) throw error;
  return (await listKb()).length;
}

const KB_CATEGORY_LABELS: Record<string, string> = {
  business: 'BUSINESS FACT',
  faq: 'FAQ',
  style: 'SERVICE STYLE',
  correction: 'CORRECTION / HOW TO HANDLE',
};

// DeepSeek chat supports ~64K input tokens (~200K chars), but requests with
// giant system prompts frequently time out when their API is under load.
// 24K is enough for the owner's actual corrections + core business facts.
// The category priority below ensures corrections stay in even when the KB grows.
const MAX_KB_CHARS = 24000;

// Higher-priority categories are packed first so they never get dropped when
// the KB grows past MAX_KB_CHARS. Corrections override everything → they win.
const CATEGORY_PRIORITY: Record<string, number> = {
  correction: 0,
  business: 1,
  faq: 2,
  style: 3,
};

/**
 * LEGACY path (kept as a safety net): dumps the whole KB into the prompt,
 * priority-sorted, capped at MAX_KB_CHARS. Used only when the vector-search
 * RAG path throws (OpenAI down, pgvector missing, etc.).
 */
export async function getKbPromptSection(): Promise<string> {
  const kb = await listKb();
  if (!kb.length) return '';
  const sorted = [...kb].sort((a, b) => {
    const pa = CATEGORY_PRIORITY[a.category] ?? 99;
    const pb = CATEGORY_PRIORITY[b.category] ?? 99;
    if (pa !== pb) return pa - pb;
    return (b.createdAt || '').localeCompare(a.createdAt || '');
  });
  const parts: string[] = [];
  let used = 0;
  for (const e of sorted) {
    const label = KB_CATEGORY_LABELS[e.category] || 'NOTE';
    const line = `- [${label}] ${e.text}\n`;
    if (used + line.length > MAX_KB_CHARS) continue;
    parts.push(line);
    used += line.length;
  }
  return parts.join('').trim();
}

// --- RAG: vector-search retrieval over kb_chunks ------------------------------

export interface KbChunkMatch {
  id: number;
  entry_id: string;
  category: string;
  text: string;
  similarity: number;
}

/**
 * Retrieve the top chunks most relevant to the query embedding.
 * Hits the `match_kb_chunks` SQL RPC installed by the kb_rag migration.
 *
 * We EXCLUDE `style` and `correction` categories from vector search — those
 * are policies that must always apply regardless of what the customer asked,
 * so they're loaded separately via `getPolicyChunks()`.
 */
export async function matchKbChunks(
  queryEmbedding: number[],
  { count = 8, minSimilarity = 0.25 }: { count?: number; minSimilarity?: number } = {},
): Promise<KbChunkMatch[]> {
  const { data, error } = await db().rpc('match_kb_chunks', {
    query_embedding: queryEmbedding,
    match_count: count,
    min_similarity: minSimilarity,
  });
  if (error) throw error;
  const all = (data as KbChunkMatch[]) || [];
  // Drop policy categories — they're injected unconditionally elsewhere.
  return all.filter((c) => c.category !== 'style' && c.category !== 'correction');
}

/**
 * Pull ALL chunks in policy categories (style, correction). These are the
 * owner's overrides and tone rules — they must apply to every reply, not
 * depend on whether the customer's current message happens to match them.
 */
export async function getPolicyChunks(): Promise<KbChunkMatch[]> {
  const { data, error } = await db()
    .from('kb_chunks')
    .select('id, entry_id, category, text')
    .in('category', ['correction', 'style'])
    .order('chunk_index', { ascending: true });
  if (error) throw error;
  // similarity isn't computed here (they're always-included); use 1.0 as a flag.
  return (data as Omit<KbChunkMatch, 'similarity'>[]).map((c) => ({ ...c, similarity: 1 }));
}

/**
 * Render a set of retrieved chunks as the KB prompt section.
 * Groups by entry+category so the LLM sees coherent chunks, not isolated snippets.
 */
export function renderChunks(matches: KbChunkMatch[]): string {
  if (!matches.length) return '';
  // Sort by category priority first (corrections win when the prompt is tight),
  // then by similarity so the strongest match in each category comes first.
  const sorted = [...matches].sort((a, b) => {
    const pa = CATEGORY_PRIORITY[a.category] ?? 99;
    const pb = CATEGORY_PRIORITY[b.category] ?? 99;
    if (pa !== pb) return pa - pb;
    return b.similarity - a.similarity;
  });
  return sorted
    .map((m) => `- [${KB_CATEGORY_LABELS[m.category] || 'NOTE'}] ${m.text}`)
    .join('\n');
}

/** Insert one chunk + its embedding. Used by the backfill script. */
export async function insertKbChunk(row: {
  entry_id: string;
  category: string;
  text: string;
  chunk_index: number;
  embedding: number[];
}): Promise<void> {
  const { error } = await db().from('kb_chunks').insert(row);
  if (error) throw error;
}

/** Drop every chunk for an entry (used before re-indexing). */
export async function deleteKbChunksForEntry(entryId: string): Promise<void> {
  const { error } = await db().from('kb_chunks').delete().eq('entry_id', entryId);
  if (error) throw error;
}

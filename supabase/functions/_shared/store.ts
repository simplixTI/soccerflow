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

const MAX_HISTORY = 20;

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
  const hours = Number(Deno.env.get('TAKEOVER_TTL_HOURS') || '24');
  return (Number.isFinite(hours) && hours > 0 ? hours : 24) * 60 * 60 * 1000;
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

const MAX_KB_CHARS = 6000;

/**
 * Render the owner-fed knowledge entries as a prompt section.
 * Newest entries win when over the size cap. Returns '' when empty.
 */
export async function getKbPromptSection(): Promise<string> {
  const kb = await listKb();
  if (!kb.length) return '';
  const newestFirst = [...kb].reverse();
  let out = '';
  for (const e of newestFirst) {
    const label = KB_CATEGORY_LABELS[e.category] || 'NOTE';
    const line = `- [${label}] ${e.text}\n`;
    if (out.length + line.length > MAX_KB_CHARS) break;
    out = line + out; // keep chronological order in the final text
  }
  return out.trim();
}

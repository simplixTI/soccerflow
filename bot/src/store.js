import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const adapter = new JSONFile(path.join(dataDir, 'db.json'));
const defaultData = { conversations: {}, leads: [], takeovers: {}, kb: [] };
const db = new Low(adapter, defaultData);

await db.read();
db.data ||= defaultData;
db.data.conversations ||= {};
db.data.leads ||= [];
db.data.takeovers ||= {};
db.data.kb ||= [];

const MAX_HISTORY = 20;
const convKey = (channel, phone) => `${channel}:${phone}`;

export async function getHistory(channel, phone) {
  await db.read();
  return db.data.conversations[convKey(channel, phone)]?.messages || [];
}

export async function appendMessages(channel, phone, messages) {
  await db.read();
  const key = convKey(channel, phone);
  db.data.conversations[key] ||= { messages: [] };
  const conv = db.data.conversations[key];
  conv.messages.push(...messages);
  if (conv.messages.length > MAX_HISTORY) {
    conv.messages = conv.messages.slice(-MAX_HISTORY);
  }
  conv.updatedAt = new Date().toISOString();
  await db.write();
}

export async function findLead(channel, phone) {
  await db.read();
  return db.data.leads.find((l) => l.channel === channel && l.phone === phone) || null;
}

/**
 * Merge newly extracted lead fields into the stored lead record.
 * Creates the record on first call. Returns the updated lead.
 */
export async function upsertLead(channel, phone, fields = {}, state = null) {
  await db.read();
  let lead = db.data.leads.find((l) => l.channel === channel && l.phone === phone);
  if (!lead) {
    lead = {
      channel,
      phone,
      parentName: null,
      childName: null,
      childAge: null,
      program: null,
      preferredTime: null,
      state: 'LEAD_IN_PROGRESS',
      ownerNotified: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    db.data.leads.push(lead);
  }
  for (const key of ['parentName', 'childName', 'childAge', 'program', 'preferredTime']) {
    if (fields[key] != null && fields[key] !== '') lead[key] = fields[key];
  }
  if (state) lead.state = state;
  lead.updatedAt = new Date().toISOString();
  await db.write();
  return lead;
}

export async function markLeadNotified(channel, phone) {
  await db.read();
  const lead = db.data.leads.find((l) => l.channel === channel && l.phone === phone);
  if (lead) {
    lead.ownerNotified = true;
    lead.updatedAt = new Date().toISOString();
    await db.write();
  }
}

// --- Human takeover (/assumir) ------------------------------------------------

/** Owner takes over a conversation: the AI goes silent for this channel+phone. */
export async function setTakeover(channel, phone, by = 'owner') {
  await db.read();
  db.data.takeovers[convKey(channel, phone)] = { by, at: new Date().toISOString() };
  await db.write();
}

/** AI resumes control of the conversation. */
export async function clearTakeover(channel, phone) {
  await db.read();
  if (db.data.takeovers[convKey(channel, phone)]) {
    delete db.data.takeovers[convKey(channel, phone)];
    await db.write();
  }
}

export async function isTakeover(channel, phone) {
  await db.read();
  return Boolean(db.data.takeovers[convKey(channel, phone)]);
}

// --- Living knowledge base (owner-fed RAG) -------------------------------------

export const KB_CATEGORIES = ['business', 'faq', 'style', 'correction'];

/** Add a knowledge entry. Categories: business | faq | style | correction. */
export async function addKbEntry({ category, text, source = 'admin' }) {
  await db.read();
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    category: KB_CATEGORIES.includes(category) ? category : 'business',
    text: String(text || '').trim(),
    source,
    createdAt: new Date().toISOString(),
  };
  db.data.kb ||= [];
  db.data.kb.push(entry);
  await db.write();
  return entry;
}

export async function listKb() {
  await db.read();
  return db.data.kb;
}

export async function deleteKbEntry(id) {
  await db.read();
  const before = db.data.kb.length;
  db.data.kb = db.data.kb.filter((e) => e.id !== id);
  await db.write();
  return db.data.kb.length;
}

const KB_CATEGORY_LABELS = {
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
export async function getKbPromptSection() {
  await db.read();
  if (!db.data.kb.length) return '';
  const newestFirst = [...db.data.kb].reverse();
  let out = '';
  for (const e of newestFirst) {
    const label = KB_CATEGORY_LABELS[e.category] || 'NOTE';
    const line = `- [${label}] ${e.text}\n`;
    if (out.length + line.length > MAX_KB_CHARS) break;
    out = line + out; // keep chronological order in the final text
  }
  return out.trim();
}

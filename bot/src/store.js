import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const adapter = new JSONFile(path.join(dataDir, 'db.json'));
const defaultData = { conversations: {}, leads: [] };
const db = new Low(adapter, defaultData);

await db.read();
db.data ||= defaultData;
db.data.conversations ||= {};
db.data.leads ||= [];

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

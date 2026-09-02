#!/usr/bin/env node
/**
 * One-off importer: seeds the Supabase `conversations` table with existing
 * WhatsApp chat history pulled from uazapi, so the AI has context for
 * customers who talked with the business number before the bot was deployed.
 *
 * Usage:
 *   UAZAPI_BASE_URL=... UAZAPI_TOKEN=... \
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   node scripts/import-uazapi-history.mjs [--dry-run] [--limit N]
 *
 * Behavior:
 *   - Iterates all non-group chats via /chat/find
 *   - For each chat, pulls the last MAX_HISTORY text messages via /message/find
 *   - Maps fromMe=true → 'assistant', fromMe=false → 'user'
 *   - Inserts into `conversations` ONLY when there's no existing row (or the
 *     row has zero messages) — never overwrites a live bot conversation
 *   - --dry-run: prints what it would do, no writes
 */

const {
  UAZAPI_BASE_URL,
  UAZAPI_TOKEN,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
} = process.env;

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const CHAT_LIMIT = limitArg ? Number(limitArg.split('=')[1]) : Infinity;

const MAX_HISTORY = 20; // must match supabase/functions/_shared/store.ts
const CHAT_PAGE = 50;

function requireEnv(name, value) {
  if (!value) {
    console.error(`Missing env var: ${name}`);
    process.exit(1);
  }
}

requireEnv('UAZAPI_BASE_URL', UAZAPI_BASE_URL);
requireEnv('UAZAPI_TOKEN', UAZAPI_TOKEN);
if (!DRY_RUN) {
  requireEnv('SUPABASE_URL', SUPABASE_URL);
  requireEnv('SUPABASE_SERVICE_ROLE_KEY', SUPABASE_SERVICE_ROLE_KEY);
}

const uazapiBase = UAZAPI_BASE_URL.replace(/\/$/, '');
const supabaseBase = (SUPABASE_URL || '').replace(/\/$/, '');

async function uazapi(path, body) {
  const res = await fetch(`${uazapiBase}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      token: UAZAPI_TOKEN,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`uazapi ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

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
    const text = await res.text().catch(() => '');
    throw new Error(`supabase ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  // `Prefer: return=minimal` returns an empty body on 201/200 — don't blow up.
  const text = await res.text();
  if (!text.trim()) return null;
  return JSON.parse(text);
}

/**
 * uazapi returns some strings as double-encoded UTF-8 (mojibake), e.g. `’` shows
 * up as `â€™`. Detect and repair: reinterpret each char as a Latin-1 byte and
 * decode the result as UTF-8. Falls back to the original on decode failure.
 */
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
function fixMojibake(s) {
  if (!s || !/[ÂÃâ€]/.test(s)) return s;
  try {
    const bytes = new Uint8Array([...s].map((c) => c.charCodeAt(0) & 0xff));
    return utf8Decoder.decode(bytes);
  } catch {
    return s;
  }
}

function digits(s) {
  return String(s || '').replace(/\D/g, '');
}

function extractText(msg) {
  const raw = (
    msg.text ||
    msg.content?.text ||
    msg.content?.caption ||
    msg.content?.conversation ||
    ''
  ).trim();
  return fixMojibake(raw);
}

async function listAllChats() {
  const chats = [];
  let offset = 0;
  while (chats.length < CHAT_LIMIT) {
    const page = await uazapi('/chat/find', {
      operator: 'AND',
      limit: CHAT_PAGE,
      offset,
    });
    const batch = page.chats || [];
    if (!batch.length) break;
    for (const c of batch) {
      if (c.wa_isGroup) continue;
      if (!c.wa_chatid || c.wa_chatid.endsWith('@g.us')) continue;
      chats.push(c);
      if (chats.length >= CHAT_LIMIT) break;
    }
    offset += batch.length;
    if (batch.length < CHAT_PAGE) break;
  }
  return chats;
}

async function fetchChatMessages(chatid) {
  // /message/find returns newest first. Grab a few pages worth in case many
  // messages are non-text so we still end up with MAX_HISTORY usable ones.
  const wanted = MAX_HISTORY * 3;
  const page = await uazapi('/message/find', {
    operator: 'AND',
    chatid,
    limit: wanted,
  });
  return page.messages || [];
}

async function conversationExists(phone) {
  const rows = await supabase(
    `/conversations?channel=eq.whatsapp&phone=eq.${encodeURIComponent(phone)}&select=phone,messages`,
  );
  if (!Array.isArray(rows) || rows.length === 0) return false;
  const msgs = rows[0].messages;
  return Array.isArray(msgs) && msgs.length > 0;
}

async function upsertConversation(phone, messages) {
  await supabase('/conversations?on_conflict=channel,phone', {
    method: 'POST',
    headers: {
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({
      channel: 'whatsapp',
      phone,
      messages,
      updated_at: new Date().toISOString(),
    }),
  });
}

async function main() {
  console.log(`[import] fetching chats from ${uazapiBase} ...`);
  const chats = await listAllChats();
  console.log(`[import] ${chats.length} 1:1 chats to process (dry-run=${DRY_RUN})`);

  let imported = 0;
  let skipped = 0;
  let empty = 0;
  let errors = 0;

  for (const [i, chat] of chats.entries()) {
    const phone = digits(chat.wa_chatid.split('@')[0]);
    const label = `${i + 1}/${chats.length} ${chat.name || chat.wa_name || phone}`;

    try {
      if (!phone) { empty++; continue; }

      if (!DRY_RUN && !FORCE && (await conversationExists(phone))) {
        console.log(`  [skip] ${label} (${phone}) — already has bot-tracked history`);
        skipped++;
        continue;
      }

      const raw = await fetchChatMessages(chat.wa_chatid);
      const usable = [];
      // raw is newest-first; walk in that order but push into `usable` from the
      // end so we end up chronological (oldest → newest).
      for (const m of raw) {
        const text = extractText(m);
        if (!text) continue;
        usable.push({
          role: m.fromMe ? 'assistant' : 'user',
          content: text,
        });
        if (usable.length >= MAX_HISTORY) break;
      }
      const chronological = usable.reverse();

      if (!chronological.length) {
        console.log(`  [empty] ${label} (${phone}) — no text messages`);
        empty++;
        continue;
      }

      if (DRY_RUN) {
        console.log(`  [dry] ${label} (${phone}) — would import ${chronological.length} msgs`);
      } else {
        await upsertConversation(phone, chronological);
        console.log(`  [ok] ${label} (${phone}) — imported ${chronological.length} msgs`);
      }
      imported++;
    } catch (err) {
      console.error(`  [err] ${label}: ${err.message}`);
      errors++;
    }
  }

  console.log('');
  console.log(`[import] done. imported=${imported} skipped=${skipped} empty=${empty} errors=${errors}`);
}

main().catch((err) => {
  console.error('[import] fatal:', err);
  process.exit(1);
});

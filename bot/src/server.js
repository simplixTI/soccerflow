import 'dotenv/config';
import express from 'express';
import twilio from 'twilio';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { handleIncoming, handleOwnerMessage } from './brain.js';
import { parseIncoming, sendText } from './uazapi.js';
import { setTakeover, clearTakeover, addKbEntry, listKb, deleteKbEntry } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const adminPage = readFileSync(path.join(__dirname, 'admin.html'), 'utf8');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const PORT = process.env.PORT || 3000;

function xmlEscape(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Twilio signature validation middleware.
 * Skipped when TWILIO_VALIDATE_SIGNATURE=false (local dev only).
 */
function twilioSignatureGuard(req, res, next) {
  if (String(process.env.TWILIO_VALIDATE_SIGNATURE).toLowerCase() === 'false') {
    return next();
  }
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const signature = req.headers['x-twilio-signature'];
  if (!authToken || !signature) {
    return res.status(403).send('Missing Twilio signature configuration');
  }
  // Twilio signs the full public URL; behind a proxy (Render/ngrok) trust X-Forwarded-*.
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const url = `${proto}://${host}${req.originalUrl}`;
  const valid = twilio.validateRequest(authToken, signature, url, req.body || {});
  if (!valid) {
    console.warn('[twilio] invalid signature for', url);
    return res.status(403).send('Invalid Twilio signature');
  }
  next();
}

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'soccerflow-bot', time: new Date().toISOString() });
});

// --- SMS via Twilio -------------------------------------------------------
app.post('/webhook/twilio', twilioSignatureGuard, async (req, res) => {
  try {
    const from = req.body.From;
    const body = (req.body.Body || '').trim();
    res.set('Content-Type', 'text/xml');
    if (!from || !body) {
      return res.send('<Response></Response>');
    }

    // Owner commands via SMS: "/assumir +1XXX" / "/voltar +1XXX" / "/ensinar <tipo> <texto>"
    const ownerDigits = (process.env.OWNER_SMS_NUMBER || '').replace(/\D/g, '');
    if (ownerDigits && from.replace(/\D/g, '') === ownerDigits && body.startsWith('/')) {
      let answer;

      // /ensinar <fato|faq|estilo|correcao> <texto> — teach the AI from SMS
      const teach = body.match(/^\/ensinar\s+(\S+)\s+([\s\S]+)/i);
      if (teach) {
        const catMap = { fato: 'business', faq: 'faq', estilo: 'style', correcao: 'correction' };
        const category = catMap[teach[1].toLowerCase()] || 'business';
        const entry = await addKbEntry({ category, text: teach[2], source: 'sms' });
        answer = `Saved ✓ AI now knows this (#${entry.id.slice(-4)}, ${category}). It applies to all conversations immediately.`;
      } else {
        const match = body.match(/^\/(assumir|voltar|takeover|resume)\b\s*(\+?[\d][\d\s()-]*)?/i);
        const cmd = match?.[1]?.toLowerCase();
        const target = match?.[2] ? `+${match[2].replace(/\D/g, '')}` : null;
        if (!cmd || !target) {
          answer = 'Commands: /assumir +1XXX, /voltar +1XXX, /ensinar <fato|faq|estilo|correcao> <text>';
        } else if (cmd === 'assumir' || cmd === 'takeover') {
          await setTakeover('sms', target);
          answer = `OK — AI paused for ${target}. You have control. /voltar ${target} to resume.`;
        } else {
          await clearTakeover('sms', target);
          answer = `OK — AI resumed for ${target}.`;
        }
      }
      return res.send(`<Response><Message>${xmlEscape(answer)}</Message></Response>`);
    }

    const reply = await handleIncoming({ channel: 'sms', phone: from, text: body });
    if (reply == null) {
      return res.send('<Response></Response>'); // takeover active: stay silent
    }
    res.send(`<Response><Message>${xmlEscape(reply)}</Message></Response>`);
  } catch (err) {
    console.error('[twilio webhook] error:', err);
    res.set('Content-Type', 'text/xml');
    res.send('<Response></Response>'); // never 500 Twilio; it would retry
  }
});

// --- WhatsApp via uazapi --------------------------------------------------
app.post('/webhook/uazapi', async (req, res) => {
  // Always 200-ack quickly so uazapi doesn't retry.
  res.status(200).json({ received: true });
  try {
    const incoming = parseIncoming(req.body);
    if (!incoming) {
      console.log('[uazapi webhook] ignored payload:', JSON.stringify(req.body).slice(0, 500));
      return;
    }

    // Message sent by the business number itself (owner typing in the chat).
    if (incoming.fromMe) {
      const ownerReply = await handleOwnerMessage({
        channel: 'whatsapp',
        phone: incoming.phone,
        text: incoming.text,
      });
      if (ownerReply) {
        try {
          await sendText(incoming.phone, ownerReply);
        } catch (err) {
          console.error('[uazapi webhook] failed to send owner-command reply:', err.message);
        }
      }
      return;
    }

    const reply = await handleIncoming({
      channel: 'whatsapp',
      phone: incoming.phone,
      text: incoming.text,
    });
    if (reply == null) return; // takeover active: stay silent
    try {
      await sendText(incoming.phone, reply);
    } catch (err) {
      console.error('[uazapi webhook] failed to send reply:', err.message);
    }
  } catch (err) {
    console.error('[uazapi webhook] error:', err);
  }
});

// --- Admin: living knowledge base (/admin) ------------------------------------
function adminGuard(req, res, next) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return res.status(503).send('ADMIN_TOKEN not configured');
  const key = req.headers['x-admin-key'] || req.query.key;
  if (key !== token) return res.status(401).json({ error: 'invalid admin key' });
  next();
}

app.get('/admin', (req, res) => {
  res.set('Content-Type', 'text/html');
  res.send(adminPage);
});

app.get('/api/kb', adminGuard, async (req, res) => {
  res.json(await listKb());
});

app.post('/api/kb', adminGuard, async (req, res) => {
  const { category, text } = req.body || {};
  if (!text || !String(text).trim()) {
    return res.status(400).json({ error: 'text is required' });
  }
  const entry = await addKbEntry({ category, text, source: 'admin-page' });
  res.status(201).json(entry);
});

app.delete('/api/kb/:id', adminGuard, async (req, res) => {
  await deleteKbEntry(req.params.id);
  res.json({ ok: true });
});

// Error handler — last line of defense, never crash the process.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[express] unhandled error:', err);
  if (!res.headersSent) res.status(500).json({ error: 'internal error' });
});

app.listen(PORT, () => {
  console.log(`Soccer Flow bot listening on port ${PORT}`);
});

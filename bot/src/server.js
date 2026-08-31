import 'dotenv/config';
import express from 'express';
import twilio from 'twilio';
import { handleIncoming } from './brain.js';
import { parseIncoming, sendText } from './uazapi.js';

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
    if (!from || !body) {
      res.set('Content-Type', 'text/xml');
      return res.send('<Response></Response>');
    }
    const reply = await handleIncoming({ channel: 'sms', phone: from, text: body });
    res.set('Content-Type', 'text/xml');
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
    const reply = await handleIncoming({
      channel: 'whatsapp',
      phone: incoming.phone,
      text: incoming.text,
    });
    try {
      await sendText(incoming.phone, reply);
    } catch (err) {
      console.error('[uazapi webhook] failed to send reply:', err.message);
    }
  } catch (err) {
    console.error('[uazapi webhook] error:', err);
  }
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

/**
 * Twilio SMS webhook (replaces the Express /webhook/twilio route).
 * - Validates the Twilio signature (skip with TWILIO_VALIDATE_SIGNATURE=false).
 * - Owner commands from OWNER_SMS_NUMBER:
 *     /ensinar <fato|faq|estilo|correcao> <texto>
 *     /assumir +1XXX   /voltar +1XXX   (aliases: /takeover /resume)
 * - Otherwise runs the conversation brain and replies via TwiML.
 * NEVER returns 500 to Twilio (it would retry); errors -> empty <Response/>.
 */
import { handleIncoming } from '../_shared/brain.ts';
import { setTakeover, clearTakeover, addKbEntry } from '../_shared/store.ts';
import { validateTwilioSignature } from '../_shared/twilio.ts';

function xmlEscape(str: unknown): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function twiml(inner: string): Response {
  return new Response(`<Response>${inner}</Response>`, {
    status: 200,
    headers: { 'Content-Type': 'text/xml' },
  });
}

Deno.serve(async (req: Request) => {
  try {
    if (req.method !== 'POST') return twiml('');

    const form = await req.formData();
    const params: Record<string, string> = {};
    for (const [key, value] of form.entries()) params[key] = String(value);

    // Twilio signature validation.
    // Skipped when TWILIO_VALIDATE_SIGNATURE=false (local dev only).
    if (String(Deno.env.get('TWILIO_VALIDATE_SIGNATURE')).toLowerCase() !== 'false') {
      const authToken = Deno.env.get('TWILIO_AUTH_TOKEN');
      const signature = req.headers.get('x-twilio-signature');
      if (!authToken || !signature) {
        return new Response('Missing Twilio signature configuration', { status: 403 });
      }
      // Twilio signs the PUBLIC URL configured in its console. Inside the
      // edge runtime req.url may differ (internal host / stripped path),
      // so validate against both candidates.
      const publicUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/twilio-webhook`;
      let valid = false;
      for (const candidate of [publicUrl, req.url]) {
        if (await validateTwilioSignature(authToken, signature, candidate, params)) {
          valid = true;
          break;
        }
      }
      if (!valid) {
        console.warn('[twilio] invalid signature. req.url =', req.url);
        return new Response('Invalid Twilio signature', { status: 403 });
      }
    }

    const from = params.From;
    const body = (params.Body || '').trim();
    if (!from || !body) return twiml('');

    // Owner commands via SMS: "/assumir +1XXX" / "/voltar +1XXX" / "/ensinar <tipo> <texto>"
    const ownerDigits = (Deno.env.get('OWNER_SMS_NUMBER') || '').replace(/\D/g, '');
    if (ownerDigits && from.replace(/\D/g, '') === ownerDigits && body.startsWith('/')) {
      let answer: string;

      // /ensinar <fato|faq|estilo|correcao> <texto> — teach the AI from SMS
      const teach = body.match(/^\/ensinar\s+(\S+)\s+([\s\S]+)/i);
      if (teach) {
        const catMap: Record<string, string> = { fato: 'business', faq: 'faq', estilo: 'style', correcao: 'correction' };
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
      return twiml(`<Message>${xmlEscape(answer)}</Message>`);
    }

    const reply = await handleIncoming({ channel: 'sms', phone: from, text: body });
    if (reply == null) {
      return twiml(''); // takeover active: stay silent
    }
    return twiml(`<Message>${xmlEscape(reply)}</Message>`);
  } catch (err) {
    console.error('[twilio webhook] error:', err);
    return twiml(''); // never 500 Twilio; it would retry
  }
});

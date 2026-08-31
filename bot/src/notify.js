import twilio from 'twilio';
import { sendText as sendWhatsApp } from './uazapi.js';

/**
 * Notify the owner about a qualified lead or a human-handoff request.
 * Sends via BOTH WhatsApp (uazapi) and SMS (Twilio REST API).
 * Failures are logged, never thrown — the parent must still get a reply.
 */
export async function notifyOwner({ lead, kind, reason }) {
  const lines = [
    kind === 'LEAD_QUALIFIED' ? '⚽ New QUALIFIED LEAD (Soccer Flow)' : '🙋 HUMAN HANDOFF REQUEST (Soccer Flow)',
    `Channel: ${lead.channel}`,
    `Phone: ${lead.phone}`,
    `Parent: ${lead.parentName || '-'}`,
    `Child: ${lead.childName || '-'}`,
    `Age: ${lead.childAge || '-'}`,
    `Area: ${lead.area || '-'}`,
    `Preferred: ${lead.preferredTime || '-'}`,
  ];
  if (reason) lines.push(`Reason: ${reason}`);
  const summary = lines.join('\n');

  const tasks = [];

  if (process.env.OWNER_WHATSAPP_NUMBER) {
    tasks.push(
      sendWhatsApp(process.env.OWNER_WHATSAPP_NUMBER, summary).catch((err) => {
        console.error('[notify] WhatsApp to owner failed:', err.message);
      })
    );
  } else {
    console.warn('[notify] OWNER_WHATSAPP_NUMBER not set, skipping WhatsApp notification');
  }

  if (process.env.OWNER_SMS_NUMBER) {
    tasks.push(
      sendOwnerSms(summary).catch((err) => {
        console.error('[notify] SMS to owner failed:', err.message);
      })
    );
  } else {
    console.warn('[notify] OWNER_SMS_NUMBER not set, skipping SMS notification');
  }

  await Promise.all(tasks);
}

async function sendOwnerSms(text) {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, OWNER_SMS_NUMBER } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
    throw new Error('Twilio env vars (SID / token / TWILIO_PHONE_NUMBER) not set');
  }
  const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  await client.messages.create({
    from: TWILIO_PHONE_NUMBER,
    to: OWNER_SMS_NUMBER,
    body: text,
  });
}

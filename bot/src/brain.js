import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chat } from './deepseek.js';
import {
  getHistory,
  appendMessages,
  findLead,
  upsertLead,
  markLeadNotified,
  isTakeover,
  setTakeover,
  clearTakeover,
} from './store.js';
import { notifyOwner } from './notify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const business = JSON.parse(
  readFileSync(path.join(__dirname, '..', 'business.json'), 'utf8')
);

const FALLBACK_REPLY =
  "Hi! Thanks for texting Soccer Flow ⚽ We're having a little technical hiccup — " +
  'the coach will get back to you shortly. You can also call us at ' +
  (business.phone || 'our number') + '.';

function buildSystemPrompt(lead) {
  const knownLead = lead
    ? `RETURNING CONTACT — already collected from this family: ${JSON.stringify({
        parentName: lead.parentName,
        childName: lead.childName,
        childAge: lead.childAge,
        program: lead.program,
        preferredTime: lead.preferredTime,
        state: lead.state,
      })}. Do NOT re-ask fields already collected.`
    : 'New contact — nothing known about this family yet.';

  return `You are the first-contact assistant for "${business['01_company'].name}", a youth soccer program in ${business['01_company'].city}. You reply on SMS/WhatsApp as a friendly member of the Soccer Flow team — natural, warm and human, never like a corporate bot.

KNOWLEDGE BASE (your only source of truth — never go beyond it):
${JSON.stringify(business, null, 2)}

BEHAVIOR RULES:
- LANGUAGE: mirror the customer's language — English, Spanish or Portuguese. Default English. Never switch unless the customer does.
- STYLE: follow 12_communication_style. SHORT progressive messages, max 320 characters, 1-3 sentences. Never dump all information at once. Never pushy with sales.
- FIRST IDENTIFY who is writing: (1) new family interested in Soccer Flow, (2) family with a child already enrolled, (3) family that already did or scheduled a free trial, (4) other reason. Use the known-contact info below before asking unnecessary questions.
- NEW LEADS — main goal: book the FREE TRIAL class. Converse gradually, ONE question at a time. Get the child's name and age early — the age determines the program (see age_to_program_rule). Recommend the program, present its available days/times from 03_schedule, and offer the free trial.
- Collect before booking the trial (one at a time, never re-ask known fields): child's name, child's age, parent/guardian name, preferred day/time. The phone number is already known.
- LEAD_QUALIFIED: childName, childAge, parentName and preferredTime are all collected. Confirm clearly in one message: child's name, program, day, time, location (Liberty Station) — plus the trial instructions from 06_free_trial (arrive 5-10 min early, comfortable clothes, cleats not required, water).
- QUESTION: parent asking about the program, prices, schedules, policies, or a current member with a basic question. Answer ONLY from the knowledge base.
- PRICING: use 05_pricing exactly. Sibling discount: say special sibling pricing exists and the team will confirm the exact amount — then hand off.
- ENROLLMENT/PAYMENT LINKS: never send payment or enrollment links before the child has done the trial and the parent shows interest in continuing. Only share links listed in 10_links — never create or guess links. If a link is "TODO", hand off instead.
- WEATHER: never assume a class is canceled. Follow 08_policies.weather — check current_class_status; if it is WAITING FOR WEATHER UPDATE, say conditions are being checked and the family will be updated.
- NEVER invent prices, schedules, addresses, availability, discounts or policies. If something is "TODO", missing, or you are not sure: say someone from the Soccer Flow team will follow up, set handoff=true with handoff_reason.
- HUMAN_HANDOFF / handoff=true: anything in 11_human_escalation, the customer asks for a person, is upset, or you are unsure. Reply warmly that the team will personally follow up soon.
- ${knownLead}

OUTPUT FORMAT: respond with STRICT JSON only, no markdown, no extra text:
{"reply": "...", "state": "QUESTION|LEAD_IN_PROGRESS|LEAD_QUALIFIED|HUMAN_HANDOFF", "lead": {"parentName": null, "childName": null, "childAge": null, "program": null, "preferredTime": null}, "handoff": false, "handoff_reason": null}
- In "lead", include every field known so far (carry forward previously collected values), null for missing ones. "program" is derived from the child's age per age_to_program_rule.
- handoff must be true whenever state is LEAD_QUALIFIED or HUMAN_HANDOFF.`;
}

/**
 * Shared conversation logic used by both SMS and WhatsApp channels.
 * Returns the reply text to send back to the parent, or null when the bot
 * must stay silent (human takeover active). Never throws.
 */
export async function handleIncoming({ channel, phone, text }) {
  try {
    // Human takeover: the owner is handling this conversation manually.
    // Record the parent's message for context but stay silent.
    if (await isTakeover(channel, phone)) {
      await appendMessages(channel, phone, [{ role: 'user', content: text }]);
      console.log(`[brain] takeover active for ${channel}:${phone} — staying silent`);
      return null;
    }

    const existingLead = await findLead(channel, phone);
    const history = await getHistory(channel, phone);

    const result = await chat({
      systemPrompt: buildSystemPrompt(existingLead),
      messages: [...history, { role: 'user', content: text }],
    });

    // Persist conversation turn.
    await appendMessages(channel, phone, [
      { role: 'user', content: text },
      { role: 'assistant', content: result.reply },
    ]);

    // Persist lead progress if the model captured anything or state is lead-ish.
    const hasLeadData = Object.values(result.lead).some((v) => v != null && v !== '');
    if (hasLeadData || result.state === 'LEAD_IN_PROGRESS' || result.state === 'LEAD_QUALIFIED') {
      await upsertLead(channel, phone, result.lead, result.state);
    }

    // Owner notification: LEAD_QUALIFIED (once per lead) or HUMAN_HANDOFF.
    const lead = await findLead(channel, phone);
    if (result.state === 'LEAD_QUALIFIED' && lead && !lead.ownerNotified) {
      await notifyOwner({ lead, kind: 'LEAD_QUALIFIED', reason: result.handoff_reason });
      await markLeadNotified(channel, phone);
    } else if (result.handoff && result.state === 'HUMAN_HANDOFF') {
      await notifyOwner({
        lead: lead || { channel, phone },
        kind: 'HUMAN_HANDOFF',
        reason: result.handoff_reason,
      });
    }

    return result.reply;
  } catch (err) {
    console.error(`[brain] error handling ${channel}:${phone}:`, err.message);
    return FALLBACK_REPLY;
  }
}

const TAKEOVER_REPLY =
  "You're now chatting directly with the Soccer Flow team ⚽ We'll take it from here!";
const RESUME_REPLY =
  'Thanks for your patience! Our assistant is back and happy to help ⚽';

/**
 * Handle a message sent BY the business number itself (owner typing in the
 * customer chat, delivered via the uazapi fromMe webhook).
 *
 * Commands:
 *   /assumir — owner takes over; the AI goes silent in this conversation
 *   /voltar  — AI resumes control
 *
 * Returns a customer-facing message to send into the chat, or null.
 * While takeover is active, non-command owner messages are recorded as
 * assistant messages so the AI has full context when it resumes.
 */
export async function handleOwnerMessage({ channel, phone, text }) {
  try {
    const cmd = text.trim().toLowerCase();
    if (cmd === '/assumir' || cmd === '/takeover') {
      await setTakeover(channel, phone);
      console.log(`[brain] takeover ON for ${channel}:${phone}`);
      return TAKEOVER_REPLY;
    }
    if (cmd === '/voltar' || cmd === '/resume') {
      await clearTakeover(channel, phone);
      console.log(`[brain] takeover OFF for ${channel}:${phone}`);
      return RESUME_REPLY;
    }
    // Not a command. If takeover is active, this is the owner talking to the
    // customer — record it as an assistant message for AI context. Otherwise
    // it's an echo of the bot's own API reply: ignore.
    if (await isTakeover(channel, phone)) {
      await appendMessages(channel, phone, [{ role: 'assistant', content: text }]);
    }
    return null;
  } catch (err) {
    console.error(`[brain] error handling owner message for ${channel}:${phone}:`, err.message);
    return null;
  }
}

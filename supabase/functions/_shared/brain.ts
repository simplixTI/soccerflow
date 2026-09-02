/**
 * Conversation brain (port of bot/src/brain.js).
 * Shared conversation logic used by both SMS and WhatsApp channels.
 */
import { chat } from './deepseek.ts';
import {
  getHistory,
  appendMessages,
  findLead,
  upsertLead,
  markLeadNotified,
  isTakeover,
  setTakeover,
  clearTakeover,
  getKbPromptSection,
  type Lead,
} from './store.ts';
import { notifyOwner } from './notify.ts';
import business from './business.json' with { type: 'json' };

const FALLBACK_REPLY =
  "Hi! Thanks for texting Soccer Flow ⚽ We're having a little technical hiccup — " +
  'the coach will get back to you shortly. You can also call us at ' +
  // Note: the original brain.js read `business.phone`, which does not exist
  // in business.json, so this was always the fallback text. Kept as-is.
  (((business as unknown) as Record<string, unknown>).phone || 'our number') + '.';

function buildSystemPrompt(lead: Lead | null, kbSection: string, hasHistory: boolean): string {
  const leadJson = lead
    ? JSON.stringify({
        parentName: lead.parentName,
        childName: lead.childName,
        childAge: lead.childAge,
        program: lead.program,
        preferredTime: lead.preferredTime,
        state: lead.state,
      })
    : null;

  const knownLead = lead
    ? `RETURNING CONTACT — structured data captured so far: ${leadJson}. Do NOT re-ask fields already filled in. Fields shown as null may STILL have been answered in the chat history (a human teammate often replies manually without updating the structured record) — always scan the history for the answer BEFORE asking the customer again.`
    : hasHistory
      ? 'RETURNING CONTACT — you have spoken with this family before. Prior messages are in the chat history below (some may have been typed manually by a human teammate — treat them as fully authoritative). USE them: acknowledge continuity, do NOT restart from scratch, and do NOT ask anything already discussed.'
      : 'New contact — nothing known about this family yet.';

  const historyRule = hasHistory
    ? '\n- CONTEXT-FIRST — before asking ANY question (child name/age, parent name, preferred day/time, program, etc.), scan the full chat history above. If the answer is anywhere in it (from you OR from a manual reply by the team), use it directly instead of asking again. Re-asking answered questions confuses returning customers and MUST be avoided.'
    : '';

  const extraKnowledge = kbSection
    ? `\n\nTEAM TEACHINGS (added over time by the Soccer Flow team — authoritative; they refine and may override the base knowledge above):\n${kbSection}`
    : '';

  return `You are the first-contact assistant for "${business['01_company'].name}", a youth soccer program in ${business['01_company'].city}. You reply on SMS/WhatsApp as a friendly member of the Soccer Flow team — natural, warm and human, never like a corporate bot.

KNOWLEDGE BASE (your only source of truth — never go beyond it):
${JSON.stringify(business, null, 2)}${extraKnowledge}

BEHAVIOR RULES:
- LANGUAGE: mirror the customer's language — English, Spanish or Portuguese. Default English. Never switch unless the customer does.
- STYLE: follow 12_communication_style. SHORT progressive messages (target 150-300 chars, hard cap ~700). ALWAYS end at a complete sentence — never leave a message mid-thought or mid-word. Never dump all information at once. Never pushy with sales.
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
- ${knownLead}${historyRule}

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
export async function handleIncoming(
  { channel, phone, text }: { channel: string; phone: string; text: string },
): Promise<string | null> {
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
    const kbSection = await getKbPromptSection();

    const result = await chat({
      systemPrompt: buildSystemPrompt(existingLead, kbSection, history.length > 0),
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
    console.error(`[brain] error handling ${channel}:${phone}:`, (err as Error).message);
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
 *   /assumir — owner takes over explicitly; the AI goes silent
 *   /voltar  — AI resumes control immediately
 *
 * AUTO-TAKEOVER: any non-command owner message was typed manually (bot API
 * replies are excluded at the webhook level via wasSentByApi), so it also
 * triggers a takeover: the AI goes silent and the message is recorded as
 * assistant context for when the AI resumes — via /voltar or automatically
 * when the takeover TTL (TAKEOVER_TTL_HOURS, default 24h) expires.
 *
 * Returns a customer-facing message to send into the chat, or null.
 */
export async function handleOwnerMessage(
  { channel, phone, text }: { channel: string; phone: string; text: string },
): Promise<string | null> {
  try {
    const cmd = text.trim().toLowerCase();
    if (cmd === '/assumir' || cmd === '/takeover') {
      await setTakeover(channel, phone);
      console.log(`[brain] takeover ON (explicit) for ${channel}:${phone}`);
      return TAKEOVER_REPLY;
    }
    if (cmd === '/voltar' || cmd === '/resume') {
      await clearTakeover(channel, phone);
      console.log(`[brain] takeover OFF for ${channel}:${phone}`);
      return RESUME_REPLY;
    }
    // Not a command: manual owner message → automatic takeover.
    await setTakeover(channel, phone);
    await appendMessages(channel, phone, [{ role: 'assistant', content: text }]);
    console.log(`[brain] auto-takeover for ${channel}:${phone} (owner typed manually)`);
    return null;
  } catch (err) {
    console.error(`[brain] error handling owner message for ${channel}:${phone}:`, (err as Error).message);
    return null;
  }
}

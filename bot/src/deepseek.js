const API_URL = 'https://api.deepseek.com/chat/completions';

/**
 * Call DeepSeek's OpenAI-compatible chat API.
 * Expects the model to return strict JSON:
 *   { reply, state, lead: {...}, handoff, handoff_reason }
 * Parses defensively; throws on HTTP/transport errors so the caller
 * can fall back to a graceful message.
 */
export async function chat({ systemPrompt, messages }) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is not set');

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      response_format: { type: 'json_object' },
      temperature: 0.4,
      max_tokens: 400,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`DeepSeek API error ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('DeepSeek returned an empty response');

  return parseModelOutput(content);
}

function parseModelOutput(content) {
  let parsed = null;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Defensive: try to pull a JSON object out of surrounding prose.
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        parsed = null;
      }
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    // Plain-text fallback: treat the whole content as the reply.
    return {
      reply: content.slice(0, 320),
      state: 'QUESTION',
      lead: {},
      handoff: false,
      handoff_reason: null,
    };
  }

  const validStates = ['QUESTION', 'LEAD_IN_PROGRESS', 'LEAD_QUALIFIED', 'HUMAN_HANDOFF'];
  const lead = (parsed.lead && typeof parsed.lead === 'object') ? parsed.lead : {};

  return {
    reply: String(parsed.reply || '').slice(0, 320) ||
      "Thanks for reaching out to Soccer Flow! How can I help you today?",
    state: validStates.includes(parsed.state) ? parsed.state : 'QUESTION',
    lead: {
      parentName: lead.parentName ?? null,
      childName: lead.childName ?? null,
      childAge: lead.childAge ?? null,
      area: lead.area ?? null,
      preferredTime: lead.preferredTime ?? null,
    },
    handoff: Boolean(parsed.handoff),
    handoff_reason: parsed.handoff_reason ? String(parsed.handoff_reason) : null,
  };
}

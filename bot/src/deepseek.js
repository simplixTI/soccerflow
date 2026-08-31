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

  // DeepSeek occasionally returns whitespace-only content with json_object
  // mode (finish_reason "stop"). Retry, and on the last attempt drop
  // response_format entirely (parseModelOutput extracts the JSON anyway).
  const MAX_ATTEMPTS = 3;
  let lastContent = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const useJsonMode = attempt < MAX_ATTEMPTS;
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        ...(useJsonMode ? { response_format: { type: 'json_object' } } : {}),
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
    if (process.env.DEBUG_DEEPSEEK) {
      console.error('[deepseek] finish_reason:', data?.choices?.[0]?.finish_reason);
      console.error('[deepseek] raw content:', JSON.stringify(content));
    }

    if (content && content.trim()) return parseModelOutput(content);

    lastContent = content;
    console.warn(`[deepseek] whitespace-only response (attempt ${attempt}/${MAX_ATTEMPTS}, json_mode=${useJsonMode})`);
  }

  throw new Error(`DeepSeek returned only whitespace after ${MAX_ATTEMPTS} attempts: ${JSON.stringify(lastContent)}`);
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
      program: lead.program ?? null,
      preferredTime: lead.preferredTime ?? null,
    },
    handoff: Boolean(parsed.handoff),
    handoff_reason: parsed.handoff_reason ? String(parsed.handoff_reason) : null,
  };
}

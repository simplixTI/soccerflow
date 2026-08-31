/**
 * Dependency-free Twilio helpers (no npm:twilio).
 * - validateTwilioSignature: per Twilio docs — sort POST params by key,
 *   append key+value to the full URL string, HMAC-SHA1 with the auth token,
 *   base64, constant-time-ish compare. Uses Web Crypto.
 * - sendSms: POST form-encoded to the Twilio REST API with basic auth.
 */

function toBase64(buf: ArrayBuffer): string {
  let s = '';
  for (const byte of new Uint8Array(buf)) s += String.fromCharCode(byte);
  return btoa(s);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Validate the X-Twilio-Signature header for an incoming webhook.
 * `url` must be the full public request URL Twilio POSTed to;
 * `params` are the POST form fields as a plain string map.
 */
export async function validateTwilioSignature(
  authToken: string,
  signature: string,
  url: string,
  params: Record<string, string>,
): Promise<boolean> {
  let data = url;
  for (const key of Object.keys(params).sort()) {
    data += key + params[key];
  }
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(authToken),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return timingSafeEqual(toBase64(sig), signature);
}

/**
 * Send an SMS via the Twilio REST API.
 * Throws on failure — callers must catch and log.
 */
// deno-lint-ignore no-explicit-any
export async function sendSms(
  { from, to, body }: { from: string; to: string; body: string },
): Promise<any> {
  const sid = Deno.env.get('TWILIO_ACCOUNT_SID');
  const authToken = Deno.env.get('TWILIO_AUTH_TOKEN');
  if (!sid || !authToken) {
    throw new Error('Twilio env vars (SID / token) not set');
  }

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${btoa(`${sid}:${authToken}`)}`,
      },
      body: new URLSearchParams({ From: from, To: to, Body: body }).toString(),
    },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Twilio Messages API failed ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json().catch(() => ({}));
}

/**
 * Admin function (replaces the Express /admin page + /api/kb routes).
 * - GET any path without /api/  -> the admin HTML page (text/html).
 * - GET    ./api/kb             -> list knowledge entries (JSON).
 * - POST   ./api/kb {category,text} -> add entry (201 JSON).
 * - DELETE ./api/kb/:id         -> delete entry ({ok:true}).
 *
 * Auth (same adminGuard semantics): ADMIN_TOKEN env required; accept the
 * `x-admin-key` header or `?key=` query param; 401 JSON on mismatch,
 * 503 when ADMIN_TOKEN is unset. The HTML page itself is unguarded,
 * exactly like the original. CORS is open on the API (`*`).
 */
import { addKbEntry, listKb, deleteKbEntry } from '../_shared/store.ts';
import { indexKbEntry } from '../_shared/kb-index.ts';
import { currentTimeAnchor } from '../_shared/brain.ts';
import { ADMIN_HTML } from './page.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-admin-key',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

/** Returns a Response when the request must be rejected, null when allowed. */
function adminGuard(req: Request, url: URL): Response | null {
  const token = Deno.env.get('ADMIN_TOKEN');
  if (!token) return json({ error: 'ADMIN_TOKEN not configured' }, 503);
  const key = req.headers.get('x-admin-key') || url.searchParams.get('key');
  if (key !== token) return json({ error: 'invalid admin key' }, 401);
  return null;
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname;

  // CORS preflight.
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const apiIndex = path.indexOf('/api/kb');
  const isBalance = path.endsWith('/api/balance');
  const isAnchor = path.endsWith('/api/anchor');
  if (apiIndex === -1 && !isBalance && !isAnchor) {
    // Admin HTML page (unguarded — the page itself asks for the key).
    const headers = new Headers(CORS_HEADERS);
    headers.set('Content-Type', 'text/html; charset=utf-8');
    return new Response(ADMIN_HTML, { status: 200, headers });
  }

  // JSON API — everything below is behind the admin guard.
  const rejected = adminGuard(req, url);
  if (rejected) return rejected;

  if (isBalance) {
    try {
      return json(await fetchBalances());
    } catch (err) {
      console.error('[admin] balance error:', err);
      return json({ error: 'balance unavailable' }, 500);
    }
  }

  // Diagnostic: the exact TIME ANCHOR text the bot receives right now.
  if (isAnchor) {
    return json({ server_utc: new Date().toISOString(), anchor: currentTimeAnchor() });
  }

  try {
    const rest = path.slice(apiIndex + '/api/kb'.length); // '' or '/:id'

    if (req.method === 'GET' && (rest === '' || rest === '/')) {
      return json(await listKb());
    }

    if (req.method === 'POST' && (rest === '' || rest === '/')) {
      const body = await req.json().catch(() => null);
      const { category, text } = body || {};
      if (!text || !String(text).trim()) {
        return json({ error: 'text is required' }, 400);
      }
      const entry = await addKbEntry({ category, text, source: 'admin-page' });
      // Index immediately so the teaching is live in RAG on the next message.
      // If embedding fails we still keep the entry (it is in kb_entries and the
      // legacy dump fallback can see it) and report the problem to the page.
      let chunks = 0;
      let indexError: string | null = null;
      try {
        chunks = await indexKbEntry(entry);
      } catch (err) {
        indexError = (err as Error).message;
        console.error('[admin] indexing failed for', entry.id, indexError);
      }
      return json({ ...entry, chunks, indexError }, 201);
    }

    if (req.method === 'DELETE' && rest.startsWith('/')) {
      const id = decodeURIComponent(rest.slice(1));
      await deleteKbEntry(id);
      return json({ ok: true });
    }

    return json({ error: 'not found' }, 404);
  } catch (err) {
    console.error('[admin] error:', err);
    return json({ error: 'internal error' }, 500);
  }
});

// --- API balance route (separate server block so the /api/kb matching above
// doesn't fight us). Actually we handle it inline below:
async function fetchBalances(): Promise<unknown> {
  const result: Record<string, unknown> = {
    deepseek: null,
    openai: {
      configured: !!Deno.env.get('OPENAI_API_KEY'),
      dashboard_url: 'https://platform.openai.com/settings/organization/billing/overview',
    },
  };

  const dsKey = Deno.env.get('DEEPSEEK_API_KEY');
  if (dsKey) {
    try {
      const res = await fetch('https://api.deepseek.com/user/balance', {
        headers: { Authorization: `Bearer ${dsKey}` },
      });
      if (res.ok) {
        const data = await res.json();
        const usd = (data.balance_infos || []).find((b: { currency: string }) => b.currency === 'USD');
        result.deepseek = {
          is_available: !!data.is_available,
          total_balance: usd?.total_balance ?? null,
          currency: 'USD',
        };
      } else {
        result.deepseek = { error: `HTTP ${res.status}` };
      }
    } catch (err) {
      result.deepseek = { error: (err as Error).message };
    }
  }

  return result;
}

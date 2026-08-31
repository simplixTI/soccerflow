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
  if (apiIndex === -1) {
    // Admin HTML page (unguarded — the page itself asks for the key).
    return new Response(ADMIN_HTML, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS },
    });
  }

  // KB JSON API — everything below is behind the admin guard.
  const rejected = adminGuard(req, url);
  if (rejected) return rejected;

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
      return json(entry, 201);
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

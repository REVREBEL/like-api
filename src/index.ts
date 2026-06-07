type CounterRow = {
  slug: string;
  likes: number;
  views: number;
  created_at?: string;
  updated_at?: string;
};

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };

const JS_CLIENT = `(() => {
  const API_BASE = (window.LIKES_API_BASE || '').replace(/\/$/, '');

  const getSlug = (el, attr) => el.getAttribute(attr) || el.getAttribute('data-storage-key') || window.location.pathname.replace(/^\/+|\/+$/g, '') || 'home';
  const fmt = (value) => Number(value || 0).toLocaleString();

  async function request(path, body) {
    const response = await fetch(API_BASE + path, {
      method: 'POST',
      mode: 'cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }

  async function getStats(slug) {
    const response = await fetch(API_BASE + '/api/stats/' + encodeURIComponent(slug), {
      mode: 'cors'
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }

  function updateMetrics(slug, stats) {
    document.querySelectorAll('[data-metric-like="' + CSS.escape(slug) + '"]').forEach((el) => el.textContent = fmt(stats.likes));
    document.querySelectorAll('[data-metric-view="' + CSS.escape(slug) + '"]').forEach((el) => el.textContent = fmt(stats.views));
  }

  async function hydrate(slug) {
    try {
      const stats = await getStats(slug);
      updateMetrics(slug, stats);
    } catch (error) {
      console.warn('[REVREBEL likes] stats failed', error);
    }
  }

  function initLikes() {
    document.querySelectorAll('[data-action-like]').forEach((button) => {
      const slug = getSlug(button, 'data-action-like');
      const storageKey = 'revrebel-like:' + (button.getAttribute('data-storage-key') || slug);
      const liked = localStorage.getItem(storageKey) === '1';
      button.classList.toggle('is-liked', liked);
      button.setAttribute('aria-pressed', liked ? 'true' : 'false');
      hydrate(slug);

      button.addEventListener('click', async () => {
        const alreadyLiked = localStorage.getItem(storageKey) === '1';
        const path = alreadyLiked ? '/api/likes/decrement' : '/api/likes/increment';
        button.disabled = true;
        try {
          const stats = await request(path, { slug });
          localStorage.setItem(storageKey, alreadyLiked ? '0' : '1');
          button.classList.toggle('is-liked', !alreadyLiked);
          button.setAttribute('aria-pressed', !alreadyLiked ? 'true' : 'false');
          updateMetrics(slug, stats);
          window.dispatchEvent(new CustomEvent('like:toggled', { detail: { slug, liked: !alreadyLiked, stats } }));
        } catch (error) {
          console.warn('[REVREBEL likes] toggle failed', error);
        } finally {
          button.disabled = false;
        }
      });
    });
  }

  function initViews() {
    document.querySelectorAll('[data-action-view]').forEach(async (el) => {
      const slug = getSlug(el, 'data-action-view');
      const sessionKey = 'revrebel-view:' + slug;
      if (sessionStorage.getItem(sessionKey) === '1') {
        hydrate(slug);
        return;
      }
      sessionStorage.setItem(sessionKey, '1');
      try {
        const stats = await request('/api/views/increment', { slug });
        updateMetrics(slug, stats);
      } catch (error) {
        console.warn('[REVREBEL likes] view failed', error);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { initLikes(); initViews(); });
  } else {
    initLikes();
    initViews();
  }
})();`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request, env) });

    try {
      if (url.pathname === '/') {
        return json(request, env, {
          ok: true,
          service: 'revrebel-like-api',
          storage: 'd1',
          endpoints: [
            'GET /api/health',
            'GET /likes-views-devlink.js',
            'POST /api/views/increment',
            'POST /api/likes/increment',
            'POST /api/likes/decrement',
            'GET /api/stats/:slug'
          ]
        });
      }
      if (url.pathname === '/api/health') return health(request, env);
      if (url.pathname === '/likes-views-devlink.js') {
        return new Response(JS_CLIENT, {
          headers: {
            ...corsHeaders(request, env),
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'public, max-age=300'
          }
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/views/increment') {
        const slug = await getSlugFromBody(request);
        return json(request, env, await incrementCounter(env, request, slug, 'view', 1));
      }

      if (request.method === 'POST' && url.pathname === '/api/likes/increment') {
        const slug = await getSlugFromBody(request);
        return json(request, env, await incrementCounter(env, request, slug, 'like', 1));
      }

      if (request.method === 'POST' && url.pathname === '/api/likes/decrement') {
        const slug = await getSlugFromBody(request);
        return json(request, env, await incrementCounter(env, request, slug, 'like', -1));
      }

      const statsMatch = url.pathname.match(/^\/api\/stats\/(.+)$/);
      if (request.method === 'GET' && statsMatch) {
        const slug = normalizeSlug(decodeURIComponent(statsMatch[1]));
        return json(request, env, await getStats(env, slug));
      }

      return json(request, env, { error: 'Not found' }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      const status = message.includes('slug') ? 400 : 500;
      return json(request, env, { error: message }, status);
    }
  }
};

async function health(request: Request, env: Env): Promise<Response> {
  const result = await env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
  return json(request, env, { ok: result?.ok === 1, database: 'connected' });
}

async function getSlugFromBody(request: Request): Promise<string> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new Error('A JSON body with a slug is required.');
  }

  if (!body || typeof body !== 'object' || !('slug' in body)) {
    throw new Error('A slug is required.');
  }

  return normalizeSlug(String((body as { slug: unknown }).slug));
}

function normalizeSlug(slug: string): string {
  const normalized = slug.trim().toLowerCase().replace(/[^a-z0-9/_-]+/g, '-').replace(/-+/g, '-').replace(/^[-/]+|[-/]+$/g, '');
  if (!normalized) throw new Error('A valid slug is required.');
  if (normalized.length > 240) throw new Error('Slug must be 240 characters or fewer.');
  return normalized;
}

async function getStats(env: Env, slug: string): Promise<CounterRow> {
  const existing = await env.DB.prepare(
    'SELECT slug, likes, views, created_at, updated_at FROM content_counters WHERE slug = ?'
  ).bind(slug).first<CounterRow>();

  return existing ?? { slug, likes: 0, views: 0 };
}

async function incrementCounter(env: Env, request: Request, slug: string, metric: 'like' | 'view', delta: 1 | -1): Promise<CounterRow> {
  const column = metric === 'like' ? 'likes' : 'views';
  const action = delta > 0 ? 'increment' : 'decrement';

  const counterSql = `
    INSERT INTO content_counters (slug, ${column}, created_at, updated_at)
    VALUES (?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(slug) DO UPDATE SET
      ${column} = MAX(0, ${column} + excluded.${column}),
      updated_at = datetime('now')
    RETURNING slug, likes, views, created_at, updated_at
  `;

  const userAgent = request.headers.get('user-agent')?.slice(0, 300) ?? null;

  const counterResult = env.DB.prepare(counterSql).bind(slug, delta);
  const eventResult = env.DB.prepare(
    `INSERT INTO counter_events (slug, metric, action, delta, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`
  ).bind(slug, metric, action, delta, userAgent);

  const results = await env.DB.batch([counterResult, eventResult]);
  const row = results[0].results?.[0] as CounterRow | undefined;

  if (!row) return getStats(env, slug);
  return row;
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const allowed = env.ALLOWED_ORIGINS || '*';
  const origin = request.headers.get('Origin') || '';
  const allowedOrigins = allowed.split(',').map((item) => item.trim()).filter(Boolean);
  const allowOrigin = allowed === '*' || allowedOrigins.includes(origin) ? (allowed === '*' ? '*' : origin) : allowedOrigins[0] || '*';

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin'
  };
}

function json(request: Request, env: Env, body: JsonObject, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(request, env),
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

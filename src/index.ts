type CounterRow = {
  slug: string;
  likes: number;
  views: number;
  created_at?: string;
  updated_at?: string;
};

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      if (!isAllowedOrigin(request, env)) {
        return new Response(null, { status: 403, headers: corsHeaders(request, env) });
      }
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    if (!isAllowedOrigin(request, env)) {
      return json(request, env, { error: 'Origin not allowed.' }, 403);
    }

    try {
      if (url.pathname === '/') {
        return json(request, env, {
          ok: true,
          service: 'like-api',
          storage: 'd1',
          endpoints: [
            'GET /api/health',
            'POST /api/views/increment',
            'POST /api/likes/increment',
            'POST /api/likes/decrement',
            'GET /api/stats/:slug'
          ]
        });
      }

      if (request.method === 'GET' && url.pathname === '/api/health') {
        return health(request, env);
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
      const status = message.toLowerCase().includes('slug') ? 400 : 500;
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
  const normalized = slug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-/]+|[-/]+$/g, '');

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

  return row ?? getStats(env, slug);
}

function isAllowedOrigin(request: Request, env: Env): boolean {
  const allowed = env.ALLOWED_ORIGINS || '*';
  if (allowed === '*') return true;

  const origin = request.headers.get('Origin');
  if (!origin) return true;

  const allowedOrigins = allowed.split(',').map((item) => item.trim()).filter(Boolean);
  return allowedOrigins.includes(origin);
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const allowed = env.ALLOWED_ORIGINS || '*';
  const origin = request.headers.get('Origin') || '';
  const allowedOrigins = allowed.split(',').map((item) => item.trim()).filter(Boolean);
  const allowOrigin = allowed === '*' || allowedOrigins.includes(origin)
    ? (allowed === '*' ? '*' : origin)
    : 'null';

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

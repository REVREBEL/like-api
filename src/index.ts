type CounterRow = {
  slug: string;
  likes: number;
  views: number;
  webflow_item_id?: string | null;
  sync_pending?: number;
  created_at?: string;
  updated_at?: string;
};

type WebflowItem = {
  id: string;
  fieldData?: {
    slug?: string;
  };
};

type WebflowItemsResponse = {
  items?: WebflowItem[];
  pagination?: {
    limit: number;
    offset: number;
    total: number;
  };
};

type SyncResult = {
  pending: number;
  synced: number;
  unmapped: number;
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
          cmsSync: 'Webflow every five minutes',
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
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      syncPendingCounters(env).then((result) => {
        console.log('Webflow counter sync completed', result);
      }).catch((error) => {
        console.error('Webflow counter sync failed', error);
      })
    );
  }
};

async function health(request: Request, env: Env): Promise<Response> {
  const database = await env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
  const pending = await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM content_counters WHERE sync_pending = 1'
  ).first<{ count: number }>();

  return json(request, env, {
    ok: database?.ok === 1,
    database: 'connected',
    pendingWebflowSyncs: Number(pending?.count ?? 0),
    webflowTokenConfigured: Boolean(env.WEBFLOW_API_TOKEN)
  });
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
    `SELECT slug, likes, views, webflow_item_id, sync_pending, created_at, updated_at
     FROM content_counters
     WHERE slug = ?`
  ).bind(slug).first<CounterRow>();

  return existing ?? { slug, likes: 0, views: 0 };
}

async function incrementCounter(
  env: Env,
  request: Request,
  slug: string,
  metric: 'like' | 'view',
  delta: 1 | -1
): Promise<CounterRow> {
  const column = metric === 'like' ? 'likes' : 'views';
  const action = delta > 0 ? 'increment' : 'decrement';

  const counterSql = `
    INSERT INTO content_counters (
      slug,
      ${column},
      sync_pending,
      created_at,
      updated_at
    )
    VALUES (?, ?, 1, datetime('now'), datetime('now'))
    ON CONFLICT(slug) DO UPDATE SET
      ${column} = MAX(0, ${column} + excluded.${column}),
      sync_pending = 1,
      sync_error = NULL,
      updated_at = datetime('now')
    RETURNING
      slug,
      likes,
      views,
      webflow_item_id,
      sync_pending,
      created_at,
      updated_at
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

async function syncPendingCounters(env: Env): Promise<SyncResult> {
  if (!env.WEBFLOW_API_TOKEN) {
    throw new Error('WEBFLOW_API_TOKEN is not configured.');
  }

  if (!env.WEBFLOW_COLLECTION_ID) {
    throw new Error('WEBFLOW_COLLECTION_ID is not configured.');
  }

  const pendingResult = await env.DB.prepare(
    `SELECT slug, likes, views, webflow_item_id
     FROM content_counters
     WHERE sync_pending = 1
     ORDER BY updated_at ASC
     LIMIT 100`
  ).all<CounterRow>();

  const pending = pendingResult.results ?? [];
  if (pending.length === 0) {
    return { pending: 0, synced: 0, unmapped: 0 };
  }

  const needsMapping = pending.some((row) => !row.webflow_item_id);
  const slugMap = needsMapping ? await fetchWebflowSlugMap(env) : new Map<string, string>();

  const mapped: Array<CounterRow & { webflow_item_id: string }> = [];
  const mappingStatements: D1PreparedStatement[] = [];
  const unmappedStatements: D1PreparedStatement[] = [];

  for (const row of pending) {
    const itemId = row.webflow_item_id || slugMap.get(row.slug);

    if (!itemId) {
      unmappedStatements.push(
        env.DB.prepare(
          `UPDATE content_counters
           SET sync_error = ?, updated_at = updated_at
           WHERE slug = ?`
        ).bind('No matching Webflow CMS item was found for this slug.', row.slug)
      );
      continue;
    }

    if (!row.webflow_item_id) {
      mappingStatements.push(
        env.DB.prepare(
          `UPDATE content_counters
           SET webflow_item_id = ?, sync_error = NULL
           WHERE slug = ?`
        ).bind(itemId, row.slug)
      );
    }

    mapped.push({ ...row, webflow_item_id: itemId });
  }

  if (mappingStatements.length > 0) await env.DB.batch(mappingStatements);
  if (unmappedStatements.length > 0) await env.DB.batch(unmappedStatements);

  if (mapped.length === 0) {
    return { pending: pending.length, synced: 0, unmapped: pending.length };
  }

  await updateWebflowItems(env, mapped);
  await publishWebflowItems(env, mapped.map((row) => row.webflow_item_id));

  const completionStatements = mapped.map((row) =>
    env.DB.prepare(
      `UPDATE content_counters
       SET
         synced_likes = ?,
         synced_views = ?,
         sync_pending = CASE
           WHEN likes = ? AND views = ? THEN 0
           ELSE 1
         END,
         last_synced_at = datetime('now'),
         sync_error = NULL
       WHERE slug = ?`
    ).bind(row.likes, row.views, row.likes, row.views, row.slug)
  );

  await env.DB.batch(completionStatements);

  return {
    pending: pending.length,
    synced: mapped.length,
    unmapped: pending.length - mapped.length
  };
}

async function fetchWebflowSlugMap(env: Env): Promise<Map<string, string>> {
  const slugMap = new Map<string, string>();
  let offset = 0;
  const limit = 100;

  while (true) {
    const response = await webflowFetch(
      env,
      `/collections/${env.WEBFLOW_COLLECTION_ID}/items?limit=${limit}&offset=${offset}`,
      { method: 'GET' }
    );

    const data = await response.json<WebflowItemsResponse>();
    const items = data.items ?? [];

    for (const item of items) {
      const slug = item.fieldData?.slug;
      if (slug) slugMap.set(normalizeSlug(slug), item.id);
    }

    const total = data.pagination?.total ?? items.length;
    offset += items.length;

    if (items.length === 0 || offset >= total) break;
  }

  return slugMap;
}

async function updateWebflowItems(
  env: Env,
  rows: Array<CounterRow & { webflow_item_id: string }>
): Promise<void> {
  await webflowFetch(env, `/collections/${env.WEBFLOW_COLLECTION_ID}/items`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: rows.map((row) => ({
        id: row.webflow_item_id,
        fieldData: {
          likes: row.likes,
          views: row.views
        }
      }))
    })
  });
}

async function publishWebflowItems(env: Env, itemIds: string[]): Promise<void> {
  await webflowFetch(env, `/collections/${env.WEBFLOW_COLLECTION_ID}/items/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemIds })
  });
}

async function webflowFetch(env: Env, path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${env.WEBFLOW_API_TOKEN}`);
  headers.set('Accept', 'application/json');

  const response = await fetch(`https://api.webflow.com/v2${path}`, {
    ...init,
    headers
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(`Webflow API ${response.status}: ${responseBody.slice(0, 500)}`);
  }

  return response;
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

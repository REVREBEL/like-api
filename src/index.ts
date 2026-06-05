type Stats = {
  slug: string;
  likes: number;
  views: number;
  updatedAt: string;
};

type IncrementBody = {
  slug?: string;
};

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

function getCorsHeaders(request: Request, env: Env): HeadersInit {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '*')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  const allowOrigin =
    allowed.includes('*') || !origin
      ? '*'
      : allowed.includes(origin)
        ? origin
        : allowed[0] || '*';

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(request: Request, env: Env, data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...JSON_HEADERS,
      ...getCorsHeaders(request, env),
    },
  });
}

function text(request: Request, env: Env, body: string, contentType = 'text/plain; charset=utf-8', status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=300',
      ...getCorsHeaders(request, env),
    },
  });
}

function normalizeSlug(input: unknown): string | null {
  if (typeof input !== 'string') return null;

  const slug = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[#?].*$/, '')
    .replace(/\/+$/, '')
    .replace(/[^a-z0-9/_:.-]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 250);

  return slug.length ? slug : null;
}

function statsKey(slug: string): string {
  return `stats:${slug}`;
}

async function readStats(env: Env, slug: string): Promise<Stats> {
  const existing = await env.LIKES_VIEWS_KV.get<Stats>(statsKey(slug), 'json');

  return {
    slug,
    likes: Math.max(0, Number(existing?.likes || 0)),
    views: Math.max(0, Number(existing?.views || 0)),
    updatedAt: existing?.updatedAt || new Date(0).toISOString(),
  };
}

async function writeStats(env: Env, stats: Stats): Promise<void> {
  await env.LIKES_VIEWS_KV.put(statsKey(stats.slug), JSON.stringify(stats));
}

async function updateCounter(env: Env, slug: string, field: 'likes' | 'views', delta: number): Promise<Stats> {
  // KV is eventually consistent and not ideal for high-concurrency counters.
  // For blog/article interactions this is usually fine. For strict counters,
  // move this update function into a Durable Object later.
  const stats = await readStats(env, slug);
  stats[field] = Math.max(0, stats[field] + delta);
  stats.updatedAt = new Date().toISOString();
  await writeStats(env, stats);
  return stats;
}

async function parseSlugFromBody(request: Request): Promise<string | null> {
  let body: IncrementBody | null = null;

  try {
    body = (await request.json()) as IncrementBody;
  } catch {
    return null;
  }

  return normalizeSlug(body?.slug);
}

function scriptSource(): string {
  return `(() => {
  const API_BASE = (window.LIKES_API_BASE || '').replace(/\\/$/, '');

  const readText = (value) => {
    const number = Number(value || 0);
    return Number.isFinite(number) ? number : 0;
  };

  const postJSON = async (path, payload) => {
    const response = await fetch(\`${'${API_BASE}'}\${path}\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      mode: 'cors',
    });

    if (!response.ok) throw new Error(\`Like API error: \${response.status}\`);
    return response.json();
  };

  const getJSON = async (path) => {
    const response = await fetch(\`${'${API_BASE}'}\${path}\`, { mode: 'cors' });
    if (!response.ok) throw new Error(\`Like API error: \${response.status}\`);
    return response.json();
  };

  const localKey = (slug) => \`revrebel-liked:\${slug}\`;

  const setLikeState = (button, slug, liked) => {
    button.classList.toggle('is-liked', liked);
    button.setAttribute('aria-pressed', liked ? 'true' : 'false');
    button.dataset.liked = liked ? 'true' : 'false';
    try {
      if (liked) localStorage.setItem(localKey(slug), '1');
      else localStorage.removeItem(localKey(slug));
    } catch (_) {}
  };

  const updateMetrics = (slug, stats) => {
    document.querySelectorAll(\`[data-metric-like="\${CSS.escape(slug)}"]\`).forEach((element) => {
      element.textContent = String(readText(stats.likes));
    });

    document.querySelectorAll(\`[data-metric-view="\${CSS.escape(slug)}"]\`).forEach((element) => {
      element.textContent = String(readText(stats.views));
    });
  };

  const hydrateStats = async (slug) => {
    try {
      const stats = await getJSON(\`/api/stats/\${encodeURIComponent(slug)}\`);
      updateMetrics(slug, stats);
    } catch (error) {
      console.warn(error);
    }
  };

  const initLikes = () => {
    document.querySelectorAll('[data-action-like]').forEach((button) => {
      const slug = button.getAttribute('data-action-like');
      if (!slug) return;

      let liked = false;
      try { liked = localStorage.getItem(localKey(slug)) === '1'; } catch (_) {}
      setLikeState(button, slug, liked);
      hydrateStats(slug);

      button.addEventListener('click', async (event) => {
        event.preventDefault();
        const nextLiked = button.dataset.liked !== 'true';
        setLikeState(button, slug, nextLiked);

        try {
          const endpoint = nextLiked ? '/api/likes/increment' : '/api/likes/decrement';
          const stats = await postJSON(endpoint, { slug });
          updateMetrics(slug, stats);
          button.dispatchEvent(new CustomEvent('like:toggled', {
            bubbles: true,
            detail: { slug, liked: nextLiked, stats },
          }));
        } catch (error) {
          setLikeState(button, slug, !nextLiked);
          console.warn(error);
        }
      });
    });
  };

  const initViews = () => {
    document.querySelectorAll('[data-action-view]').forEach(async (element) => {
      const slug = element.getAttribute('data-action-view');
      if (!slug || element.dataset.viewTracked === 'true') return;
      element.dataset.viewTracked = 'true';

      try {
        const stats = await postJSON('/api/views/increment', { slug });
        updateMetrics(slug, stats);
      } catch (error) {
        console.warn(error);
      }
    });
  };

  const init = () => {
    initLikes();
    initViews();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: getCorsHeaders(request, env),
      });
    }

    if (request.method === 'GET' && url.pathname === '/') {
      return json(request, env, {
        ok: true,
        service: 'REVREBEL Like/View Worker',
        endpoints: [
          'GET /api/health',
          'GET /likes-views-devlink.js',
          'POST /api/views/increment',
          'POST /api/likes/increment',
          'POST /api/likes/decrement',
          'GET /api/stats/:slug',
        ],
      });
    }

    if (request.method === 'GET' && url.pathname === '/api/health') {
      return json(request, env, { ok: true, timestamp: new Date().toISOString() });
    }

    if (request.method === 'GET' && url.pathname === '/likes-views-devlink.js') {
      return text(request, env, scriptSource(), 'application/javascript; charset=utf-8');
    }

    if (request.method === 'GET' && url.pathname.startsWith('/api/stats/')) {
      const rawSlug = decodeURIComponent(url.pathname.replace('/api/stats/', ''));
      const slug = normalizeSlug(rawSlug);
      if (!slug) return json(request, env, { error: 'Missing or invalid slug.' }, 400);
      return json(request, env, await readStats(env, slug));
    }

    if (request.method === 'POST' && url.pathname === '/api/views/increment') {
      const slug = await parseSlugFromBody(request);
      if (!slug) return json(request, env, { error: 'Missing or invalid slug.' }, 400);
      return json(request, env, await updateCounter(env, slug, 'views', 1));
    }

    if (request.method === 'POST' && url.pathname === '/api/likes/increment') {
      const slug = await parseSlugFromBody(request);
      if (!slug) return json(request, env, { error: 'Missing or invalid slug.' }, 400);
      return json(request, env, await updateCounter(env, slug, 'likes', 1));
    }

    if (request.method === 'POST' && url.pathname === '/api/likes/decrement') {
      const slug = await parseSlugFromBody(request);
      if (!slug) return json(request, env, { error: 'Missing or invalid slug.' }, 400);
      return json(request, env, await updateCounter(env, slug, 'likes', -1));
    }

    return json(request, env, { error: 'Not found.' }, 404);
  },
};

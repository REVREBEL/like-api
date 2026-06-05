# REVREBEL Like/View Cloudflare Worker

Small standalone Cloudflare Worker API for Webflow like and view tracking.

## What this includes

- `GET /` service info
- `GET /api/health` health check
- `GET /likes-views-devlink.js` Webflow/DevLink browser script
- `POST /api/views/increment`
- `POST /api/likes/increment`
- `POST /api/likes/decrement`
- `GET /api/stats/:slug`

## 1. Install

```bash
npm install
```

## 2. Create the KV namespaces

```bash
npx wrangler kv namespace create LIKES_VIEWS_KV
npx wrangler kv namespace create LIKES_VIEWS_KV --preview
```

Copy the returned IDs into `wrangler.jsonc`:

```jsonc
"kv_namespaces": [
  {
    "binding": "LIKES_VIEWS_KV",
    "id": "YOUR_PRODUCTION_ID",
    "preview_id": "YOUR_PREVIEW_ID"
  }
]
```

## 3. Test locally

```bash
npm run dev
```

Health check:

```bash
curl http://localhost:8787/api/health
```

Increment a like:

```bash
curl -X POST http://localhost:8787/api/likes/increment \
  -H "Content-Type: application/json" \
  -d '{"slug":"test-post"}'
```

Read stats:

```bash
curl http://localhost:8787/api/stats/test-post
```

## 4. Deploy

```bash
npm run deploy
```

Then add a custom domain in Cloudflare Workers, for example:

```txt
likes.revrebel.io
```

## 5. Webflow setup

Add this before `</body>` in Webflow:

```html
<script>
  window.LIKES_API_BASE = "https://likes.revrebel.io";
</script>
<script src="https://likes.revrebel.io/likes-views-devlink.js"></script>
```

Like button element:

```html
<button data-action-like="your-post-slug" aria-pressed="false">
  Like <span data-metric-like="your-post-slug">0</span>
</button>
```

View tracker:

```html
<div data-action-view="your-post-slug" hidden></div>
Views: <span data-metric-view="your-post-slug">0</span>
```

For Webflow CMS, use the CMS slug as the value for each matching data attribute.

## Notes

Cloudflare KV is a good simple fit for lightweight blog/article likes and views. If exact counting under heavy concurrent traffic becomes important, move counter writes to a Durable Object later.
# like-api

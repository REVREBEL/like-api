# LIKES API

Cloudflare Worker API for Webflow-powered like and view counters.

This project uses **Cloudflare Workers** for the API and **Cloudflare D1** for storage so the database schema is owned by the repo through SQL migrations.

## Routes

```txt
GET  /
GET  /api/health
GET  /likes-views-devlink.js
POST /api/views/increment
POST /api/likes/increment
POST /api/likes/decrement
GET  /api/stats/:slug
```

## Database

The Worker expects a D1 binding named:

```txt
DB
```

The Wrangler database name is:

```txt
revrebel-like-api-db
```

Migrations create:

```txt
content_counters
counter_events
```

## First-time setup

Install dependencies:

```bash
npm install
```

Create the D1 database:

```bash
npm run db:create
```

Wrangler will return a `database_id`. Paste that ID into `wrangler.jsonc` under `d1_databases`:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "likes_db",
    "database_id": "PASTE_DATABASE_ID_HERE"
  }
]
```

Apply migrations to the remote D1 database:

```bash
npm run db:migrate:remote
```

Deploy the Worker:

```bash
npm run deploy
```

## Cloudflare Workers Builds

After the D1 database exists and the `database_id` is committed in `wrangler.jsonc`, use this build/deploy command:

```bash
npm run db:migrate:remote && npm run deploy
```

If Cloudflare does not install dependencies automatically, use:

```bash
npm install && npm run db:migrate:remote && npm run deploy
```

## Webflow embed

Add this before `</body>`:

```html
<script>
  window.LIKES_API_BASE = "https://likes.revrebel.io";
</script>
<script src="https://likes.revrebel.io/likes-views-devlink.js"></script>
```

Example attributes:

```html
<button data-action-like="your-post-slug" data-storage-key="your-post-slug" aria-pressed="false">
  Like <span data-metric-like="your-post-slug">0</span>
</button>

<div data-action-view="your-post-slug" hidden></div>
Views: <span data-metric-view="your-post-slug">0</span>
```

## Test commands

Health:

```bash
curl https://likes.revrebel.io/api/health
```

Increment like:

```bash
curl -X POST https://likes.revrebel.io/api/likes/increment \
  -H "Content-Type: application/json" \
  -d '{"slug":"test-post"}'
```

Get stats:

```bash
curl https://likes.revrebel.io/api/stats/test-post
```

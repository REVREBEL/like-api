# LIKES API

Cloudflare Worker API for Webflow-powered like and view counters.

Cloudflare D1 is the source of truth. Browser increment requests update D1 immediately, while a scheduled Worker sync publishes the latest accumulated totals to the Webflow Articles CMS collection every five minutes.

## Routes

```txt
GET  /
GET  /api/health
POST /api/views/increment
POST /api/likes/increment
POST /api/likes/decrement
GET  /api/stats/:slug
```

The Webflow page should render the `likes` and `views` CMS fields directly. It does not need to call `GET /api/stats/:slug` on every page load. That endpoint remains available for diagnostics and fallback use.

## Data flow

```txt
Webflow page renders CMS count
        ↓
Visitor view or like triggers one API request
        ↓
Worker atomically updates D1 and marks the row pending
        ↓
Scheduled Worker runs every five minutes
        ↓
Worker pushes the latest totals to Webflow CMS
        ↓
Worker publishes the changed CMS items
```

Multiple increments during the five-minute window are consolidated into one Webflow update per CMS item.

## Database

The Worker expects the D1 binding:

```txt
DB
```

The configured database is:

```txt
likes_db
```

Migrations create and maintain:

```txt
content_counters
counter_events
Webflow item mappings
CMS synchronization state
```

The synchronization fields include:

```txt
webflow_item_id
synced_likes
synced_views
sync_pending
last_synced_at
sync_error
```

## Webflow configuration

```txt
Site ID:       6a09244ce43d4439301ce56f
Collection ID: 6a214464a0f85c77ad29ea36
Likes field:   likes
Views field:   views
```

The collection ID is stored as a non-secret Worker variable in `wrangler.jsonc`:

```jsonc
"WEBFLOW_COLLECTION_ID": "6a214464a0f85c77ad29ea36"
```

The Worker discovers Webflow item IDs from article slugs on the first pending synchronization and saves those mappings in D1. Subsequent synchronizations reuse the stored item IDs.

## Required Cloudflare secret

Create this encrypted runtime secret in the Cloudflare Worker settings:

```txt
WEBFLOW_API_TOKEN
```

The token must be authorized to read, update, and publish CMS collection items. Do not commit the token to GitHub or place it in Webflow browser code.

## Scheduled synchronization

`wrangler.jsonc` contains:

```jsonc
"triggers": {
  "crons": ["*/5 * * * *"]
}
```

This runs the CMS synchronization every five minutes.

The sync is concurrency-safe: if another increment arrives while Webflow is being updated, the row remains pending and is included in the next scheduled run.

## Install and deploy

```bash
npm install
npm run cf:build
```

`cf:build` applies all pending D1 migrations before deploying the Worker:

```txt
npm run cf:migrate
npm run cf:deploy
```

## Health check

```bash
curl https://likes.revrebel.io/api/health
```

The response includes:

```txt
database
pendingWebflowSyncs
webflowTokenConfigured
```

## Increment examples

Increment a view:

```bash
curl -X POST https://likes.revrebel.io/api/views/increment \
  -H "Content-Type: application/json" \
  -d '{"slug":"understanding-the-role-of-revenue-management"}'
```

Increment a like:

```bash
curl -X POST https://likes.revrebel.io/api/likes/increment \
  -H "Content-Type: application/json" \
  -d '{"slug":"understanding-the-role-of-revenue-management"}'
```

Read the D1 count directly through the diagnostic endpoint:

```bash
curl https://likes.revrebel.io/api/stats/understanding-the-role-of-revenue-management
```

Requests made from a browser are restricted to the origins configured by `ALLOWED_ORIGINS` in `wrangler.jsonc`.

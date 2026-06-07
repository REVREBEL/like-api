import { readFile, writeFile } from 'node:fs/promises';

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const databaseName = process.env.D1_DATABASE_NAME || 'likes_db';
const sourceConfigPath = process.env.WRANGLER_SOURCE_CONFIG || 'wrangler.jsonc';
const generatedConfigPath = process.env.WRANGLER_GENERATED_CONFIG || 'wrangler.generated.jsonc';

if (!accountId) {
  fail('Missing CLOUDFLARE_ACCOUNT_ID. Add it as a Cloudflare Workers Builds environment variable.');
}

if (!apiToken) {
  fail('Missing CLOUDFLARE_API_TOKEN. Make sure the Worker Build has a valid deploy token available to the build environment.');
}

const apiBase = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`;

const headers = {
  Authorization: `Bearer ${apiToken}`,
  'Content-Type': 'application/json',
};

const database = await findOrCreateDatabase(databaseName);
const databaseId = database.uuid || database.id;

if (!databaseId) {
  fail(`Cloudflare returned a D1 database object for ${databaseName}, but no uuid/id was present.`);
}

const sourceConfig = await readFile(sourceConfigPath, 'utf8');
const generatedConfig = sourceConfig.replace(
  /"database_id"\s*:\s*"[^"]*"/,
  `"database_id": "${databaseId}"`,
);

if (generatedConfig === sourceConfig) {
  fail(`Could not replace database_id in ${sourceConfigPath}. Expected a database_id field.`);
}

await writeFile(generatedConfigPath, generatedConfig);

console.log(`D1 database ready: ${databaseName} (${databaseId})`);
console.log(`Generated Wrangler config: ${generatedConfigPath}`);

async function findOrCreateDatabase(name) {
  const existing = await listDatabases(name);
  const match = existing.find((database) => database.name === name);

  if (match) {
    console.log(`Found existing D1 database: ${name}`);
    return match;
  }

  console.log(`Creating D1 database: ${name}`);
  const response = await fetch(apiBase, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name }),
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok || !payload?.success) {
    fail(`Failed to create D1 database ${name}: ${JSON.stringify(payload)}`);
  }

  return payload.result;
}

async function listDatabases(name) {
  const databases = [];
  let page = 1;

  while (true) {
    const url = new URL(apiBase);
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', '100');
    url.searchParams.set('name', name);

    const response = await fetch(url, { headers });
    const payload = await response.json().catch(() => null);

    if (!response.ok || !payload?.success) {
      fail(`Failed to list D1 databases: ${JSON.stringify(payload)}`);
    }

    databases.push(...(payload.result || []));

    const resultInfo = payload.result_info;
    if (!resultInfo || page >= resultInfo.total_pages) break;
    page += 1;
  }

  return databases;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

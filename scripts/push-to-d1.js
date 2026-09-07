/**
 * Push flattened daily snapshots into the Cloudflare D1 `metrics` table via the
 * D1 REST API. Runs in CI after the scrape while data/stats.json still exists.
 *
 * Usage:
 *   node scripts/push-to-d1.js                  # latest snapshot per stream (daily run)
 *   node scripts/push-to-d1.js --all            # every snapshot + past-year CC totals (backfill / re-sync)
 *   node scripts/push-to-d1.js --since 2026-08-01
 *   node scripts/push-to-d1.js --dry-run [...]  # no HTTP; print counts and a sample statement
 *
 * Requires CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID
 * (token needs the "D1 Edit" permission).
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { flattenStats, listStreams, listYearTotals } = require('../scraper/flatten');
const { formatDate } = require('../scraper/utils');

const ROOT = path.resolve(__dirname, '..');
const DATA_PATH = path.join(ROOT, 'data', 'stats.json');

// D1 allows 100 bound parameters per statement; each row binds 7.
const PARAMS_PER_ROW = 7;
const ROWS_PER_STATEMENT = 14;
const STATEMENTS_PER_REQUEST = 50;
const MAX_ATTEMPTS = 5;

const UPSERT_TAIL = `
ON CONFLICT(company, source, entity, date, metric_key)
DO UPDATE SET value = excluded.value, year = excluded.year, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`;

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Turn metric rows into multi-row upsert statements.
 * @param {Array<Row>} rows
 * @returns {Array<{sql: string, params: Array}>}
 */
function buildStatements(rows) {
  return chunk(rows, ROWS_PER_STATEMENT).map(group => ({
    sql: 'INSERT INTO metrics (company, source, entity, date, metric_key, value, year)\nVALUES '
      + group.map(() => '(' + Array(PARAMS_PER_ROW).fill('?').join(',') + ')').join(',')
      + UPSERT_TAIL,
    params: group.flatMap(r => [r.company, r.source, r.entity, r.date, r.metric_key, r.value, r.year ?? null])
  }));
}

function parseArgs(argv) {
  const opts = { mode: 'latest', since: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--all') opts.mode = 'all';
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--since') {
      const value = argv[++i];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) throw new Error('--since requires a YYYY-MM-DD date');
      opts.mode = 'since';
      opts.since = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

/** @returns {(snapshots: Array) => Array} */
function makeSelector({ mode, since }) {
  if (mode === 'all') return snaps => snaps;
  if (mode === 'since') return snaps => snaps.filter(s => s.date >= since);
  return snaps => snaps.slice(-1);
}

function d1Url({ accountId, databaseId }) {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
}

function describeErrors(body) {
  const errors = body?.errors || [];
  return errors.length ? errors.map(e => e.message || JSON.stringify(e)).join('; ') : JSON.stringify(body);
}

async function sendBatch(batch, cfg, { fetch, sleep }) {
  let lastFailure = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(1000 * 2 ** (attempt - 2));
    let res;
    try {
      res = await fetch(d1Url(cfg), {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ batch })
      });
    } catch (err) {
      lastFailure = `network error: ${err.message}`;
      continue;
    }

    const body = await res.json().catch(() => ({}));
    if (res.status === 429 || res.status >= 500) {
      lastFailure = `HTTP ${res.status}: ${describeErrors(body)}`;
      continue;
    }
    if (!res.ok || body.success === false) {
      throw new Error(`D1 request failed (HTTP ${res.status}): ${describeErrors(body)}`);
    }

    const results = Array.isArray(body.result) ? body.result : [];
    const failedIndex = results.findIndex(r => r && r.success === false);
    if (failedIndex >= 0) {
      throw new Error(`D1 statement ${failedIndex} in batch failed: ${results[failedIndex].error || JSON.stringify(results[failedIndex])}`);
    }
    return;
  }
  throw new Error(`D1 request failed after ${MAX_ATTEMPTS} attempts; last failure: ${lastFailure}`);
}

/**
 * Send statements to D1 in batches, sequentially, with retry on transient failures.
 * @param {Array<{sql, params}>} statements
 * @param {{accountId, databaseId, token}} cfg
 * @param {{fetch?: Function, sleep?: Function, log?: Function}} [deps]
 * @returns {Promise<{requests: number}>}
 */
async function pushStatements(statements, cfg, deps = {}) {
  const io = {
    fetch: deps.fetch || globalThis.fetch,
    sleep: deps.sleep || (ms => new Promise(r => setTimeout(r, ms))),
    log: deps.log || (() => {})
  };
  const batches = chunk(statements, STATEMENTS_PER_REQUEST);
  for (let i = 0; i < batches.length; i++) {
    await sendBatch(batches[i], cfg, io);
    if ((i + 1) % 10 === 0 || i + 1 === batches.length) io.log(`  ${i + 1}/${batches.length} requests sent`);
  }
  return { requests: batches.length };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cfg = {
    token: process.env.CLOUDFLARE_API_TOKEN,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID
  };

  if (!opts.dryRun && (!cfg.token || !cfg.accountId || !cfg.databaseId)) {
    console.error('Error: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_D1_DATABASE_ID must be set');
    process.exit(1);
  }
  if (!fs.existsSync(DATA_PATH)) {
    console.error(`Error: ${DATA_PATH} not found. Run "npm run decrypt" first.`);
    process.exit(1);
  }

  const stats = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const select = makeSelector(opts);
  const today = formatDate();

  console.log(`Push mode: ${opts.mode}${opts.since ? ` ${opts.since}` : ''}${opts.dryRun ? ' (dry run)' : ''}`);
  for (const stream of listStreams(stats)) {
    const chosen = select(stream.snapshots);
    const label = `${stream.company}/${stream.source}${stream.entity ? `/${stream.entity}` : ''}`;
    if (chosen.length === 0) {
      console.log(`  ${label}: no snapshots`);
      continue;
    }
    const first = chosen[0].date, last = chosen[chosen.length - 1].date;
    const stale = opts.mode === 'latest' && last !== today ? `  WARNING: latest is ${last}, not today (${today})` : '';
    console.log(`  ${label}: ${chosen.length} snapshot(s) ${first === last ? first : `${first}..${last}`}${stale}`);
  }

  const includeYearTotals = opts.mode === 'all';
  if (includeYearTotals) {
    for (const { company, year } of listYearTotals(stats, new Date().getFullYear())) {
      console.log(`  ${company}/cc: year total ${year} (stored as ${year}-12-31)`);
    }
  }

  const rows = flattenStats(stats, { selectSnapshots: select, includeYearTotals });
  const statements = buildStatements(rows);
  console.log(`Rows: ${rows.length}, statements: ${statements.length}, requests: ${chunk(statements, STATEMENTS_PER_REQUEST).length}`);

  if (opts.dryRun) {
    if (statements.length) {
      console.log('\nSample statement:\n' + statements[0].sql);
      console.log('First row params:', statements[0].params.slice(0, PARAMS_PER_ROW));
    }
    return;
  }
  if (rows.length === 0) {
    console.log('Nothing to push.');
    return;
  }

  const started = Date.now();
  const { requests } = await pushStatements(statements, cfg, { log: console.log });
  console.log(`✓ Pushed ${rows.length} rows in ${requests} request(s), ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

module.exports = {
  buildStatements,
  chunk,
  makeSelector,
  parseArgs,
  pushStatements,
  ROWS_PER_STATEMENT,
  STATEMENTS_PER_REQUEST
};

if (require.main === module) {
  main().catch(err => {
    console.error('Push to D1 failed:', err.message || err);
    process.exit(1);
  });
}

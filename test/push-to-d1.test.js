const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildStatements,
  chunk,
  makeSelector,
  parseArgs,
  pushStatements,
  ROWS_PER_STATEMENT,
  STATEMENTS_PER_REQUEST
} = require('../scripts/push-to-d1');

const row = (i, date = '2026-09-05') => ({
  company: 'aaction', source: 'cc', entity: '', date, metric_key: `k${i}`, value: i, year: 2026
});

test('buildStatements packs 14 rows per upsert statement with 7 params each', () => {
  assert.equal(ROWS_PER_STATEMENT, 14);
  const rows = Array.from({ length: 30 }, (_, i) => row(i));
  const stmts = buildStatements(rows);
  assert.equal(stmts.length, 3);
  assert.equal(stmts[0].params.length, 14 * 7);
  assert.equal(stmts[2].params.length, 2 * 7);
  assert.match(stmts[0].sql, /^INSERT INTO metrics \(company, source, entity, date, metric_key, value, year\)\nVALUES \(\?,\?,\?,\?,\?,\?,\?\)(,\(\?,\?,\?,\?,\?,\?,\?\)){13}\n/);
  assert.match(stmts[0].sql, /ON CONFLICT\(company, source, entity, date, metric_key\)\s+DO UPDATE SET value = excluded\.value, year = excluded\.year, updated_at = strftime/);
  assert.deepEqual(stmts[0].params.slice(0, 7), ['aaction', 'cc', '', '2026-09-05', 'k0', 0, 2026]);
});

test('buildStatements sends null year as null', () => {
  const stmts = buildStatements([{ ...row(1), year: null }]);
  assert.equal(stmts[0].params[6], null);
});

test('chunk splits an array into fixed-size pieces', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 2), []);
});

test('parseArgs understands --all, --since and --dry-run', () => {
  assert.deepEqual(parseArgs([]), { mode: 'latest', since: null, dryRun: false });
  assert.deepEqual(parseArgs(['--all']), { mode: 'all', since: null, dryRun: false });
  assert.deepEqual(parseArgs(['--since', '2026-08-01', '--dry-run']), { mode: 'since', since: '2026-08-01', dryRun: true });
  assert.throws(() => parseArgs(['--since']), /--since requires/);
  assert.throws(() => parseArgs(['--bogus']), /Unknown argument/);
});

test('makeSelector picks latest, all, or since a date', () => {
  const snaps = [{ date: '2026-09-01' }, { date: '2026-09-03' }, { date: '2026-09-05' }];
  assert.deepEqual(makeSelector({ mode: 'latest' })(snaps), [{ date: '2026-09-05' }]);
  assert.deepEqual(makeSelector({ mode: 'latest' })([]), []);
  assert.deepEqual(makeSelector({ mode: 'all' })(snaps), snaps);
  assert.deepEqual(makeSelector({ mode: 'since', since: '2026-09-03' })(snaps), snaps.slice(1));
});

function fakeFetch(responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return { ok: next.status < 400, status: next.status, json: async () => next.body, text: async () => JSON.stringify(next.body) };
  };
  return { fetch, calls };
}

const okBody = n => ({ success: true, result: Array.from({ length: n }, () => ({ success: true })) });
const cfg = { accountId: 'acct', databaseId: 'db', token: 'tok' };

test('pushStatements batches statements per request with the D1 batch body shape', async () => {
  assert.equal(STATEMENTS_PER_REQUEST, 50);
  const stmts = Array.from({ length: 120 }, (_, i) => ({ sql: `S${i}`, params: [i] }));
  const { fetch, calls } = fakeFetch([{ status: 200, body: okBody(50) }, { status: 200, body: okBody(50) }, { status: 200, body: okBody(20) }]);
  const summary = await pushStatements(stmts, cfg, { fetch, sleep: async () => {} });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'https://api.cloudflare.com/client/v4/accounts/acct/d1/database/db/query');
  assert.equal(calls[0].auth, 'Bearer tok');
  assert.equal(calls[0].body.batch.length, 50);
  assert.deepEqual(calls[0].body.batch[0], { sql: 'S0', params: [0] });
  assert.equal(calls[2].body.batch.length, 20);
  assert.equal(summary.requests, 3);
});

test('pushStatements retries 429 and 5xx with backoff, then succeeds', async () => {
  const stmts = [{ sql: 'S', params: [] }];
  const delays = [];
  const { fetch, calls } = fakeFetch([
    { status: 429, body: { errors: [{ message: 'slow down' }] } },
    { status: 503, body: {} },
    new TypeError('fetch failed'),
    { status: 200, body: okBody(1) }
  ]);
  await pushStatements(stmts, cfg, { fetch, sleep: async ms => { delays.push(ms); } });
  assert.equal(calls.length, 4);
  assert.deepEqual(delays, [1000, 2000, 4000]);
});

test('pushStatements gives up after 5 attempts', async () => {
  const { fetch } = fakeFetch(Array.from({ length: 5 }, () => ({ status: 500, body: {} })));
  await assert.rejects(pushStatements([{ sql: 'S', params: [] }], cfg, { fetch, sleep: async () => {} }), /after 5 attempts/);
});

test('pushStatements fails fast on non-retryable 4xx with the Cloudflare error text', async () => {
  const { fetch, calls } = fakeFetch([{ status: 401, body: { success: false, errors: [{ code: 10000, message: 'Authentication error' }] } }]);
  await assert.rejects(pushStatements([{ sql: 'S', params: [] }], cfg, { fetch, sleep: async () => {} }), /Authentication error/);
  assert.equal(calls.length, 1);
});

test('pushStatements reports the failing statement index when a statement in the batch fails', async () => {
  const body = { success: true, result: [{ success: true }, { success: false, error: 'no such table: metrics' }] };
  const { fetch } = fakeFetch([{ status: 200, body }]);
  await assert.rejects(
    pushStatements([{ sql: 'A', params: [] }, { sql: 'B', params: [] }], cfg, { fetch, sleep: async () => {} }),
    /statement 1 .*no such table: metrics/
  );
});

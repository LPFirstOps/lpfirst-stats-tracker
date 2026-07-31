/**
 * Sync decrypted data/stats.json into the Cloudflare Worker's D1 database
 * via POST /api/ingest.
 *
 * Usage:
 *   node scripts/sync-to-d1.js            # latest snapshot per group (daily use)
 *   node scripts/sync-to-d1.js --all      # full historical migration
 *   node scripts/sync-to-d1.js --dry      # print what would be sent
 *
 * Env: WORKER_URL, INGEST_TOKEN. Exits 0 with a warning if unset, so the
 * scrape workflow keeps working before the Worker is deployed.
 * Requires data/stats.json (run `npm run decrypt` first).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const WORKER_URL = (process.env.WORKER_URL || '').replace(/\/$/, '');
const INGEST_TOKEN = process.env.INGEST_TOKEN;
const args = process.argv.slice(2);
const ALL = args.includes('--all');
const DRY = args.includes('--dry');

if (!DRY && (!WORKER_URL || !INGEST_TOKEN)) {
  console.warn('sync-to-d1: WORKER_URL / INGEST_TOKEN not set, skipping sync.');
  process.exit(0);
}

const statsPath = path.join(__dirname, '..', 'data', 'stats.json');
if (!fs.existsSync(statsPath)) {
  console.error('sync-to-d1: data/stats.json not found. Run `npm run decrypt` first.');
  process.exit(1);
}
const stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));

// --- metric flattening -------------------------------------------------------

function parseNumeric(str) {
  if (typeof str !== 'string') return null;
  const cleaned = str.replace(/[$,%\s,]/g, '');
  if (cleaned === '' || isNaN(cleaned)) return null;
  return parseFloat(cleaned);
}

function flatten(node, prefix, out, extra) {
  if (node == null) return out;
  const t = typeof node;
  if (t === 'number') {
    if (Number.isFinite(node)) out.push({ ...extra, metric: prefix, value: node });
    return out;
  }
  if (t === 'boolean') {
    out.push({ ...extra, metric: prefix, value: node ? 1 : 0 });
    return out;
  }
  if (t === 'string') {
    const n = parseNumeric(node);
    out.push({ ...extra, metric: prefix, value: n, textValue: node });
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out, extra));
    return out;
  }
  if (t === 'object') {
    for (const [k, v] of Object.entries(node)) {
      flatten(v, prefix ? `${prefix}.${k}` : k, out, extra);
    }
  }
  return out;
}

/** CC payloads: { date?, data|<tabs>: { byType: { type: {...} } }, summary?, diff?, previousDate? } */
function ccMetrics(payload) {
  const out = [];
  const tabsRoot = payload.data && typeof payload.data === 'object' ? payload.data : payload;
  for (const [tab, tabData] of Object.entries(tabsRoot)) {
    if (['date', 'year', 'summary', 'diff', 'previousDate', 'lastUpdated'].includes(tab)) continue;
    if (!tabData || typeof tabData !== 'object') continue;
    const byType = tabData.byType && typeof tabData.byType === 'object' ? tabData.byType : tabData;
    for (const [assignmentType, typeData] of Object.entries(byType)) {
      if (typeData && typeof typeData === 'object') {
        flatten(typeData, '', out, { tab, assignmentType });
      } else {
        flatten(typeData, assignmentType, out, { tab });
      }
    }
  }
  if (payload.summary) flatten(payload.summary, 'summary', out, {});
  return out;
}

/** Sedgwick payloads: { date, dashboard: {...}, currentScores: [{workType, myScore, stateAvg}] } */
function sedgwickMetrics(payload) {
  const out = [];
  if (payload.dashboard) flatten(payload.dashboard, 'dashboard', out, {});
  (payload.currentScores || []).forEach((s) => {
    if (s && s.workType != null) {
      flatten(s.myScore, `score.${s.workType}.myScore`, out, {});
      flatten(s.stateAvg, `score.${s.workType}.stateAvg`, out, {});
    }
  });
  if (!out.length) flatten(payload, '', out, {});
  return out;
}

function genericMetrics(payload) {
  const out = [];
  const clone = { ...payload };
  delete clone.diff;
  delete clone.previousDate;
  flatten(clone, '', out, {});
  return out;
}

function metricsFor(source, payload) {
  if (source === 'cc') return ccMetrics(payload);
  if (source === 'sedgwick') return sedgwickMetrics(payload);
  return genericMetrics(payload);
}

// --- collect snapshot groups -------------------------------------------------

/** groups: { company, source, location, snapshots: [{date, payload}], yearly: [{date, payload}] } */
function collect() {
  const groups = [];

  const ccGroup = (company, node) => {
    if (!node) return;
    const g = { company, source: 'cc', location: '', snapshots: [], yearly: [] };
    for (const [year, payload] of Object.entries(node.years || {})) {
      g.yearly.push({ date: String(year), payload });
    }
    for (const snap of node.dailySnapshots || []) {
      if (snap && snap.date) g.snapshots.push({ date: snap.date, payload: snap });
    }
    if (g.snapshots.length || g.yearly.length) groups.push(g);
  };

  const dailyGroup = (company, source, node, location = '') => {
    if (!node || !Array.isArray(node.dailySnapshots)) return;
    const g = { company, source, location, snapshots: [], yearly: [] };
    for (const snap of node.dailySnapshots) {
      if (snap && snap.date) g.snapshots.push({ date: snap.date, payload: snap });
    }
    if (g.snapshots.length) groups.push(g);
  };

  // A-Action: CC at root, plus sedgwick/alacrity keys
  ccGroup('aaction', stats);
  dailyGroup('aaction', 'sedgwick', stats.sedgwick);
  dailyGroup('aaction', 'alacrity', stats.alacrity);

  // Moyer's: CC shape + sedgwick/alacrity under stats.moyers
  if (stats.moyers) {
    ccGroup('moyers', stats.moyers);
    dailyGroup('moyers', 'sedgwick', stats.moyers.sedgwick);
    dailyGroup('moyers', 'alacrity', stats.moyers.alacrity);
  }

  // Icon: sedgwick per location
  if (stats.icon && stats.icon.locations) {
    for (const [loc, node] of Object.entries(stats.icon.locations)) {
      dailyGroup('icon', 'sedgwick', node, loc);
    }
  }

  return groups;
}

// --- send --------------------------------------------------------------------

async function send(item, group) {
  const body = {
    company: group.company,
    source: group.source,
    location: group.location,
    date: item.date,
    payload: item.payload,
    metrics: metricsFor(group.source, item.payload)
  };
  if (DRY) {
    console.log(`[dry] ${group.company}/${group.source}${group.location ? '/' + group.location : ''} ${item.date}: ${body.metrics.length} metrics`);
    return;
  }
  const res = await fetch(`${WORKER_URL}/api/ingest`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${INGEST_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ingest failed (${res.status}) for ${group.company}/${group.source}/${item.date}: ${text}`);
  }
}

async function main() {
  const groups = collect();
  const queue = [];

  for (const g of groups) {
    let daily = g.snapshots;
    let yearly = g.yearly;
    if (!ALL) {
      // latest daily snapshot + current-year aggregate only
      daily = daily.length ? [daily.reduce((a, b) => (a.date > b.date ? a : b))] : [];
      const y = String(new Date().getFullYear());
      yearly = yearly.filter((s) => s.date === y);
    }
    for (const item of [...yearly, ...daily]) queue.push([item, g]);
  }

  console.log(`sync-to-d1: sending ${queue.length} snapshots (${ALL ? 'all' : 'latest'})...`);

  const CONCURRENCY = 5;
  let i = 0, failed = 0;
  async function worker() {
    while (i < queue.length) {
      const [item, g] = queue[i++];
      try {
        await send(item, g);
      } catch (e) {
        failed++;
        console.error(e.message);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  if (failed) {
    console.error(`sync-to-d1: ${failed}/${queue.length} snapshots failed.`);
    process.exit(1);
  }
  console.log('sync-to-d1: done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

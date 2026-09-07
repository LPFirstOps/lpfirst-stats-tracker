/**
 * Pure helpers that turn the nested stats.json structure into flat metric rows
 * for the Cloudflare D1 `metrics` table. No I/O, no env access.
 *
 * Row = { company, source, entity, date, metric_key, value, year }
 *
 * metric_key conventions match the diff keys the scrapers already produce:
 *   cc:       `${tab}.${assignmentType}.${metric}`, `${tab}.${metric}`, `summary.${key}`
 *   sedgwick: dashboard keys verbatim, `score_${workType}_myScore` / `_stateAvg`
 *   alacrity: flattenCIPData keys, e.g. `emergency_slas_contactInsured_actual`
 */

const { flattenCIPData } = require('./alacrity');

const isNumber = v => typeof v === 'number' && Number.isFinite(v);

/**
 * Flatten one year's CC tab structure (the shape of snapshot.data / years[year]).
 * @param {Object} yearData
 * @returns {Object} { metric_key: number }
 */
function flattenCCYearData(yearData) {
  const flat = {};
  for (const [tab, tabData] of Object.entries(yearData || {})) {
    for (const [type, metrics] of Object.entries(tabData?.byType || {})) {
      for (const [metric, value] of Object.entries(metrics || {})) {
        if (isNumber(value)) flat[`${tab}.${type}.${metric}`] = value;
      }
    }
    for (const [metric, value] of Object.entries(tabData?.data || {})) {
      if (isNumber(value)) flat[`${tab}.${metric}`] = value;
    }
  }
  return flat;
}

function flattenCCSnapshot(snapshot) {
  const flat = flattenCCYearData(snapshot.data);
  for (const [key, value] of Object.entries(snapshot.summary || {})) {
    if (isNumber(value)) flat[`summary.${key}`] = value;
  }
  return flat;
}

function flattenSedgwickSnapshot(snapshot) {
  const flat = {};
  for (const [key, value] of Object.entries(snapshot.dashboard || {})) {
    if (isNumber(value)) flat[key] = value;
  }
  for (const score of snapshot.currentScores || []) {
    if (!score?.workType) continue;
    if (isNumber(score.myScore)) flat[`score_${score.workType}_myScore`] = score.myScore;
    if (isNumber(score.stateAvg)) flat[`score_${score.workType}_stateAvg`] = score.stateAvg;
  }
  return flat;
}

function flattenAlacritySnapshot(snapshot) {
  const flat = {};
  for (const [key, value] of Object.entries(flattenCIPData(snapshot.dashboard || {}))) {
    if (isNumber(value)) flat[key] = value;
  }
  return flat;
}

const FLATTENERS = {
  cc: flattenCCSnapshot,
  sedgwick: flattenSedgwickSnapshot,
  alacrity: flattenAlacritySnapshot
};

/**
 * Alacrity keeps either one flat stream or one stream per contractor label.
 */
function alacrityStreams(company, container) {
  if (!container) return [];
  const labels = Object.keys(container.contractors || {});
  if (labels.length > 0) {
    return labels.map(label => ({
      company, source: 'alacrity', entity: label, kind: 'alacrity',
      snapshots: container.contractors[label]?.dailySnapshots || []
    }));
  }
  if (!Array.isArray(container.dailySnapshots)) return [];
  return [{ company, source: 'alacrity', entity: '', kind: 'alacrity', snapshots: container.dailySnapshots }];
}

/**
 * Enumerate every snapshot stream in stats.json. This is the only place that
 * knows the file layout. Missing containers simply produce no stream.
 * @param {Object} stats
 * @returns {Array<{company, source, entity, kind, snapshots}>}
 */
function listStreams(stats) {
  const streams = [];
  const add = (company, source, entity, kind, snapshots) => {
    if (Array.isArray(snapshots)) streams.push({ company, source, entity, kind, snapshots });
  };

  add('aaction', 'cc', '', 'cc', stats?.dailySnapshots);
  add('aaction', 'sedgwick', '', 'sedgwick', stats?.sedgwick?.dailySnapshots);
  streams.push(...alacrityStreams('aaction', stats?.alacrity));

  for (const [locKey, loc] of Object.entries(stats?.icon?.locations || {})) {
    add('icon', 'sedgwick', locKey, 'sedgwick', loc?.dailySnapshots);
  }

  add('moyers', 'cc', '', 'cc', stats?.moyers?.dailySnapshots);
  add('moyers', 'sedgwick', '', 'sedgwick', stats?.moyers?.sedgwick?.dailySnapshots);
  streams.push(...alacrityStreams('moyers', stats?.moyers?.alacrity));

  return streams;
}

/**
 * CC year totals for completed years (no daily snapshot exists for them).
 * @param {Object} stats
 * @param {number} currentYear - years >= this are skipped (covered by daily snapshots)
 * @returns {Array<{company, year, data}>}
 */
function listYearTotals(stats, currentYear) {
  const totals = [];
  for (const [company, years] of [['aaction', stats?.years], ['moyers', stats?.moyers?.years]]) {
    for (const [yearStr, data] of Object.entries(years || {})) {
      const year = Number(yearStr);
      if (Number.isInteger(year) && year < currentYear && data) totals.push({ company, year, data });
    }
  }
  return totals;
}

function rowsFromFlat(flat, base) {
  return Object.entries(flat).map(([metric_key, value]) => ({ ...base, metric_key, value }));
}

/**
 * Flatten selected snapshots (and past-year CC totals) into metric rows.
 * @param {Object} stats
 * @param {Object} [options]
 * @param {number} [options.currentYear] - defaults to the current calendar year
 * @param {(snapshots: Array, stream: Object) => Array} [options.selectSnapshots] - defaults to all
 * @param {boolean} [options.includeYearTotals] - defaults to true
 * @returns {Array<Row>}
 */
function flattenStats(stats, options = {}) {
  const currentYear = options.currentYear ?? new Date().getFullYear();
  const select = options.selectSnapshots || (snaps => snaps);
  const rows = [];

  for (const stream of listStreams(stats)) {
    const flatten = FLATTENERS[stream.kind];
    for (const snapshot of select(stream.snapshots, stream)) {
      if (!snapshot?.date) continue;
      const base = {
        company: stream.company, source: stream.source, entity: stream.entity,
        date: snapshot.date, year: stream.kind === 'cc' ? (snapshot.year ?? null) : null
      };
      rows.push(...rowsFromFlat(flatten(snapshot), base));
    }
  }

  if (options.includeYearTotals !== false) {
    for (const { company, year, data } of listYearTotals(stats, currentYear)) {
      const base = { company, source: 'cc', entity: '', date: `${year}-12-31`, year };
      rows.push(...rowsFromFlat(flattenCCYearData(data), base));
    }
  }

  return rows;
}

module.exports = {
  listStreams,
  listYearTotals,
  flattenCCSnapshot,
  flattenSedgwickSnapshot,
  flattenAlacritySnapshot,
  flattenStats
};

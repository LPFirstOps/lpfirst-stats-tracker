const test = require('node:test');
const assert = require('node:assert/strict');
const {
  listStreams,
  listYearTotals,
  flattenCCSnapshot,
  flattenSedgwickSnapshot,
  flattenAlacritySnapshot,
  flattenStats
} = require('../scraper/flatten');

const ccSnapshot = {
  date: '2026-09-05',
  year: 2026,
  data: {
    assignments: { byType: { 'Residential POMS': { assignmentsReceived: 12, jobsSold: 3 } } },
    reinspections: { byType: {}, data: { numberCompleted: 2, leakagePercent: 1.5 } },
    surveys: { byType: {} }
  },
  summary: { totalAssignmentsReceived: 12, avgPomsScore: null },
  diff: { totalAssignmentsReceived: { current: 12, previous: 10, change: 2 } },
  previousDate: '2026-09-04'
};

const sedgwickSnapshot = {
  date: '2026-09-05',
  dashboard: { overallCustomerSatisfaction: 93.8, openJobsTotal: 72 },
  currentScores: [{ workType: 'Water Mitigation', myScore: 88.1, stateAvg: 0 }],
  diff: null,
  previousDate: null
};

const alacritySnapshot = {
  date: '2026-08-15',
  dashboard: {
    totalCIPScore: 91,
    emergency: {
      cipScore: 45,
      slas: { contactInsured: { target: 95, actual: 97.2, operator: '>' } },
      survey: {},
      operational: {}
    },
    nonEmergency: { cipScore: null, slas: {}, survey: {}, operational: {} }
  }
};

test('flattenCCSnapshot emits tab.type.metric, tab.metric and summary keys', () => {
  assert.deepEqual(flattenCCSnapshot(ccSnapshot), {
    'assignments.Residential POMS.assignmentsReceived': 12,
    'assignments.Residential POMS.jobsSold': 3,
    'reinspections.numberCompleted': 2,
    'reinspections.leakagePercent': 1.5,
    'summary.totalAssignmentsReceived': 12
  });
});

test('flattenSedgwickSnapshot emits dashboard keys and per-work-type scores', () => {
  assert.deepEqual(flattenSedgwickSnapshot(sedgwickSnapshot), {
    overallCustomerSatisfaction: 93.8,
    openJobsTotal: 72,
    'score_Water Mitigation_myScore': 88.1,
    'score_Water Mitigation_stateAvg': 0
  });
});

test('flattenAlacritySnapshot reuses flattenCIPData keys and drops operators and nulls', () => {
  assert.deepEqual(flattenAlacritySnapshot(alacritySnapshot), {
    totalCIPScore: 91,
    emergency_cipScore: 45,
    emergency_slas_contactInsured_target: 95,
    emergency_slas_contactInsured_actual: 97.2
  });
});

test('listStreams walks every company/source/entity path that exists', () => {
  const stats = {
    dailySnapshots: [ccSnapshot],
    sedgwick: { dailySnapshots: [sedgwickSnapshot] },
    alacrity: { dailySnapshots: [], contractors: { 'Aaction Home Repairs': { dailySnapshots: [alacritySnapshot] } } },
    icon: { locations: { rockwood: { label: 'Rockwood', dailySnapshots: [sedgwickSnapshot] } } },
    moyers: {
      dailySnapshots: [ccSnapshot],
      sedgwick: { dailySnapshots: [sedgwickSnapshot] },
      alacrity: { dailySnapshots: [alacritySnapshot] }
    }
  };
  const streams = listStreams(stats).map(s => [s.company, s.source, s.entity, s.kind, s.snapshots.length]);
  assert.deepEqual(streams, [
    ['aaction', 'cc', '', 'cc', 1],
    ['aaction', 'sedgwick', '', 'sedgwick', 1],
    ['aaction', 'alacrity', 'Aaction Home Repairs', 'alacrity', 1],
    ['icon', 'sedgwick', 'rockwood', 'sedgwick', 1],
    ['moyers', 'cc', '', 'cc', 1],
    ['moyers', 'sedgwick', '', 'sedgwick', 1],
    ['moyers', 'alacrity', '', 'alacrity', 1]
  ]);
});

test('listStreams tolerates missing containers', () => {
  assert.deepEqual(listStreams({}), []);
  assert.deepEqual(listStreams({ icon: {}, moyers: {} }), []);
});

test('listYearTotals returns past years only, for both CC companies', () => {
  const stats = {
    years: { '2024': { assignments: { byType: {} } }, '2026': { assignments: { byType: {} } } },
    moyers: { years: { '2025': { assignments: { byType: {} } } } }
  };
  const totals = listYearTotals(stats, 2026).map(t => [t.company, t.year]);
  assert.deepEqual(totals, [['aaction', 2024], ['moyers', 2025]]);
});

test('flattenStats produces rows with year for CC, null year otherwise, and Dec 31 rows for past years', () => {
  const stats = {
    years: { '2024': { assignments: { byType: { 'Commercial POMS': { jobsSold: 7 } } } } },
    dailySnapshots: [ccSnapshot],
    sedgwick: { dailySnapshots: [sedgwickSnapshot] }
  };
  const rows = flattenStats(stats, { currentYear: 2026 });
  const cc = rows.find(r => r.metric_key === 'assignments.Residential POMS.jobsSold');
  assert.deepEqual(cc, { company: 'aaction', source: 'cc', entity: '', date: '2026-09-05', metric_key: 'assignments.Residential POMS.jobsSold', value: 3, year: 2026 });
  const sed = rows.find(r => r.metric_key === 'openJobsTotal');
  assert.deepEqual(sed, { company: 'aaction', source: 'sedgwick', entity: '', date: '2026-09-05', metric_key: 'openJobsTotal', value: 72, year: null });
  const past = rows.find(r => r.date === '2024-12-31');
  assert.deepEqual(past, { company: 'aaction', source: 'cc', entity: '', date: '2024-12-31', metric_key: 'assignments.Commercial POMS.jobsSold', value: 7, year: 2024 });
});

test('flattenStats snapshot filter selects which snapshots are flattened', () => {
  const older = { ...sedgwickSnapshot, date: '2026-09-01' };
  const stats = { sedgwick: { dailySnapshots: [older, sedgwickSnapshot] } };
  const latestOnly = flattenStats(stats, { selectSnapshots: snaps => snaps.slice(-1) });
  assert.ok(latestOnly.every(r => r.date === '2026-09-05'));
  assert.equal(latestOnly.length, 4);
});

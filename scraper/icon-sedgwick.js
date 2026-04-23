const {
  formatDate,
  calculateDiff,
  getPreviousSnapshot
} = require('./utils');
const { loginSedgwick, extractMainPageData, extractDashboardData } = require('./sedgwick');

const LOCATIONS = [
  { key: 'rochesterHills', label: 'Rochester Hills', envPrefix: 'ICON_SEDGWICK_ROCHESTER' },
  { key: 'rockwood', label: 'Rockwood', envPrefix: 'ICON_SEDGWICK_ROCKWOOD' },
  { key: 'lansing', label: 'Lansing', envPrefix: 'ICON_SEDGWICK_LANSING' },
];

/**
 * Scrape all Icon Sedgwick locations
 * @param {import('playwright').Browser} browser
 * @returns {Promise<Object|null>} { rochesterHills: {...}, rockwood: {...}, lansing: {...} }
 */
async function scrapeIconSedgwick(browser) {
  const url = process.env.ICON_SEDGWICK_URL;
  if (!url) {
    console.log('Icon Sedgwick URL not configured, skipping...');
    return null;
  }

  console.log('\n========== Starting Icon Sedgwick scraper ==========');

  const results = {};

  for (const loc of LOCATIONS) {
    const username = process.env[`${loc.envPrefix}_USERNAME`];
    const password = process.env[`${loc.envPrefix}_PASSWORD`];

    if (!username || !password) {
      console.log(`Icon Sedgwick ${loc.label} credentials not configured, skipping...`);
      continue;
    }

    console.log(`\n--- Scraping Icon Sedgwick: ${loc.label} ---`);

    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    try {
      const loginSuccess = await loginSedgwick(page, { url, username, password });

      if (!loginSuccess) {
        console.error(`Icon Sedgwick ${loc.label} login failed`);
        continue;
      }

      const { currentScores } = await extractMainPageData(page);
      const dashboard = await extractDashboardData(page);

      results[loc.key] = {
        date: formatDate(),
        dashboard,
        currentScores
      };

      console.log(`Icon Sedgwick ${loc.label} scraping complete!`);
    } catch (error) {
      console.error(`Icon Sedgwick ${loc.label} scraper error:`, error);
    } finally {
      await context.close();
    }
  }

  if (Object.keys(results).length === 0) {
    console.log('No Icon Sedgwick data scraped.');
    return null;
  }

  console.log('========== Icon Sedgwick scraping complete! ==========\n');
  return results;
}

/**
 * Store Icon Sedgwick snapshots in stats and calculate diffs
 * @param {Object} stats - Full stats object
 * @param {Object} iconData - { rochesterHills: {...}, rockwood: {...}, lansing: {...} }
 */
function storeIconSedgwickSnapshot(stats, iconData) {
  if (!iconData) return;

  if (!stats.icon) {
    stats.icon = { locations: {} };
  }

  for (const loc of LOCATIONS) {
    const data = iconData[loc.key];
    if (!data) continue;

    if (!stats.icon.locations[loc.key]) {
      stats.icon.locations[loc.key] = {
        label: loc.label,
        dailySnapshots: []
      };
    }

    const locStore = stats.icon.locations[loc.key];

    // Calculate diff from previous snapshot
    const previousSnapshot = getPreviousSnapshot(locStore.dailySnapshots);
    let diff = null;

    if (previousSnapshot) {
      const current = { ...data.dashboard };
      (data.currentScores || []).forEach(s => {
        current[`score_${s.workType}_myScore`] = s.myScore;
        current[`score_${s.workType}_stateAvg`] = s.stateAvg;
      });

      const previous = { ...previousSnapshot.dashboard };
      (previousSnapshot.currentScores || []).forEach(s => {
        previous[`score_${s.workType}_myScore`] = s.myScore;
        previous[`score_${s.workType}_stateAvg`] = s.stateAvg;
      });

      diff = calculateDiff(current, previous);

      if (diff) {
        console.log(`Icon Sedgwick ${loc.label} changes detected:`);
        for (const [key, value] of Object.entries(diff)) {
          const sign = value.change > 0 ? '+' : '';
          console.log(`  ${key}: ${sign}${value.change} (${value.previous} → ${value.current})`);
        }
      } else {
        console.log(`No Icon Sedgwick ${loc.label} changes since last snapshot.`);
      }
    }

    const snapshot = {
      ...data,
      diff,
      previousDate: previousSnapshot?.date || null
    };

    const todayIndex = locStore.dailySnapshots.findIndex(s => s.date === formatDate());
    if (todayIndex >= 0) {
      locStore.dailySnapshots[todayIndex] = snapshot;
      console.log(`Updated existing Icon Sedgwick ${loc.label} snapshot for ${formatDate()}`);
    } else {
      locStore.dailySnapshots.push(snapshot);
      console.log(`Icon Sedgwick ${loc.label} snapshot saved for ${formatDate()}`);
    }

    // Keep last 365 days
    if (locStore.dailySnapshots.length > 365) {
      locStore.dailySnapshots = locStore.dailySnapshots.slice(-365);
    }
  }
}

module.exports = {
  scrapeIconSedgwick,
  storeIconSedgwickSnapshot
};

// Allow standalone execution for testing
if (require.main === module) {
  const { runStandalone } = require('./utils');
  runStandalone('Icon Sedgwick', async (browser, stats) => {
    const data = await scrapeIconSedgwick(browser);
    if (data) {
      console.log('\nScraped data:');
      console.log(JSON.stringify(data, null, 2));
      storeIconSedgwickSnapshot(stats, data);
    } else {
      console.log('No data scraped.');
    }
  });
}

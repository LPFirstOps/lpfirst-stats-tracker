const { formatDate, saveStats } = require('./utils');
const { scrapeContractorConnection } = require('./contractor-connection');
const { loginSedgwick, extractMainPageData, extractDashboardData, storeSedgwickSnapshot } = require('./sedgwick');
const { loginAlacrity, scrapeCIPReport, storeAlacritySnapshot } = require('./alacrity');

/**
 * Scrape Moyer's ContractorConnection dashboard into stats.moyers
 * (writes directly into stats via the shared CC scraper, unlike the
 * Sedgwick/Alacrity scrapers which return data for storeMoyersSnapshot)
 * @param {import('playwright').Browser} browser
 * @param {Object} stats - Full stats object
 * @param {Object} options - { initial, daily }
 */
async function scrapeMoyersCC(browser, stats, { initial, daily }) {
  const {
    MOYERS_CC_USERNAME,
    MOYERS_CC_PASSWORD,
    MOYERS_CC_2FA_SECRET,
    MOYERS_CC_BASE_URL
  } = process.env;

  if (!MOYERS_CC_USERNAME || !MOYERS_CC_PASSWORD || !MOYERS_CC_2FA_SECRET) {
    console.log('Moyers ContractorConnection credentials not configured, skipping...');
    return;
  }

  if (!stats.moyers) stats.moyers = {};

  await scrapeContractorConnection(browser, stats.moyers, {
    initial,
    daily,
    username: MOYERS_CC_USERNAME,
    password: MOYERS_CC_PASSWORD,
    totpSecret: MOYERS_CC_2FA_SECRET,
    baseUrl: MOYERS_CC_BASE_URL,
    label: "Moyer's ContractorConnection",
    save: () => saveStats(stats)
  });
}

/**
 * Scrape Moyer's Sedgwick portal
 * @param {import('playwright').Browser} browser
 * @returns {Promise<Object|null>} { date, dashboard, currentScores } or null
 */
async function scrapeMoyersSedgwick(browser) {
  const { MOYERS_SEDGWICK_URL, MOYERS_SEDGWICK_USERNAME, MOYERS_SEDGWICK_PASSWORD } = process.env;

  if (!MOYERS_SEDGWICK_URL || !MOYERS_SEDGWICK_USERNAME || !MOYERS_SEDGWICK_PASSWORD) {
    console.log('Moyers Sedgwick credentials not configured, skipping...');
    return null;
  }

  console.log('\n--- Scraping Moyers: Sedgwick ---');

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  try {
    const loginSuccess = await loginSedgwick(page, {
      url: MOYERS_SEDGWICK_URL,
      username: MOYERS_SEDGWICK_USERNAME,
      password: MOYERS_SEDGWICK_PASSWORD
    });

    if (!loginSuccess) {
      console.error('Moyers Sedgwick login failed');
      return null;
    }

    const { currentScores } = await extractMainPageData(page);
    const dashboard = await extractDashboardData(page);

    console.log('Moyers Sedgwick scraping complete!');
    return {
      date: formatDate(),
      dashboard,
      currentScores
    };
  } catch (error) {
    console.error('Moyers Sedgwick scraper error:', error);
    return null;
  } finally {
    await context.close();
  }
}

/**
 * Scrape Moyer's Alacrity CIP dashboard
 * @param {import('playwright').Browser} browser
 * @returns {Promise<Object|null>} { date, dashboard } or null
 */
async function scrapeMoyersAlacrity(browser) {
  const {
    MOYERS_ALACRITY_URL,
    MOYERS_ALACRITY_STARTS_WITH,
    MOYERS_ALACRITY_USERNAME,
    MOYERS_ALACRITY_PASSWORD
  } = process.env;

  if (!MOYERS_ALACRITY_URL || !MOYERS_ALACRITY_USERNAME || !MOYERS_ALACRITY_PASSWORD) {
    console.log('Moyers Alacrity credentials not configured, skipping...');
    return null;
  }

  console.log('\n--- Scraping Moyers: Alacrity ---');

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  try {
    const loginSuccess = await loginAlacrity(page, {
      startsWith: MOYERS_ALACRITY_STARTS_WITH || 'EM',
      username: MOYERS_ALACRITY_USERNAME,
      password: MOYERS_ALACRITY_PASSWORD
    });

    if (!loginSuccess) {
      console.error('Moyers Alacrity login failed');
      return null;
    }

    const cipData = await scrapeCIPReport(page, MOYERS_ALACRITY_URL);

    console.log('Moyers Alacrity scraping complete!');
    return {
      date: formatDate(),
      ...cipData
    };
  } catch (error) {
    console.error('Moyers Alacrity scraper error:', error);
    return null;
  } finally {
    await context.close();
  }
}

/**
 * Scrape all Moyer's sources. CC writes directly into stats.moyers;
 * Sedgwick/Alacrity results are returned for storeMoyersSnapshot.
 * @param {import('playwright').Browser} browser
 * @param {Object} stats - Full stats object
 * @param {Object} [options] - { initial, daily }
 * @returns {Promise<Object|null>} { sedgwick, alacrity } or null if nothing scraped
 */
async function scrapeMoyers(browser, stats, { initial = false, daily = true } = {}) {
  console.log('\n========== Starting Moyers scraper ==========');

  await scrapeMoyersCC(browser, stats, { initial, daily });

  const sedgwick = await scrapeMoyersSedgwick(browser);
  const alacrity = await scrapeMoyersAlacrity(browser);

  if (!sedgwick && !alacrity) {
    console.log('No Moyers data scraped.');
    return null;
  }

  console.log('========== Moyers scraping complete! ==========\n');
  return { sedgwick, alacrity };
}

/**
 * Store Moyer's snapshots in stats and calculate diffs
 * @param {Object} stats - Full stats object
 * @param {Object} moyersData - { sedgwick, alacrity }
 */
function storeMoyersSnapshot(stats, moyersData) {
  if (!moyersData) return;

  if (!stats.moyers) {
    stats.moyers = {};
  }

  // The store helpers write to <container>.sedgwick / <container>.alacrity,
  // so passing stats.moyers reuses their diff and retention logic as-is.
  if (moyersData.sedgwick) {
    storeSedgwickSnapshot(stats.moyers, moyersData.sedgwick);
  }
  if (moyersData.alacrity) {
    storeAlacritySnapshot(stats.moyers, moyersData.alacrity);
  }
}

module.exports = {
  scrapeMoyers,
  storeMoyersSnapshot
};

// Allow standalone execution for testing
// Usage: node scraper/moyers.js [--initial]
if (require.main === module) {
  const { runStandalone } = require('./utils');
  const initial = process.argv.includes('--initial');
  runStandalone('Moyers', async (browser, stats) => {
    const data = await scrapeMoyers(browser, stats, { initial, daily: !initial });
    if (data) {
      console.log('\nScraped data:');
      console.log(JSON.stringify(data, null, 2));
      storeMoyersSnapshot(stats, data);
    } else {
      console.log('No data scraped.');
    }
  });
}

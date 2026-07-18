require('dotenv').config();
const { chromium } = require('playwright');
const { loadStats, saveStats } = require('./utils');
const { scrapeContractorConnection } = require('./contractor-connection');
const { scrapeSedgwick, storeSedgwickSnapshot } = require('./sedgwick');
const { scrapeAlacrity, storeAlacritySnapshot } = require('./alacrity');
const { scrapeIconSedgwick, storeIconSedgwickSnapshot } = require('./icon-sedgwick');
const { scrapeMoyers, storeMoyersSnapshot } = require('./moyers');

/**
 * Scrape A-Action's ContractorConnection dashboard into the stats root
 * @param {import('playwright').Browser} browser
 * @param {Object} stats - Full stats object (A-Action CC lives at the root)
 * @param {Object} options - { initial, daily }
 */
async function scrapeAactionCC(browser, stats, { initial, daily }) {
  const {
    AACTION_CC_USERNAME,
    AACTION_CC_PASSWORD,
    AACTION_CC_2FA_SECRET,
    AACTION_CC_BASE_URL
  } = process.env;

  await scrapeContractorConnection(browser, stats, {
    initial,
    daily,
    username: AACTION_CC_USERNAME,
    password: AACTION_CC_PASSWORD,
    totpSecret: AACTION_CC_2FA_SECRET,
    baseUrl: AACTION_CC_BASE_URL,
    label: 'A-Action ContractorConnection',
    save: () => saveStats(stats)
  });
}

async function runScraper({ initial = false, daily = false }) {
  const stats = loadStats();

  const headless = process.env.HEADLESS !== 'false';
  const browser = await chromium.launch({
    headless,
    slowMo: headless ? 0 : 50
  });

  try {
    // Scrape ContractorConnection
    await scrapeAactionCC(browser, stats, { initial, daily });

    // Scrape Sedgwick
    const sedgwickData = await scrapeSedgwick(browser);
    if (sedgwickData) {
      storeSedgwickSnapshot(stats, sedgwickData);
      saveStats(stats);
    }

    // Scrape Alacrity
    const alacrityData = await scrapeAlacrity(browser);
    if (alacrityData) {
      storeAlacritySnapshot(stats, alacrityData);
      saveStats(stats);
    }

    // Scrape Icon Sedgwick (multi-location)
    const iconData = await scrapeIconSedgwick(browser);
    if (iconData) {
      storeIconSedgwickSnapshot(stats, iconData);
      saveStats(stats);
    }

    // Scrape Moyer's (CC + Sedgwick + Alacrity)
    const moyersData = await scrapeMoyers(browser, stats, { initial, daily });
    if (moyersData) {
      storeMoyersSnapshot(stats, moyersData);
      saveStats(stats);
    }

    console.log('\n========== All scraping complete! ==========');
  } catch (error) {
    console.error('Scraper error:', error);
  } finally {
    await browser.close();
  }
}

module.exports = { scrapeAactionCC };

// Parse command line arguments when run directly
if (require.main === module) {
  const args = process.argv.slice(2);
  const initial = args.includes('--initial');
  const daily = args.includes('--daily');

  if (!initial && !daily) {
    console.log('Usage:');
    console.log('  npm run scrape:initial  - Scrape all years (2020-2025)');
    console.log('  npm run scrape:daily    - Scrape current year only');
    console.log('\nDefaulting to daily mode...');
    runScraper({ daily: true });
  } else {
    runScraper({ initial, daily });
  }
}

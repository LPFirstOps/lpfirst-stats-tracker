const {
  formatDate,
  calculateDiff,
  getPreviousSnapshot
} = require('./utils');

/**
 * Login to Alacrity portal
 * @param {import('playwright').Page} page
 * @param {Object} credentials
 * @returns {Promise<boolean>}
 */
async function loginAlacrity(page, { startsWith, username, password }) {
  console.log('Starting Alacrity login...');

  await page.goto('https://www.alacrity.net/Login.aspx');
  await page.waitForLoadState('networkidle');

  // Select "Start with" dropdown
  await page.locator('#LoginRoundPanel_SystemDropDownList').selectOption(startsWith);

  // Fill credentials
  await page.locator('#LoginRoundPanel_UserNameTextBox').fill(username);
  await page.locator('#LoginRoundPanel_PasswordTextBox').fill(password);

  // Click Login
  await page.getByRole('button', { name: 'Login' }).click();

  // Wait for redirect after login (may go to Home.aspx or other pages)
  console.log('Waiting for Alacrity dashboard...');
  await page.waitForURL(/em\.alacrity\.net/i, { timeout: 30000 });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  console.log('Alacrity login successful!');
  return true;
}

/**
 * Navigate to CIP Dashboard and trigger report load
 * @param {import('playwright').Page} page
 * @param {string} url - CIP report URL
 */
async function navigateToCIPDashboard(page, url) {
  console.log('Navigating to CIP Dashboard...');

  await page.goto(url);
  await page.waitForLoadState('networkidle');

  // Click View button to load the report
  await page.getByRole('button', { name: 'View' }).click();

  // Wait for "Loading...." to appear and then disappear
  console.log('Waiting for CIP report to load...');
  try {
    await page.locator('text=Loading').waitFor({ state: 'visible', timeout: 5000 });
  } catch (e) {
    // Loading may have already appeared and gone
  }
  await page.locator('text=Loading').waitFor({ state: 'hidden', timeout: 60000 });
  await page.waitForTimeout(2000);

  console.log('CIP Dashboard loaded!');
}

/**
 * Extract CIP data from the rendered dashboard
 * @param {import('playwright').Page} page
 * @returns {Promise<Object>}
 */
async function extractCIPData(page) {
  console.log('Extracting CIP data...');

  const text = await page.evaluate(() => document.body.innerText);

  // Helper to parse a number from text (strips operators like >, >=, <, <=)
  function parseNum(str) {
    if (!str) return null;
    const cleaned = str.replace(/[><=,%$]/g, '').trim();
    const num = parseFloat(cleaned);
    return isNaN(num) ? null : num;
  }

  // Extract a metric block: finds "keyword...Target\n \n<value>\nContractor\n \n<value>"
  // The actual page format has newlines and spaces between Target/Contractor and their values
  function extractMetric(sectionText, keyword, defaultOperator = '>=') {
    // Match: keyword ... Target ... <target_value> ... Contractor ... <actual_value>
    // Target value may have operators: >95%, >=3.5, <=1%, <30%
    const pattern = new RegExp(
      keyword + '[\\s\\S]*?Target\\s+([><=]*[\\d.]+%?)\\s*\\nContractor\\s+([\\d.]+%?)',
      'i'
    );
    const match = sectionText.match(pattern);
    if (match) {
      const operatorMatch = match[1].match(/^([><=]+)/);
      const operator = operatorMatch ? operatorMatch[1] : defaultOperator;
      return {
        target: parseNum(match[1]),
        actual: parseNum(match[2]),
        operator
      };
    }
    return null;
  }

  // Extract Total CIP Score
  const totalMatch = text.match(/Current\s+Total\s+CIP\s+Score:\s*([\d.]+)/i);
  const totalCIPScore = totalMatch ? parseNum(totalMatch[1]) : null;

  // Extract section CIP scores
  const emergencyScoreMatch = text.match(/Emergency\s+CIP\s+Score:\s*([\d.]+)/i);
  const nonEmergencyScoreMatch = text.match(/Non[- ]?Emergency\s+CIP\s+Score:\s*([\d.]+)/i);

  function extractSection(sectionText) {
    const section = {
      cipScore: null,
      slas: {},
      survey: {},
      operational: {}
    };

    // SLA metrics (all use > except Valid Issues which uses <=)
    const slaMetrics = [
      { key: 'contactInsured', keyword: 'Contact with insured', op: '>' },
      { key: 'visitSite', keyword: 'Visit Site', op: '>' },
      { key: 'submissionEstimate', keyword: 'Submission of Estimate', op: '>' },
      { key: 'reSubmission', keyword: 'Re-Submission of Estimate', op: '>' },
      { key: 'validIssues', keyword: 'Valid Issues', op: '<=' }
    ];

    for (const metric of slaMetrics) {
      const result = extractMetric(sectionText, metric.keyword, metric.op);
      if (result) section.slas[metric.key] = result;
    }

    // Customer Survey metrics (all use >=)
    const surveyMetrics = [
      { key: 'projectCommunication', keyword: 'Project Communication', op: '>=' },
      { key: 'employeeProfessionalism', keyword: 'Employee.s. Professionalism', op: '>=' },
      { key: 'qualityOfMaterials', keyword: 'Quality of Materials', op: '>=' },
      { key: 'qualityOfWorkmanship', keyword: 'Quality of Workmanship', op: '>=' }
    ];

    for (const metric of surveyMetrics) {
      const result = extractMetric(sectionText, metric.keyword, metric.op);
      if (result) section.survey[metric.key] = result;
    }

    // Operational Efficiency metrics (all use <)
    const operationalMetrics = [
      { key: 'returnByClaimPercent', keyword: 'Return by Claim', op: '<' },
      { key: 'pasCloseoutRejections', keyword: 'PAS Closeout Rejections', op: '<' }
    ];

    for (const metric of operationalMetrics) {
      const result = extractMetric(sectionText, metric.keyword, metric.op);
      if (result) section.operational[metric.key] = result;
    }

    return section;
  }

  // Split text into emergency and non-emergency portions at "Non-Emergency CIP Score"
  const nonEmergencyIdx = text.search(/Non[- ]?Emergency\s+CIP\s+Score/i);
  let emergencyText = text;
  let nonEmergencyText = '';

  if (nonEmergencyIdx > 0) {
    emergencyText = text.substring(0, nonEmergencyIdx);
    nonEmergencyText = text.substring(nonEmergencyIdx);
  }

  const emergency = extractSection(emergencyText);
  emergency.cipScore = emergencyScoreMatch ? parseNum(emergencyScoreMatch[1]) : null;

  const nonEmergency = extractSection(nonEmergencyText);
  nonEmergency.cipScore = nonEmergencyScoreMatch ? parseNum(nonEmergencyScoreMatch[1]) : null;

  const result = {
    totalCIPScore: totalCIPScore,
    emergency,
    nonEmergency
  };

  console.log('  CIP Data extracted:');
  console.log(`    Total CIP Score: ${result.totalCIPScore}`);
  console.log(`    Emergency CIP Score: ${emergency.cipScore}`);
  console.log(`    Non-Emergency CIP Score: ${nonEmergency.cipScore}`);
  console.log(`    Emergency SLAs: ${Object.keys(emergency.slas).length} metrics`);
  console.log(`    Emergency Survey: ${Object.keys(emergency.survey).length} metrics`);
  console.log(`    Emergency Operational: ${Object.keys(emergency.operational).length} metrics`);
  console.log(`    Non-Emergency SLAs: ${Object.keys(nonEmergency.slas).length} metrics`);
  console.log(`    Non-Emergency Survey: ${Object.keys(nonEmergency.survey).length} metrics`);
  console.log(`    Non-Emergency Operational: ${Object.keys(nonEmergency.operational).length} metrics`);

  return result;
}

/**
 * Flatten CIP data for diff calculation
 * @param {Object} dashboard - CIP dashboard data
 * @returns {Object} Flat key-value pairs
 */
function flattenCIPData(dashboard) {
  const flat = {};
  if (dashboard.totalCIPScore != null) flat.totalCIPScore = dashboard.totalCIPScore;

  for (const section of ['emergency', 'nonEmergency']) {
    const s = dashboard[section];
    if (!s) continue;

    if (s.cipScore != null) flat[`${section}_cipScore`] = s.cipScore;

    for (const category of ['slas', 'survey', 'operational']) {
      const cat = s[category];
      if (!cat) continue;
      for (const [key, val] of Object.entries(cat)) {
        if (val.target != null) flat[`${section}_${category}_${key}_target`] = val.target;
        if (val.actual != null) flat[`${section}_${category}_${key}_actual`] = val.actual;
      }
    }
  }

  return flat;
}

/**
 * Main Alacrity scraper function
 * @param {import('playwright').Browser} browser - Playwright browser instance (reused)
 * @returns {Promise<Object|null>} Scraped data or null on failure
 */
async function scrapeAlacrity(browser) {
  const { ALACRITY_URL, ALACRITY_STARTS_WITH, ALACRITY_USERNAME, ALACRITY_PASSWORD } = process.env;

  if (!ALACRITY_URL || !ALACRITY_USERNAME || !ALACRITY_PASSWORD) {
    console.log('Alacrity credentials not configured, skipping...');
    return null;
  }

  console.log('\n========== Starting Alacrity scraper ==========');

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  try {
    // Login
    const loginSuccess = await loginAlacrity(page, {
      startsWith: ALACRITY_STARTS_WITH || 'EM',
      username: ALACRITY_USERNAME,
      password: ALACRITY_PASSWORD
    });

    if (!loginSuccess) {
      console.error('Alacrity login failed');
      return null;
    }

    // Navigate to CIP Dashboard
    await navigateToCIPDashboard(page, ALACRITY_URL);

    // Extract CIP data
    const cipData = await extractCIPData(page);

    const result = {
      date: formatDate(),
      dashboard: cipData
    };

    console.log('========== Alacrity scraping complete! ==========\n');
    return result;

  } catch (error) {
    console.error('Alacrity scraper error:', error);
    return null;

  } finally {
    await context.close();
  }
}

/**
 * Store Alacrity snapshot in stats and calculate diff
 * @param {Object} stats - Full stats object
 * @param {Object} alacrityData - Scraped Alacrity data
 */
function storeAlacritySnapshot(stats, alacrityData) {
  if (!alacrityData) return;

  // Initialize alacrity section if needed
  if (!stats.alacrity) {
    stats.alacrity = { dailySnapshots: [] };
  }

  // Calculate diff from previous snapshot
  const previousSnapshot = getPreviousSnapshot(stats.alacrity.dailySnapshots);
  let diff = null;

  if (previousSnapshot) {
    const current = flattenCIPData(alacrityData.dashboard);
    const previous = flattenCIPData(previousSnapshot.dashboard);

    diff = calculateDiff(current, previous);

    if (diff) {
      console.log('Alacrity changes detected:');
      for (const [key, value] of Object.entries(diff)) {
        const sign = value.change > 0 ? '+' : '';
        console.log(`  ${key}: ${sign}${value.change} (${value.previous} -> ${value.current})`);
      }
    } else {
      console.log('No Alacrity changes since last snapshot.');
    }
  }

  const snapshot = {
    ...alacrityData,
    diff,
    previousDate: previousSnapshot?.date || null
  };

  // Check if we already have a snapshot for today
  const todayIndex = stats.alacrity.dailySnapshots.findIndex(s => s.date === formatDate());
  if (todayIndex >= 0) {
    stats.alacrity.dailySnapshots[todayIndex] = snapshot;
    console.log(`Updated existing Alacrity snapshot for ${formatDate()}`);
  } else {
    stats.alacrity.dailySnapshots.push(snapshot);
    console.log(`Alacrity snapshot saved for ${formatDate()}`);
  }

  // Keep last 365 days
  if (stats.alacrity.dailySnapshots.length > 365) {
    stats.alacrity.dailySnapshots = stats.alacrity.dailySnapshots.slice(-365);
  }
}

module.exports = {
  scrapeAlacrity,
  storeAlacritySnapshot
};

// Allow standalone execution for testing
if (require.main === module) {
  const { runStandalone } = require('./utils');
  runStandalone('Alacrity', async (browser, stats) => {
    const data = await scrapeAlacrity(browser);
    if (data) {
      console.log('\nScraped data:');
      console.log(JSON.stringify(data, null, 2));
      storeAlacritySnapshot(stats, data);
    } else {
      console.log('No data scraped.');
    }
  });
}

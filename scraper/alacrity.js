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

  // Wait for redirect after login (may go to Home.aspx or an MFA challenge)
  console.log('Waiting for Alacrity dashboard...');
  await page.waitForURL(/em\.alacrity\.net|MFAAuth\.aspx/i, { timeout: 30000 });

  if (/MFAAuth\.aspx/i.test(page.url())) {
    if (process.env.HEADLESS !== 'false') {
      console.error('Alacrity account requires interactive MFA (security code via email/phone).');
      console.error('Run with HEADLESS=false to complete the challenge manually, or disable MFA on the account.');
      return false;
    }
    console.log('MFA challenge detected — complete it in the browser window (waiting up to 10 minutes)...');
    await page.waitForURL(/em\.alacrity\.net/i, { timeout: 600000 });
  }

  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  console.log('Alacrity login successful!');
  return true;
}

/**
 * Click the View button and wait for the CIP report to finish loading
 * @param {import('playwright').Page} page
 */
async function clickViewAndWait(page) {
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
}

/**
 * List the options in the contractor combobox on the CIP report page.
 * The combobox is a custom ASP.NET AJAX control, not a native <select>.
 * @param {import('playwright').Page} page
 * @returns {Promise<Array<{label: string, value: string}>>}
 */
async function getContractorOptions(page) {
  // Open the dropdown so its item list is fully populated
  await page.locator('[id$="ContractorComboBox_TextField"]').click().catch(() => {});
  await page.waitForTimeout(1500);

  const options = await page.evaluate(() =>
    [...document.querySelectorAll('#ContractorComboBox_ItemTable td')]
      .map(td => ({
        label: td.querySelector('div')?.textContent.trim(),
        value: td.querySelector('input[type="hidden"]')?.value
      }))
      .filter(o => o.label)
  );

  // Close the dropdown again — this custom combo only closes on an outside click
  await page.mouse.click(5, 5);
  await page.waitForTimeout(500);

  return options;
}

/**
 * Select a contractor in the combobox by its label
 * @param {import('playwright').Page} page
 * @param {string} label
 */
async function selectContractor(page, label) {
  const current = await page.locator('[id$="ContractorComboBox_TextField"]').inputValue();
  if (current === label) return;

  await page.locator('[id$="ContractorComboBox_TextField"]').click();
  await page.locator(`#ContractorComboBox_ItemTable div[title="${label}"]`).click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);
}

/**
 * Navigate to the CIP report and scrape it for every contractor in the dropdown.
 * @param {import('playwright').Page} page
 * @param {string} url - CIP report URL
 * @returns {Promise<Object>} { dashboard } for a single contractor, or
 *   { contractors: { [label]: dashboard } } when the login covers multiple entities
 */
async function scrapeCIPReport(page, url) {
  console.log('Navigating to CIP Dashboard...');
  await page.goto(url);
  await page.waitForLoadState('networkidle');

  const options = await getContractorOptions(page);
  console.log(`Contractor options: ${options.map(o => o.label).join(' | ') || '(none found)'}`);

  if (options.length <= 1) {
    await clickViewAndWait(page);
    return { dashboard: await extractCIPData(page) };
  }

  const contractors = {};
  for (const option of options) {
    console.log(`\n--- Contractor: ${option.label} ---`);
    await selectContractor(page, option.label);
    await clickViewAndWait(page);
    contractors[option.label] = await extractCIPData(page);
  }
  return { contractors };
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
  const { AACTION_ALACRITY_URL, AACTION_ALACRITY_STARTS_WITH, AACTION_ALACRITY_USERNAME, AACTION_ALACRITY_PASSWORD } = process.env;

  if (!AACTION_ALACRITY_URL || !AACTION_ALACRITY_USERNAME || !AACTION_ALACRITY_PASSWORD) {
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
      startsWith: AACTION_ALACRITY_STARTS_WITH || 'EM',
      username: AACTION_ALACRITY_USERNAME,
      password: AACTION_ALACRITY_PASSWORD
    });

    if (!loginSuccess) {
      console.error('Alacrity login failed');
      return null;
    }

    // Navigate to CIP Dashboard and scrape every contractor in the dropdown
    const cipData = await scrapeCIPReport(page, AACTION_ALACRITY_URL);

    const result = {
      date: formatDate(),
      ...cipData
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

  if (alacrityData.contractors) {
    // Multiple contractor entities under one login: keep a snapshot stream per contractor
    if (!stats.alacrity.contractors) stats.alacrity.contractors = {};
    for (const [label, dashboard] of Object.entries(alacrityData.contractors)) {
      console.log(`\n[${label}]`);
      const stream = stats.alacrity.contractors[label] ||
        (stats.alacrity.contractors[label] = { dailySnapshots: [] });
      appendCIPSnapshot(stream, { date: alacrityData.date, dashboard });
    }
  } else {
    appendCIPSnapshot(stats.alacrity, alacrityData);
  }
}

/**
 * Append (or update) a daily CIP snapshot in a snapshot stream, with diff vs previous day
 * @param {Object} stream - { dailySnapshots: [] }
 * @param {Object} data - { date, dashboard }
 */
function appendCIPSnapshot(stream, data) {
  const previousSnapshot = getPreviousSnapshot(stream.dailySnapshots);
  let diff = null;

  if (previousSnapshot) {
    const current = flattenCIPData(data.dashboard);
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
    ...data,
    diff,
    previousDate: previousSnapshot?.date || null
  };

  // Check if we already have a snapshot for today
  const todayIndex = stream.dailySnapshots.findIndex(s => s.date === formatDate());
  if (todayIndex >= 0) {
    stream.dailySnapshots[todayIndex] = snapshot;
    console.log(`Updated existing Alacrity snapshot for ${formatDate()}`);
  } else {
    stream.dailySnapshots.push(snapshot);
    console.log(`Alacrity snapshot saved for ${formatDate()}`);
  }

  // Keep last 365 days
  if (stream.dailySnapshots.length > 365) {
    stream.dailySnapshots = stream.dailySnapshots.slice(-365);
  }
}

module.exports = {
  scrapeAlacrity,
  storeAlacritySnapshot,
  loginAlacrity,
  scrapeCIPReport,
  extractCIPData
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

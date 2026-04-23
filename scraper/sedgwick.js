const {
  formatDate,
  calculateDiff,
  getPreviousSnapshot
} = require('./utils');

/**
 * Login to Sedgwick Contractor Portal
 * @param {import('playwright').Page} page
 * @param {Object} credentials
 * @returns {Promise<boolean>}
 */
async function loginSedgwick(page, { url, username, password }) {
  console.log('Starting Sedgwick login...');

  await page.goto(url);
  await page.waitForLoadState('networkidle');
  // Salesforce login pages can be slow to render inputs
  await page.waitForTimeout(3000);

  // Try multiple selector strategies for the username field
  const usernameSelectors = [
    () => page.getByRole('textbox', { name: 'Username' }),
    () => page.getByRole('textbox', { name: 'Email' }),
    () => page.getByLabel('Username'),
    () => page.getByLabel('Email'),
    () => page.locator('input[name="username"]'),
    () => page.locator('input[type="email"]'),
    () => page.locator('input#username'),
  ];

  let userField = null;
  for (const sel of usernameSelectors) {
    try {
      const el = sel();
      if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
        userField = el;
        console.log('  Found username field');
        break;
      }
    } catch (e) { continue; }
  }

  if (!userField) {
    console.error('Could not find username field on login page');
    return false;
  }

  // Try multiple selector strategies for the password field
  const passwordSelectors = [
    () => page.getByRole('textbox', { name: 'Password' }),
    () => page.getByLabel('Password'),
    () => page.locator('input[name="password"]'),
    () => page.locator('input[type="password"]'),
    () => page.locator('input#password'),
  ];

  let passField = null;
  for (const sel of passwordSelectors) {
    try {
      const el = sel();
      if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
        passField = el;
        console.log('  Found password field');
        break;
      }
    } catch (e) { continue; }
  }

  if (!passField) {
    console.error('Could not find password field on login page');
    return false;
  }

  // Fill login form
  await userField.fill(username);
  await passField.fill(password);

  // Try multiple selectors for the login button
  const loginSelectors = [
    () => page.getByRole('button', { name: 'Log In' }),
    () => page.getByRole('button', { name: 'Login' }),
    () => page.locator('button[type="submit"]'),
    () => page.locator('input[type="submit"]'),
    () => page.locator('button:has-text("Log In")'),
    () => page.locator('button:has-text("Login")'),
  ];

  let loginBtn = null;
  for (const sel of loginSelectors) {
    try {
      const el = sel();
      if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
        loginBtn = el;
        break;
      }
    } catch (e) { continue; }
  }

  if (!loginBtn) {
    console.error('Could not find login button');
    return false;
  }

  await loginBtn.click();

  // Wait for redirect to contractor portal
  console.log('Waiting for Sedgwick dashboard...');
  await page.waitForURL(/\/contractor\/s\//i, { timeout: 30000 });
  // Salesforce takes time to load all components and iframe widgets
  await page.waitForTimeout(15000);

  console.log('Sedgwick login successful!');
  return true;
}

/**
 * Extract score data from the main page (outside iframe)
 * Parses the "Current Score (Rolling 12 Months)" table
 * @param {import('playwright').Page} page
 * @returns {Promise<Object>}
 */
async function extractMainPageData(page) {
  console.log('Extracting main page data...');

  const text = await page.evaluate(() => document.body.innerText);

  // The page has two separate tables:
  //   "MY SCORE" table: WorkType\n\tScore lines
  //   "AVERAGE STATE SCORE" table: WorkType\n\tScore lines
  // We need to parse both and merge by work type.

  const scoreSection = text.split(/Current Score/i)[1] || '';

  // Parse "MY SCORE" section
  const myScoreSection = scoreSection.split(/AVERAGE STATE SCORE/i)[0] || '';
  const myScores = {};
  const scoreLinePattern = /^(.+?)\n\t([\d.]+)/gm;
  let match;
  while ((match = scoreLinePattern.exec(myScoreSection)) !== null) {
    const workType = match[1].trim();
    if (workType && !workType.includes('WORK TYPE') && !workType.includes('MY SCORE')) {
      myScores[workType] = parseFloat(match[2]);
    }
  }

  // Parse "AVERAGE STATE SCORE" section
  const stateSection = scoreSection.split(/AVERAGE STATE SCORE/i)[1] || '';
  const stateScores = {};
  const statePattern = /^(.+?)\n\t([\d.]+)/gm;
  while ((match = statePattern.exec(stateSection)) !== null) {
    const workType = match[1].trim();
    if (workType && !workType.includes('WORK TYPE') && !workType.includes('SCORE')) {
      stateScores[workType] = parseFloat(match[2]);
    }
  }

  // Merge into combined scores
  const currentScores = [];
  for (const workType of Object.keys(myScores)) {
    currentScores.push({
      workType,
      myScore: myScores[workType],
      stateAvg: stateScores[workType] || 0
    });
  }

  console.log(`  Found ${currentScores.length} work type scores`);
  return { currentScores };
}

/**
 * Extract dashboard metrics from the Salesforce iframe
 * @param {import('playwright').Page} page
 * @returns {Promise<Object>}
 */
async function extractDashboardData(page) {
  console.log('Extracting Salesforce dashboard iframe data...');

  // Find the dashboard iframe (name contains "sfxdash")
  let dashFrame = null;
  for (const frame of page.frames()) {
    if (frame.name().includes('sfxdash')) {
      dashFrame = frame;
      break;
    }
  }

  if (!dashFrame) {
    console.log('  WARNING: Could not find Salesforce dashboard iframe, waiting...');
    await page.waitForTimeout(5000);
    for (const frame of page.frames()) {
      if (frame.name().includes('sfxdash')) {
        dashFrame = frame;
        break;
      }
    }
  }

  if (!dashFrame) {
    console.log('  ERROR: Salesforce dashboard iframe not found');
    return {};
  }

  console.log(`  Found dashboard iframe: ${dashFrame.name()}`);

  // Click "Load more widgets" if present to reveal Referral data
  try {
    const loadMore = dashFrame.locator('text=Load more widgets');
    if (await loadMore.isVisible({ timeout: 3000 }).catch(() => false)) {
      await loadMore.click();
      await page.waitForTimeout(3000);
      console.log('  Clicked "Load more widgets"');
    }
  } catch (e) {
    // May already be loaded
  }

  // Wait for dashboard widgets to render
  try {
    await dashFrame.locator('text=Customer Satisfaction Percentage').waitFor({ timeout: 15000 });
    console.log('  Dashboard widgets loaded');
  } catch (e) {
    console.log('  WARNING: Dashboard widgets may not have fully loaded');
  }

  // Get text and normalize non-breaking spaces (U+00A0) to regular spaces
  const rawText = await dashFrame.evaluate(() => document.body.innerText);
  const text = rawText.replace(/\u00A0/g, ' ');
  const dashboard = {};

  // "Customer Satisfaction Percentage 93.8%"
  const custSatMatch = text.match(/Customer Satisfaction Percentage\s+([\d.]+)%/);
  if (custSatMatch) dashboard.overallCustomerSatisfaction = parseFloat(custSatMatch[1]);

  // "Estimate Upload Success Rate 87.6%"
  const estUploadMatch = text.match(/Estimate Upload Success Rate\s+([\d.]+)%/);
  if (estUploadMatch) dashboard.estimateUploadScore = parseFloat(estUploadMatch[1]);

  // "Job Start Success Rate 60.5%"
  const jobStartMatch = text.match(/Job Start Success Rate\s+([\d.]+)%/);
  if (jobStartMatch) dashboard.jobStartScore = parseFloat(jobStartMatch[1]);

  // "Job Complete Success Rate 66%"
  const jobCompleteMatch = text.match(/Job Complete Success Rate\s+([\d.]+)%/);
  if (jobCompleteMatch) dashboard.jobCompleteScore = parseFloat(jobCompleteMatch[1]);

  // Open Jobs: line like "Consolidated Work Types ..., 45.83% of 72, ..."
  // appears after "Open Jobs by Work Type" and before "Issue Cases"
  const openJobsMatch = text.match(/Open Jobs[\s\S]*?([\d.]+)%\s+of\s+(\d+),\s+i\.e\./);
  if (openJobsMatch) dashboard.openJobsTotal = parseInt(openJobsMatch[2]);

  // Issue Cases: only match if the data line is close to the header (before next section)
  // Extract just the Issue Cases widget text (between "Issue Cases by Work Type" and "Load more" or "Referral")
  const afterIssueCases = text.indexOf('Issue Cases by Work Type');
  const issueCasesEnd = text.indexOf('Load more', afterIssueCases);
  const issueCasesBlock = afterIssueCases >= 0 && issueCasesEnd >= 0
    ? text.substring(afterIssueCases, issueCasesEnd) : '';
  const issueCasesMatch = issueCasesBlock.match(/([\d.]+)%\s+of\s+(\d+)/);
  dashboard.issueCasesTotal = issueCasesMatch ? parseInt(issueCasesMatch[2]) : 0;

  // Referral Count: "Record Count 85, 100% of 85" after the last "Referral Count" header
  // Use the line that has "100% of" which is the total count widget
  const referralMatch = text.match(/Record Count (\d+), 100%/);
  if (referralMatch) dashboard.referralCount = parseInt(referralMatch[1]);

  console.log('  Dashboard metrics extracted:', Object.keys(dashboard).length);
  for (const [k, v] of Object.entries(dashboard)) {
    console.log(`    ${k}: ${v}`);
  }
  return dashboard;
}

/**
 * Main Sedgwick scraper function
 * @param {import('playwright').Browser} browser - Playwright browser instance (reused)
 * @returns {Promise<Object|null>} Scraped data or null on failure
 */
async function scrapeSedgwick(browser) {
  const { SEDGWICK_URL, SEDGWICK_USERNAME, SEDGWICK_PASSWORD } = process.env;

  if (!SEDGWICK_URL || !SEDGWICK_USERNAME || !SEDGWICK_PASSWORD) {
    console.log('Sedgwick credentials not configured, skipping...');
    return null;
  }

  console.log('\n========== Starting Sedgwick scraper ==========');

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  try {
    // Login
    const loginSuccess = await loginSedgwick(page, {
      url: SEDGWICK_URL,
      username: SEDGWICK_USERNAME,
      password: SEDGWICK_PASSWORD
    });

    if (!loginSuccess) {
      console.error('Sedgwick login failed');
      return null;
    }

    // Extract data from main page
    const { currentScores } = await extractMainPageData(page);

    // Extract data from dashboard iframe
    const dashboard = await extractDashboardData(page);

    const result = {
      date: formatDate(),
      dashboard,
      currentScores
    };

    console.log('========== Sedgwick scraping complete! ==========\n');
    return result;

  } catch (error) {
    console.error('Sedgwick scraper error:', error);
    return null;

  } finally {
    await context.close();
  }
}

/**
 * Store Sedgwick snapshot in stats and calculate diff
 * @param {Object} stats - Full stats object
 * @param {Object} sedgwickData - Scraped Sedgwick data
 */
function storeSedgwickSnapshot(stats, sedgwickData) {
  if (!sedgwickData) return;

  // Initialize sedgwick section if needed
  if (!stats.sedgwick) {
    stats.sedgwick = { dailySnapshots: [] };
  }

  // Calculate diff from previous snapshot
  const previousSnapshot = getPreviousSnapshot(stats.sedgwick.dailySnapshots);
  let diff = null;

  if (previousSnapshot) {
    // Build flat objects for diffing
    const current = { ...sedgwickData.dashboard };
    sedgwickData.currentScores.forEach(s => {
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
      console.log('Sedgwick changes detected:');
      for (const [key, value] of Object.entries(diff)) {
        const sign = value.change > 0 ? '+' : '';
        console.log(`  ${key}: ${sign}${value.change} (${value.previous} → ${value.current})`);
      }
    } else {
      console.log('No Sedgwick changes since last snapshot.');
    }
  }

  const snapshot = {
    ...sedgwickData,
    diff,
    previousDate: previousSnapshot?.date || null
  };

  // Check if we already have a snapshot for today
  const todayIndex = stats.sedgwick.dailySnapshots.findIndex(s => s.date === formatDate());
  if (todayIndex >= 0) {
    stats.sedgwick.dailySnapshots[todayIndex] = snapshot;
    console.log(`Updated existing Sedgwick snapshot for ${formatDate()}`);
  } else {
    stats.sedgwick.dailySnapshots.push(snapshot);
    console.log(`Sedgwick snapshot saved for ${formatDate()}`);
  }

  // Keep last 365 days
  if (stats.sedgwick.dailySnapshots.length > 365) {
    stats.sedgwick.dailySnapshots = stats.sedgwick.dailySnapshots.slice(-365);
  }
}

module.exports = {
  scrapeSedgwick,
  storeSedgwickSnapshot,
  loginSedgwick,
  extractMainPageData,
  extractDashboardData
};

// Allow standalone execution for testing
if (require.main === module) {
  const { runStandalone } = require('./utils');
  runStandalone('Sedgwick', async (browser, stats) => {
    const data = await scrapeSedgwick(browser);
    if (data) {
      console.log('\nScraped data:');
      console.log(JSON.stringify(data, null, 2));
      storeSedgwickSnapshot(stats, data);
    } else {
      console.log('No data scraped.');
    }
  });
}

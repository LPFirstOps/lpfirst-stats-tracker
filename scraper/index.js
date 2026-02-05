require('dotenv').config();
const { chromium } = require('playwright');
const { login, navigateToScorecard } = require('./auth');
const {
  loadStats,
  saveStats,
  ASSIGNMENT_TYPES,
  INITIAL_YEARS,
  getCurrentYear,
  formatDate,
  calculateDiff,
  getPreviousSnapshot,
  calculateSummaryTotals
} = require('./utils');

// Tab names to iterate through
const TABS = ['ASSIGNMENTS', 'AVG TIP', 'POMS', 'REINSPECTIONS', 'SURVEYS', 'QA FEEDBACK'];

/**
 * Extract summary data from the dashboard page
 * @param {import('playwright').Page} page
 * @returns {Promise<Object>}
 */
async function extractSummaryData(page) {
  return await page.evaluate(() => {
    const text = document.body.innerText;

    // Parse summary cards using regex
    // Format: "Assignments {pending} - Pending {complete} - Complete {nonCompliant} - Non-Compliant"
    const assignMatch = text.match(/Assignments\s*(\d+)\s*-\s*Pending\s*(\d+)\s*-\s*Complete\s*(\d+)\s*-\s*Non-Compliant/i);
    // Format: "Avg TIP {upload} - Upload {review} - Review {total} - Total"
    const tipMatch = text.match(/Avg TIP\s*([\d.]+)\s*-\s*Upload\s*([\d.-]+)\s*-\s*Review\s*([\d.]+)\s*-\s*Total/i);
    // Format: "POMS {yourScore} - Your Score {state} - State {national} - National"
    const pomsMatch = text.match(/POMS\s*([\d.]+)\s*-\s*Your Score\s*([\d.]+)\s*-\s*State\s*([\d.]+)\s*-\s*National/i);
    // Format: "Reinspections {leakage} - Leakage {complete} - Complete"
    const reinspMatch = text.match(/Reinspections\s*(\d+)\s*-\s*Leakage\s*(\d+)\s*-\s*Complete/i);
    // Format: "Surveys {completed} - Completed {avgScore} - Avg Score"
    const surveyMatch = text.match(/Surveys\s*(\d+)\s*-\s*Completed\s*([\d.]+)\s*-\s*Avg Score/i);
    // Format: "QA Feedback {coaching} - Coaching {slf} - SLF"
    const qaMatch = text.match(/QA Feedback\s*(\d+)\s*-\s*Coaching\s*(\d+)\s*-\s*SLF/i);

    return {
      assignments: {
        summary: assignMatch ? {
          pending: +assignMatch[1],
          complete: +assignMatch[2],
          nonCompliant: +assignMatch[3]
        } : null
      },
      avgtip: {
        summary: tipMatch ? {
          upload: +tipMatch[1],
          review: +tipMatch[2],
          total: +tipMatch[3]
        } : null
      },
      poms: {
        summary: pomsMatch ? {
          yourScore: +pomsMatch[1],
          state: +pomsMatch[2],
          national: +pomsMatch[3]
        } : null
      },
      reinspections: {
        summary: reinspMatch ? {
          leakage: +reinspMatch[1],
          complete: +reinspMatch[2]
        } : null
      },
      surveys: {
        summary: surveyMatch ? {
          completed: +surveyMatch[1],
          avgScore: +surveyMatch[2]
        } : null
      },
      qafeedback: {
        summary: qaMatch ? {
          coaching: +qaMatch[1],
          slf: +qaMatch[2]
        } : null
      }
    };
  });
}

/**
 * Generic function to extract table data using provided patterns
 * Captures the LAST number in each row (YTD/total value)
 * @param {import('playwright').Page} page
 * @param {Object} patterns - Object mapping metric names to regex patterns
 * @returns {Promise<Object>}
 */
async function extractTableDataWithPatterns(page, patterns) {
  return await page.evaluate((patternsObj) => {
    const text = document.body.innerText;
    const metrics = {};

    for (const [key, patternStr] of Object.entries(patternsObj)) {
      const pattern = new RegExp(patternStr, 'im');
      const match = text.match(pattern);
      if (match) {
        metrics[key] = parseFloat(match[1].replace(/,/g, ''));
      }
    }

    return metrics;
  }, patterns);
}

// Tab-specific extraction patterns
const EXTRACTION_PATTERNS = {
  assignments: {
    assignmentsReceived: 'Assignments?\\s*Received[^\\n]*?([\\d,]+)\\s*$',
    estimatesReceived: 'Estimates?\\s*Received[^\\n]*?([\\d,]+)\\s*$',
    totalEstimateReceived: 'Total\\s*Estimate\\s*\\$?\\s*Received[^\\n]*\\$([\\d,.]+)\\s*$',
    avgEstimateReceived: 'Avg(?:erage)?\\s*Estimate\\s*\\$?\\s*Received[^\\n]*\\$([\\d,.]+)\\s*$',
    jobsSold: 'Jobs?\\s*Sold[^\\n]*?([\\d,]+)\\s*$',
    totalAmountJobsSold: 'Total\\s*\\$?\\s*Amount\\s*Jobs?\\s*Sold[^\\n]*\\$([\\d,.]+)\\s*$',
    avgAmountJobsSold: 'Avg(?:erage)?\\s*\\$?\\s*Amount\\s*Jobs?\\s*Sold[^\\n]*\\$([\\d,.]+)\\s*$',
    jobsNotSold: 'Jobs?\\s*Not\\s*Sold[^\\n]*?([\\d,]+)\\s*$',
    jobsNotComplete: 'Jobs?\\s*Not\\s*Complete[^\\n]*?([\\d,]+)\\s*$',
    jobsComplete: 'Jobs?\\s*Complete[^\\n]*?([\\d,]+)\\s*$',
    pomsExceptionRequests: 'POMS?\\s*Exception\\s*Requests?[^\\n]*?([\\d,]+)\\s*$',
    assignmentsPending: 'Assignments?\\s*Pending[^\\n]*?([\\d,]+)\\s*$',
    currentNonCompliance: 'Current\\s*Non-?Compliance[^\\n]*?([\\d,]+)\\s*$'
  },
  avgtip: {
    avgEstimateUploadTip: 'Average\\s*Estimate\\s*Upload\\s*TIP[^\\n]*?([\\d.]+)\\s*$',
    avgEstimateReviewTip: 'Average\\s*Estimate\\s*Review\\s*TIP[^\\n]*?([\\d.]+)\\s*$',
    avgJobTip: 'Average\\s*Job\\s*TIP[^\\n]*?([\\d.]+)\\s*$',
    avgTotalTip: 'Average\\s*Total\\s*TIP[^\\n]*?([\\d.]+)\\s*$'
  },
  poms: {
    inspectionTip: 'Inspection\\s*TIP[^\\n]*?([\\d.]+)\\s*$',
    firstPostUploadScore: 'First\\s*Post\\s*Upload\\s*Score[^\\n]*?([\\d.]+)\\s*$',
    estimateUploadTip: 'Estimate\\s*Upload\\s*TIP[^\\n]*?([\\d.]+)\\s*$',
    percentBoldBackReviews: '%\\s*of\\s*Bold\\s*Back\\s*Reviews[^\\n]*?([\\d.]+)\\s*$',
    jsToContrMilestonesEntered: 'JS\\s*to\\s*Contr\\s*Milestones\\s*Entered[^\\n]*?([\\d.]+)\\s*$',
    jsJcTipBelow10k: 'JS\\s*-?\\s*JC\\s*TIP\\s*\\(Below\\s*10k\\)[^\\n]*?([\\d.]+)\\s*$',
    jsJcTip10kTo25k: 'JS\\s*-?JC\\s*TIP\\s*\\(10k\\s*-\\s*25k\\)[^\\n]*?([\\d.]+)\\s*$',
    jsJcTip25kTo50k: 'JS\\s*-?JC\\s*TIP\\s*\\(25k\\s*-\\s*50k\\)[^\\n]*?([\\d.]+)\\s*$',
    percentAssignmentsWithSlf: '%\\s*of\\s*Assignments\\s*with\\s*SLF[^\\n]*?([\\d.]+)\\s*$',
    surveyScore: 'Survey\\s*Score[^\\n]*?([\\d.]+)\\s*$',
    pomsScore: 'POMS\\s*Score[^\\n]*?([\\d.]+)\\s*$'
  },
  reinspections: {
    numberCompleted: 'Number\\s*Completed[^\\n]*?([\\d,]+)\\s*$',
    numberWithLeakage: 'Number\\s*with\\s*Leakage[^\\n]*?([\\d,]+)\\s*$',
    totalAmountReinspected: 'Total\\s*\\$?\\s*Amount\\s*Reinspected[^\\n]*\\$([\\d,.]+)\\s*$',
    dollarAmount: 'Dollar\\s*Amount[^\\n]*\\$([\\d,.]+)\\s*$',
    leakagePercent: 'Leakage\\s*%\\s*for\\s*all\\s*Reinspections[^\\n]*?([\\d.]+)%?\\s*$'
  },
  surveys: {
    numberCompleted: 'Number\\s*Completed[^\\n]*?([\\d,]+)\\s*$',
    avgScore: 'Average\\s*Score[^\\n]*?([\\d.]+)\\s*$',
    netPromoterScore: 'Net\\s*Promoter\\s*Score[^\\n]*?(-?[\\d.]+)\\s*$',
    onTimeForAppointment: 'On-?Time\\s*for\\s*Appointment[^\\n]*?([\\d.]+)\\s*$',
    timelinessOfWork: 'Timeliness\\s*of\\s*Work[^\\n]*?([\\d.]+)\\s*$',
    professionalismOfWorkCrew: 'Professionalism\\s*of\\s*Work\\s*Crew[^\\n]*?([\\d.]+)\\s*$',
    qualityOfWork: 'Quality\\s*of\\s*Work[^\\n]*?([\\d.]+)\\s*$',
    overallCustomerSatisfaction: 'Overall\\s*Customer\\s*Satisfaction[^\\n]*?([\\d.]+)\\s*$',
    wouldReuseContractorAvg: 'Would\\s*Reuse\\s*Contractor\\s*Avg[^\\n]*?([\\d.]+)\\s*$',
    wouldReuseProgramAvg: 'Would\\s*Reuse\\s*Program\\s*Avg[^\\n]*?([\\d.]+)\\s*$',
    likelyToRecommendService: 'Likely\\s*To\\s*Recommend\\s*Service[^\\n]*?([\\d.]+)\\s*$'
  },
  qafeedback: {
    coachingTotal: 'Coaching\\s*Opportunities[\\s\\S]*?Total[^\\n]*?([\\d,]+)\\s*$',
    slfTotal: 'SLF\\s*Breakdown[\\s\\S]*?Total[^\\n]*?([\\d,]+)\\s*$',
    assignTimelines: 'Assign\\s*Timelines[^\\n]*?([\\d,]+)\\s*$',
    generalAssignmentManagement: 'General\\s*Assignment\\s*Management[^\\n]*?([\\d,]+)\\s*$',
    estimatesReview: 'Estimates\\s*Review[^\\n]*?([\\d,]+)\\s*$',
    missingDocumentation: 'Missing\\s*Documentation[^\\n]*?([\\d,]+)\\s*$'
  }
};

/**
 * Extract table data based on the current tab
 * @param {import('playwright').Page} page
 * @param {string} tabKey - The tab identifier (e.g., 'assignments', 'avgtip')
 * @returns {Promise<Object>}
 */
async function extractTableData(page, tabKey) {
  const patterns = EXTRACTION_PATTERNS[tabKey];
  if (!patterns) {
    console.log(`  WARNING: No extraction patterns defined for tab: ${tabKey}`);
    return {};
  }
  return await extractTableDataWithPatterns(page, patterns);
}

/**
 * Select year from dropdown
 * @param {import('playwright').Page} page
 * @param {number} year
 */
async function selectYear(page, year) {
  console.log(`Selecting year: ${year}`);

  try {
    // The year dropdown is inside #Medallion-Section
    const yearDropdown = page.locator('#Medallion-Section').getByRole('combobox');
    await yearDropdown.selectOption(year.toString());
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);
    console.log(`Successfully selected year ${year}`);
    return true;
  } catch (e) {
    console.log(`Could not select year ${year}: ${e.message}`);
    return false;
  }
}

/**
 * Click on a tab (yellow medallion card) to load its data table
 * @param {import('playwright').Page} page
 * @param {string} tabName - e.g., 'ASSIGNMENTS', 'AVG TIP', 'POMS'
 */
async function clickTab(page, tabName) {
  console.log(`  Clicking tab: ${tabName}`);

  // The tabs are yellow medallion cards that are clickable
  const tabSelectors = [
    // Try exact text match first
    `.medallion:has-text("${tabName}")`,
    `[class*="medallion"]:has-text("${tabName}")`,
    // Try the card header
    `div:has-text("${tabName}"):visible`,
    // Try finding by partial text in a clickable area
    `a:has-text("${tabName}")`,
    `button:has-text("${tabName}")`
  ];

  for (const selector of tabSelectors) {
    try {
      const tab = page.locator(selector).first();
      if (await tab.isVisible({ timeout: 2000 }).catch(() => false)) {
        await tab.click();
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(2000);
        console.log(`    ✓ Clicked tab: ${tabName}`);
        return true;
      }
    } catch (e) {
      continue;
    }
  }

  console.log(`    ✗ Could not click tab: ${tabName}`);
  return false;
}

/**
 * Check if the current tab has a type dropdown (Assignment Type or POMS Score Type)
 * @param {import('playwright').Page} page
 */
async function checkForTypeDropdown(page) {
  try {
    const dropdownIndicators = [
      'text=/Select.*Assignment.*Type/i',
      'text=/Select.*POMS.*Score.*Type/i',
      'select[name*="type" i]',
      'select[id*="type" i]'
    ];

    for (const selector of dropdownIndicators) {
      const el = page.locator(selector).first();
      if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Wait for loading indicator to disappear
 * @param {import('playwright').Page} page
 */
async function waitForLoadingComplete(page) {
  try {
    // Wait for "Loading..." text to disappear
    const loadingIndicator = page.locator('text=/Loading/i');
    if (await loadingIndicator.isVisible({ timeout: 500 }).catch(() => false)) {
      console.log(`    Waiting for loading to complete...`);
      await loadingIndicator.waitFor({ state: 'hidden', timeout: 10000 });
      await page.waitForTimeout(500); // Small additional wait after loading completes
    }
  } catch (e) {
    // Loading indicator may have already disappeared or not exist
  }
}

/**
 * Select assignment type from dropdown
 * Uses multiple selector strategies for robust detection
 * @param {import('playwright').Page} page
 * @param {string} type
 */
async function selectAssignmentType(page, type) {
  try {
    // Try multiple selector strategies for the assignment type dropdown
    const dropdownSelectors = [
      'select[name*="type" i]',
      'select[id*="type" i]',
      'select[name*="assignment" i]',
      '#ddlAssignmentType',
      'select.assignment-type',
      '#Medallion-Section select:not(:first-child)'  // Second dropdown in section (after year)
    ];

    for (const selector of dropdownSelectors) {
      try {
        const dropdown = page.locator(selector).first();
        if (await dropdown.isVisible({ timeout: 2000 }).catch(() => false)) {
          await dropdown.selectOption({ label: type });
          await page.waitForLoadState('networkidle');
          await page.waitForTimeout(1000);
          await waitForLoadingComplete(page);
          console.log(`  Selected assignment type: ${type} (using ${selector})`);
          return true;
        }
      } catch (e) {
        continue;
      }
    }

    // Fallback: look for dropdown near "Assignment Type" or "Select Assignment Type" text
    const textSelectors = [
      'text=/Assignment.*Type/i',
      'text=/Select.*Assignment/i',
      'text=/Type:/i'
    ];

    for (const textSelector of textSelectors) {
      try {
        const nearbyDropdown = page.locator(textSelector).locator('xpath=ancestor::*[.//select][1]//select').first();
        if (await nearbyDropdown.isVisible({ timeout: 2000 }).catch(() => false)) {
          await nearbyDropdown.selectOption({ label: type });
          await page.waitForLoadState('networkidle');
          await page.waitForTimeout(1000);
          await waitForLoadingComplete(page);
          console.log(`  Selected assignment type: ${type} (using text proximity)`);
          return true;
        }
      } catch (e) {
        continue;
      }
    }

    // Last resort: try parent selector approach
    try {
      const assignmentDropdown = page.locator('text=Select Assignment Type').locator('..').getByRole('combobox');
      await assignmentDropdown.selectOption(type);
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(2000);
      console.log(`  Selected assignment type: ${type} (using parent selector)`);
      return true;
    } catch (e) {
      // Continue to failure message
    }

    console.log(`  Could not find assignment type dropdown for: ${type}`);
    return false;
  } catch (e) {
    console.log(`  Error selecting assignment type ${type}: ${e.message}`);
    return false;
  }
}

/**
 * Main scraper function
 * @param {Object} options
 * @param {boolean} options.initial - Run initial full scrape (all years)
 * @param {boolean} options.daily - Run daily update (current year only)
 */
async function runScraper({ initial = false, daily = false }) {
  // Validate environment variables
  const { CC_USERNAME, CC_PASSWORD, CC_2FA_SECRET, CC_BASE_URL } = process.env;

  if (!CC_USERNAME || !CC_PASSWORD || !CC_2FA_SECRET) {
    console.error('Missing required environment variables. Please set:');
    console.error('  - CC_USERNAME');
    console.error('  - CC_PASSWORD');
    console.error('  - CC_2FA_SECRET');
    console.error('Copy .env.example to .env and fill in your credentials.');
    process.exit(1);
  }

  const baseUrl = CC_BASE_URL || 'https://www.contractorconnection.com/ContractorDashboard/Summary';

  console.log('Starting ContractorConnection scraper...');
  console.log(`Mode: ${initial ? 'Initial (all years)' : 'Daily update'}`);

  // Determine years to scrape
  const yearsToScrape = initial ? INITIAL_YEARS : [getCurrentYear()];
  console.log(`Years to scrape: ${yearsToScrape.join(', ')}`);

  // Load existing stats
  const stats = loadStats();

  // Launch browser (headless by default, set HEADLESS=false in .env to show browser)
  const headless = process.env.HEADLESS !== 'false';
  const browser = await chromium.launch({
    headless,
    slowMo: headless ? 0 : 50
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  try {
    // Login
    const loginSuccess = await login(page, {
      username: CC_USERNAME,
      password: CC_PASSWORD,
      totpSecret: CC_2FA_SECRET,
      baseUrl
    });

    if (!loginSuccess) {
      console.error('Login failed, aborting scrape');
      await browser.close();
      process.exit(1);
    }

    // Wait for dashboard to fully load
    await page.waitForTimeout(3000);

    // Scrape each year
    for (const year of yearsToScrape) {
      console.log(`\n========== Scraping year: ${year} ==========`);

      // Reload the page to reset state
      await page.goto(baseUrl);
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(2000);

      // Select year
      await selectYear(page, year);
      await page.waitForTimeout(3000);

      // Initialize year data structure
      stats.years[year] = {};

      // Click on each tab and extract data
      for (const tabName of TABS) {
        console.log(`\n--- Tab: ${tabName} ---`);

        const clicked = await clickTab(page, tabName);
        if (!clicked) {
          console.log(`  Skipping tab ${tabName} - could not click`);
          continue;
        }

        // Wait for table to load
        await page.waitForTimeout(2000);

        const tabKey = tabName.toLowerCase().replace(/\s+/g, '');
        stats.years[year][tabKey] = { byType: {} };

        // Check if this tab has a type dropdown (Assignment Type or POMS Score Type)
        const hasDropdown = await checkForTypeDropdown(page);
        console.log(`  Has type dropdown: ${hasDropdown}`);

        if (hasDropdown) {
          // Iterate through each assignment type
          for (const assignmentType of ASSIGNMENT_TYPES) {
            console.log(`    Processing type: ${assignmentType}`);
            const selected = await selectAssignmentType(page, assignmentType);

            if (selected) {
              const tableData = await extractTableData(page, tabKey);
              const metricCount = Object.keys(tableData).length;

              if (metricCount > 0) {
                stats.years[year][tabKey].byType[assignmentType] = tableData;
                console.log(`      Extracted ${metricCount} metrics`);
              } else {
                console.log(`      No data for this type`);
              }
            }
          }
          // Reset to ALL
          await selectAssignmentType(page, 'ALL');
        } else {
          // No dropdown - just extract the single table
          const tableData = await extractTableData(page, tabKey);
          stats.years[year][tabKey].data = tableData;
          console.log(`  Extracted ${Object.keys(tableData).length} metrics`);
        }
      }

      // Save after each year (in case of interruption)
      saveStats(stats);
      console.log(`\nYear ${year} data saved.`);
    }

    // If daily mode, also add to daily snapshots with diff calculation
    if (daily) {
      const currentYear = getCurrentYear();
      const todayData = stats.years[currentYear];
      const todaySummary = calculateSummaryTotals(todayData);

      // Get previous snapshot for diff calculation
      const previousSnapshot = getPreviousSnapshot(stats.dailySnapshots);
      let diff = null;
      let previousSummary = null;

      if (previousSnapshot) {
        previousSummary = calculateSummaryTotals(previousSnapshot.data);
        diff = calculateDiff(todaySummary, previousSummary);
        console.log(`\nCalculating diff from ${previousSnapshot.date}...`);
        if (diff) {
          console.log('Changes detected:');
          for (const [key, value] of Object.entries(diff)) {
            const sign = value.change > 0 ? '+' : '';
            console.log(`  ${key}: ${sign}${value.change} (${value.previous} → ${value.current})`);
          }
        } else {
          console.log('No changes detected since last snapshot.');
        }
      }

      const snapshot = {
        date: formatDate(),
        year: currentYear,
        data: todayData,
        summary: todaySummary,
        diff: diff,
        previousDate: previousSnapshot?.date || null
      };

      // Check if we already have a snapshot for today (update it instead of adding)
      const todayIndex = stats.dailySnapshots.findIndex(s => s.date === formatDate());
      if (todayIndex >= 0) {
        stats.dailySnapshots[todayIndex] = snapshot;
        console.log(`\nUpdated existing snapshot for ${formatDate()}`);
      } else {
        stats.dailySnapshots.push(snapshot);
        console.log(`\nDaily snapshot saved for ${formatDate()}`);
      }

      // Keep last 365 days
      if (stats.dailySnapshots.length > 365) {
        stats.dailySnapshots = stats.dailySnapshots.slice(-365);
      }

      saveStats(stats);
    }

    console.log('\n========== Scraping complete! ==========');

  } catch (error) {
    console.error('Scraper error:', error);
  } finally {
    await browser.close();
  }
}

// Parse command line arguments
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

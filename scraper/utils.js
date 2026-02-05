const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'stats.json');

// Assignment types to iterate through (excluding "ALL")
const ASSIGNMENT_TYPES = [
  'Residential POMS',
  'Commercial POMS',
  'Emergency Services POMS',
  'Specialty Services POMS',
  'Commercial Emergency Services POMS',
  'Commercial Specialty Services POMS',
  'Specialty Emergency Services POMS'
];

// Years to scrape for initial pull
const INITIAL_YEARS = [2020, 2021, 2022, 2023, 2024, 2025];

/**
 * Load existing stats data from JSON file
 * @returns {Object} Stats data
 */
function loadStats() {
  try {
    const data = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.log('No existing stats file, creating new one');
    return {
      lastUpdated: null,
      years: {},
      dailySnapshots: []
    };
  }
}

/**
 * Save stats data to JSON file
 * @param {Object} stats - Stats data to save
 */
function saveStats(stats) {
  stats.lastUpdated = new Date().toISOString();
  fs.writeFileSync(DATA_FILE, JSON.stringify(stats, null, 2));
  console.log('Stats saved to', DATA_FILE);
}

/**
 * Parse numeric value from text (handles currency, percentages, etc)
 * @param {string} text - Text to parse
 * @returns {number|null} Parsed number or null
 */
function parseNumber(text) {
  if (!text || text === '-' || text === 'N/A') return null;

  // Remove currency symbols, commas, and whitespace
  const cleaned = text.replace(/[$,\s]/g, '').trim();

  // Handle percentages
  if (cleaned.endsWith('%')) {
    return parseFloat(cleaned.slice(0, -1));
  }

  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

/**
 * Wait for element and get its text content
 * @param {import('playwright').Page} page
 * @param {string} selector
 * @param {number} timeout
 * @returns {Promise<string|null>}
 */
async function getElementText(page, selector, timeout = 5000) {
  try {
    await page.waitForSelector(selector, { timeout });
    const element = page.locator(selector).first();
    return await element.textContent();
  } catch (error) {
    console.log(`Element not found: ${selector}`);
    return null;
  }
}

/**
 * Select value from dropdown
 * @param {import('playwright').Page} page
 * @param {string} dropdownSelector - Selector for the dropdown
 * @param {string} value - Value to select
 */
async function selectDropdown(page, dropdownSelector, value) {
  try {
    const dropdown = page.locator(dropdownSelector).first();
    await dropdown.waitFor({ timeout: 5000 });

    // Try different methods of selection
    // Method 1: Select by visible text
    try {
      await dropdown.selectOption({ label: value });
      return true;
    } catch (e) {
      // Method 2: Select by value attribute
      try {
        await dropdown.selectOption({ value: value });
        return true;
      } catch (e2) {
        // Method 3: Click and select from list (for custom dropdowns)
        await dropdown.click();
        await page.locator(`text="${value}"`).first().click();
        return true;
      }
    }
  } catch (error) {
    console.log(`Failed to select ${value} from ${dropdownSelector}:`, error.message);
    return false;
  }
}

/**
 * Get all options from a dropdown
 * @param {import('playwright').Page} page
 * @param {string} dropdownSelector
 * @returns {Promise<string[]>}
 */
async function getDropdownOptions(page, dropdownSelector) {
  try {
    const dropdown = page.locator(dropdownSelector).first();
    await dropdown.waitFor({ timeout: 5000 });

    const options = await dropdown.locator('option').allTextContents();
    return options.filter(opt => opt && opt.trim() !== '' && opt.toUpperCase() !== 'ALL');
  } catch (error) {
    console.log(`Failed to get dropdown options from ${dropdownSelector}:`, error.message);
    return [];
  }
}

/**
 * Extract table data from a table element
 * @param {import('playwright').Page} page
 * @param {string} tableSelector
 * @returns {Promise<Object[]>}
 */
async function extractTableData(page, tableSelector) {
  try {
    await page.waitForSelector(tableSelector, { timeout: 5000 });

    const data = await page.evaluate((selector) => {
      const table = document.querySelector(selector);
      if (!table) return [];

      const rows = [];
      const headerRow = table.querySelector('thead tr, tr:first-child');
      const headers = headerRow
        ? Array.from(headerRow.querySelectorAll('th, td')).map(cell => cell.textContent.trim())
        : [];

      const bodyRows = table.querySelectorAll('tbody tr, tr:not(:first-child)');
      bodyRows.forEach(row => {
        const cells = Array.from(row.querySelectorAll('td'));
        if (cells.length > 0) {
          const rowData = {};
          cells.forEach((cell, index) => {
            const key = headers[index] || `col${index}`;
            rowData[key] = cell.textContent.trim();
          });
          rows.push(rowData);
        }
      });

      return rows;
    }, tableSelector);

    return data;
  } catch (error) {
    console.log(`Failed to extract table data from ${tableSelector}:`, error.message);
    return [];
  }
}

/**
 * Click on a tab and wait for content to load
 * @param {import('playwright').Page} page
 * @param {string} tabName
 */
async function clickTab(page, tabName) {
  console.log(`Clicking on tab: ${tabName}`);

  // Try various selectors for tabs
  const selectors = [
    `a:has-text("${tabName}")`,
    `button:has-text("${tabName}")`,
    `[role="tab"]:has-text("${tabName}")`,
    `.nav-link:has-text("${tabName}")`,
    `.tab:has-text("${tabName}")`,
    `li:has-text("${tabName}")`,
    `[data-tab="${tabName}"]`
  ];

  for (const selector of selectors) {
    try {
      const tab = page.locator(selector).first();
      if (await tab.isVisible({ timeout: 1000 }).catch(() => false)) {
        await tab.click();
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(1000); // Give time for data to load
        console.log(`Tab ${tabName} clicked successfully`);
        return true;
      }
    } catch (e) {
      continue;
    }
  }

  console.log(`Could not find tab: ${tabName}`);
  return false;
}

/**
 * Select year from dropdown
 * @param {import('playwright').Page} page
 * @param {number} year
 */
async function selectYear(page, year) {
  console.log(`Selecting year: ${year}`);

  // Try common year dropdown selectors
  const selectors = [
    'select[name*="year" i]',
    'select[id*="year" i]',
    'select.year-selector',
    '#yearDropdown',
    '#ddlYear',
    'select[name="Year"]',
    '#Year'
  ];

  for (const selector of selectors) {
    try {
      const dropdown = page.locator(selector).first();
      if (await dropdown.isVisible({ timeout: 1000 }).catch(() => false)) {
        await dropdown.selectOption({ label: year.toString() });
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(1000);
        console.log(`Year ${year} selected`);
        return true;
      }
    } catch (e) {
      continue;
    }
  }

  // Try clicking on year text if it's a custom dropdown
  try {
    const yearText = page.locator(`text="${year}"`).first();
    if (await yearText.isVisible({ timeout: 1000 }).catch(() => false)) {
      await yearText.click();
      await page.waitForLoadState('networkidle');
      return true;
    }
  } catch (e) {
    // Ignore
  }

  console.log(`Could not select year: ${year}`);
  return false;
}

/**
 * Check if dropdown exists on current tab
 * @param {import('playwright').Page} page
 * @param {string} dropdownSelector
 * @returns {Promise<boolean>}
 */
async function hasDropdown(page, dropdownSelector) {
  try {
    const dropdown = page.locator(dropdownSelector).first();
    return await dropdown.isVisible({ timeout: 2000 });
  } catch {
    return false;
  }
}

/**
 * Get current year
 * @returns {number}
 */
function getCurrentYear() {
  return new Date().getFullYear();
}

/**
 * Format date as YYYY-MM-DD
 * @param {Date} date
 * @returns {string}
 */
function formatDate(date = new Date()) {
  return date.toISOString().split('T')[0];
}

/**
 * Calculate the difference between two data objects (today - yesterday)
 * @param {Object} current - Current data
 * @param {Object} previous - Previous data
 * @returns {Object} Object with differences
 */
function calculateDiff(current, previous) {
  if (!previous) return null;

  const diff = {};

  // Helper to recursively calculate numeric diffs
  function diffObjects(curr, prev, path = '') {
    if (!curr || !prev) return;

    for (const key of Object.keys(curr)) {
      const currVal = curr[key];
      const prevVal = prev[key];

      if (typeof currVal === 'number' && typeof prevVal === 'number') {
        const change = currVal - prevVal;
        if (change !== 0) {
          diff[path ? `${path}.${key}` : key] = {
            current: currVal,
            previous: prevVal,
            change: change,
            percentChange: prevVal !== 0 ? ((change / prevVal) * 100).toFixed(2) : null
          };
        }
      } else if (typeof currVal === 'object' && currVal !== null && typeof prevVal === 'object' && prevVal !== null) {
        diffObjects(currVal, prevVal, path ? `${path}.${key}` : key);
      }
    }
  }

  diffObjects(current, previous);
  return Object.keys(diff).length > 0 ? diff : null;
}

/**
 * Get the previous day's snapshot
 * @param {Array} snapshots - Array of daily snapshots
 * @returns {Object|null} Previous snapshot or null
 */
function getPreviousSnapshot(snapshots) {
  if (!snapshots || snapshots.length === 0) return null;

  const today = formatDate();
  // Find the most recent snapshot that's not from today
  for (let i = snapshots.length - 1; i >= 0; i--) {
    if (snapshots[i].date !== today) {
      return snapshots[i];
    }
  }
  return null;
}

/**
 * Calculate summary totals from byType data
 * @param {Object} yearData - Year data object with tab-based structure
 * @returns {Object} Summary totals
 */
function calculateSummaryTotals(yearData) {
  if (!yearData) return {};

  const summary = {};

  // Assignments totals
  if (yearData.assignments?.byType) {
    const byType = yearData.assignments.byType;
    summary.totalAssignmentsReceived = Object.values(byType).reduce((sum, t) => sum + (t.assignmentsReceived || 0), 0);
    summary.totalJobsSold = Object.values(byType).reduce((sum, t) => sum + (t.jobsSold || 0), 0);
    summary.totalRevenue = Object.values(byType).reduce((sum, t) => sum + (t.totalAmountJobsSold || 0), 0);
    summary.totalJobsComplete = Object.values(byType).reduce((sum, t) => sum + (t.jobsComplete || 0), 0);
  }

  // POMS scores (average across types that have data)
  if (yearData.poms?.byType) {
    const scores = Object.values(yearData.poms.byType).filter(t => t.pomsScore).map(t => t.pomsScore);
    summary.avgPomsScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  }

  // Survey totals
  if (yearData.surveys?.byType) {
    const byType = yearData.surveys.byType;
    summary.totalSurveysCompleted = Object.values(byType).reduce((sum, t) => sum + (t.numberCompleted || 0), 0);
    const scores = Object.values(byType).filter(t => t.avgScore).map(t => t.avgScore);
    summary.avgSurveyScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  }

  // QA Feedback totals
  if (yearData.qafeedback?.byType) {
    const byType = yearData.qafeedback.byType;
    summary.totalCoaching = Object.values(byType).reduce((sum, t) => sum + (t.coachingTotal || 0), 0);
    summary.totalSlf = Object.values(byType).reduce((sum, t) => sum + (t.slfTotal || 0), 0);
  }

  // Reinspections
  if (yearData.reinspections?.data) {
    summary.reinspectionsCompleted = yearData.reinspections.data.numberCompleted || 0;
    summary.reinspectionsLeakage = yearData.reinspections.data.numberWithLeakage || 0;
  }

  return summary;
}

module.exports = {
  ASSIGNMENT_TYPES,
  INITIAL_YEARS,
  loadStats,
  saveStats,
  parseNumber,
  getElementText,
  selectDropdown,
  getDropdownOptions,
  extractTableData,
  clickTab,
  selectYear,
  hasDropdown,
  getCurrentYear,
  formatDate,
  calculateDiff,
  getPreviousSnapshot,
  calculateSummaryTotals
};

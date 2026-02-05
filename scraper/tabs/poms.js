const { parseNumber, selectDropdown, hasDropdown, ASSIGNMENT_TYPES } = require('../utils');

/**
 * Scrape POMS tab data
 * @param {import('playwright').Page} page
 * @returns {Promise<Object>}
 */
async function scrapePoms(page) {
  console.log('Scraping POMS tab...');

  const data = {
    summary: {},
    byType: {}
  };

  // Extract summary metrics (Your Score, State, National)
  try {
    const summaryMetrics = await extractPomsMetrics(page);
    data.summary = summaryMetrics;
  } catch (error) {
    console.log('Error extracting POMS summary:', error.message);
  }

  // Check for assignment type dropdown
  const dropdownSelectors = [
    'select[name*="type" i]',
    'select[id*="type" i]',
    'select[name*="assignment" i]',
    '#ddlAssignmentType',
    '#assignmentType',
    'select.assignment-type'
  ];

  let dropdownFound = false;
  let dropdownSelector = '';

  for (const selector of dropdownSelectors) {
    if (await hasDropdown(page, selector)) {
      dropdownFound = true;
      dropdownSelector = selector;
      break;
    }
  }

  if (dropdownFound) {
    console.log('Assignment type dropdown found on POMS tab, iterating through types...');

    for (const assignmentType of ASSIGNMENT_TYPES) {
      console.log(`  Scraping POMS for type: ${assignmentType}`);

      const selected = await selectDropdown(page, dropdownSelector, assignmentType);
      if (!selected) {
        console.log(`  Could not select ${assignmentType}, skipping`);
        continue;
      }

      await page.waitForTimeout(1500);

      const typeMetrics = await extractPomsMetrics(page);
      if (Object.keys(typeMetrics).length > 0) {
        data.byType[assignmentType] = typeMetrics;
      }
    }
  }

  console.log('POMS data:', JSON.stringify(data, null, 2));
  return data;
}

/**
 * Extract POMS metrics from the page
 * @param {import('playwright').Page} page
 * @returns {Promise<Object>}
 */
async function extractPomsMetrics(page) {
  const metrics = {};

  // Try to find metrics in cards or specific elements
  const metricSelectors = {
    yourScore: [
      '.card:has-text("Your Score") .value',
      '.card:has-text("Your") .value',
      '[class*="your-score"] .number',
      '.poms-your-score',
      '#yourScore'
    ],
    state: [
      '.card:has-text("State") .value',
      '[class*="state"] .number',
      '.poms-state',
      '#stateScore'
    ],
    national: [
      '.card:has-text("National") .value',
      '[class*="national"] .number',
      '.poms-national',
      '#nationalScore'
    ]
  };

  for (const [key, selectors] of Object.entries(metricSelectors)) {
    for (const selector of selectors) {
      try {
        const element = page.locator(selector).first();
        if (await element.isVisible({ timeout: 500 }).catch(() => false)) {
          const text = await element.textContent();
          metrics[key] = parseNumber(text);
          break;
        }
      } catch (e) {
        continue;
      }
    }
  }

  // Fallback: extract from page text
  if (Object.keys(metrics).length === 0) {
    const pageText = await page.textContent('body');

    const patterns = {
      yourScore: /Your\s*Score[:\s]*([\d.]+)/i,
      state: /State[:\s]*([\d.]+)/i,
      national: /National[:\s]*([\d.]+)/i
    };

    for (const [key, pattern] of Object.entries(patterns)) {
      const match = pageText.match(pattern);
      if (match) {
        metrics[key] = parseNumber(match[1]);
      }
    }
  }

  // Try to extract from a grid/table layout
  if (Object.keys(metrics).length === 0) {
    try {
      const extractedMetrics = await page.evaluate(() => {
        const result = {};
        const elements = document.querySelectorAll('.metric, .stat, .kpi, [class*="metric"], [class*="stat"], .score-card, .comparison');

        elements.forEach(el => {
          const text = el.textContent.toLowerCase();
          if (text.includes('your')) {
            const num = text.match(/([\d.]+)/);
            if (num) result.yourScore = parseFloat(num[1]);
          }
          if (text.includes('state') && !text.includes('your') && !text.includes('national')) {
            const num = text.match(/([\d.]+)/);
            if (num) result.state = parseFloat(num[1]);
          }
          if (text.includes('national')) {
            const num = text.match(/([\d.]+)/);
            if (num) result.national = parseFloat(num[1]);
          }
        });

        return result;
      });

      Object.assign(metrics, extractedMetrics);
    } catch (e) {
      // Ignore
    }
  }

  return metrics;
}

module.exports = { scrapePoms };

const { parseNumber, selectDropdown, hasDropdown, ASSIGNMENT_TYPES } = require('../utils');

/**
 * Scrape QA FEEDBACK tab data
 * @param {import('playwright').Page} page
 * @returns {Promise<Object>}
 */
async function scrapeQaFeedback(page) {
  console.log('Scraping QA FEEDBACK tab...');

  const data = {
    summary: {},
    byType: {}
  };

  // Extract summary metrics (Coaching, SLF)
  try {
    const summaryMetrics = await extractQaMetrics(page);
    data.summary = summaryMetrics;
  } catch (error) {
    console.log('Error extracting QA FEEDBACK summary:', error.message);
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
    console.log('Assignment type dropdown found on QA FEEDBACK tab, iterating through types...');

    for (const assignmentType of ASSIGNMENT_TYPES) {
      console.log(`  Scraping QA FEEDBACK for type: ${assignmentType}`);

      const selected = await selectDropdown(page, dropdownSelector, assignmentType);
      if (!selected) {
        console.log(`  Could not select ${assignmentType}, skipping`);
        continue;
      }

      await page.waitForTimeout(1500);

      const typeMetrics = await extractQaMetrics(page);
      if (Object.keys(typeMetrics).length > 0) {
        data.byType[assignmentType] = typeMetrics;
      }
    }
  }

  console.log('QA FEEDBACK data:', JSON.stringify(data, null, 2));
  return data;
}

/**
 * Extract QA feedback metrics from the page
 * @param {import('playwright').Page} page
 * @returns {Promise<Object>}
 */
async function extractQaMetrics(page) {
  const metrics = {};

  // Try to find metrics in cards or specific elements
  const metricSelectors = {
    coaching: [
      '.card:has-text("Coaching") .value',
      '[class*="coaching"] .number',
      '.qa-coaching',
      '#coaching'
    ],
    slf: [
      '.card:has-text("SLF") .value',
      '.card:has-text("SLF") .value',
      '[class*="slf"] .number',
      '.qa-slf',
      '#slf'
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
      coaching: /Coaching[:\s]*(\d+)/i,
      slf: /SLF[:\s]*(\d+)/i
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
        const elements = document.querySelectorAll('.metric, .stat, .kpi, [class*="metric"], [class*="stat"]');

        elements.forEach(el => {
          const text = el.textContent.toLowerCase();
          if (text.includes('coaching')) {
            const num = text.match(/(\d+)/);
            if (num) result.coaching = parseInt(num[1]);
          }
          if (text.includes('slf')) {
            const num = text.match(/(\d+)/);
            if (num) result.slf = parseInt(num[1]);
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

module.exports = { scrapeQaFeedback };

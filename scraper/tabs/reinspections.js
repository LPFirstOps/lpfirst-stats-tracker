const { parseNumber, selectDropdown, hasDropdown, ASSIGNMENT_TYPES } = require('../utils');

/**
 * Scrape REINSPECTIONS tab data
 * @param {import('playwright').Page} page
 * @returns {Promise<Object>}
 */
async function scrapeReinspections(page) {
  console.log('Scraping REINSPECTIONS tab...');

  const data = {
    summary: {},
    byType: {}
  };

  // Extract summary metrics (Leakage, Complete)
  try {
    const summaryMetrics = await extractReinspectionMetrics(page);
    data.summary = summaryMetrics;
  } catch (error) {
    console.log('Error extracting REINSPECTIONS summary:', error.message);
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
    console.log('Assignment type dropdown found on REINSPECTIONS tab, iterating through types...');

    for (const assignmentType of ASSIGNMENT_TYPES) {
      console.log(`  Scraping REINSPECTIONS for type: ${assignmentType}`);

      const selected = await selectDropdown(page, dropdownSelector, assignmentType);
      if (!selected) {
        console.log(`  Could not select ${assignmentType}, skipping`);
        continue;
      }

      await page.waitForTimeout(1500);

      const typeMetrics = await extractReinspectionMetrics(page);
      if (Object.keys(typeMetrics).length > 0) {
        data.byType[assignmentType] = typeMetrics;
      }
    }
  }

  console.log('REINSPECTIONS data:', JSON.stringify(data, null, 2));
  return data;
}

/**
 * Extract reinspection metrics from the page
 * @param {import('playwright').Page} page
 * @returns {Promise<Object>}
 */
async function extractReinspectionMetrics(page) {
  const metrics = {};

  // Try to find metrics in cards or specific elements
  const metricSelectors = {
    leakage: [
      '.card:has-text("Leakage") .value',
      '[class*="leakage"] .number',
      '.reinspection-leakage',
      '#leakage'
    ],
    complete: [
      '.card:has-text("Complete") .value',
      '[class*="complete"] .number',
      '.reinspection-complete',
      '#complete'
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
      leakage: /Leakage[:\s]*(\d+)/i,
      complete: /Complete[:\s]*(\d+)/i
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
          if (text.includes('leakage')) {
            const num = text.match(/(\d+)/);
            if (num) result.leakage = parseInt(num[1]);
          }
          if (text.includes('complete') && !text.includes('non')) {
            const num = text.match(/(\d+)/);
            if (num) result.complete = parseInt(num[1]);
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

module.exports = { scrapeReinspections };

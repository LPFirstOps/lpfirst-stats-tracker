const { parseNumber, selectDropdown, hasDropdown, ASSIGNMENT_TYPES } = require('../utils');

/**
 * Scrape AVG TIP tab data
 * @param {import('playwright').Page} page
 * @returns {Promise<Object>}
 */
async function scrapeAvgTip(page) {
  console.log('Scraping AVG TIP tab...');

  const data = {
    summary: {},
    byType: {}
  };

  // Extract summary metrics (Upload, Review, Total)
  try {
    const summaryMetrics = await extractTipMetrics(page);
    data.summary = summaryMetrics;
  } catch (error) {
    console.log('Error extracting TIP summary:', error.message);
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
    console.log('Assignment type dropdown found on AVG TIP tab, iterating through types...');

    for (const assignmentType of ASSIGNMENT_TYPES) {
      console.log(`  Scraping AVG TIP for type: ${assignmentType}`);

      const selected = await selectDropdown(page, dropdownSelector, assignmentType);
      if (!selected) {
        console.log(`  Could not select ${assignmentType}, skipping`);
        continue;
      }

      await page.waitForTimeout(1500);

      const typeMetrics = await extractTipMetrics(page);
      if (Object.keys(typeMetrics).length > 0) {
        data.byType[assignmentType] = typeMetrics;
      }
    }
  }

  console.log('AVG TIP data:', JSON.stringify(data, null, 2));
  return data;
}

/**
 * Extract TIP metrics from the page
 * @param {import('playwright').Page} page
 * @returns {Promise<Object>}
 */
async function extractTipMetrics(page) {
  const metrics = {};

  // Try to find metrics in cards or specific elements
  const metricSelectors = {
    upload: [
      '.card:has-text("Upload") .value',
      '[class*="upload"] .number',
      '.tip-upload',
      '#tipUpload'
    ],
    review: [
      '.card:has-text("Review") .value',
      '[class*="review"] .number',
      '.tip-review',
      '#tipReview'
    ],
    total: [
      '.card:has-text("Total") .value',
      '[class*="total"] .number',
      '.tip-total',
      '#tipTotal'
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
      upload: /Upload[:\s]*([-]?\d+\.?\d*)/i,
      review: /Review[:\s]*([-]?\d+\.?\d*)/i,
      total: /Total[:\s]*([-]?\d+\.?\d*)/i
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
          if (text.includes('upload')) {
            const num = text.match(/([-]?\d+\.?\d*)/);
            if (num) result.upload = parseFloat(num[1]);
          }
          if (text.includes('review')) {
            const num = text.match(/([-]?\d+\.?\d*)/);
            if (num) result.review = parseFloat(num[1]);
          }
          if (text.includes('total') && !text.includes('upload') && !text.includes('review')) {
            const num = text.match(/([-]?\d+\.?\d*)/);
            if (num) result.total = parseFloat(num[1]);
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

module.exports = { scrapeAvgTip };

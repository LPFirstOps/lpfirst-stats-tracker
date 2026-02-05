const { parseNumber, selectDropdown, hasDropdown, ASSIGNMENT_TYPES } = require('../utils');

/**
 * Scrape SURVEYS tab data
 * @param {import('playwright').Page} page
 * @returns {Promise<Object>}
 */
async function scrapeSurveys(page) {
  console.log('Scraping SURVEYS tab...');

  const data = {
    summary: {},
    byType: {}
  };

  // Extract summary metrics (Completed, Avg Score)
  try {
    const summaryMetrics = await extractSurveyMetrics(page);
    data.summary = summaryMetrics;
  } catch (error) {
    console.log('Error extracting SURVEYS summary:', error.message);
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
    console.log('Assignment type dropdown found on SURVEYS tab, iterating through types...');

    for (const assignmentType of ASSIGNMENT_TYPES) {
      console.log(`  Scraping SURVEYS for type: ${assignmentType}`);

      const selected = await selectDropdown(page, dropdownSelector, assignmentType);
      if (!selected) {
        console.log(`  Could not select ${assignmentType}, skipping`);
        continue;
      }

      await page.waitForTimeout(1500);

      const typeMetrics = await extractSurveyMetrics(page);
      if (Object.keys(typeMetrics).length > 0) {
        data.byType[assignmentType] = typeMetrics;
      }
    }
  }

  console.log('SURVEYS data:', JSON.stringify(data, null, 2));
  return data;
}

/**
 * Extract survey metrics from the page
 * @param {import('playwright').Page} page
 * @returns {Promise<Object>}
 */
async function extractSurveyMetrics(page) {
  const metrics = {};

  // Try to find metrics in cards or specific elements
  const metricSelectors = {
    completed: [
      '.card:has-text("Completed") .value',
      '[class*="completed"] .number',
      '.survey-completed',
      '#completed'
    ],
    avgScore: [
      '.card:has-text("Avg Score") .value',
      '.card:has-text("Average") .value',
      '[class*="avg-score"] .number',
      '.survey-avg-score',
      '#avgScore'
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
      completed: /Completed[:\s]*(\d+)/i,
      avgScore: /Avg\.?\s*Score[:\s]*([\d.]+)/i
    };

    for (const [key, pattern] of Object.entries(patterns)) {
      const match = pageText.match(pattern);
      if (match) {
        metrics[key] = parseNumber(match[1]);
      }
    }

    // Try alternate patterns
    if (!metrics.avgScore) {
      const avgMatch = pageText.match(/Average[:\s]*([\d.]+)/i);
      if (avgMatch) {
        metrics.avgScore = parseNumber(avgMatch[1]);
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
          if (text.includes('completed') || text.includes('surveys')) {
            const num = text.match(/(\d+)/);
            if (num && !result.completed) result.completed = parseInt(num[1]);
          }
          if (text.includes('avg') || text.includes('score') || text.includes('average')) {
            const num = text.match(/([\d.]+)/);
            if (num && !result.avgScore) result.avgScore = parseFloat(num[1]);
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

module.exports = { scrapeSurveys };

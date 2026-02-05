const { parseNumber, selectDropdown, extractTableData, hasDropdown, ASSIGNMENT_TYPES } = require('../utils');

/**
 * Scrape ASSIGNMENTS tab data
 * @param {import('playwright').Page} page
 * @returns {Promise<Object>}
 */
async function scrapeAssignments(page) {
  console.log('Scraping ASSIGNMENTS tab...');

  const data = {
    summary: {},
    byType: {}
  };

  // Extract summary metrics from header cards
  try {
    // Look for summary cards (yellow cards at top)
    const summarySelectors = {
      pending: [
        '.card:has-text("Pending") .value',
        '[class*="pending"] .number',
        'text=/Pending.*\\d+/i'
      ],
      complete: [
        '.card:has-text("Complete") .value',
        '[class*="complete"] .number',
        'text=/Complete.*\\d+/i'
      ],
      nonCompliant: [
        '.card:has-text("Non-Compliant") .value',
        '.card:has-text("Non Compliant") .value',
        '[class*="non-compliant"] .number'
      ]
    };

    // Try to extract summary values
    for (const [key, selectors] of Object.entries(summarySelectors)) {
      for (const selector of selectors) {
        try {
          const element = page.locator(selector).first();
          if (await element.isVisible({ timeout: 1000 }).catch(() => false)) {
            const text = await element.textContent();
            data.summary[key] = parseNumber(text);
            break;
          }
        } catch (e) {
          continue;
        }
      }
    }

    // If couldn't find specific elements, try to extract from page text
    if (Object.keys(data.summary).length === 0) {
      const pageText = await page.textContent('body');

      // Parse summary numbers from page
      const pendingMatch = pageText.match(/Pending[:\s]*(\d+)/i);
      const completeMatch = pageText.match(/Complete[:\s]*(\d+)/i);
      const nonCompliantMatch = pageText.match(/Non[- ]?Compliant[:\s]*(\d+)/i);

      if (pendingMatch) data.summary.pending = parseInt(pendingMatch[1]);
      if (completeMatch) data.summary.complete = parseInt(completeMatch[1]);
      if (nonCompliantMatch) data.summary.nonCompliant = parseInt(nonCompliantMatch[1]);
    }

  } catch (error) {
    console.log('Error extracting summary:', error.message);
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
    console.log('Assignment type dropdown found, iterating through types...');

    for (const assignmentType of ASSIGNMENT_TYPES) {
      console.log(`  Scraping type: ${assignmentType}`);

      const selected = await selectDropdown(page, dropdownSelector, assignmentType);
      if (!selected) {
        console.log(`  Could not select ${assignmentType}, skipping`);
        continue;
      }

      await page.waitForTimeout(1500); // Wait for data to load

      // Extract detailed table data
      const tableData = await extractAssignmentTable(page);
      if (tableData) {
        data.byType[assignmentType] = tableData;
      }
    }
  } else {
    console.log('No assignment type dropdown found, extracting general table');
    const tableData = await extractAssignmentTable(page);
    if (tableData) {
      data.byType['General'] = tableData;
    }
  }

  console.log('ASSIGNMENTS data:', JSON.stringify(data, null, 2));
  return data;
}

/**
 * Extract assignment table data
 * @param {import('playwright').Page} page
 * @returns {Promise<Object|null>}
 */
async function extractAssignmentTable(page) {
  try {
    // Try to find and parse the assignments table
    const tableSelectors = [
      'table.assignments',
      'table[id*="assignment" i]',
      '.assignments-table',
      'table.data-table',
      'table'
    ];

    for (const selector of tableSelectors) {
      try {
        const table = page.locator(selector).first();
        if (await table.isVisible({ timeout: 1000 }).catch(() => false)) {
          // Extract table data
          const rows = await page.evaluate((sel) => {
            const table = document.querySelector(sel);
            if (!table) return null;

            const result = {};
            const cells = table.querySelectorAll('td, th');

            cells.forEach(cell => {
              const text = cell.textContent.trim();
              // Look for label: value patterns
              const match = text.match(/^([^:]+):\s*(.+)$/);
              if (match) {
                result[match[1].trim()] = match[2].trim();
              }
            });

            // Also try to extract from rows
            const trs = table.querySelectorAll('tr');
            trs.forEach(row => {
              const tds = row.querySelectorAll('td');
              if (tds.length >= 2) {
                const label = tds[0].textContent.trim();
                const value = tds[1].textContent.trim();
                if (label && value) {
                  result[label] = value;
                }
              }
            });

            return result;
          }, selector);

          if (rows && Object.keys(rows).length > 0) {
            // Convert string values to numbers where applicable
            const parsed = {};
            for (const [key, value] of Object.entries(rows)) {
              parsed[camelCase(key)] = parseNumber(value) ?? value;
            }
            return parsed;
          }
        }
      } catch (e) {
        continue;
      }
    }

    // Fallback: try to extract metrics from page text
    const pageText = await page.textContent('body');
    const metrics = extractMetricsFromText(pageText);
    return Object.keys(metrics).length > 0 ? metrics : null;

  } catch (error) {
    console.log('Error extracting assignment table:', error.message);
    return null;
  }
}

/**
 * Extract metrics from page text using regex patterns
 * @param {string} text
 * @returns {Object}
 */
function extractMetricsFromText(text) {
  const metrics = {};

  const patterns = {
    assignmentsReceived: /Assignments?\s*Received[:\s]*(\d+)/i,
    estimatesReceived: /Estimates?\s*Received[:\s]*(\d+)/i,
    totalEstimateReceived: /Total\s*Estimate\s*Received[:\s]*\$?([\d,]+\.?\d*)/i,
    avgEstimateReceived: /Avg\.?\s*Estimate\s*Received[:\s]*\$?([\d,]+\.?\d*)/i,
    jobsSold: /Jobs?\s*Sold[:\s]*(\d+)/i,
    totalAmountJobsSold: /Total\s*Amount\s*Jobs?\s*Sold[:\s]*\$?([\d,]+\.?\d*)/i,
    avgAmountJobsSold: /Avg\.?\s*Amount\s*Jobs?\s*Sold[:\s]*\$?([\d,]+\.?\d*)/i,
    jobsNotSold: /Jobs?\s*Not\s*Sold[:\s]*(\d+)/i,
    jobsNotComplete: /Jobs?\s*Not\s*Complete[:\s]*(\d+)/i,
    jobsComplete: /Jobs?\s*Complete[:\s]*(\d+)/i,
    pomsExceptionRequests: /POMS?\s*Exception\s*Requests?[:\s]*(\d+)/i
  };

  for (const [key, pattern] of Object.entries(patterns)) {
    const match = text.match(pattern);
    if (match) {
      metrics[key] = parseNumber(match[1]);
    }
  }

  return metrics;
}

/**
 * Convert string to camelCase
 * @param {string} str
 * @returns {string}
 */
function camelCase(str) {
  return str
    .toLowerCase()
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, char) => char.toUpperCase())
    .replace(/^./, char => char.toLowerCase());
}

module.exports = { scrapeAssignments };

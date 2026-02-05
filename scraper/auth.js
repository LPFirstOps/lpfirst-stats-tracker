const { generateSync } = require('otplib');

/**
 * Authenticate to ContractorConnection via Auth0
 * @param {import('playwright').Page} page - Playwright page instance
 * @param {Object} credentials - Login credentials
 * @param {string} credentials.username
 * @param {string} credentials.password
 * @param {string} credentials.totpSecret - Base32 TOTP secret
 * @param {string} credentials.baseUrl
 * @returns {Promise<boolean>} - True if login successful
 */
async function login(page, { username, password, totpSecret, baseUrl }) {
  console.log('Starting login process...');

  // Navigate to dashboard - will redirect to Auth0 login
  await page.goto(baseUrl);
  await page.waitForLoadState('networkidle');

  // Check if already logged in
  if (page.url().includes('ContractorDashboard')) {
    console.log('Already logged in!');
    return true;
  }

  // Wait for Auth0 login page
  console.log('Waiting for Auth0 login page...');
  await page.waitForURL(/auth0\.com/, { timeout: 30000 });

  // Step 1: Enter username
  console.log('Entering username...');
  await page.getByRole('textbox', { name: /username|email/i }).fill(username);

  // Click the visible Continue button
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForLoadState('networkidle');

  // Step 2: Enter password
  console.log('Entering password...');
  await page.getByRole('textbox', { name: /password/i }).fill(password);

  // Click Continue
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForLoadState('networkidle');

  // Step 3: Handle 2FA
  console.log('Handling 2FA...');
  await page.waitForSelector('input[inputmode="numeric"], input[name="code"]', { timeout: 10000 });

  // Generate TOTP code
  const token = generateSync({ secret: totpSecret });
  console.log(`Generated TOTP code: ${token}`);

  // Enter the code
  await page.getByRole('textbox', { name: /code/i }).fill(token);

  // Click Continue
  await page.getByRole('button', { name: 'Continue' }).click();

  // Wait for redirect to dashboard
  console.log('Waiting for dashboard redirect...');
  await page.waitForURL(/ContractorDashboard/, { timeout: 30000 });

  console.log('Login successful!');
  return true;
}

/**
 * Navigate to the Scorecard/Summary page
 * @param {import('playwright').Page} page
 * @param {string} baseUrl
 */
async function navigateToScorecard(page, baseUrl) {
  console.log('Navigating to Scorecard...');

  // The baseUrl should already point to the summary page
  if (!page.url().includes('Summary')) {
    await page.goto(baseUrl);
    await page.waitForLoadState('networkidle');
  }

  console.log('At Scorecard page:', page.url());
}

module.exports = {
  login,
  navigateToScorecard
};

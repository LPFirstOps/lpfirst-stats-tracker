// Standalone ContractorConnection scraper
if (require.main === module) {
  const { runStandalone } = require('./utils');
  const { scrapeContractorConnection } = require('./index');
  runStandalone('ContractorConnection', async (browser, stats) => {
    await scrapeContractorConnection(browser, stats, { daily: true });
  });
}

// Standalone ContractorConnection scraper (A-Action)
if (require.main === module) {
  const { runStandalone } = require('./utils');
  const { scrapeAactionCC } = require('./index');
  runStandalone('ContractorConnection', async (browser, stats) => {
    await scrapeAactionCC(browser, stats, { daily: true });
  });
}

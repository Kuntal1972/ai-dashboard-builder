const puppeteer = require('puppeteer');
const path = require('path');

(async () => {
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();

  // Set a wide viewport to match cheatsheet design
  await page.setViewport({ width: 1450, height: 900, deviceScaleFactor: 1.5 });

  const filePath = path.resolve(__dirname, 'cheatsheet.html');
  await page.goto(`file:///${filePath}`, { waitUntil: 'networkidle0' });

  // Wait a moment for rendering
  await new Promise(r => setTimeout(r, 500));

  // Get full page height
  const bodyHeight = await page.evaluate(() => document.body.scrollHeight);
  await page.setViewport({ width: 1450, height: bodyHeight, deviceScaleFactor: 1.5 });
  await page.goto(`file:///${filePath}`, { waitUntil: 'networkidle0' });

  await page.screenshot({
    path: path.resolve(__dirname, 'AI_Dashboard_Builder_CheatSheet.png'),
    fullPage: true
  });

  await browser.close();
  console.log('Screenshot saved: AI_Dashboard_Builder_CheatSheet.png');
})();

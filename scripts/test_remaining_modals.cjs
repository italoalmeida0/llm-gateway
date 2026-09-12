const { chromium } = require('/usr/share/code/resources/app/node_modules/playwright-core');
const { execSync } = require('child_process');

async function testRemaining() {
  const browser = await chromium.launch({
    executablePath: '/home/user/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
    headless: true
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 }
  });
  const page = await context.newPage();

  // Login as admin
  await page.goto('http://localhost:4991/');
  await page.fill('input[type="email"]', 'admin@example.com');
  await page.fill('input[type="password"]', 'adminpassword123');
  await page.click('button[type="submit"]');
  await page.waitForTimeout(1000);

  // Test 1: Keys Token Reveal modal
  console.log('--- Testing Keys Token Reveal modal ---');
  await page.goto('http://localhost:4991/#/keys');
  await page.waitForSelector('button:has-text("New key")');
  await page.click('button:has-text("New key")');
  await page.waitForSelector('[role="dialog"]');
  await page.fill('[role="dialog"] input[type="text"]', 'audit-test-token-reveal');
  await page.click('[role="dialog"] button:has-text("Create key")');
  await page.waitForSelector('[role="dialog"] h3:has-text("API key generated successfully")');
  console.log('Keys Token Reveal modal opened! Title:', await page.locator('[role="dialog"] h3').innerText());
  await page.click('[role="dialog"] button:has-text("Done")');
  await page.waitForTimeout(300);

  // Test 2: Settings Disable 2FA modal
  console.log('--- Testing Settings Disable 2FA modal ---');
  execSync(`bun -e "
    import { Database } from 'bun:sqlite';
    const db = new Database('/tmp/audit-llmgw-v2/gateway.db');
    db.prepare('UPDATE users SET totp_secret = ? WHERE role = ?').run('JBSWY3DPEHPK3PXP', 'admin');
  "`);
  await page.goto('http://localhost:4991/#/settings');
  await page.waitForSelector('button:has-text("Disable 2FA")');
  await page.click('button:has-text("Disable 2FA")');
  await page.waitForSelector('[role="dialog"] h3:has-text("Disable two-factor authentication")');
  console.log('Disable 2FA modal opened! Title:', await page.locator('[role="dialog"] h3').innerText());
  await page.click('[role="dialog"] button:has-text("Cancel")');
  await page.waitForTimeout(300);

  // Test 3: Indirect Code Settings modal
  console.log('--- Testing Indirect Code Settings modal ---');
  await page.goto('http://localhost:4991/#/code');
  await page.waitForSelector('button:has-text("Settings")');
  await page.click('button:has-text("Settings")');
  await page.waitForSelector('[role="dialog"] h3:has-text("Host & Agent Settings")');
  console.log('Indirect Code Settings modal opened! Title:', await page.locator('[role="dialog"] h3').innerText());
  await page.click('[role="dialog"] button:has-text("Cancel")');
  await page.waitForTimeout(300);

  // Test 4: Indirect Code Pair Host modal
  console.log('--- Testing Indirect Code Pair Host modal ---');
  // Click host switcher button
  const hostBtn = page.locator('aside button').filter({ hasText: 'AuditHost' }).first();
  await hostBtn.click();
  await page.waitForSelector('button:has-text("Connect another host")');
  await page.click('button:has-text("Connect another host")');
  await page.waitForSelector('[role="dialog"] h3:has-text("Pair Indirect Code Host")');
  console.log('Pair Host modal opened! Title:', await page.locator('[role="dialog"] h3').innerText());
  await page.click('[role="dialog"] button:has-text("Done")');
  await page.waitForTimeout(300);

  // Test 5: Indirect Code New Project modal
  console.log('--- Testing Indirect Code New Project modal ---');
  // Look for new project button in sidebar
  const newProjBtn = page.locator('button[title="Open a local folder as a project"]');
  if (await newProjBtn.isVisible()) {
    await newProjBtn.click();
  } else {
    // Or folder icon
    const altBtn = page.locator('aside button:has-text("New project")');
    if (await altBtn.isVisible()) {
      await altBtn.click();
    } else {
      console.log('Looking for folder button in sidebar...');
      await page.click('aside [title*="project"], aside [aria-label*="project"]');
    }
  }
  await page.waitForSelector('[role="dialog"] h3:has-text("Select project folder")');
  console.log('New Project modal opened! Title:', await page.locator('[role="dialog"] h3').innerText());
  await page.click('[role="dialog"] button:has-text("Cancel")');

  await browser.close();
  console.log('All remaining modals tested successfully!');
}

testRemaining().catch(console.error);

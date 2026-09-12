const { chromium } = require('/usr/share/code/resources/app/node_modules/playwright-core');

async function testModals() {
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
  console.log('Logged in URL:', page.url());

  // Test 1: Keys create modal
  await page.goto('http://localhost:4991/#/keys');
  await page.waitForSelector('button:has-text("New key")');
  await page.click('button:has-text("New key")');
  await page.waitForSelector('[role="dialog"]');
  console.log('Keys Create modal opened! Title:', await page.locator('[role="dialog"] h3').innerText());
  await page.click('[role="dialog"] button:has-text("Cancel")');
  await page.waitForTimeout(300);

  // Test 2: Admin models modal
  await page.goto('http://localhost:4991/#/admin/models');
  await page.waitForSelector('button:has-text("New model")');
  await page.click('button:has-text("New model")');
  await page.waitForSelector('[role="dialog"]');
  console.log('Admin Models modal opened! Title:', await page.locator('[role="dialog"] h3').innerText());
  await page.click('[role="dialog"] button:has-text("Cancel")');
  await page.waitForTimeout(300);

  // Test 3: Admin providers modal
  await page.goto('http://localhost:4991/#/admin/providers');
  await page.waitForSelector('button:has-text("New provider")');
  await page.click('button:has-text("New provider")');
  await page.waitForSelector('[role="dialog"]');
  console.log('Admin Providers modal opened! Title:', await page.locator('[role="dialog"] h3').innerText());
  await page.click('[role="dialog"] button:has-text("Cancel")');
  await page.waitForTimeout(300);

  // Test 4: Admin users modal
  await page.goto('http://localhost:4991/#/admin/users');
  await page.waitForSelector('button:has-text("New user")');
  await page.click('button:has-text("New user")');
  await page.waitForSelector('[role="dialog"]');
  console.log('Admin Users modal opened! Title:', await page.locator('[role="dialog"] h3').innerText());
  await page.click('[role="dialog"] button:has-text("Cancel")');
  await page.waitForTimeout(300);

  // Test 5: Indirect code page
  await page.goto('http://localhost:4991/#/code');
  await page.waitForTimeout(1500);
  console.log('Indirect code URL:', page.url());
  const sidebarExists = await page.locator('aside').count();
  console.log('Sidebar count:', sidebarExists);

  await browser.close();
}

testModals().catch(console.error);

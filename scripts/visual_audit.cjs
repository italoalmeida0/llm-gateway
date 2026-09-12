const { chromium } = require('/usr/share/code/resources/app/node_modules/playwright-core');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SCREENSHOT_DIR = '/home/user/.gemini/antigravity-cli/brain/0a5f1057-c340-4fab-a385-a8d11d2b231f/audit_screenshots_v2';
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 375, height: 812 }
];

const auditResults = {
  viewports: {},
  colorViolations: [],
  responsiveChecks: []
};

async function ensureSidebarOpen(page) {
  const expandBtn = page.locator('button[aria-label="Expand sidebar"]');
  try {
    if (await expandBtn.isVisible({ timeout: 500 })) {
      await expandBtn.click();
      await page.waitForTimeout(300);
    }
  } catch {}
}

async function runAudit() {
  console.log('=== STARTING VISUAL QA & RESPONSIVENESS AUDIT ===');
  console.log(`Destination directory: ${SCREENSHOT_DIR}`);

  const browser = await chromium.launch({
    executablePath: '/home/user/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
    headless: true
  });

  for (const vp of VIEWPORTS) {
    console.log(`\n========================================`);
    console.log(`>>> VIEWPORT: ${vp.name.toUpperCase()} (${vp.width}x${vp.height}) <<<`);
    console.log(`========================================`);
    auditResults.viewports[vp.name] = { modals: [] };

    // Reset TOTP in DB before login
    execSync(`bun -e "
      import { Database } from 'bun:sqlite';
      const db = new Database('/tmp/audit-llmgw-v2/gateway.db');
      db.prepare('UPDATE users SET totp_secret = NULL WHERE role = ?').run('admin');
    "`);

    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2 // Crisp high-DPI screenshots
    });
    const page = await context.newPage();

    // Login as admin
    await page.goto('http://localhost:4991/');
    await page.fill('input[type="email"]', 'admin@example.com');
    await page.fill('input[type="password"]', 'adminpassword123');
    await page.click('button[type="submit"]');
    await page.waitForTimeout(1000);

    // Ensure dark theme for consistency
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
      localStorage.setItem('llmgw-theme', 'dark');
    });

    // Helper to inspect modal styling and take screenshot
    async function auditAndCapture(modalKey, modalTitle) {
      const dialog = page.locator('[role="dialog"]');
      await dialog.waitFor({ state: 'visible', timeout: 8000 });
      await page.waitForTimeout(400); // let animation settle

      // Run styling verification
      const inspection = await dialog.evaluate((dialogEl, { vpWidth, vpHeight, modalKey }) => {
        const bodyEl = dialogEl.querySelector('.overflow-y-auto') || dialogEl;
        const rect = dialogEl.getBoundingClientRect();
        
        // 1. Check for blue- classes
        const allElements = dialogEl.querySelectorAll('*');
        const blueClasses = [];
        for (const el of allElements) {
          const cls = el.className || '';
          if (typeof cls === 'string') {
            const matches = cls.match(/\bblue-[a-z0-9]+/g);
            if (matches) blueClasses.push(...matches);
          }
        }

        // 2. Check for overflow
        const hasHorizontalOverflow = bodyEl.scrollWidth > bodyEl.clientWidth + 2;
        
        // 3. Check width constraint
        const fitsInViewport = rect.width <= vpWidth;
        const isCentered = Math.abs((vpWidth - rect.width) / 2 - rect.left) < 25;

        // 4. Check buttons for primary styling
        const primaryBtns = Array.from(dialogEl.querySelectorAll('button')).filter(b => {
          const cls = b.className || '';
          return cls.includes('bg-accent-500');
        });

        // 5. Check active chips
        const activeChips = Array.from(dialogEl.querySelectorAll('button')).filter(b => {
          const cls = b.className || '';
          return cls.includes('bg-accent-500') && cls.includes('text-accent-fg');
        });

        return {
          blueClasses: Array.from(new Set(blueClasses)),
          dialogWidth: Math.round(rect.width),
          dialogHeight: Math.round(rect.height),
          dialogLeft: Math.round(rect.left),
          fitsInViewport,
          isCentered,
          hasHorizontalOverflow,
          bodyScrollWidth: bodyEl.scrollWidth,
          bodyClientWidth: bodyEl.clientWidth,
          hasVerticalScroll: bodyEl.scrollHeight > bodyEl.clientHeight,
          primaryBtnCount: primaryBtns.length,
          activeChipCount: activeChips.length
        };
      }, { vpWidth: vp.width, vpHeight: vp.height, modalKey });

      console.log(`  [Audit ${modalKey}] Width: ${inspection.dialogWidth}px (fits: ${inspection.fitsInViewport}), HorizOverflow: ${inspection.hasHorizontalOverflow}, BlueClasses: ${inspection.blueClasses.length}`);

      if (inspection.blueClasses.length > 0) {
        console.warn(`    WARNING: Hardcoded blue found in ${modalKey}: ${inspection.blueClasses.join(', ')}`);
        auditResults.colorViolations.push({ vp: vp.name, modal: modalKey, classes: inspection.blueClasses });
      }

      auditResults.viewports[vp.name].modals.push({
        modalKey,
        modalTitle,
        ...inspection
      });

      const shotName = `${vp.name}_${modalKey}.png`;
      const shotPath = path.join(SCREENSHOT_DIR, shotName);
      await page.screenshot({ path: shotPath, fullPage: false });
      console.log(`  [Screenshot saved] ${shotName}`);
    }

    // -------------------------------------------------------------
    // MODAL 1: Keys - Create Key modal
    // -------------------------------------------------------------
    console.log('\n--- 1. Keys: Create Key modal ---');
    await page.goto('http://localhost:4991/#/keys');
    await page.waitForSelector('button:has-text("New key")');
    await page.click('button:has-text("New key")');
    await page.waitForSelector('[role="dialog"]');

    // Select preset chip "30 days"
    const chip30 = page.locator('[role="dialog"] button:has-text("30 days")');
    if (await chip30.isVisible()) await chip30.click();

    // Toggle switch card for RPM
    const rpmSwitch = page.locator('[role="dialog"] [role="button"]:has-text("Enable per-minute rate limiting")');
    if (await rpmSwitch.isVisible()) await rpmSwitch.click();

    // Fill key name
    await page.fill('[role="dialog"] input[placeholder*="production"]', 'prod-api-key');

    await auditAndCapture('01_keys_create', 'Create API key');

    // -------------------------------------------------------------
    // MODAL 2: Keys - Token Reveal modal
    // -------------------------------------------------------------
    console.log('\n--- 2. Keys: Token Reveal modal ---');
    // Click "Create key" in the already-open Create Key modal
    await page.click('[role="dialog"] button:has-text("Create key")');
    await page.waitForSelector('[role="dialog"] h3:has-text("API key generated successfully")');
    await auditAndCapture('02_keys_reveal', 'Token Reveal');
    await page.click('[role="dialog"] button:has-text("Done")');
    await page.waitForTimeout(300);

    // -------------------------------------------------------------
    // MODAL 3: Admin Models - New Model modal
    // -------------------------------------------------------------
    console.log('\n--- 3. Admin Models: New Model modal ---');
    await page.goto('http://localhost:4991/#/admin/models');
    await page.waitForSelector('button:has-text("New model")');
    await page.click('button:has-text("New model")');
    await page.waitForSelector('[role="dialog"]');

    // Fill public model ID
    await page.fill('[role="dialog"] input[placeholder*="gpt-4o"]', 'claude-3-5-sonnet-audit');

    // Click "+ Add another fallback target"
    const addTargetBtn = page.locator('[role="dialog"] button:has-text("+ Add another fallback target")');
    if (await addTargetBtn.isVisible()) await addTargetBtn.click();
    await page.waitForTimeout(200);

    await auditAndCapture('03_admin_models', 'Register model');
    await page.click('[role="dialog"] button:has-text("Cancel")');
    await page.waitForTimeout(300);

    // -------------------------------------------------------------
    // MODAL 4: Admin Providers - New Provider modal
    // -------------------------------------------------------------
    console.log('\n--- 4. Admin Providers: New Provider modal ---');
    await page.goto('http://localhost:4991/#/admin/providers');
    await page.waitForSelector('button:has-text("New provider")');
    await page.click('button:has-text("New provider")');
    await page.waitForSelector('[role="dialog"]');

    // Fill provider fields
    await page.fill('[role="dialog"] input[placeholder*="OpenAI Direct"]', 'Mistral AI Cloud');
    await page.fill('[role="dialog"] input[placeholder*="https://api.openai.com/v1"]', 'https://api.mistral.ai/v1');
    await page.fill('[role="dialog"] input[type="password"]', 'sk-mistral-live-mock-key-secret');

    await auditAndCapture('04_admin_providers', 'New provider');
    await page.click('[role="dialog"] button:has-text("Cancel")');
    await page.waitForTimeout(300);

    // -------------------------------------------------------------
    // MODAL 5: Admin Users - New User modal
    // -------------------------------------------------------------
    console.log('\n--- 5. Admin Users: New User modal ---');
    await page.goto('http://localhost:4991/#/admin/users');
    await page.waitForSelector('button:has-text("New user")');
    await page.click('button:has-text("New user")');
    await page.waitForSelector('[role="dialog"]');

    // Fill user inputs
    await page.fill('[role="dialog"] input[type="email"]', 'auditor@deepmind.internal');
    await page.fill('[role="dialog"] input[placeholder*="Alice Smith"]', 'Visual QA Auditor');

    // Select Admin role chip
    const adminChip = page.locator('[role="dialog"] button:has-text("Admin (Full access)")');
    if (await adminChip.isVisible()) await adminChip.click();

    await auditAndCapture('05_admin_users', 'Create user');
    await page.click('[role="dialog"] button:has-text("Cancel")');
    await page.waitForTimeout(300);

    // -------------------------------------------------------------
    // MODAL 6: Settings - Disable 2FA modal
    // -------------------------------------------------------------
    console.log('\n--- 6. Settings: Disable 2FA modal ---');
    // Enable TOTP in DB and in localStorage session
    execSync(`bun -e "
      import { Database } from 'bun:sqlite';
      const db = new Database('/tmp/audit-llmgw-v2/gateway.db');
      db.prepare('UPDATE users SET totp_secret = ? WHERE role = ?').run('JBSWY3DPEHPK3PXP', 'admin');
    "`);
    await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('llm_gateway_session') || '{}');
      if (s.user) s.user.totpEnabled = true;
      localStorage.setItem('llm_gateway_session', JSON.stringify(s));
    });
    await page.goto('http://localhost:4991/#/settings');
    await page.reload();
    await page.waitForSelector('button:has-text("Disable 2FA")');
    await page.click('button:has-text("Disable 2FA")');
    await page.waitForSelector('[role="dialog"] h3:has-text("Disable two-factor authentication")');

    // Fill 6-digit code
    await page.fill('[role="dialog"] input[autocomplete="one-time-code"]', '482910');

    await auditAndCapture('06_settings_disable_2fa', 'Disable two-factor authentication');
    await page.click('[role="dialog"] button:has-text("Cancel")');
    await page.waitForTimeout(300);

    // Reset totp in DB
    execSync(`bun -e "
      import { Database } from 'bun:sqlite';
      const db = new Database('/tmp/audit-llmgw-v2/gateway.db');
      db.prepare('UPDATE users SET totp_secret = NULL WHERE role = ?').run('admin');
    "`);

    // -------------------------------------------------------------
    // MODAL 7: Indirect Code - New Project modal
    // -------------------------------------------------------------
    console.log('\n--- 7. Indirect Code: New Project modal ---');
    await page.goto('http://localhost:4991/#/code');
    await page.waitForTimeout(1500);

    await ensureSidebarOpen(page);

    const newProjectTrigger = page.locator('aside button[aria-label="Create new project"], aside button:has-text("Select a project folder")').first();
    await newProjectTrigger.click();
    await page.waitForTimeout(200);

    const npOption = page.locator('button:has-text("New Project")');
    if (await npOption.isVisible()) {
      await npOption.click();
    }
    await page.waitForSelector('[role="dialog"] h3:has-text("Select project folder")');
    await page.waitForTimeout(500); // let host folder list load

    await auditAndCapture('07_indirect_code_new_project', 'Select project folder');
    await page.click('[role="dialog"] button:has-text("Cancel")');
    await page.waitForTimeout(300);

    // -------------------------------------------------------------
    // MODAL 8: Indirect Code - Pair Host modal
    // -------------------------------------------------------------
    console.log('\n--- 8. Indirect Code: Pair Host modal ---');
    await ensureSidebarOpen(page);

    const hostBtn = page.locator('aside button').filter({ hasText: 'AuditHost' }).first();
    await hostBtn.click();
    await page.waitForSelector('button:has-text("Connect another host")');
    await page.click('button:has-text("Connect another host")');
    await page.waitForSelector('[role="dialog"] h3:has-text("Pair Indirect Code Host")');

    await auditAndCapture('08_indirect_code_pair_host', 'Pair Indirect Code Host');
    await page.click('[role="dialog"] button:has-text("Done")');
    await page.waitForTimeout(300);

    // -------------------------------------------------------------
    // MODAL 9: Indirect Code - Settings modal
    // -------------------------------------------------------------
    console.log('\n--- 9. Indirect Code: Settings modal ---');
    await ensureSidebarOpen(page);

    const settingsBtn = page.locator('aside button:has-text("Settings")');
    await settingsBtn.click();
    await page.waitForSelector('[role="dialog"] h3:has-text("Host & Agent Settings")');

    await auditAndCapture('09_indirect_code_settings', 'Host & Agent Settings');
    await page.click('[role="dialog"] button:has-text("Cancel")');
    await page.waitForTimeout(300);

    await context.close();
  }

  await browser.close();

  // Save audit report
  const reportPath = path.join(SCREENSHOT_DIR, 'audit_report.json');
  fs.writeFileSync(reportPath, JSON.stringify(auditResults, null, 2));
  console.log(`\n=== AUDIT COMPLETE ===`);
  console.log(`Total screenshots saved: ${VIEWPORTS.length * 9}`);
  console.log(`Report written to: ${reportPath}`);
}

runAudit().catch(err => {
  console.error('Audit failed with error:', err);
  process.exit(1);
});

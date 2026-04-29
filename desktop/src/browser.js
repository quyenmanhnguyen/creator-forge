const path = require("path");
const fs = require("fs");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { LOGIN_URL, SESSIONS_DIR } = require("./config");
const { delay, humanType, waitForTurnstile, handleCf } = require("./utils");

puppeteer.use(StealthPlugin());

/**
 * Auto-detect Chrome/Chromium/Edge executable on the system.
 * Returns the first found path, or null if none found.
 */
function findChromePath() {
  const possiblePaths = [];

  if (process.platform === "win32") {
    const prefixes = [
      process.env.PROGRAMFILES,
      process.env["PROGRAMFILES(X86)"],
      process.env.LOCALAPPDATA,
    ].filter(Boolean);

    for (const prefix of prefixes) {
      possiblePaths.push(
        path.join(prefix, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(prefix, "Chromium", "Application", "chrome.exe"),
      );
    }
    // Edge as fallback (Chromium-based)
    for (const prefix of prefixes) {
      possiblePaths.push(
        path.join(prefix, "Microsoft", "Edge", "Application", "msedge.exe"),
      );
    }
  } else if (process.platform === "darwin") {
    possiblePaths.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  } else {
    // Linux
    possiblePaths.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    );
  }

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      console.log(`[Browser] ✅ Found Chrome at: ${p}`);
      return p;
    }
  }

  console.log("[Browser] ⚠️ No system Chrome found, will try Puppeteer bundled Chrome");
  return null;
}

async function login(page, email, password, label) {
  console.log(`[${label}] 🔑 Login ${email}...`);
  await page.goto(LOGIN_URL, { waitUntil: "networkidle2", timeout: 60000 });
  await handleCf(page, label);
  await delay(2000, 3000);
  if ((await page.title()).toLowerCase().includes("just a moment")) {
    console.log(`[${label}] 🛡️ CF on login page, waiting...`);
    await handleCf(page, label);
  }
  const emailInput = await page
    .waitForSelector('[data-testid="email"]', { timeout: 10000 })
    .catch(() => null);
  if (!emailInput) {
    console.log(`[${label}] ✅ Đã login sẵn, skip!`);
    return true;
  }
  await delay(500, 1000);
  await humanType(page, '[data-testid="email"]', email);
  await delay(500, 1000);
  await page.click('button[type="submit"]');
  await page.waitForSelector('input[name="password"]', { timeout: 15000 });
  await delay(500, 1000);
  await humanType(page, 'input[name="password"]', password);
  await delay(1000, 2000);
  if (
    await page.evaluate(
      () => !!document.querySelector('input[name="cf-turnstile-response"]'),
    )
  )
    await waitForTurnstile(page);
  await delay(500, 1000);
  await page.click('button[type="submit"]');
  await page
    .waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 })
    .catch(() => { });
  if (page.url().includes("sign-in")) {
    console.log(`[${label}] ❌ Login failed!`);
    return false;
  }
  console.log(`[${label}] ✅ Login OK!`);
  return true;
}

/**
 * Wait for headers with x-statsig-id to be captured
 * Returns a promise that resolves when headers are captured or timeout
 */
function waitForHeaders(page, label, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let capturedHeaders = null;
    const startTime = Date.now();

    const handler = (req) => {
      if (!capturedHeaders) {
        const h = req.headers();
        if (h['x-statsig-id']) {
          capturedHeaders = { ...h };
          console.log(`[${label}] 🔑 Headers captured (x-statsig-id: ${h['x-statsig-id']?.substring(0, 20)}...)`);
          resolve(capturedHeaders);
        }
      }
    };

    page.on('request', handler);

    // Timeout fallback
    setTimeout(() => {
      if (!capturedHeaders) {
        console.log(`[${label}] ⏰ Header capture timeout after ${timeoutMs}ms`);
        resolve(null);
      }
    }, timeoutMs);
  });
}

async function setupAccount(account, accIdx) {
  const label = `Acc${accIdx + 1}`;
  const emailSafe = account.email.replace(/[^a-z0-9]/gi, "_");
  const sessionDir = path.join(SESSIONS_DIR, emailSafe);

  console.log(`[${label}] 🔧 Launch: ${account.email}`);

  const chromePath = findChromePath();
  if (!chromePath) {
    throw new Error(
      "Chrome/Edge not found on this machine. Please install Google Chrome or Microsoft Edge."
    );
  }

  console.log(`[${label}] 🚀 Launching browser...`);
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: chromePath,
    defaultViewport: { width: 1280, height: 720 },
    userDataDir: sessionDir,
    protocolTimeout: 300000,
    args: [
      "--window-position=0,0",
      "--window-size=1280,720",
      "--no-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--disable-features=TranslateUI",
      "--remote-debugging-port=0",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  });

  const pages = await browser.pages();
  for (let i = 1; i < pages.length; i++) await pages[i].close();
  const page = pages[0] || (await browser.newPage());
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  // Check session bằng accounts.x.ai/account
  console.log(`[${label}] 🔍 Check session...`);
  await page.goto("https://accounts.x.ai/account", {
    waitUntil: "networkidle2",
    timeout: 60000,
  });
  await delay(2000, 3000);

  const checkUrl = page.url();
  const needsLogin = checkUrl.includes("sign-in");

  if (needsLogin) {
    console.log(`[${label}] 🔑 Session hết hạn, cần login... (redirected → ${checkUrl})`);
    const loggedIn = await login(page, account.email, account.password, label);
    if (!loggedIn) {
      console.log(`[${label}] ❌ Login failed!`);
      await browser.close();
      return null;
    }
  } else {
    console.log(`[${label}] ✅ Session OK (${checkUrl})`);
  }

  // Navigate to grok.com and capture headers
  console.log(`[${label}] 🌐 Mở grok.com và capture headers...`);

  // Start header capture BEFORE navigation
  const headerPromise = waitForHeaders(page, label, 30000);

  await page.goto("https://grok.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await handleCf(page, label);

  // Wait for networkidle (best-effort)
  try {
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 10000 });
  } catch (e) { }

  // Wait for headers to be captured (up to 15s)
  let capturedHeaders = await headerPromise;

  // Retry: if no headers captured, reload and try again
  if (!capturedHeaders) {
    console.log(`[${label}] 🔄 Retry header capture — reloading grok.com...`);
    const retryHeaderPromise = waitForHeaders(page, label, 30000);
    await page.reload({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => { });
    await delay(2000, 3000);
    capturedHeaders = await retryHeaderPromise;
  }

  // Third attempt: type something to trigger an API call
  if (!capturedHeaders) {
    console.log(`[${label}] 🔄 Third attempt — triggering API call...`);
    const thirdHeaderPromise = waitForHeaders(page, label, 30000);
    try {
      const chatInput = await page.waitForSelector('textarea, [contenteditable], input[type="text"]', { timeout: 5000 }).catch(() => null);
      if (chatInput) {
        await chatInput.click();
        await delay(1000, 2000);
        await page.keyboard.type('hi', { delay: 100 });
        await delay(2000, 3000);
        await page.keyboard.down('Control');
        await page.keyboard.press('a');
        await page.keyboard.up('Control');
        await page.keyboard.press('Backspace');
      }
      await page.reload({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
    } catch (_) {}
    capturedHeaders = await thirdHeaderPromise;
  }

  if (capturedHeaders) {
    console.log(`[${label}] ✅ Got ${Object.keys(capturedHeaders).length} headers`);
  } else {
    console.log(`[${label}] ❌ Failed to capture headers after retry`);
    await browser.close();
    return null;
  }

  console.log(`[${label}] ✅ Ready! (1 tab)\n`);
  return { browser, page, accIdx, statsigId: capturedHeaders?.['x-statsig-id'] || null, capturedHeaders };
}

module.exports = { login, setupAccount };

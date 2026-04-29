function delay(min, max) {
  const ms = max ? Math.floor(Math.random() * (max - min + 1)) + min : min;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function humanType(page, selector, text) {
  await page.click(selector);
  await delay(200, 400);
  for (const char of text) {
    await page.keyboard.type(char, { delay: Math.random() * 80 + 20 });
  }
}

async function waitForTurnstile(page) {
  for (let i = 0; i < 20; i++) {
    const ok = await page.evaluate(() => {
      const el = document.querySelector('input[name="cf-turnstile-response"]');
      return el && el.value && el.value.length > 0;
    });
    if (ok) return true;
    const cf = page
      .frames()
      .find(
        (f) =>
          f.url().includes("challenges.cloudflare.com") ||
          f.url().includes("turnstile"),
      );
    if (cf) {
      const cb = await cf
        .waitForSelector(
          'input[type="checkbox"], .cb-lb, .ctp-checkbox-label',
          { timeout: 2000 },
        )
        .catch(() => null);
      if (cb) {
        await delay(500, 1200);
        await cb.click();
        await delay(2000, 3000);
      }
    }
    await delay(1000, 1500);
  }
  return false;
}

async function handleCf(page, label) {
  const title = await page.title();
  if (!title.toLowerCase().includes("just a moment")) return true;
  console.log(`[${label}] 🛡️ CF challenge...`);
  for (let i = 0; i < 30; i++) {
    try {
      const cf = page
        .frames()
        .find(
          (f) =>
            f.url().includes("challenges.cloudflare.com") ||
            f.url().includes("turnstile"),
        );
      if (cf) {
        const el = await cf
          .waitForSelector(
            'input[type="checkbox"], .cb-lb, .ctp-checkbox-label, button, [role="button"], label',
            { timeout: 3000 },
          )
          .catch(() => null);
        if (el) {
          await delay(500, 1500);
          await el.click();
          await delay(2000, 4000);
        }
      }
      if (!(await page.title()).toLowerCase().includes("just a moment")) {
        console.log(`[${label}] ✅ CF passed!`);
        return true;
      }
    } catch (e) {}
    await delay(1000, 2000);
  }
  return false;
}

module.exports = { delay, humanType, waitForTurnstile, handleCf };

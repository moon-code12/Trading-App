import { test, expect } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { code } from '../server/src/totp.js';

const PASSWORD = 'password123';
const NEW_PASSWORD = 'newpassword456';
const stamp = Date.now();

const dbToken = (email) => {
  const db = new DatabaseSync(process.env.E2E_DB);
  const row = db.prepare('SELECT t.token FROM email_tokens t JOIN users u ON u.id = t.user_id WHERE u.email = ?').get(email);
  db.close();
  return row?.token;
};

async function login(page, email, password, totpSecret) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  if (totpSecret) {
    await page.getByLabel('Two-factor code').fill(code(totpSecret));
    await page.getByRole('button', { name: 'Log in' }).click();
  }
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

const logout = async (page) => {
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login/);
};

const noHorizontalOverflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

// Orders render as table rows on desktop and as list cards on mobile.
const orderRow = (page, re) => page.locator(page.viewportSize().width < 1024 ? 'li' : 'tr').filter({ hasText: re });

const apiGet = (page, path) =>
  page.evaluate(async (p) => {
    const r = await fetch('/api' + p, { headers: { authorization: `Bearer ${localStorage.getItem('token')}` } });
    return r.json();
  }, path);

test('full user journey', async ({ page, browser }, info) => {
  const email = `user-${info.project.name}-${stamp}@e2e.test`;
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  // Expected 4xx responses from negative-path steps are logged by the browser; only flag unexpected ones.
  page.on('response', (r) => {
    if (r.status() === 404 || r.status() >= 500) errors.push(`${r.status()} ${r.url()}`);
  });
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(`console: ${m.text()}`);
  });
  const isMobile = info.project.name === 'mobile';

  await test.step('landing page', async () => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Trade smarter');
    expect(await noHorizontalOverflow(page)).toBe(true);
  });

  await test.step('register shows validation and creates account', async () => {
    await page.getByRole('link', { name: 'Create free account' }).click();
    await expect(page).toHaveURL(/\/register/);
    await page.getByLabel('Full name').fill('E2E User');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel(/Password/).fill(PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByText('Your email is not verified yet')).toBeVisible();
  });

  await test.step('duplicate registration is rejected', async () => {
    const other = await browser.newPage();
    await other.goto('/register');
    await other.getByLabel('Full name').fill('Dup');
    await other.getByLabel('Email').fill(email);
    await other.getByLabel(/Password/).fill(PASSWORD);
    await other.getByRole('button', { name: 'Create account' }).click();
    await expect(other.getByText('Email already registered')).toBeVisible();
    await other.close();
  });

  await test.step('email verification', async () => {
    const token = dbToken(email);
    expect(token).toBeTruthy();
    await page.goto(`/verify-email?token=${token}`);
    await page.getByRole('button', { name: 'Confirm my email' }).click();
    await expect(page.getByText('Email verified')).toBeVisible();
    await page.goto('/dashboard');
    await expect(page.getByText('Your email is not verified yet')).toBeHidden();
    await page.goto('/verify-email?token=bogus');
    await page.getByRole('button', { name: 'Confirm my email' }).click();
    await expect(page.getByText('Invalid or expired token')).toBeVisible();
  });

  await test.step('logout and login, wrong password rejected', async () => {
    await page.goto('/dashboard');
    await logout(page);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('wrongpass1');
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page.getByText('Invalid email or password')).toBeVisible();
    await login(page, email, PASSWORD);
  });

  await test.step('wallet deposit and blocked withdrawal', async () => {
    await page.goto('/wallet');
    await page.getByLabel('Amount').fill('500');
    await page.getByRole('button', { name: 'Deposit' }).click();
    await expect(page.getByText('Demo funds added.')).toBeVisible();
    await expect(page.getByText('$10,500.00').first()).toBeVisible();
    await page.getByLabel('Amount').fill('10');
    await page.getByRole('button', { name: 'Withdraw' }).click();
    await expect(page.getByText('KYC approval required to withdraw')).toBeVisible();
  });

  await test.step('KYC submission', async () => {
    await page.goto('/kyc');
    await page.getByLabel('Full legal name').fill('E2E User');
    await page.getByLabel('Date of birth').fill('1990-05-17');
    await page.getByLabel('Country').fill('Canada');
    await page.getByLabel('Document number').fill('P1234567');
    await page.getByRole('button', { name: 'Submit for review' }).click();
    await expect(page.getByText('We are reviewing your details.')).toBeVisible();
  });

  await test.step('admin approves KYC', async () => {
    const ctx = await browser.newContext({ ...info.project.use });
    const admin = await ctx.newPage();
    await login(admin, 'admin@e2e.test', 'adminpass1');
    await admin.goto('/admin');
    await expect(admin.getByRole('heading', { name: 'Admin dashboard' })).toBeVisible();
    const row = admin.getByRole('row', { name: /E2E User/ }).first();
    await row.getByRole('button', { name: 'Approve' }).click();
    await expect(admin.getByRole('row', { name: /E2E User.*P1234567/ })).toHaveCount(0);
    expect(await noHorizontalOverflow(admin)).toBe(true);
    await ctx.close();
    await page.goto('/kyc');
    await expect(page.getByText('You are verified and can withdraw funds.')).toBeVisible();
  });

  await test.step('withdrawal after approval', async () => {
    await page.goto('/wallet');
    await page.getByLabel('Amount').fill('10');
    await page.getByRole('button', { name: 'Withdraw' }).click();
    await expect(page.getByText('Withdrawal requested.')).toBeVisible();
    await expect(page.getByText('$10,490.00').first()).toBeVisible();
    await expect(page.getByRole('row', { name: /\$10\.00 pending/ })).toBeVisible();
    await page.getByLabel('Amount').fill('999999');
    await page.getByRole('button', { name: 'Withdraw' }).click();
    await expect(page.getByText('Insufficient funds')).toBeVisible();
  });

  await test.step('admin reviews the withdrawal, searches users and sees the audit log', async () => {
    const ctx = await browser.newContext({ ...info.project.use });
    const admin = await ctx.newPage();
    await login(admin, 'admin@e2e.test', 'adminpass1');
    await admin.goto('/admin');
    await admin.getByRole('button', { name: 'Withdrawals' }).click();
    const row = admin.getByRole('row', { name: new RegExp(email) });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: /Approve withdrawal/ }).click();
    await expect(admin.getByText('Approved.')).toBeVisible();
    await admin.getByRole('button', { name: 'Users' }).click();
    await admin.getByLabel('Search name, email or ID').fill(email);
    await admin.getByRole('button', { name: 'Search' }).click();
    await expect(admin.getByRole('row', { name: new RegExp(email) })).toBeVisible();
    await admin.getByRole('button', { name: 'Audit log' }).click();
    await expect(admin.getByRole('row', { name: /withdrawal\.approve/ }).first()).toBeVisible();
    expect(await noHorizontalOverflow(admin)).toBe(true);
    await ctx.close();
    await page.goto('/wallet');
    await expect(page.getByRole('row', { name: /approved/ })).toBeVisible();
  });

  const placeOrder = async ({ side = 'buy', type = 'market', quantity, price }) => {
    await page.goto('/trade/ETH');
    await page.getByLabel('Side').selectOption(side);
    await page.getByLabel('Order type').selectOption(type);
    await page.getByLabel('Quantity').fill(String(quantity));
    if (price) await page.getByLabel(/^(Limit|Stop) price$/).fill(String(price));
    await page.getByRole('button', { name: 'Review order' }).click();
    await expect(page.getByRole('heading', { name: 'Confirm your order' })).toBeVisible();
    await page.getByRole('button', { name: 'Confirm order' }).click();
    await expect(page).toHaveURL(/\/orders/);
  };

  await test.step('market order', async () => {
    // Prices drift, so top up enough that three ETH buys never run out of funds.
    await page.goto('/wallet');
    await page.getByLabel('Amount').fill('5000');
    await page.getByRole('button', { name: 'Deposit' }).click();
    await expect(page.getByText('Demo funds added.')).toBeVisible();
    await placeOrder({ quantity: 1 });
    await expect(orderRow(page, /ETH.*Buy.*Market.*filled/i)).toBeVisible();
  });

  await test.step('limit order pending then cancelled', async () => {
    await placeOrder({ type: 'limit', quantity: 1, price: 1 });
    const row = orderRow(page, /Limit.*pending/i);
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Cancel' }).click();
    await expect(orderRow(page, /Limit.*cancelled/i)).toBeVisible();
  });

  await test.step('limit order fills when price is reachable', async () => {
    await placeOrder({ type: 'limit', quantity: 1, price: 1000000 });
    await page.reload();
    await expect(orderRow(page, /Limit.*filled/i)).toBeVisible();
  });

  await test.step('stop order pending then cancelled; triggered stop fills', async () => {
    await placeOrder({ side: 'sell', type: 'stop', quantity: 1, price: 1 });
    const row = orderRow(page, /Sell.*Stop.*pending/i);
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Cancel' }).click();
    await expect(orderRow(page, /Sell.*Stop.*cancelled/i)).toBeVisible();
    await placeOrder({ type: 'stop', quantity: 1, price: 1 });
    await page.reload();
    await expect(orderRow(page, /Buy.*Stop.*filled/i)).toBeVisible();
  });

  await test.step('order validation: oversell and overspend rejected', async () => {
    await page.goto('/trade/BTC');
    await page.getByLabel('Quantity').fill('1000');
    await page.getByRole('button', { name: 'Review order' }).click();
    await expect(page.getByText('Insufficient funds')).toBeVisible(); // rejected at review, before any confirmation
    await page.goto('/trade/ETH');
    await page.getByLabel('Side').selectOption('sell');
    await page.getByLabel('Quantity').fill('50');
    await page.getByRole('button', { name: 'Review order' }).click();
    await expect(page.getByText('Insufficient holdings')).toBeVisible();
  });

  await test.step('portfolio numbers are consistent', async () => {
    await page.goto('/portfolio');
    await expect(page.getByRole('row', { name: /ETH/ })).toBeVisible();
    const pf = await apiGet(page, '/portfolio');
    const eth = pf.holdings.find((h) => h.symbol === 'ETH');
    expect(eth.quantity).toBe(3); // 1 market + 1 limit + 1 stop
    expect(Math.abs(pf.totalValue - (pf.balance + pf.invested))).toBeLessThan(0.02);
    expect(Math.abs(eth.pnl - (eth.price - eth.avgCost) * eth.quantity)).toBeLessThan(0.02);
    const txs = (await apiGet(page, '/transactions')).transactions;
    const net = txs.reduce((s, t) => s + t.amount, 0);
    expect(Math.abs(10000 + net - pf.balance)).toBeLessThan(0.02);
  });

  await test.step('portfolio analytics and CSV statement', async () => {
    await page.goto('/portfolio');
    await expect(page.getByText('DEMO · simulated funds')).toBeVisible();
    for (const label of ['Total value (demo)', 'Daily return', 'Total return', 'Realized P/L', 'Unrealized P/L']) {
      await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
    }
    await expect(page.getByText(/^Avg (purchase )?price$/).filter({ visible: true })).toHaveCount(1);
    await expect(page.getByText('Best performer')).toBeVisible();
    const cols = await page.evaluate(() => {
      const row = [...document.querySelectorAll('tbody tr')].find((r) => r.textContent.includes('ETH'));
      const table = row.closest('table');
      const shown = (el) => getComputedStyle(el).display !== 'none';
      return [[...table.querySelectorAll('thead th')].filter(shown).length, [...row.children].filter(shown).length];
    });
    expect(cols[1], 'holdings cells line up with headers').toBe(cols[0]);
    await expect(page.getByRole('img', { name: /Asset allocation/ })).toBeVisible();
    for (const label of ['1D', '1W', '1M', 'All']) {
      await page.getByRole('button', { name: label, exact: true }).click();
      await expect(page.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByRole('img', { name: /Portfolio value over time/ })).toBeVisible();
    }
    const a = await apiGet(page, '/portfolio/analytics');
    const pf = await apiGet(page, '/portfolio');
    expect(a.mode).toBe('demo');
    expect(Math.abs(a.summary.totalValue - pf.totalValue)).toBeLessThan(pf.totalValue * 0.01); // two calls a moment apart; simulated prices drift
    expect(Math.abs(a.summary.totalPnl - a.summary.tradingPnl)).toBeLessThan(0.1);
    expect(a.performance.ALL.history.length).toBeGreaterThan(10);
    await page.goto('/transactions');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download CSV statement' }).click()]);
    expect(dl.suggestedFilename()).toMatch(/^demo-statement-\d{4}-\d{2}-\d{2}\.csv$/);
    const csv = await (await import('node:fs/promises')).readFile(await dl.path(), 'utf8');
    expect(csv.split('\r\n')[0]).toBe('date_utc,type,symbol,quantity,price,amount,realized_pnl,balance_after,description,mode');
    expect(csv).toContain('opening_balance');
    expect(csv.trim().split('\r\n').slice(1).every((l) => l.endsWith(',DEMO'))).toBe(true);
  });

  await test.step('dashboard, markets, asset pages and watchlist', async () => {
    await page.goto('/markets');
    for (const c of ['crypto', 'stocks', 'forex', 'commodities']) {
      await page.getByRole('button', { name: c, exact: true }).click();
      await expect(page.getByRole('row').nth(1)).toBeVisible();
    }
    await page.getByRole('button', { name: 'crypto', exact: true }).click();
    await page.getByRole('link', { name: 'BTC', exact: true }).click();
    await expect(page.getByRole('heading', { name: /Bitcoin/ })).toBeVisible();
    await expect(page.getByRole('img', { name: 'Price chart' })).toBeVisible();
    const chart = page.getByRole('img', { name: 'Price chart' });
    const readout = page.getByTestId('chart-readout');
    for (const tf of ['1H', '1W', '1M', '1D']) {
      await page.getByRole('button', { name: tf, exact: true }).click();
      await expect(page.getByRole('button', { name: tf, exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(chart).toBeVisible();
    }
    await chart.hover();
    await expect(readout).toContainText(/O \$[\d,.]+ H \$[\d,.]+ L \$[\d,.]+ C \$[\d,.]+/);
    await page.getByRole('button', { name: 'Line' }).click();
    await expect(chart.locator('path[stroke]').first()).toBeVisible();
    await page.getByRole('button', { name: 'Candles' }).click();
    const priceText = () => page.locator('p.text-3xl').innerText();
    const before = await priceText();
    await expect.poll(priceText, { timeout: 15000, message: 'live price should update' }).not.toBe(before);
    // price alerts: one that fires immediately, one that stays active and gets deleted
    await page.getByLabel(/^Target price/).fill('1');
    await page.getByRole('button', { name: 'Add alert' }).click();
    await expect(page.getByRole('list', { name: 'Alerts for this asset' })).toContainText(/≥ \$1\.00/);
    await page.getByLabel(/^Target price/).fill('1000000');
    await page.getByRole('button', { name: 'Add alert' }).click();
    const alertRow = page.getByRole('listitem').filter({ hasText: /≥ \$1,000,000\.00/ });
    await expect(alertRow).toBeVisible();
    await alertRow.getByRole('button', { name: 'Delete' }).click();
    await expect(alertRow).toHaveCount(0);
    await page.getByRole('button', { name: 'Add to favourites' }).click();
    await expect(page.getByRole('button', { name: 'Remove from favourites' })).toBeVisible();
    await page.goto('/dashboard');
    await expect(page.getByRole('link', { name: 'BTC', exact: true })).toBeVisible();
  });

  await test.step('transactions and notifications', async () => {
    await page.goto('/transactions');
    await expect(page.getByRole('row', { name: /deposit/i }).first()).toBeVisible();
    await expect(page.getByRole('row', { name: /withdrawal/i })).toBeVisible();
    await page.goto('/notifications');
    await expect(page.getByText(/filled at/).first()).toBeVisible();
    await expect(page.getByText('Your identity verification was approved.')).toBeVisible();
    await expect(page.getByText(/BTC is now .*, above your alert at 1\./)).toBeVisible();
    await page.getByRole('button', { name: 'Mark all read' }).click();
    await expect(page.getByRole('button', { name: 'Mark all read' })).toBeHidden();
  });

  await test.step('profile update', async () => {
    await page.goto('/profile');
    await page.getByLabel('Name').fill('Renamed User');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('Name')).toHaveValue('Renamed User');
    if (!isMobile) await expect(page.getByText('Renamed User').first()).toBeVisible();
  });

  await test.step('password change', async () => {
    await page.goto('/security');
    await page.getByLabel('Current password').fill('wrong-current');
    await page.getByLabel(/New password/).fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Update password' }).click();
    await expect(page.getByText('Current password is incorrect')).toBeVisible();
    await page.getByLabel('Current password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Update password' }).click();
    await expect(page.getByText('Password updated.')).toBeVisible();
    await logout(page);
    await login(page, email, NEW_PASSWORD);
  });

  let secret;
  await test.step('enable two-factor', async () => {
    await page.goto('/security');
    await page.getByRole('button', { name: 'Set up authenticator app' }).click();
    secret = (await page.locator('code').innerText()).trim();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    await page.getByLabel('6-digit code').fill('000000');
    await page.getByRole('button', { name: 'Enable', exact: true }).click();
    await expect(page.getByText('Invalid code')).toBeVisible();
    await page.getByLabel('6-digit code').fill(code(secret));
    await page.getByRole('button', { name: 'Enable', exact: true }).click();
    await expect(page.getByText('Two-factor enabled.')).toBeVisible();
  });

  await test.step('two-factor login', async () => {
    await logout(page);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page.getByLabel('Two-factor code')).toBeVisible();
    await page.getByLabel('Two-factor code').fill('000000');
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page.getByText('Invalid two-factor code')).toBeVisible();
    await page.getByLabel('Two-factor code').fill(code(secret));
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });

  await test.step('non-admin cannot reach admin', async () => {
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });

  await test.step('challenges: join a weekly challenge, choose a display name, opt out and back in, start a private one', async () => {
    await page.goto('/challenges');
    await expect(page.getByRole('heading', { name: 'Challenges', exact: true })).toBeVisible();
    await page.getByRole('button', { name: /^Join Weekly challenge/ }).first().click();
    await expect(page.getByText(/^You joined Weekly challenge/)).toBeVisible();
    await expect(page.getByText('you are in').first()).toBeVisible();

    const alias = `E2E ${info.project.name} ${String(stamp).slice(-5)}`;
    await page.getByLabel('Display name').fill(alias);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Display name saved.')).toBeVisible();
    const hide = page.getByLabel(/Hide me from public leaderboards/);
    await hide.check();
    await expect(page.getByText('You are hidden from public leaderboards.')).toBeVisible();
    await hide.uncheck();
    await expect(page.getByText('You can appear on public leaderboards again.')).toBeVisible();

    await expect(page.getByText(/has not ended yet/)).toBeVisible(); // no practice reset in the middle of a challenge
    await expect(page.getByRole('button', { name: 'Reset practice account' })).toBeDisabled();

    await page.getByLabel('Name', { exact: true }).fill(`E2E mates ${String(stamp).slice(-4)}`);
    await page.getByRole('button', { name: 'Create and get a code' }).click();
    await expect(page.getByTestId('invite-code').first()).toHaveText(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    await expect(page.getByRole('heading', { name: 'Leaderboard' })).toBeVisible();
    await expect(page.getByText('Ranked by percentage return, which deposits and withdrawals cannot change.')).toBeVisible();
    await page.getByRole('button', { name: 'Profit', exact: true }).click();
    await expect(page.getByText(/Bigger accounts make bigger profits/)).toBeVisible();
    await expect(page.getByText(alias).first()).toBeVisible(); // you appear by display name
    await expect(page.locator('body')).not.toContainText(email); // and the email is nowhere on the page
    expect(await noHorizontalOverflow(page)).toBe(true);
  });

  await test.step('achievements: the first trade has been earned', async () => {
    await page.goto('/achievements');
    await expect(page.getByTestId('achievement-count')).toContainText('earned');
    await expect(page.getByRole('listitem').filter({ hasText: 'First trade' }).getByText('Earned', { exact: true })).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: 'Challenger' }).getByText('Earned', { exact: true })).toBeVisible();
  });

  await test.step('paper-trading explanation is shown where orders are placed and reviewed', async () => {
    for (const path of ['/trade/ETH', '/orders', '/portfolio']) {
      await page.goto(path);
      const notice = page.getByRole('complementary', { name: 'Paper trading notice' });
      await expect(notice).toBeVisible();
      await expect(notice).toContainText('real results can differ');
    }
  });

  await test.step('layout: every page fits the viewport', async () => {
    const paths = ['/dashboard', '/markets', '/markets/ETH', '/trade/ETH', '/portfolio', '/orders', '/transactions',
      '/wallet', '/notifications', '/risk', '/kyc', '/profile', '/security', '/markets/compare', '/challenges', '/achievements'];
    for (const p of paths) {
      await page.goto(p);
      await page.waitForLoadState('networkidle');
      await page.screenshot({ path: `screenshots/${info.project.name}${p.replace(/\//g, '_')}.png`, fullPage: true });
      expect(await noHorizontalOverflow(page), `horizontal overflow on ${p}`).toBe(true);
      const clipped = await page.evaluate(() => [...document.querySelectorAll('.overflow-x-auto')].filter((e) => e.scrollWidth > e.clientWidth + 1).length);
      expect(clipped, `table scrolls sideways inside its card on ${p}`).toBe(0);
    }
  });

  expect(errors, 'browser console/page errors').toEqual([]);
});

test('advanced orders and risk controls', async ({ page }, info) => {
  const email = `adv-${info.project.name}-${stamp}@e2e.test`;
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('response', (r) => {
    const expected404 = r.url().endsWith('/api/orders/999999'); // the missing-order check below asks for it on purpose
    if ((r.status() === 404 && !expected404) || r.status() >= 500) errors.push(`${r.status()} ${r.url()}`);
  });
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(`console: ${m.text()}`);
  });

  await page.goto('/register');
  await page.getByLabel('Full name').fill('Advanced User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel(/Password/).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  const ticket = async (symbol, { side = 'buy', type = 'market', quantity, tif, ...fields }) => {
    await page.goto(`/trade/${symbol}`);
    await page.getByLabel('Side').selectOption(side);
    await page.getByLabel('Order type').selectOption(type);
    await page.getByLabel('Quantity').fill(String(quantity));
    if (tif) await page.getByLabel('Time in force').selectOption(tif);
    for (const [label, value] of Object.entries(fields)) {
      if (label === 'Trail type') await page.getByLabel(label).selectOption(value);
      else await page.getByLabel(label, { exact: true }).fill(String(value));
    }
    await page.getByRole('button', { name: 'Review order' }).click();
  };
  const confirm = async () => {
    await expect(page.getByRole('heading', { name: 'Confirm your order' })).toBeVisible();
    await page.getByRole('button', { name: 'Confirm order' }).click();
    await expect(page).toHaveURL(/\/orders/);
  };
  const price = async (symbol) => (await apiGet(page, `/markets/${symbol}`)).asset.price;

  await test.step('large order: warning, confirmation checkbox, and partial fill', async () => {
    // 5,600 EURUSD is ~60% of the portfolio (needs confirmation) and above one slot of liquidity (fills in parts).
    await ticket('EURUSD', { quantity: 5600 });
    await expect(page.getByRole('heading', { name: 'Confirm your order' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Risk warnings' })).toContainText('fill in several parts');
    await expect(page.getByRole('list', { name: 'Risk warnings' })).toContainText('maximum order size');
    const submit = page.getByRole('button', { name: 'Confirm order' });
    await expect(submit).toBeDisabled();
    await page.getByRole('checkbox', { name: /understand this is a large order/ }).check();
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page).toHaveURL(/\/orders/);
    await expect(orderRow(page, /EURUSD/).first()).toBeVisible();
  });

  await test.step('volatile asset warning and maximum order size warning', async () => {
    // 0.9 ETH is roughly 30% of the portfolio (over the 25% maximum, under the 50% that needs confirming), and the exit orders
    // placed below (0.4 + 0.2 + 0.3) need exactly this many coins. The EURUSD order above is kept small enough to leave the cash.
    await ticket('ETH', { quantity: 0.9 });
    await expect(page.getByRole('heading', { name: 'Confirm your order' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Risk warnings' })).toContainText('highly volatile');
    await expect(page.getByRole('checkbox', { name: /large order/ })).toHaveCount(0); // ~30% is a warning, not a confirmation
    await page.getByRole('button', { name: 'Confirm order' }).click();
    await expect(page).toHaveURL(/\/orders/);
    await expect(orderRow(page, /ETH.*buy.*Market.*filled/i)).toBeVisible();
  });

  await test.step('the partial order keeps filling until complete', async () => {
    await expect.poll(async () => {
      const { orders } = await apiGet(page, '/orders');
      return orders.find((o) => o.symbol === 'EURUSD')?.status;
    }, { timeout: 40_000 }).toBe('filled');
    const { orders } = await apiGet(page, '/orders');
    expect(orders.find((o) => o.symbol === 'EURUSD').filled_quantity).toBe(5600);
  });

  await test.step('order types depend on the side', async () => {
    await page.goto('/trade/ETH');
    await expect(page.getByLabel('Order type').locator('option', { hasText: 'Stop-loss' })).toHaveCount(0);
    await expect(page.getByLabel('Order type').locator('option', { hasText: 'OCO' })).toHaveCount(1);
    await page.getByLabel('Side').selectOption('sell');
    for (const t of ['Stop-loss', 'Take-profit', 'Trailing stop', 'Stop-limit', 'OCO']) {
      await expect(page.getByLabel('Order type').locator('option', { hasText: t })).toHaveCount(1);
    }
  });

  await test.step('stop-loss above the market is rejected before confirmation', async () => {
    const p = await price('ETH');
    await ticket('ETH', { side: 'sell', type: 'stop_loss', quantity: 0.1, 'Stop-loss price': (p * 2).toFixed(2) });
    await expect(page.getByText('Stop-loss price must be below the current price')).toBeVisible();
  });

  await test.step('take-profit and trailing stop rest as good-till-cancelled orders', async () => {
    const p = await price('ETH');
    await ticket('ETH', { side: 'sell', type: 'take_profit', quantity: 0.4, 'Take-profit price': (p * 1.5).toFixed(2) });
    await confirm();
    await expect(orderRow(page, /Take-profit.*GTC.*pending/i)).toBeVisible();
    await ticket('ETH', { side: 'sell', type: 'trailing_stop', quantity: 0.2, 'Trail type': 'percent', 'Trailing distance (%)': 5 });
    await confirm();
    await expect(orderRow(page, /Trailing stop.*trails 5%.*pending/i)).toBeVisible();
  });

  await test.step('OCO places two linked orders and cancelling one cancels both', async () => {
    const p = await price('ETH');
    await ticket('ETH', { side: 'sell', type: 'oco', quantity: 0.3, 'Take-profit price': (p * 1.6).toFixed(2), 'Stop-loss price': (p * 0.4).toFixed(2) });
    await expect(page.getByText('Take-profit price').first()).toBeVisible();
    await confirm();
    await expect(orderRow(page, /OCO #\d+.*pending/i)).toHaveCount(2);
    await orderRow(page, /OCO #\d+.*pending/i).first().getByRole('button', { name: 'Cancel' }).click();
    await expect(orderRow(page, /OCO #\d+.*cancelled/i)).toHaveCount(2);
  });

  await test.step('shares held by working orders cannot be sold again', async () => {
    // Take-profit 0.4 + trailing 0.2 already hold 0.6 of 0.9 ETH, so 0.4 is not available.
    await ticket('ETH', { side: 'sell', quantity: 0.4 });
    await expect(page.getByText('Insufficient holdings')).toBeVisible();
  });

  await test.step('day order shows its expiry; cash for resting buys is reserved', async () => {
    const p = await price('ETH');
    await ticket('ETH', { type: 'limit', quantity: 0.01, tif: 'day', 'Limit price': (p * 0.5).toFixed(2) });
    await expect(page.getByText(/Day, expires/)).toBeVisible();
    await confirm();
    await expect(orderRow(page, /Limit.*Day order.*expires.*pending/i)).toBeVisible();
    await ticket('ETH', { type: 'limit', quantity: 5, 'Limit price': (p * 0.9).toFixed(2) });
    await expect(page.getByText('Insufficient funds')).toBeVisible();
  });

  await test.step('orders page filters partial, expired and rejected states', async () => {
    await page.goto('/orders');
    for (const tab of ['pending', 'filled', 'cancelled', 'expired', 'rejected', 'all']) {
      await page.getByRole('button', { name: tab, exact: true }).click();
    }
    await page.getByRole('button', { name: 'pending', exact: true }).click();
    await expect(orderRow(page, /Take-profit/i)).toBeVisible();
    await expect(orderRow(page, /OCO/i)).toHaveCount(0);
  });

  await test.step('order detail shows fills, progress and a plain-language explanation', async () => {
    await page.goto('/orders');
    // The 5,600 EURUSD order filled in two parts (5,000 then 600).
    await orderRow(page, /EURUSD/).first().getByRole('link', { name: /Details|View fills/ }).click();
    await expect(page.getByRole('heading', { name: /Order #\d+/ })).toBeVisible();
    await expect(page.getByRole('progressbar', { name: 'Order progress' })).toHaveAttribute('aria-valuenow', '100');
    await expect(page.getByText('5600 of 5600 EURUSD filled')).toBeVisible();
    await expect(page.getByRole('table', { name: 'Fills' }).locator('tbody tr')).toHaveCount(2);
    await expect(page.getByRole('status')).toContainText('Filled completely');
    expect(await noHorizontalOverflow(page)).toBe(true);

    // A resting take-profit explains its trigger and shows live state.
    await page.goto('/orders');
    await orderRow(page, /Take-profit.*pending/i).getByRole('link', { name: 'Details' }).click();
    await expect(page.getByRole('status')).toContainText(/Will sell once the price rises to/);
    await expect(page.getByText('Price now')).toBeVisible();
    await expect(page.getByText('Nothing has filled yet.')).toBeVisible();
    expect(await noHorizontalOverflow(page)).toBe(true);

    // A cancelled OCO leg says why and links to its partner.
    await page.goto('/orders');
    await orderRow(page, /OCO #\d+.*cancelled/i).first().getByRole('link', { name: 'Details' }).click();
    await expect(page.getByRole('status')).toContainText('Cancelled by you.');
    await expect(page.getByRole('heading', { name: 'Linked OCO order' })).toBeVisible();
    await page.getByRole('link', { name: /Order #\d+ ·/ }).click();
    await expect(page.getByRole('heading', { name: /Order #\d+/ })).toBeVisible();

    // Cancelling from the detail page works and the view updates.
    await page.goto('/orders');
    await orderRow(page, /Trailing stop.*pending/i).getByRole('link', { name: 'Details' }).click();
    await expect(page.getByRole('status')).toContainText(/trails 5% below the highest price seen/);
    await page.getByRole('button', { name: 'Cancel order' }).click();
    await expect(page.getByRole('status')).toContainText('Cancelled by you.');
    await expect(page.getByRole('button', { name: 'Cancel order' })).toHaveCount(0);

    // Someone else's or missing orders are not shown.
    await page.goto('/orders/999999');
    await expect(page.getByText('Order not found')).toBeVisible();
  });

  await test.step('risk limits page saves the daily demo-loss limit', async () => {
    await page.goto('/risk');
    await expect(page.getByText('DEMO · simulated funds')).toBeVisible();
    await expect(page.getByText('No daily loss limit is set.')).toBeVisible();
    await page.getByLabel('Daily demo-loss limit').fill('500');
    await page.getByLabel('Maximum order size (% of portfolio)').fill('40');
    await page.getByLabel('Large-order confirmation above (% of portfolio)').fill('70');
    await page.getByRole('button', { name: 'Save limits' }).click();
    await expect(page.getByText('Risk limits saved.')).toBeVisible();
    const risk = await apiGet(page, '/risk');
    expect(risk.dailyLossLimit).toBe(500);
    expect(risk.maxOrderPct).toBe(40);
    expect(risk.largeOrderPct).toBe(70);
    await page.reload();
    await expect(page.getByLabel('Daily demo-loss limit')).toHaveValue('500');
    // The browser itself refuses out-of-range values; the server rejects them too (covered by the API tests).
    await page.getByLabel('Maximum order size (% of portfolio)').fill('500');
    expect(await page.getByLabel('Maximum order size (% of portfolio)').evaluate((el) => el.validity.valid)).toBe(false);
  });

  await test.step('layout: new and changed pages fit the viewport', async () => {
    for (const p of ['/risk', '/orders', '/trade/ETH']) {
      await page.goto(p);
      await page.waitForLoadState('networkidle');
      await page.screenshot({ path: `screenshots/${info.project.name}_adv${p.replace(/\//g, '_')}.png`, fullPage: true });
      expect(await noHorizontalOverflow(page), `horizontal overflow on ${p}`).toBe(true);
      const clipped = await page.evaluate(() => [...document.querySelectorAll('.overflow-x-auto')].filter((e) => e.scrollWidth > e.clientWidth + 1).length);
      expect(clipped, `table scrolls sideways inside its card on ${p}`).toBe(0);
    }
  });

  expect(errors, 'browser console/page errors').toEqual([]);
});

test('market discovery', async ({ page }, info) => {
  const email = `disc-${info.project.name}-${stamp}@e2e.test`;
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() === 404 || r.status() >= 500) errors.push(`${r.status()} ${r.url()}`);
  });
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(`console: ${m.text()}`);
  });

  await page.goto('/register');
  await page.getByLabel('Full name').fill('Discovery User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel(/Password/).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  const search = page.getByLabel('Search markets');
  const dataRows = () => page.locator('tbody tr');
  const symbolsShown = () => dataRows().evaluateAll((rows) => rows.map((r) => r.querySelector('a')?.textContent?.trim()));

  await test.step('top gainers, top losers and most active', async () => {
    await page.goto('/markets');
    for (const t of ['Top gainers', 'Top losers', 'Most active']) await expect(page.getByRole('heading', { name: t })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Most active' }).getByRole('link')).toHaveCount(3);
    const d = await apiGet(page, '/markets/discovery');
    for (const a of d.gainers) expect(a.change24h).toBeGreaterThan(0);
    for (const a of d.losers) expect(a.change24h).toBeLessThan(0);
    for (let i = 1; i < d.active.length; i++) expect(d.active[i - 1].volumeUsd24h).toBeGreaterThanOrEqual(d.active[i].volumeUsd24h);
    const gainersList = page.getByRole('list', { name: 'Top gainers' });
    if (d.gainers.length) await expect(gainersList.getByRole('link')).toHaveCount(d.gainers.length);
    else await expect(page.getByText('Nothing is up over 24h right now.')).toBeVisible();
  });

  await test.step('search by symbol or name, with filters and no-result state', async () => {
    await expect(dataRows()).toHaveCount(10);
    await search.fill('gold');
    await expect.poll(symbolsShown).toEqual(['XAU']);
    await search.fill('bit');
    await expect.poll(symbolsShown).toEqual(['BTC']);
    await search.fill('  ETH ');
    await expect.poll(symbolsShown).toEqual(['ETH']);
    await search.fill('zzz');
    await expect(page.getByText('No assets match your search.')).toBeVisible();
    await search.fill('');
    await page.getByRole('button', { name: 'stocks', exact: true }).click();
    await expect.poll(symbolsShown).toEqual(['AAPL', 'TSLA', 'MSFT']);
    await search.fill('inc');
    await expect.poll(symbolsShown).toEqual(['AAPL', 'TSLA']);
    await search.fill('');
    await page.getByRole('button', { name: 'all', exact: true }).click();
    await expect(dataRows()).toHaveCount(10);
  });

  await test.step('sorting by 24h change', async () => {
    await page.getByLabel('Sort by').selectOption('change');
    await expect.poll(async () => {
      const values = await dataRows().evaluateAll((rows) => rows.map((r) => Number(r.querySelectorAll('td')[4].textContent.replace(/[+%]/g, ''))));
      return values.length === 10 && values.every((v, i) => i === 0 || values[i - 1] >= v);
    }).toBe(true);
    await page.getByLabel('Sort by').selectOption('');
  });

  await test.step('market open and closed indicators follow the simulated sessions', async () => {
    const now = new Date();
    const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const weekday = now.getUTCDay() >= 1 && now.getUTCDay() <= 5;
    const stocksOpen = weekday && minutes >= 14 * 60 + 30 && minutes < 21 * 60;
    const label = (open) => (open ? 'Open' : 'Closed');
    const status = (row, text) => page.getByRole('row', { name: row }).getByText(text, { exact: true }).filter({ visible: true });
    await expect(status(/BTC/, 'Open')).toBeVisible(); // crypto never closes
    await expect(status(/AAPL/, label(stocksOpen))).toBeVisible();
    const api = await apiGet(page, '/markets');
    expect(api.assets.find((a) => a.symbol === 'AAPL').market.open).toBe(stocksOpen);
    expect(api.assets.find((a) => a.symbol === 'BTC').market.nextChange).toBeNull();
  });

  await test.step('favourites persist and can be removed', async () => {
    await expect(page.getByText('Tap the star on any asset to keep it here.')).toBeVisible();
    await page.getByRole('button', { name: 'Add ETH to favourites' }).click();
    await expect(page.getByRole('button', { name: 'Remove ETH from favourites' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('list', { name: 'Favourite assets' }).getByRole('link')).toHaveCount(1);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Remove ETH from favourites' })).toBeVisible();
    await page.getByRole('button', { name: 'Remove ETH from favourites' }).click();
    await expect(page.getByText('Tap the star on any asset to keep it here.')).toBeVisible();
  });

  await test.step('asset page shows 24h high, low, volume and change, and records the view', async () => {
    await expect(page.getByText('Assets you open will appear here.')).toBeVisible();
    await page.getByRole('link', { name: 'ETH', exact: true }).click();
    await expect(page.getByRole('heading', { name: /Ethereum/ })).toBeVisible();
    for (const label of ['24h open', '24h high', '24h low', '24h volume', '24h change', 'Volatility']) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }
    await expect(page.getByText('Always open')).toBeVisible();
    const eth = (await apiGet(page, '/markets/ETH')).asset;
    expect(eth.low24h).toBeLessThanOrEqual(eth.price);
    expect(eth.high24h).toBeGreaterThanOrEqual(eth.price);
    expect(eth.volume24h).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Add to favourites' }).click();
    await expect(page.getByRole('button', { name: 'Remove from favourites' })).toBeVisible();
    await page.getByRole('button', { name: 'Remove from favourites' }).click();
    await page.goto('/markets/SOL');
    await expect(page.getByRole('heading', { name: /Solana/ })).toBeVisible();
  });

  await test.step('recently viewed lists the newest first and can be cleared', async () => {
    await page.goto('/markets');
    const list = page.getByRole('list', { name: 'Recently viewed assets' });
    await expect(list.getByRole('link')).toHaveCount(2);
    await expect(list.getByRole('link').first()).toContainText('SOL');
    await expect(list.getByRole('link').nth(1)).toContainText('ETH');
    await page.getByRole('button', { name: 'Clear' }).click();
    await expect(page.getByText('Assets you open will appear here.')).toBeVisible();
  });

  await test.step('compare two assets', async () => {
    await page.getByRole('link', { name: 'Compare assets' }).click();
    await expect(page.getByRole('heading', { name: 'Compare assets' })).toBeVisible();
    await expect(page.getByLabel('First asset')).toHaveValue('BTC');
    await expect(page.getByLabel('Second asset')).toHaveValue('ETH');
    await expect(page.getByRole('img', { name: /Performance of BTC and ETH/ })).toBeVisible();
    await expect(page.getByRole('status')).toContainText(/outperformed|performed about the same/);
    for (const label of ['Price', '24h change', '24h high', '24h low', '24h volume', '24h traded value', 'Volatility', 'Market']) {
      await expect(page.getByRole('rowheader', { name: label, exact: true })).toBeVisible();
    }
    await page.getByLabel('First asset').selectOption('EURUSD');
    await page.getByLabel('Second asset').selectOption('XAU');
    await expect(page.getByRole('img', { name: /Performance of EURUSD and XAU/ })).toBeVisible();
    await page.getByRole('button', { name: '1W', exact: true }).click();
    await expect(page.getByRole('button', { name: '1W', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText(/over 7 days/).first()).toBeVisible();
    await page.getByRole('button', { name: 'Swap' }).click();
    await expect(page.getByLabel('First asset')).toHaveValue('XAU');
    await expect(page.getByLabel('Second asset')).toHaveValue('EURUSD');
    const chart = page.getByRole('img', { name: /Performance of XAU and EURUSD/ });
    await chart.hover();
    await expect(page.getByTestId('compare-readout')).not.toContainText('Both start at 100');
    await page.getByLabel('Second asset').selectOption('XAU');
    await expect(page.getByText('Choose two different assets to compare.')).toBeVisible();
    await expect(page.getByRole('img', { name: /Performance of/ })).toHaveCount(0);
  });

  await test.step('compare is reachable from an asset page and preselects it', async () => {
    await page.goto('/markets/SOL');
    await page.getByRole('link', { name: 'Compare', exact: true }).click();
    await expect(page.getByLabel('First asset')).toHaveValue('SOL');
  });

  await test.step('layout: markets and compare fit the viewport', async () => {
    for (const p of ['/markets', '/markets/ETH', '/markets/compare?a=BTC&b=SOL&range=1W']) {
      await page.goto(p);
      await page.waitForLoadState('networkidle');
      await page.screenshot({ path: `screenshots/${info.project.name}_disc${p.split('?')[0].replace(/\//g, '_')}.png`, fullPage: true });
      expect(await noHorizontalOverflow(page), `horizontal overflow on ${p}`).toBe(true);
      const clipped = await page.evaluate(() => [...document.querySelectorAll('.overflow-x-auto')].filter((e) => e.scrollWidth > e.clientWidth + 1).length);
      expect(clipped, `table scrolls sideways inside its card on ${p}`).toBe(0);
    }
  });

  expect(errors, 'browser console/page errors').toEqual([]);
});

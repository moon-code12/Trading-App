import { test, expect } from '@playwright/test';

// Every screen, at phone, tablet and desktop widths: nothing may push the page sideways, nothing may be cut off, and
// tap targets must be big enough to use. Runs once (the viewport is set here, so the device projects do not matter).

const WIDTHS = [320, 375, 768, 1024, 1440];
const ADMIN = ['admin@e2e.test', 'adminpass1'];
const ADMIN_TABS = ['Overview', 'Users', 'Withdrawals', 'Assets', 'Announcements', 'Failed logins', 'Audit log', 'Reports'];

async function login(page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN[0]);
  await page.getByLabel('Password').fill(ADMIN[1]);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

// What is wrong with the page as currently laid out? (an empty list means nothing)
const inspect = (page) => page.evaluate(() => {
  const vw = document.documentElement.clientWidth;
  const problems = [];
  const label = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${typeof el.className === 'string' && el.className ? `.${el.className.split(' ').slice(0, 3).join('.')}` : ''} "${(el.textContent || '').trim().slice(0, 30)}"`;
  if (document.documentElement.scrollWidth > vw + 1) {
    const wide = [...document.querySelectorAll('body *')].filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.right > vw + 1 && !(e.parentElement && e.parentElement.closest('.overflow-x-auto'));
    }).slice(0, 4).map(label);
    problems.push(`page scrolls sideways (${document.documentElement.scrollWidth} > ${vw}): ${wide.join(' | ')}`);
  }
  // Tap targets: buttons, links and inputs the user must hit on a touch screen.
  if (vw < 768) {
    const small = [...document.querySelectorAll('button, a[href], input:not([type=hidden]), select, summary')].filter((e) => {
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      if (!r.width || !r.height || cs.visibility === 'hidden') return false;
      if (e.tagName === 'A' && e.closest('p, li, span') && !e.closest('nav')) return false; // inline text links
      if (e.type === 'checkbox' || e.type === 'radio') return false; // their label is the target
      return r.height < 32 || r.width < 32;
    }).slice(0, 3).map(label);
    if (small.length) problems.push(`small tap targets: ${small.join(' | ')}`);
  }
  // Text clipped by a fixed-size box.
  const clipped = [...document.querySelectorAll('body *')].filter((e) => {
    const cs = getComputedStyle(e);
    return cs.overflow === 'hidden' && e.scrollWidth > e.clientWidth + 2 && cs.textOverflow !== 'ellipsis' && e.clientWidth > 0 && e.tagName !== 'SVG' && !e.closest('svg') && !e.matches('.sr-only') && !e.closest('.sr-only');
  }).slice(0, 3).map(label);
  if (clipped.length) problems.push(`content cut off: ${clipped.join(' | ')}`);
  return problems;
});

test('every screen fits every screen size', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'desktop', 'sets its own viewports');
  test.setTimeout(600_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page);

  // Something to look at on the detail pages.
  const token = await page.evaluate(() => localStorage.getItem('token'));
  const api = async (method, path, data) => (await request.fetch(`http://localhost:4100/api${path}`, { method, headers: { authorization: `Bearer ${token}` }, data })).json();
  const order = await api('POST', '/orders', { symbol: 'ETH', side: 'buy', type: 'market', quantity: 0.1 });
  const challenge = await api('POST', '/challenges', { name: `Layout check ${Date.now() % 10000}`, days: 3 });

  const screens = [
    ['/', 'landing'], ['/login', 'login'], ['/register', 'register'], ['/forgot-password', 'forgot'],
    ['/dashboard'], ['/markets'], ['/markets/ETH'], ['/markets/AAPL'], ['/markets/compare?a=BTC&b=ETH'], ['/trade/ETH'], ['/portfolio'], ['/orders'],
    [`/orders/${order.order?.id}`], ['/transactions'], ['/wallet'], ['/notifications'], ['/risk'], ['/kyc'], ['/profile'], ['/security'],
    ['/security/login-history'], ['/challenges'], [`/challenges/${challenge.challenge?.id}`], ['/achievements'],
    ...ADMIN_TABS.map((t) => ['/admin', `admin: ${t}`, t]),
  ];

  const failures = [];
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: width < 768 ? 800 : 900 });
    for (const [path, name, tab] of screens) {
      if (path === '/' || ['/login', '/register', '/forgot-password'].includes(path)) {
        // Public screens need to be signed out.
        const ctx = await page.context().browser().newContext({ viewport: { width, height: 800 }, baseURL: info.project.use.baseURL });
        const pub = await ctx.newPage();
        await pub.goto(path);
        await pub.waitForLoadState('networkidle');
        for (const p of await inspect(pub)) failures.push(`${width}px ${name ?? path}: ${p}`);
        await ctx.close();
        continue;
      }
      await page.goto(path);
      if (tab) await page.getByRole('button', { name: tab, exact: true }).click();
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(150);
      for (const p of await inspect(page)) failures.push(`${width}px ${name ?? path}: ${p}`);
      if (process.env.SHOTS) await page.screenshot({ path: `screenshots/responsive-${width}-${(name ?? path).replace(/[^a-z0-9]+/gi, '_')}.png`, fullPage: true });
    }
  }
  expect(failures, `\n${failures.join('\n')}\n`).toEqual([]);
});

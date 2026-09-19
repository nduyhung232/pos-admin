// End-to-end smoke test of the admin login flow against the running server.
const BASE = 'http://localhost:3100';

// 1. Read login options page, grab the manager syncId from the seeded DB via pull is not allowed for browser,
//    so we hit the login page and extract the option value.
const loginHtml = await (await fetch(`${BASE}/login`)).text();
const m = loginHtml.match(/<option value="([0-9a-f-]{36})"/i);
if (!m) { console.log('NO_MANAGER_OPTION'); process.exit(1); }
const staffSyncId = m[1];
console.log('manager syncId:', staffSyncId);

// 2. POST login with the seeded PIN, capture the session cookie. Do not follow redirect.
const body = new URLSearchParams({ staffSyncId, pin: '1234' });
const loginRes = await fetch(`${BASE}/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body,
  redirect: 'manual',
});
const cookie = loginRes.headers.get('set-cookie');
console.log('login status:', loginRes.status, '(expect 302)');
console.log('got session cookie:', cookie ? 'yes' : 'no');

// 3. Use the cookie to fetch a protected page.
const reports = await fetch(`${BASE}/reports`, {
  headers: { cookie: cookie?.split(';')[0] ?? '' },
  redirect: 'manual',
});
console.log('reports status:', reports.status, '(expect 200)');
const html = await reports.text();
console.log('reports has revenue heading:', html.includes('Báo cáo doanh thu'));

// 4. Wrong PIN must be rejected.
const bad = await fetch(`${BASE}/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ staffSyncId, pin: '9999' }),
  redirect: 'manual',
});
console.log('wrong-pin status:', bad.status, '(expect 401)');

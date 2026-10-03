'use strict';
/**
 * اختبار شامل بمتصفح حقيقي (Chrome headless) على خادم محلي بقاعدة بيانات وهمية.
 *   CHROME_PATH=/path/to/chrome node tests/e2e.js
 * يحتاج حزمة puppeteer-core (npm i -D puppeteer-core) — غير مطلوب لتشغيل الموقع نفسه.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const L = require('../server/lib');
const { handle } = require('../server/routes');
const { makeFake } = require('./fake');

let puppeteer;
try {
  puppeteer = require('puppeteer-core');
} catch (e) {
  console.error('puppeteer-core غير مثبّت: npm i -D puppeteer-core');
  process.exit(2);
}
const CHROME = process.env.CHROME_PATH;
if (!CHROME) {
  console.error('حدد مسار Chrome في CHROME_PATH');
  process.exit(2);
}

const ROOT = path.join(__dirname, '..');
const fb = makeFake();
L.setFirebaseForTests(fb);
process.env.FIREBASE_WEB_API_KEY = 'k';
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (String(url).includes('identitytoolkit')) {
    const { email, password } = JSON.parse(opts.body);
    const u = [...fb.auth._users.values()].find((x) => x.email === email);
    if (!u || u.password !== password) return { ok: false, json: async () => ({ error: { message: 'INVALID_LOGIN_CREDENTIALS' } }) };
    return { ok: true, json: async () => ({ idToken: 'idtoken-' + u.uid }) };
  }
  return realFetch(url, opts);
};

const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const globalHeaders = Object.fromEntries(vercel.headers[0].headers.map((h) => [h.key, h.value]));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw && /json/.test(req.headers['content-type'] || '')) {
        try {
          req.body = JSON.parse(raw);
        } catch (e) {
          req.body = raw;
        }
      }
      handle(req, res);
    });
    return;
  }
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.statusCode = 404;
    return res.end('not found');
  }
  for (const [k, v] of Object.entries(globalHeaders)) res.setHeader(k, v);
  res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push([true, name]);
  } catch (e) {
    results.push([false, name + ' — ' + (e.message || e).toString().split('\n')[0]]);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 15000, label = 'condition') {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {}
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + label);
    await sleep(150);
  }
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://localhost:' + server.address().port;

  const mk = async (email, claims, pass) => {
    const u = await fb.auth.createUser({ email, password: pass, displayName: email.split('@')[0] });
    await fb.auth.setCustomUserClaims(u.uid, claims);
  };
  await mk('admin@x.org', { admin: true }, 'adminpass1');
  await mk('serv@x.org', { servant: true }, 'servpass1');

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const consoleErrors = [];
  async function newDevice() {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    page.on('pageerror', (e) => consoleErrors.push(String(e.message)));
    // نتجاهل أخطاء تحميل الـ CDN لأن البيئة بلا إنترنت
    return { ctx, page };
  }
  async function login(page, id, pw) {
    await page.goto(base + '/login.html', { waitUntil: 'domcontentloaded' });
    await page.type('#id', id);
    await page.type('#pw', pw);
    await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('#go')]);
  }
  const ls = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);

  const A = await newDevice();

  await test('بدون جلسة: فتح لوحة الإدارة يحوّل إلى صفحة الدخول', async () => {
    await A.page.goto(base + '/admin-dashboard.html', { waitUntil: 'domcontentloaded' });
    await waitFor(async () => A.page.url().includes('login.html'), 8000, 'redirect to login');
  });

  await test('دخول خاطئ يعرض رسالة ولا يدخل', async () => {
    await A.page.goto(base + '/login.html', { waitUntil: 'domcontentloaded' });
    await A.page.type('#id', 'admin@x.org');
    await A.page.type('#pw', 'wrong-pass');
    await A.page.click('#go');
    await waitFor(() => A.page.$eval('#err', (e) => e.classList.contains('show')), 8000, 'error msg');
    assert.ok(A.page.url().includes('login.html'));
  });

  await test('دخول الأدمن يفتح الصفحة الرئيسية بواجهة الأدمن', async () => {
    await login(A.page, 'admin@x.org', 'adminpass1');
    await waitFor(() => A.page.evaluate(() => { const e = document.getElementById('staffPanel'); return !!e && !e.hidden; }), 8000, 'staff panel');
  });

  await test('لوحة الإدارة تفتح وتبدأ المزامنة (حالة سحابية)', async () => {
    await A.page.goto(base + '/admin-dashboard.html?task=members', { waitUntil: 'domcontentloaded' });
    await waitFor(() => A.page.evaluate(() => typeof churchSync !== 'undefined' && churchSync && churchSync.status().lastSync > 0), 15000, 'first sync');
    const txt = await A.page.$eval('#cloudStatusText', (e) => e.textContent);
    assert.ok(/متزامن/.test(txt), txt);
  });

  await test('Service Worker يُسجَّل ويحفظ الصفحات', async () => {
    await waitFor(() => A.page.evaluate(async () => (await navigator.serviceWorker.getRegistration()) && (await caches.keys()).length > 0), 15000, 'sw');
    await waitFor(() => A.page.evaluate(async () => {
      const c = await caches.open((await caches.keys())[0]);
      return !!(await c.match('/admin-dashboard.html')) && !!(await c.match('/auth-client.js')) && !!(await c.match('/church-sync.js'));
    }), 15000, 'precache');
  });

  await test('إضافة مخدوم وتسجيل حضوره بدالة اللوحة الحقيقية', async () => {
    await A.page.evaluate(() => {
      members.push({ id: 5001, code: '5001', name: 'مينا اختبار', stage: 'سنة أولى', level: 'الفرقة الأولى', phone: '', fieldEvaluations: [], visits: [], projects: [] });
      localStorage.setItem('my_church_class', JSON.stringify(members));
      syncToCloud('members', members);
    });
    await waitFor(() => A.page.evaluate(() => churchSync.pendingCount() === 0), 15000, 'members pushed');
    await A.page.evaluate(() => atomicRegisterAttendance(members.find((m) => m.id === 5001)));
    await waitFor(() => A.page.evaluate(() => churchSync.pendingCount() === 0), 15000, 'attendance pushed');
    const recs = [...fb.db._store.appRecords.values()].filter((r) => !r.d);
    assert.ok(recs.some((r) => r.path === 'members' && r.key === '5001'));
    assert.ok(recs.some((r) => r.path === 'attendance' && r.key.endsWith('|5001')));
  });

  await test('أوف لاين: إعادة تحميل الصفحة تعمل من الجهاز', async () => {
    await A.page.setOfflineMode(true);
    await A.page.reload({ waitUntil: 'domcontentloaded' });
    await waitFor(() => A.page.evaluate(() => typeof churchSync !== 'undefined' && churchSync && document.getElementById('mainApp') && getComputedStyle(document.getElementById('mainApp')).display !== 'none'), 15000, 'dashboard offline');
    assert.ok(!A.page.url().includes('login.html'));
    assert.strictEqual(await A.page.evaluate(() => members.length), 1);
  });

  await test('أوف لاين: تعديلات جديدة تُحفظ وتظهر في عدّاد الانتظار', async () => {
    await A.page.evaluate(() => {
      members.push({ id: 5002, code: '5002', name: 'كيرلس أوفلاين', stage: 'سنة أولى', level: 'الفرقة الأولى', phone: '', fieldEvaluations: [], visits: [], projects: [] });
      localStorage.setItem('my_church_class', JSON.stringify(members));
      syncToCloud('members', members);
      atomicRegisterAttendance(members.find((m) => m.id === 5002));
    });
    await sleep(700);
    const pending = await A.page.evaluate(() => churchSync.pendingCount());
    assert.ok(pending >= 2, 'pending=' + pending);
    const badge = await A.page.$eval('#pendingSyncBadge', (e) => getComputedStyle(e).display);
    assert.notStrictEqual(badge, 'none');
    const txt = await A.page.$eval('#cloudStatusText', (e) => e.textContent);
    assert.ok(/جهازك|بالجهاز/.test(txt), txt);
    // لم يصل شيء للخادم بعد
    assert.ok(![...fb.db._store.appRecords.values()].some((r) => r.key === '5002'));
  });

  await test('أوف لاين: إغلاق الصفحة وفتحها لا يضيع الطابور', async () => {
    await A.page.reload({ waitUntil: 'domcontentloaded' });
    await waitFor(() => A.page.evaluate(() => typeof churchSync !== 'undefined' && churchSync && members.length === 2), 15000, 'reload offline');
    assert.ok((await A.page.evaluate(() => churchSync.pendingCount())) >= 2);
  });

  await test('عودة الإنترنت: يُرفع كل شيء تلقائيًا', async () => {
    await A.page.setOfflineMode(false);
    await A.page.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitFor(() => A.page.evaluate(() => churchSync.pendingCount() === 0), 20000, 'drain');
    assert.ok([...fb.db._store.appRecords.values()].some((r) => r.path === 'members' && r.key === '5002'));
    assert.ok([...fb.db._store.appRecords.values()].some((r) => r.path === 'attendance' && r.key.endsWith('|5002')));
  });

  const B = await newDevice();

  await test('جهاز ثانٍ (خادم) يرى المخدومين والحضور بعد الدخول', async () => {
    await login(B.page, 'serv@x.org', 'servpass1');
    await B.page.goto(base + '/admin-dashboard.html?task=attendance', { waitUntil: 'domcontentloaded' });
    await waitFor(() => B.page.evaluate(() => typeof members !== 'undefined' && members.length === 2), 20000, 'B members');
    const att = await B.page.evaluate(() => (attendanceRecord[today] || []).length);
    assert.strictEqual(att, 2);
  });

  await test('الخادم لا يستطيع فتح صفحة إدارة الخدام (للأدمن فقط)', async () => {
    await B.page.goto(base + '/admin_subjects.html', { waitUntil: 'domcontentloaded' });
    await waitFor(async () => !B.page.url().includes('admin_subjects'), 8000, 'redirect away');
  });

  await test('تعديل على الجهاز B ينتقل إلى الجهاز A', async () => {
    await B.page.goto(base + '/admin-dashboard.html?task=members', { waitUntil: 'domcontentloaded' });
    await waitFor(() => B.page.evaluate(() => typeof churchSync !== 'undefined' && churchSync && members.length === 2), 15000, 'B ready');
    await B.page.evaluate(() => {
      const i = members.findIndex((m) => m.id === 5001);
      members[i] = { ...members[i], phone: '0100000999' };
      localStorage.setItem('my_church_class', JSON.stringify(members));
      syncToCloud('members', members);
    });
    await waitFor(() => B.page.evaluate(() => churchSync.pendingCount() === 0), 15000, 'B pushed');
    await A.page.evaluate(() => pushPendingData());
    await waitFor(() => A.page.evaluate(() => members.find((m) => m.id === 5001).phone === '0100000999'), 20000, 'A got update');
  });

  await test('الخروج بدون تعديلات معلّقة يمسح بيانات الخدمة من الجهاز', async () => {
    await A.page.evaluate(() => { window.confirm = () => true; });
    await A.page.evaluate(() => logout());
    await waitFor(async () => A.page.url().includes('login.html'), 10000, 'logout redirect');
    assert.strictEqual(await ls(A.page, 'my_church_class'), null);
    assert.strictEqual(await ls(A.page, 'my_church_active_user'), null);
    await A.page.goto(base + '/admin-dashboard.html', { waitUntil: 'domcontentloaded' });
    await waitFor(async () => A.page.url().includes('login.html'), 8000, 'still logged out');
  });

  await test('لا أخطاء JavaScript غير متوقعة في الصفحات', async () => {
    const real = consoleErrors.filter((m) => !/Script error|Failed to fetch|ResizeObserver|html5-qrcode|XLSX|bootstrap|qrcode|JsBarcode/i.test(m));
    assert.deepStrictEqual(real, []);
  });

  /* ---------------- الصفحة الرئيسية index.html ---------------- */
  const stu = await fb.auth.createUser({ email: '7001@church.local', password: 'stupass1', displayName: 'مريم' });
  await fb.auth.setCustomUserClaims(stu.uid, { code: '7001', role: 'student' });
  await fb.db.collection('students').doc('7001').set({ code: '7001', name: 'مريم', level: 'الفرقة الأولى', points: 35, readCount: 2, spiritualDays: 1, sheetsCount: 3, active: true, uid: stu.uid });
  const vis = (page, id) => page.evaluate((i) => { const e = document.getElementById(i); return !!e && !e.hidden && getComputedStyle(e).display !== 'none'; }, id);

  const C = await newDevice();
  await test('الرئيسية (أدمن): تظهر لوحة الخدمة فقط وأدوات الأدمن ظاهرة وأرقام الخادم', async () => {
    await login(C.page, 'admin@x.org', 'adminpass1');
    await waitFor(() => vis(C.page, 'staffPanel'), 8000, 'staff panel');
    assert.strictEqual(await vis(C.page, 'memberPanel'), false);
    assert.strictEqual(await C.page.$$eval('[data-admin-only]', (els) => els.filter((e) => !e.hidden).length), 8);
    await waitFor(() => C.page.$eval('#statStudents', (e) => e.textContent !== '0'), 8000, 'stats loaded');
    assert.strictEqual(await C.page.$eval('#statStudents', (e) => e.textContent), '1'); // حساب بوابة واحد (7001)
  });

  await test('الرئيسية: لا يُلغى الـ Service Worker ولا يُمسح الكاش', async () => {
    await sleep(1500);
    assert.ok(await C.page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())));
    assert.ok(await C.page.evaluate(async () => (await caches.keys()).length > 0));
  });

  await test('الرئيسية: بدون خطة قراءة تظهر رسالة مناسبة ولا ينكسر شيء', async () => {
    const txt = await C.page.$eval('#readingValue', (e) => e.textContent);
    assert.ok(txt.length > 0 && txt !== '…', txt);
  });

  await test('الرئيسية: أوف لاين تظهر الصفحة والأرقام المحفوظة وشريط التنبيه', async () => {
    await C.page.setOfflineMode(true);
    try {
      await C.page.reload({ waitUntil: 'domcontentloaded' });
      await waitFor(() => vis(C.page, 'staffPanel'), 10000, 'staff offline');
      assert.strictEqual(await C.page.$eval('#statStudents', (e) => e.textContent), '1');
      assert.strictEqual(await vis(C.page, 'offlineBar'), true);
    } finally {
      await C.page.setOfflineMode(false);
    }
  });

  await test('الخروج من الرئيسية يُنهي الجلسة فعلًا ولا يعيد المستخدم للصفحة', async () => {
    await C.page.click('#logoutBtn');
    await waitFor(async () => C.page.url().includes('login.html'), 8000, 'to login');
    await sleep(1500);
    assert.ok(C.page.url().includes('login.html'), 'bounced back: ' + C.page.url());
    const st = await C.page.evaluate(async () => (await fetch('/api/me', { credentials: 'same-origin' })).status);
    assert.strictEqual(st, 401);
    assert.strictEqual(await ls(C.page, 'home_stats_staff'), null);
  });

  const D = await newDevice();
  await test('الرئيسية (مخدوم): تظهر لوحة المخدوم بنقاطه الحقيقية ولا تظهر لوحة الخدمة', async () => {
    await login(D.page, '7001', 'stupass1');
    await waitFor(() => vis(D.page, 'memberPanel'), 8000, 'member panel');
    assert.strictEqual(await vis(D.page, 'staffPanel'), false);
    await waitFor(() => D.page.$eval('#memberSheets', (e) => e.textContent === '3'), 8000, 'harvest loaded');
    assert.strictEqual(await D.page.$eval('#memberPoints', (e) => e.textContent), '35');
    assert.strictEqual(await D.page.$eval('#memberName', (e) => e.textContent), 'مريم');
  });

  await test('المخدوم لا يفتح لوحة الإدارة', async () => {
    await D.page.goto(base + '/admin-dashboard.html', { waitUntil: 'domcontentloaded' });
    await waitFor(async () => !D.page.url().includes('admin-dashboard'), 8000, 'student bounced');
  });

  const E = await newDevice();
  await test('الرئيسية (خادم): أدوات الأدمن مخفية والباقي ظاهر', async () => {
    await login(E.page, 'serv@x.org', 'servpass1');
    await waitFor(() => vis(E.page, 'staffPanel'), 8000, 'staff panel');
    assert.strictEqual(await E.page.$$eval('[data-admin-only]', (els) => els.filter((e) => !e.hidden).length), 0);
    assert.strictEqual(await E.page.$eval('#staffBadge', (e) => e.textContent), 'خادم ميداني');
    assert.strictEqual(await E.page.$eval('#statServants', (e) => e.textContent), '—');
  });

  await browser.close();
  server.close();

  let failed = 0;
  for (const [ok, name] of results) {
    console.log((ok ? '✔ ' : '✘ ') + name);
    if (!ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} اختبار متصفح ناجح`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('E2E crashed:', e);
  process.exit(1);
});

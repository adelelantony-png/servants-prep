'use strict';
/**
 * اختبار المزامنة (أوف لاين ثم دمج) بين جهازين وهميين على خادم واحد.
 *   node tests/sync.js
 */
const assert = require('assert');
const L = require('../server/lib');
const { handle } = require('../server/routes');
const { makeFake } = require('./fake');
const ChurchSync = require('../church-sync');

const fb = makeFake();
L.setFirebaseForTests(fb);
let T = 1_800_000_000_000; // زمن موحّد للخادم والأجهزة الوهمية
L.setClockForTests(() => T);
process.env.FIREBASE_WEB_API_KEY = 'k';
global.fetch = async (url, opts) => {
  const { email, password } = JSON.parse(opts.body);
  const u = [...fb.auth._users.values()].find((x) => x.email === email);
  if (!u || u.password !== password) return { ok: false, json: async () => ({ error: { message: 'INVALID_LOGIN_CREDENTIALS' } }) };
  return { ok: true, json: async () => ({ idToken: 'idtoken-' + u.uid }) };
};

let ipSeq = 1;
async function http(method, path, { body, cookie } = {}) {
  const req = {
    method,
    url: path,
    headers: { host: 'app.test', 'x-forwarded-for': '10.1.0.' + (ipSeq++ % 250), ...(cookie ? { cookie: `__session=${cookie}` } : {}) },
    body
  };
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    end(d) {
      this.body = d ? JSON.parse(d) : null;
    }
  };
  await handle(req, res);
  return res;
}

/* جهاز وهمي: تخزين محلي + اتصال قابل للقطع + ساعة قابلة للانحراف */
function device(name, cookie, { skew = 0 } = {}) {
  const mem = new Map();
  const storage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => void mem.set(k, String(v)),
    removeItem: (k) => void mem.delete(k)
  };
  const d = {
    name,
    online: true,
    get clock() {
      return T + skew;
    },
    storage,
    changes: [],
    tick(ms = 1000) {
      T += ms;
    },
    get(key, def) {
      const v = storage.getItem(key);
      return v ? JSON.parse(v) : def;
    },
    set(key, val) {
      storage.setItem(key, JSON.stringify(val));
    }
  };
  d.sync = ChurchSync.create({
    storage,
    now: () => d.clock,
    isOnline: () => d.online,
    autoSync: false,
    onChange: (p) => d.changes.push(p),
    api: async (method, url, body) => {
      if (!d.online) throw new Error('network');
      const r = await http(method, url, { body, cookie });
      return { status: r.statusCode, ok: r.statusCode >= 200 && r.statusCode < 300, json: r.body };
    }
  });
  return d;
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push([true, name]);
  } catch (e) {
    results.push([false, name + ' — ' + (e.stack || e.message).split('\n').slice(0, 3).join(' | ')]);
  }
}

(async () => {
  const mk = async (email, claims, pass = 'password1') => {
    const u = await fb.auth.createUser({ email, password: pass, displayName: email });
    await fb.auth.setCustomUserClaims(u.uid, claims);
    return 'cookie-' + u.uid;
  };
  const adminC = await mk('a@x.org', { admin: true });
  const servC = await mk('s@x.org', { servant: true });

  const A = device('A', adminC);
  const B = device('B', servC);

  const att = (d) => d.get('my_church_attendance', {});
  const ids = (arr) => (arr || []).map((e) => String(e.id)).sort();

  await test('صفحة بيضاء: أول مزامنة بلا أخطاء', async () => {
    const r = await A.sync.sync();
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(A.sync.pendingCount(), 0);
  });

  await test('أوف لاين: التعديل يُحفظ في الطابور ولا يضيع', async () => {
    A.online = false;
    A.set('my_church_class', [
      { id: 1, name: 'مينا', points: 0 },
      { id: 2, name: 'كيرلس', points: 0 }
    ]);
    A.sync.touch('members');
    assert.strictEqual(A.sync.pendingCount(), 2);
    const r = await A.sync.sync();
    assert.ok(r.offline);
    assert.strictEqual(A.sync.status().state, 'offline');
    assert.strictEqual(A.sync.pendingCount(), 2); // ما زال محفوظًا
  });

  await test('الطابور يبقى بعد إغلاق المتصفح (تخزين محلي فقط)', async () => {
    const A2 = device('A-reopen', adminC);
    A2.storage.setItem('sync_outbox', A.storage.getItem('sync_outbox'));
    A2.storage.setItem('sync_base', A.storage.getItem('sync_base') || '{}');
    A2.set('my_church_class', A.get('my_church_class', []));
    assert.strictEqual(A2.sync.pendingCount(), 2);
  });

  await test('عودة الإنترنت: الرفع ثم ظهور البيانات على جهاز آخر', async () => {
    A.online = true;
    assert.ok((await A.sync.sync()).ok);
    assert.strictEqual(A.sync.pendingCount(), 0);
    assert.ok((await B.sync.sync()).ok);
    assert.deepStrictEqual(B.get('my_church_class', []).map((m) => m.name).sort(), ['كيرلس', 'مينا']);
    assert.ok(B.changes.length > 0);
  });

  await test('حضور جهازين لمخدومَين مختلفين في نفس اليوم يندمجان (بدون فقد)', async () => {
    A.online = false;
    B.online = false;
    const day = '2026-10-01';
    A.set('my_church_attendance', { [day]: [{ id: 1, name: 'مينا', time: '10:00' }] });
    A.sync.touch('attendance');
    B.set('my_church_attendance', { [day]: [{ id: 2, name: 'كيرلس', time: '10:01' }] });
    B.sync.touch('attendance');
    A.online = true;
    B.online = true;
    await A.sync.sync();
    await B.sync.sync();
    await A.sync.sync();
    assert.deepStrictEqual(ids(att(A)[day]), ['1', '2']);
    assert.deepStrictEqual(ids(att(B)[day]), ['1', '2']);
  });

  await test('تعارض على نفس السجل: آخر تعديل يفوز على الجهازين', async () => {
    A.online = false;
    B.online = false;
    A.tick(1000);
    A.set('my_church_class', A.get('my_church_class', []).map((m) => (m.id === 1 ? { ...m, phone: 'من-A' } : m)));
    A.sync.touch('members');
    B.tick(5000); // B عدّل لاحقًا
    B.set('my_church_class', B.get('my_church_class', []).map((m) => (m.id === 1 ? { ...m, phone: 'من-B' } : m)));
    B.sync.touch('members');
    A.online = true;
    B.online = true;
    await B.sync.sync(); // B يرفع أولًا
    await A.sync.sync(); // A تعديله أقدم → يخسر
    await B.sync.sync();
    const pa = A.get('my_church_class', []).find((m) => m.id === 1).phone;
    const pb = B.get('my_church_class', []).find((m) => m.id === 1).phone;
    assert.strictEqual(pa, 'من-B');
    assert.strictEqual(pb, 'من-B');
    assert.strictEqual(A.sync.pendingCount(), 0);
  });

  await test('التعديل الأحدث يفوز حتى لو رُفع أولًا من الجهاز الآخر', async () => {
    A.online = false;
    B.online = false;
    B.tick(1000);
    B.set('my_church_class', B.get('my_church_class', []).map((m) => (m.id === 2 ? { ...m, phone: 'قديم' } : m)));
    B.sync.touch('members');
    A.tick(60000);
    A.set('my_church_class', A.get('my_church_class', []).map((m) => (m.id === 2 ? { ...m, phone: 'جديد' } : m)));
    A.sync.touch('members');
    A.online = true;
    B.online = true;
    await B.sync.sync(); // القديم يصل أولًا
    await A.sync.sync(); // الجديد يفوز
    await B.sync.sync();
    assert.strictEqual(B.get('my_church_class', []).find((m) => m.id === 2).phone, 'جديد');
    assert.strictEqual(A.get('my_church_class', []).find((m) => m.id === 2).phone, 'جديد');
  });

  await test('حذف على جهاز ينتقل للآخر (Tombstone) ولا يعود', async () => {
    A.set('my_church_class', A.get('my_church_class', []).filter((m) => m.id !== 2));
    A.sync.touch('members');
    await A.sync.sync();
    await B.sync.sync();
    assert.deepStrictEqual(B.get('my_church_class', []).map((m) => m.id), [1]);
    await A.sync.sync();
    await B.sync.sync();
    assert.deepStrictEqual(A.get('my_church_class', []).map((m) => m.id), [1]);
  });

  await test('إلغاء حضور (حذف سجل حضور) ينتقل للجهاز الآخر', async () => {
    const day = '2026-10-01';
    A.tick(1000);
    A.set('my_church_attendance', { [day]: att(A)[day].filter((e) => e.id !== 1) });
    A.sync.touch('attendance');
    await A.sync.sync();
    await B.sync.sync();
    assert.deepStrictEqual(ids(att(B)[day]), ['2']);
  });

  await test('الخادم (servant) لا يستطيع تعديل الإعدادات/الخطة/الخدام: تُرفض بدون تعليق', async () => {
    B.set('my_church_master_plan', [{ id: 'p1', title: 'محاولة' }]);
    B.sync.touch('master_plan');
    B.set('my_church_settings', { churchName: 'محاولة' });
    B.sync.touch('settings');
    const r = await B.sync.sync();
    assert.ok(r.ok);
    assert.strictEqual(r.rejected, 2);
    assert.strictEqual(B.sync.pendingCount(), 0);
    await A.sync.sync();
    assert.deepStrictEqual(A.get('my_church_master_plan', []), []);
  });

  await test('الأدمن يضبط الإعدادات والخطة فتصل للخادم', async () => {
    A.tick(1000);
    A.set('my_church_settings', { churchName: 'كنيسة الاختبار', allowedDelay: 15 });
    A.sync.touch('settings');
    A.set('my_church_master_plan', [{ id: 'p1', title: 'اجتماع' }]);
    A.sync.touch('master_plan');
    await A.sync.sync();
    await B.sync.sync();
    assert.strictEqual(B.get('my_church_settings', {}).churchName, 'كنيسة الاختبار');
    assert.strictEqual(B.get('my_church_master_plan', [])[0].title, 'اجتماع');
  });

  await test('جهاز جديد فارغ يسحب كل شيء، وإعداداته الافتراضية لا تطغى', async () => {
    const C = device('C', adminC);
    C.set('my_church_settings', { churchName: 'افتراضي-محلي' }); // قيمة افتراضية كتبتها الصفحة
    C.sync.scanAll(false); // لا يفحص الإعدادات بدون touch
    assert.strictEqual(C.sync.pendingCount(), 0);
    assert.ok((await C.sync.sync()).ok);
    assert.strictEqual(C.get('my_church_settings', {}).churchName, 'كنيسة الاختبار');
    assert.deepStrictEqual(C.get('my_church_class', []).map((m) => m.id), [1]);
  });

  await test('ساعة جهاز متقدمة بسنة لا تتحكم بالنتائج (تصحيح فرق الساعة)', async () => {
    const D = device('D', adminC, { skew: 365 * 86400000 });
    await D.sync.sync(); // يتعلم فرق الساعة من الخادم
    const off = Number(D.storage.getItem('sync_offset'));
    assert.ok(Math.abs(off) > 300 * 86400000, 'offset should be learned');
    const before = T;
    D.set('my_church_class', [...D.get('my_church_class', []), { id: 9, name: 'من D' }]);
    D.sync.touch('members');
    const u = JSON.parse(D.storage.getItem('sync_outbox')).members['9'].u;
    assert.ok(Math.abs(u - before) < 5000, 'stamp uses corrected clock, got diff ' + (u - before));
    await D.sync.sync();
    const rec = [...fb.db._store.appRecords.values()].find((r) => r.path === 'members' && r.key === '9');
    assert.ok(Math.abs(rec.u - T) < 5000, 'stored u follows server time, not the skewed device clock');
  });

  await test('تعديلات كثيرة (450 مخدومًا) تُرفع على دفعات وتُسحب كاملة', async () => {
    const E = device('E', adminC);
    await E.sync.sync();
    const many = [];
    for (let i = 100; i < 550; i++) many.push({ id: i, name: 'م' + i });
    E.set('my_church_class', [...E.get('my_church_class', []), ...many]);
    E.sync.touch('members');
    assert.ok(E.sync.pendingCount() >= 450);
    assert.ok((await E.sync.sync()).ok);
    assert.strictEqual(E.sync.pendingCount(), 0);
    const F = device('F', servC);
    assert.ok((await F.sync.sync()).ok);
    assert.ok(F.get('my_church_class', []).length >= 451);
  });

  await test('جلسة منتهية (401): لا تضيع البيانات وتظهر حالة auth', async () => {
    const G = device('G', 'cookie-غير-موجود');
    G.set('my_church_class', [{ id: 77, name: 'محلي' }]);
    G.sync.touch('members');
    const r = await G.sync.sync();
    assert.ok(!r.ok);
    assert.strictEqual(G.sync.status().state, 'auth');
    assert.strictEqual(G.sync.pendingCount(), 1);
    assert.strictEqual(G.get('my_church_class', []).length, 1);
  });

  await test('تبديل المستخدم على نفس الجهاز يمسح بيانات المستخدم السابق (إن لم تكن هناك تعديلات معلّقة)', async () => {
    const H = device('H', adminC);
    await H.sync.sync();
    H.sync.bindOwner('uid-1');
    assert.ok(H.get('my_church_class', []).length > 0);
    H.sync.bindOwner('uid-2');
    assert.strictEqual(H.get('my_church_class', []).length, 0);
    // مع تعديلات معلّقة: لا نمسح
    H.set('my_church_class', [{ id: 5, name: 'x' }]);
    H.sync.touch('members');
    H.sync.bindOwner('uid-3');
    assert.strictEqual(H.get('my_church_class', []).length, 1);
  });

  await test('الخادم يرفض سجلات تالفة', async () => {
    const bad = [
      { path: 'nope', key: 'a', u: 1, d: 0, data: {} },
      { path: 'members', key: '', u: 1, d: 0, data: {} },
      { path: 'members', key: 'a', u: 'x', d: 0, data: {} },
      { path: 'members', key: 'a', u: 1, d: 0, data: 'str' }
    ];
    for (const r of bad) {
      const res = await http('POST', '/api/state', { cookie: adminC, body: { records: [r] } });
      assert.strictEqual(res.statusCode, 400, JSON.stringify(r));
    }
    const res = await http('POST', '/api/state', { body: { records: [] } });
    assert.strictEqual(res.statusCode, 401);
    const stu = await fb.auth.createUser({ email: '9@church.local', password: 'p', displayName: 's' });
    await fb.auth.setCustomUserClaims(stu.uid, { code: '9', role: 'student' });
    fb.db._store.students = fb.db._store.students || new Map();
    fb.db._store.students.set('9', { code: '9', name: 's', level: 'الفرقة الأولى', active: true });
    const res2 = await http('GET', '/api/state', { cookie: 'cookie-' + stu.uid });
    assert.strictEqual(res2.statusCode, 403);
  });

  let failed = 0;
  for (const [ok, name] of results) {
    console.log((ok ? '✔ ' : '✘ ') + name);
    if (!ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} اختبار مزامنة ناجح`);
  process.exit(failed ? 1 : 0);
})();

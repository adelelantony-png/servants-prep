'use strict';
/**
 * اختبارات الخادم — تعمل بدون إنترنت وبدون Firebase حقيقي.
 *   npm test
 */
const assert = require('assert');
const L = require('../server/lib');
const { handle } = require('../server/routes');

/* ---------------- Firestore / Auth وهميان ---------------- */

function makeFake() {
  const store = {}; // col -> Map(id -> data)
  const col = (n) => (store[n] = store[n] || new Map());
  const users = new Map(); // uid -> {uid,email,displayName,password,customClaims}
  let uidSeq = 1;

  const snapOf = (c, id) => {
    const data = col(c).get(id);
    return { exists: data !== undefined, id, data: () => (data ? { ...data } : undefined), ref: docRef(c, id) };
  };
  function docRef(c, id) {
    return {
      _c: c,
      _id: id,
      id,
      get: async () => snapOf(c, id),
      set: async (d) => void col(c).set(id, { ...d }),
      update: async (d) => {
        if (!col(c).has(id)) throw new Error('NOT_FOUND ' + c + '/' + id);
        col(c).set(id, { ...col(c).get(id), ...d });
      },
      delete: async () => void col(c).delete(id)
    };
  }
  function query(c, filters = [], order = null, lim = Infinity) {
    const q = {
      where: (f, op, v) => query(c, [...filters, [f, op, v]], order, lim),
      orderBy: (f) => query(c, filters, f, lim),
      limit: (n) => query(c, filters, order, n),
      get: async () => {
        let rows = [...col(c).entries()].filter(([, d]) =>
          filters.every(([f, op, v]) => (op === '==' ? d[f] === v : op === 'in' ? v.includes(d[f]) : false))
        );
        if (order) rows.sort((a, b) => String(a[1][order]).localeCompare(String(b[1][order])));
        rows = rows.slice(0, lim);
        const docs = rows.map(([id]) => snapOf(c, id));
        return { docs, size: docs.length, empty: docs.length === 0 };
      }
    };
    return q;
  }
  let autoId = 1;
  const db = {
    _store: store,
    collection: (c) => ({
      doc: (id) => docRef(c, String(id)),
      add: async (d) => {
        const id = 'auto' + autoId++;
        col(c).set(id, { ...d });
        return docRef(c, id);
      },
      ...query(c)
    }),
    batch: () => {
      const ops = [];
      return {
        delete: (r) => ops.push(() => r.delete()),
        update: (r, d) => ops.push(() => r.update(d)),
        commit: async () => {
          for (const o of ops) await o();
        }
      };
    },
    runTransaction: async (fn) => {
      const tx = {
        get: async (r) => r.get(),
        set: (r, d) => writes.push(() => r.set(d)),
        update: (r, d) => writes.push(() => r.update(d)),
        delete: (r) => writes.push(() => r.delete())
      };
      const writes = [];
      const out = await fn(tx);
      for (const w of writes) await w();
      return out;
    }
  };

  const tokens = new Map(); // 'cookie-uid' -> uid
  const auth = {
    _users: users,
    createUser: async ({ email, password, displayName }) => {
      if ([...users.values()].some((u) => u.email === email)) {
        const e = new Error('exists');
        e.code = 'auth/email-already-exists';
        throw e;
      }
      const uid = 'u' + uidSeq++;
      const u = { uid, email, password, displayName, customClaims: null };
      users.set(uid, u);
      return u;
    },
    setCustomUserClaims: async (uid, claims) => void (users.get(uid).customClaims = claims),
    getUserByEmail: async (email) => {
      const u = [...users.values()].find((x) => x.email === email);
      if (!u) {
        const e = new Error('nf');
        e.code = 'auth/user-not-found';
        throw e;
      }
      return u;
    },
    getUser: async (uid) => users.get(uid),
    updateUser: async (uid, patch) => Object.assign(users.get(uid), patch),
    deleteUser: async (uid) => void users.delete(uid),
    revokeRefreshTokens: async () => {},
    listUsers: async () => ({ users: [...users.values()] }),
    verifyIdToken: async (t) => {
      const u = users.get(t.replace('idtoken-', ''));
      if (!u) throw new Error('bad');
      return { uid: u.uid, email: u.email, name: u.displayName, ...(u.customClaims || {}) };
    },
    createSessionCookie: async (t) => 'cookie-' + t.replace('idtoken-', ''),
    verifySessionCookie: async (c) => {
      const u = users.get(String(c).replace('cookie-', ''));
      if (!u) throw new Error('bad cookie');
      return { uid: u.uid, email: u.email, name: u.displayName, ...(u.customClaims || {}) };
    }
  };
  void tokens;
  return { db, auth };
}

const fb = makeFake();
L.setFirebaseForTests(fb);
process.env.FIREBASE_WEB_API_KEY = 'test-key';

// Identity Toolkit وهمي
global.fetch = async (url, opts) => {
  const { email, password } = JSON.parse(opts.body);
  const u = [...fb.auth._users.values()].find((x) => x.email === email);
  if (!u || u.password !== password) {
    return { ok: false, json: async () => ({ error: { message: 'INVALID_LOGIN_CREDENTIALS' } }) };
  }
  return { ok: true, json: async () => ({ idToken: 'idtoken-' + u.uid, expiresIn: '3600' }) };
};

/* ---------------- أدوات الاختبار ---------------- */

let ipSeq = 1;
async function call(method, path, { body, cookie, headers = {}, ip } = {}) {
  const req = {
    method,
    url: path,
    headers: {
      host: 'app.test',
      'x-forwarded-for': ip || '10.0.0.' + (ipSeq++ % 250),
      ...(cookie ? { cookie: `__session=${cookie}` } : {}),
      ...headers
    },
    body
  };
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    end(data) {
      this.body = data ? JSON.parse(data) : null;
    }
  };
  await handle(req, res);
  return res;
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push([true, name]);
  } catch (e) {
    results.push([false, name + ' — ' + e.message]);
  }
}

function cookieFrom(res) {
  const m = /__session=([^;]*)/.exec(res.headers['set-cookie'] || '');
  return m ? decodeURIComponent(m[1]) : null;
}

/* ---------------- السيناريو ---------------- */

(async () => {
  // حساب أدمن وخادم
  const admin = await fb.auth.createUser({ email: 'admin@example.org', password: 'adminpass1', displayName: 'الأدمن' });
  await fb.auth.setCustomUserClaims(admin.uid, { admin: true });
  const servant = await fb.auth.createUser({ email: 'servant@example.org', password: 'servpass1', displayName: 'خادم' });
  await fb.auth.setCustomUserClaims(servant.uid, { servant: true });

  let adminCookie, servantCookie, s1Cookie, s2Cookie;

  await test('الدخول: بيانات خاطئة → 401 بدون كوكي', async () => {
    const r = await call('POST', '/api/auth-login', { body: { identifier: 'admin@example.org', password: 'wrong' } });
    assert.strictEqual(r.statusCode, 401);
    assert.ok(!r.headers['set-cookie']);
  });

  await test('الدخول: الأدمن بالبريد → كوكي HttpOnly + Secure + Strict', async () => {
    const r = await call('POST', '/api/auth-login', { body: { identifier: 'admin@example.org', password: 'adminpass1' } });
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(r.body.role, 'admin');
    const h = r.headers['set-cookie'];
    assert.ok(/HttpOnly/.test(h) && /Secure/.test(h) && /SameSite=Strict/.test(h));
    adminCookie = cookieFrom(r);
  });

  await test('الدخول: الخادم', async () => {
    const r = await call('POST', '/api/auth-login', { body: { email: 'servant@example.org', password: 'servpass1' } });
    assert.strictEqual(r.body.role, 'servant');
    servantCookie = cookieFrom(r);
  });

  await test('me بدون جلسة → 401', async () => {
    const r = await call('GET', '/api/me');
    assert.strictEqual(r.statusCode, 401);
  });

  await test('إضافة مخدوم بكلمة مرور قصيرة → 400', async () => {
    const r = await call('POST', '/api/admin', {
      cookie: adminCookie,
      body: { action: 'add_student', code: '1001', name: 'مينا', level: 'الفرقة الأولى', password: '123' }
    });
    assert.strictEqual(r.statusCode, 400);
  });

  await test('إضافة مخدومين (واحد بكلمة مرور وواحد بكلمة مولّدة)', async () => {
    let r = await call('POST', '/api/admin', {
      cookie: adminCookie,
      body: { action: 'add_student', code: '1001', name: 'مينا جرجس', level: 'الفرقة الأولى', password: 'minapass1' }
    });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.ok(!r.body.tempPassword);
    r = await call('POST', '/api/admin', {
      cookie: adminCookie,
      body: { action: 'add_student', code: '1002', name: 'كيرلس نبيل', level: 'الفرقة الثانية' }
    });
    assert.strictEqual(r.statusCode, 200);
    assert.ok(r.body.tempPassword && r.body.tempPassword.length === 8);
    fb.__temp2 = r.body.tempPassword;
  });

  await test('إضافة كود مكرر → 409', async () => {
    const r = await call('POST', '/api/admin', {
      cookie: adminCookie,
      body: { action: 'add_student', code: '1001', name: 'آخر', level: 'الفرقة الأولى', password: 'abcdef' }
    });
    assert.strictEqual(r.statusCode, 409);
  });

  await test('الخادم لا يستطيع الإضافة (POST admin للأدمن فقط) → 403', async () => {
    const r = await call('POST', '/api/admin', {
      cookie: servantCookie,
      body: { action: 'add_student', code: '9', name: 'x', level: 'الفرقة الأولى', password: 'abcdef' }
    });
    assert.strictEqual(r.statusCode, 403);
  });

  await test('الخادم يقرأ قائمة المخدومين', async () => {
    const r = await call('GET', '/api/admin?type=students', { cookie: servantCookie });
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(r.body.data.length, 2);
    assert.ok(r.body.data.every((s) => !('password' in s) && !('uid' in s)));
  });

  await test('دخول المخدوم بالكود', async () => {
    let r = await call('POST', '/api/auth-login', { body: { identifier: '1001', password: 'minapass1' } });
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(r.body.data.code, '1001');
    s1Cookie = cookieFrom(r);
    r = await call('POST', '/api/auth-login', { body: { identifier: '1002', password: fb.__temp2 } });
    assert.strictEqual(r.statusCode, 200);
    s2Cookie = cookieFrom(r);
  });

  await test('المخدوم لا يصل لواجهة الإدارة → 403', async () => {
    assert.strictEqual((await call('GET', '/api/admin?type=students', { cookie: s1Cookie })).statusCode, 403);
    assert.strictEqual((await call('GET', '/api/members', { cookie: s1Cookie })).statusCode, 403);
    assert.strictEqual(
      (await call('POST', '/api/admin', { cookie: s1Cookie, body: { action: 'delete_student', code: '1002' } })).statusCode,
      403
    );
  });

  await test('المخدوم لا يطلب بيانات مخدوم آخر → 403', async () => {
    const r = await call('GET', '/api/harvest?code=1002', { cookie: s1Cookie });
    assert.strictEqual(r.statusCode, 403);
  });

  await test('تسجيل قراءة اليوم: +5 نقاط ثم 409 عند التكرار بدون نقاط إضافية', async () => {
    const t = L.cairoToday();
    // الشكل المتداخل الذي ترسله student.html
    let r = await call('POST', '/api/mark_plan_read', {
      cookie: s1Cookie,
      body: { payload: { action: 'mark_reading', code: '1001', month: t.month, day: t.day, reading: 'تكوين 1' } }
    });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.points, 5);
    r = await call('POST', '/api/mark_plan_read', { cookie: s1Cookie, body: { month: t.month, day: t.day } });
    assert.strictEqual(r.statusCode, 409);
    assert.strictEqual(r.body.points, 5);
  });

  await test('قراءة يوم مستقبلي أو تاريخ وهمي → 400', async () => {
    const t = L.cairoToday();
    const future = new Date(Date.UTC(t.year, t.month - 1, t.day + 3));
    const r1 = await call('POST', '/api/mark_plan_read', {
      cookie: s1Cookie,
      body: { month: future.getUTCMonth() + 1, day: future.getUTCDate() }
    });
    // قد يقع اليوم المستقبلي في السنة التالية (نهاية ديسمبر) فيُقبل كيوم ماضٍ من نفس السنة
    if (!(t.month === 12 && t.day > 28)) assert.strictEqual(r1.statusCode, 400);
    const r2 = await call('POST', '/api/mark_plan_read', { cookie: s1Cookie, body: { month: 2, day: 31 } });
    assert.strictEqual(r2.statusCode, 400);
    const r3 = await call('POST', '/api/mark_plan_read', { cookie: s1Cookie, body: { month: 13, day: 1 } });
    assert.strictEqual(r3.statusCode, 400);
  });

  await test('تسجيل قراءة أصحاح وإلغاؤه يحدّث العدّاد', async () => {
    let r = await call('POST', '/api/update_reading', { cookie: s1Cookie, body: { book: 'تكوين', chapter: 1, status: 1 } });
    assert.strictEqual(r.body.is_read, true);
    r = await call('POST', '/api/update_reading', { cookie: s1Cookie, body: { book: 'تكوين', chapter: 1, status: 1 } });
    assert.strictEqual(fb.db._store.students.get('1001').readCount, 2); // قراءة يومية + أصحاح (بدون تكرار)
    r = await call('POST', '/api/update_reading', { cookie: s1Cookie, body: { book: 'تكوين', chapter: 1, status: 0 } });
    assert.strictEqual(r.body.is_read, false);
    assert.strictEqual(fb.db._store.students.get('1001').readCount, 1);
  });

  await test('النوتة الروحية: اليوم مقبول، المستقبل والقديم مرفوضان', async () => {
    const t = L.cairoToday();
    let r = await call('POST', '/api/spiritual_note', { cookie: s1Cookie, body: { date: t.iso, baker: true, mass: true } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    await call('POST', '/api/spiritual_note', { cookie: s1Cookie, body: { date: t.iso, baker: false } });
    assert.strictEqual(fb.db._store.students.get('1001').spiritualDays, 1);
    r = await call('POST', '/api/spiritual_note', { cookie: s1Cookie, body: { date: '2999-01-01' } });
    assert.strictEqual(r.statusCode, 400);
    r = await call('POST', '/api/spiritual_note', { cookie: s1Cookie, body: { date: '2000-01-01' } });
    assert.strictEqual(r.statusCode, 400);
    r = await call('POST', '/api/spiritual_note', { cookie: s1Cookie, body: { date: 'not-a-date' } });
    assert.strictEqual(r.statusCode, 400);
  });

  await test('الأدمن يضيف شيتًا برابط صالح فقط ويظهر للمخدوم المناسب', async () => {
    let r = await call('POST', '/api/admin', {
      cookie: adminCookie,
      body: { action: 'add_sheet', title: 'العقيدة', link: 'javascript:alert(1)', level: 'الفرقة الأولى' }
    });
    assert.strictEqual(r.statusCode, 400);
    r = await call('POST', '/api/admin', {
      cookie: adminCookie,
      body: { action: 'add_sheet', title: 'حياة الصلاة', link: 'https://drive.google.com/file/d/abc/view', level: 'الفرقة الأولى' }
    });
    assert.strictEqual(r.statusCode, 200);
    await call('POST', '/api/admin', {
      cookie: adminCookie,
      body: { action: 'add_sheet', title: 'للفرقة الثانية', link: 'https://example.org/x', level: 'الفرقة الثانية' }
    });
    r = await call('GET', '/api/get_subjects?level=' + encodeURIComponent('الفرقة الثانية'), { cookie: s1Cookie });
    assert.strictEqual(r.statusCode, 200);
    const titles = r.body.subjects.map((s) => s.title);
    assert.deepStrictEqual(titles, ['حياة الصلاة']); // يتجاهل level المرسل ويستخدم فرقته
  });

  await test('تسليم شيت: مرة جديدة ثم تحديث بدون عدّ مزدوج', async () => {
    let r = await call('POST', '/api/submit_sheet', { cookie: s1Cookie, body: { subject: 'حياة الصلاة', q1: 'أ', q2: 'ب' } });
    assert.strictEqual(r.statusCode, 200);
    r = await call('POST', '/api/submit_sheet', { cookie: s1Cookie, body: { subject: 'حياة الصلاة', q1: 'أ2', q2: 'ب2' } });
    assert.strictEqual(fb.db._store.students.get('1001').sheetsCount, 1);
    r = await call('POST', '/api/submit_sheet', { cookie: s1Cookie, body: { subject: 'x', q1: '', q2: 'ب' } });
    assert.strictEqual(r.statusCode, 400);
  });

  await test('الحصاد يعكس البيانات الفعلية', async () => {
    const r = await call('GET', '/api/harvest', { cookie: s1Cookie });
    assert.strictEqual(r.statusCode, 200);
    assert.deepStrictEqual(
      [r.body.data.points, r.body.data.bibleCount, r.body.data.submittedSheets, r.body.data.spiritualCount, r.body.data.totalSubjects],
      [5, 1, 1, 1, 1]
    );
  });

  await test('المشروعات: إضافة بالأدمن، مشاركة (+نقاط) وإلغاء (−نقاط)، وفرقة أخرى ممنوعة', async () => {
    let r = await call('POST', '/api/admin', {
      cookie: adminCookie,
      body: { action: 'add_project', title: 'يوم روحي', date: '2026-11-14', level: 'الكل', points: 15, description: 'د' }
    });
    assert.strictEqual(r.statusCode, 200);
    const pid = r.body.id;
    r = await call('POST', '/api/admin', {
      cookie: adminCookie,
      body: { action: 'add_project', title: 'للثانية', date: '2026-11-15', level: 'الفرقة الثانية', points: 50 }
    });
    const pid2 = r.body.id;
    r = await call('POST', '/api/projects', { cookie: s1Cookie, body: { action: 'toggle', id: pid } });
    assert.strictEqual(r.body.points, 20);
    assert.strictEqual(r.body.joined, true);
    r = await call('GET', '/api/projects', { cookie: s1Cookie });
    assert.strictEqual(r.body.data.length, 1);
    assert.strictEqual(r.body.data[0].joined, true);
    r = await call('POST', '/api/projects', { cookie: s1Cookie, body: { action: 'toggle', id: pid } });
    assert.strictEqual(r.body.points, 5);
    r = await call('POST', '/api/projects', { cookie: s1Cookie, body: { action: 'toggle', id: pid2 } });
    assert.strictEqual(r.statusCode, 403);
  });

  await test('لوحة الإدارة: إحصاءات صحيحة', async () => {
    const r = await call('GET', '/api/admin?type=dashboard', { cookie: adminCookie });
    const d = r.body.data;
    assert.strictEqual(d.totalStudents, 2);
    assert.strictEqual(d.totalPoints, 5);
    assert.strictEqual(d.readers, 1);
    assert.strictEqual(d.topStudents[0].code, '1001');
    assert.strictEqual(d.byLevel['الفرقة الأولى'], 1);
  });

  await test('ترحيل الفرق', async () => {
    const r = await call('POST', '/api/admin', {
      cookie: adminCookie,
      body: { action: 'promote_students', fromLevel: 'الفرقة الأولى', toLevel: 'الفرقة الثالثة' }
    });
    assert.strictEqual(r.body.count, 1);
    assert.strictEqual(fb.db._store.students.get('1001').level, 'الفرقة الثالثة');
    await call('POST', '/api/admin', {
      cookie: adminCookie,
      body: { action: 'promote_students', fromLevel: 'الفرقة الثالثة', toLevel: 'الفرقة الأولى' }
    });
  });

  await test('استيراد Excel: إنشاء + تحديث + رفض صف خاطئ + كلمات مولّدة', async () => {
    const r = await call('POST', '/api/admin', {
      cookie: adminCookie,
      body: {
        action: 'import_excel',
        students: [
          { code: '2001', name: 'جديد', level: 'الفرقة الأولى', password: '' },
          { code: '1001', name: 'مينا (محدّث)', level: 'الفرقة الأولى' },
          { code: 'bad code!', name: 'x', level: 'الفرقة الأولى' },
          { code: '2002', name: 'ثاني', level: 'الفرقة الأولى', password: 'secret12' }
        ]
      }
    });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.created, 2);
    assert.strictEqual(r.body.updated, 1);
    assert.strictEqual(r.body.failed.length, 1);
    assert.strictEqual(r.body.credentials.length, 1);
  });

  await test('إعادة تعيين كلمة مرور مخدوم ثم الدخول بها', async () => {
    let r = await call('POST', '/api/admin', {
      cookie: adminCookie,
      body: { action: 'reset_password', code: '1002', password: 'newpass99' }
    });
    assert.strictEqual(r.statusCode, 200);
    r = await call('POST', '/api/auth-login', { body: { identifier: '1002', password: 'newpass99' } });
    assert.strictEqual(r.statusCode, 200);
  });

  await test('إضافة خادم من الأدمن وعدم تصعيد الصلاحيات', async () => {
    let r = await call('POST', '/api/admin', {
      cookie: adminCookie,
      body: { action: 'add_servant', email: 'new@example.org', name: 'خادم جديد', password: 'servpass2' }
    });
    assert.strictEqual(r.statusCode, 200);
    const u = await fb.auth.getUserByEmail('new@example.org');
    assert.deepStrictEqual(u.customClaims, { servant: true });
    r = await call('POST', '/api/admin', {
      cookie: adminCookie,
      body: { action: 'add_servant', email: 'x@church.local', name: 'x', password: 'servpass2' }
    });
    assert.strictEqual(r.statusCode, 400);
    r = await call('GET', '/api/admin?type=servants', { cookie: adminCookie });
    assert.ok(r.body.data.some((s) => s.email === 'new@example.org'));
    r = await call('POST', '/api/admin', { cookie: adminCookie, body: { action: 'delete_servant', uid: admin.uid } });
    assert.strictEqual(r.statusCode, 400);
  });

  await test('تغيير كلمة المرور: الحالية مطلوبة والجديدة ≥ 8', async () => {
    let r = await call('POST', '/api/change-password', { cookie: s1Cookie, body: { currentPassword: 'x', newPassword: 'longenough1' } });
    assert.strictEqual(r.statusCode, 403);
    r = await call('POST', '/api/change-password', { cookie: s1Cookie, body: { currentPassword: 'minapass1', newPassword: 'short' } });
    assert.strictEqual(r.statusCode, 400);
    r = await call('POST', '/api/change-password', { cookie: s1Cookie, body: { currentPassword: 'minapass1', newPassword: 'minapass-new' } });
    assert.strictEqual(r.statusCode, 200);
    assert.ok(/Max-Age=0/.test(r.headers['set-cookie']));
  });

  await test('التحقق من كلمة مرور الأدمن (للعمليات الحساسة)', async () => {
    let r = await call('POST', '/api/verify-password', { cookie: adminCookie, body: { password: 'adminpass1' } });
    assert.strictEqual(r.statusCode, 200);
    r = await call('POST', '/api/verify-password', { cookie: adminCookie, body: { password: '1234567' } });
    assert.strictEqual(r.statusCode, 403);
  });

  await test('CSRF: طلب POST من موقع آخر يُرفض', async () => {
    let r = await call('POST', '/api/admin', {
      cookie: adminCookie,
      headers: { origin: 'https://evil.example' },
      body: { action: 'delete_student', code: '1002' }
    });
    assert.strictEqual(r.statusCode, 403);
    r = await call('POST', '/api/admin', {
      cookie: adminCookie,
      headers: { 'sec-fetch-site': 'cross-site' },
      body: { action: 'delete_student', code: '1002' }
    });
    assert.strictEqual(r.statusCode, 403);
    assert.ok(fb.db._store.students.get('1002'));
  });

  await test('تحديد المعدل: محاولات الدخول الخاطئة المتكررة → 429', async () => {
    let last;
    for (let i = 0; i < 8; i++) {
      last = await call('POST', '/api/auth-login', { ip: '9.9.9.9', body: { identifier: '7777', password: 'bad' + i } });
    }
    assert.strictEqual(last.statusCode, 429);
  });

  await test('حذف مخدوم يحذف حسابه وكل بياناته', async () => {
    const r = await call('POST', '/api/admin', { cookie: adminCookie, body: { action: 'delete_student', code: '1001' } });
    assert.strictEqual(r.statusCode, 200);
    assert.ok(!fb.db._store.students.get('1001'));
    assert.strictEqual(fb.db._store.planReads.size, 0);
    assert.strictEqual(fb.db._store.sheetSubs.size, 0);
    assert.strictEqual(fb.db._store.dailyLogs.size, 0);
    assert.strictEqual(fb.db._store.readingLogs.size, 0);
    assert.strictEqual(fb.db._store.participations.size, 0);
    await assert.rejects(() => fb.auth.getUserByEmail('1001@church.local'));
  });

  await test('مخدوم معطّل/محذوف لا يدخل ولا تعمل جلسته', async () => {
    let r = await call('GET', '/api/me', { cookie: s1Cookie });
    assert.strictEqual(r.statusCode, 401); // الحساب حُذف → الجلسة غير صالحة
    fb.db._store.students.get('1002').active = false;
    r = await call('POST', '/api/auth-login', { ip: '8.8.8.8', body: { identifier: '1002', password: 'newpass99' } });
    assert.strictEqual(r.statusCode, 403);
  });

  await test('مسارات غير موجودة / طرق خاطئة', async () => {
    assert.strictEqual((await call('GET', '/api/nope')).statusCode, 404);
    assert.strictEqual((await call('GET', '/api/auth-login')).statusCode, 405);
  });

  await test('health لا يكشف أسرارًا', async () => {
    const r = await call('GET', '/api/health');
    assert.strictEqual(r.statusCode, 200);
    assert.deepStrictEqual(Object.keys(r.body).sort(), ['firebaseServerConfigured', 'ok', 'service', 'success', 'webApiKeyConfigured']);
  });

  /* ---- تقرير ---- */
  let failed = 0;
  for (const [ok, name] of results) {
    console.log((ok ? '✔ ' : '✘ ') + name);
    if (!ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} اختبارًا ناجحًا`);
  process.exit(failed ? 1 : 0);
})();

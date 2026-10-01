'use strict';
const L = require('./lib');
const { HttpError } = L;

const PLAN_READ_POINTS = 5;
const PLAN_TOTAL_DAYS = 366;
const STAFF = ['admin', 'servant'];

/* ======================= أدوات مشتركة ======================= */

async function identityToolkitSignIn(email, password) {
  const key = process.env.FIREBASE_WEB_API_KEY;
  if (!key) throw new Error('FIREBASE_WEB_API_KEY is not configured.');
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(key)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true })
    }
  );
  const data = await r.json().catch(() => ({}));
  if (r.ok && data.idToken) return data;
  const code = (data.error && data.error.message) || '';
  if (/EMAIL_NOT_FOUND|INVALID_PASSWORD|INVALID_LOGIN_CREDENTIALS|USER_DISABLED|INVALID_EMAIL/.test(code)) return null;
  if (/TOO_MANY_ATTEMPTS/.test(code)) throw new HttpError(429, 'محاولات كثيرة. حاول لاحقًا.');
  throw new Error('Identity Toolkit error: ' + code);
}

async function loadStudent(db, code) {
  if (!code) return null;
  const snap = await db.collection('students').doc(String(code)).get();
  return snap.exists ? snap.data() : null;
}

/** يبني بيانات المستخدم الحالي. للمخدوم يتحقق أن حسابه موجود ومفعّل. */
async function buildProfile(session, db) {
  if (session.role === 'student') {
    const st = await loadStudent(db, session.code);
    if (!st || st.active === false) throw new HttpError(403, 'هذا الحساب غير مفعّل. تواصل مع أمين الخدمة.');
    return {
      uid: session.uid,
      role: 'student',
      code: st.code,
      name: st.name,
      level: st.level,
      points: Number(st.points || 0)
    };
  }
  return {
    uid: session.uid,
    role: session.role,
    code: session.role,
    name: session.name || session.email || (session.role === 'admin' ? 'أمين الخدمة' : 'خادم'),
    email: session.email,
    level: 'الإدارة',
    points: 0
  };
}

/** يحدد المخدوم المقصود: المخدوم لا يستطيع إلا نفسه، والخدام يمكنهم تحديد الكود */
async function resolveStudent(ctx, requestedCode, { requireStudentRole = false } = {}) {
  const { session, db } = ctx;
  if (session.role === 'student') {
    if (requestedCode && String(requestedCode) !== session.code) {
      throw new HttpError(403, 'لا يمكنك الوصول لبيانات مخدوم آخر.');
    }
    const st = await loadStudent(db, session.code);
    if (!st || st.active === false) throw new HttpError(403, 'هذا الحساب غير مفعّل.');
    return st;
  }
  if (requireStudentRole) throw new HttpError(403, 'هذه العملية خاصة بالمخدومين.');
  if (!requestedCode) return null;
  return loadStudent(db, String(requestedCode));
}

function toInt(v, min, max, label) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `قيمة ${label} غير صحيحة.`);
  return n;
}

function validIsoDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

async function deleteWhere(db, collection, field, value) {
  let total = 0;
  for (;;) {
    const snap = await db.collection(collection).where(field, '==', value).limit(400).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    total += snap.size;
    if (snap.size < 400) break;
  }
  return total;
}

/* ======================= المصادقة ======================= */

async function health() {
  const configured = Boolean(
    process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY
  );
  return {
    service: 'khedmety-pro',
    firebaseServerConfigured: configured,
    webApiKeyConfigured: Boolean(process.env.FIREBASE_WEB_API_KEY)
  };
}

async function authLogin(ctx) {
  const { req, res, body } = ctx;
  const identifier = L.str(body.identifier || body.email || body.code, 120, 'الدخول');
  const password = typeof body.password === 'string' ? body.password : '';
  if (!identifier || !password || password.length > 100) {
    throw new HttpError(400, 'اكتب الكود أو البريد وكلمة المرور.');
  }

  const ip = L.clientIp(req);
  L.rateLimit(`login-ip:${ip}`, 30, 10 * 60 * 1000);

  let email;
  if (identifier.includes('@')) {
    email = identifier.toLowerCase();
  } else if (/^[A-Za-z0-9_-]{1,32}$/.test(identifier)) {
    email = L.studentEmail(identifier);
  } else {
    throw new HttpError(401, 'بيانات الدخول غير صحيحة.');
  }
  const userKey = `login-user:${email}`;
  L.rateLimit(userKey, 6, 10 * 60 * 1000);

  const signed = await identityToolkitSignIn(email, password);
  if (!signed) throw new HttpError(401, 'بيانات الدخول غير صحيحة.');

  const { auth, db } = ctx.fb;
  const decoded = await auth.verifyIdToken(signed.idToken);
  const session = {
    uid: decoded.uid,
    role: L.roleFromClaims(decoded),
    code: decoded.code ? String(decoded.code) : null,
    email: decoded.email || email,
    name: decoded.name || null
  };
  const profile = await buildProfile(session, db);

  const cookie = await auth.createSessionCookie(signed.idToken, { expiresIn: L.SESSION_MAX_AGE_MS });
  res.setHeader('Set-Cookie', L.sessionCookieHeader(cookie, Math.floor(L.SESSION_MAX_AGE_MS / 1000)));
  L.resetRateLimit(userKey);
  return { data: profile, role: profile.role };
}

async function authLogout(ctx) {
  ctx.res.setHeader('Set-Cookie', L.sessionCookieHeader('', 0));
  return {};
}

async function me(ctx) {
  const profile = await buildProfile(ctx.session, ctx.db);
  return { data: profile, role: profile.role, uid: profile.uid };
}

async function verifyPassword(ctx) {
  const { session, body } = ctx;
  L.rateLimit(`verify-pw:${session.uid}`, 8, 60 * 1000);
  const password = typeof body.password === 'string' ? body.password : '';
  if (!password || !session.email) throw new HttpError(400, 'كلمة المرور مطلوبة.');
  const signed = await identityToolkitSignIn(session.email, password);
  if (!signed) throw new HttpError(403, 'كلمة المرور غير صحيحة.');
  return { verified: true };
}

async function changePassword(ctx) {
  const { session, body, res } = ctx;
  L.rateLimit(`change-pw:${session.uid}`, 5, 10 * 60 * 1000);
  const current = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  const next = typeof body.newPassword === 'string' ? body.newPassword : '';
  if (next.length < 8 || next.length > 100) throw new HttpError(400, 'كلمة المرور الجديدة يجب ألا تقل عن 8 أحرف.');
  const signed = await identityToolkitSignIn(session.email, current);
  if (!signed) throw new HttpError(403, 'كلمة المرور الحالية غير صحيحة.');
  const { auth } = ctx.fb;
  await auth.updateUser(session.uid, { password: next });
  await auth.revokeRefreshTokens(session.uid);
  res.setHeader('Set-Cookie', L.sessionCookieHeader('', 0));
  return { relogin: true, message: 'تم تغيير كلمة المرور. سجّل الدخول من جديد.' };
}

/* ======================= المخدوم ======================= */

async function getSubjects(ctx) {
  const { db, query, session } = ctx;
  const st = await resolveStudent(ctx, query.code);
  let levels;
  if (session.role === 'student') levels = [st.level, 'الكل'];
  else if (query.level) levels = [L.validLevel(query.level), 'الكل'];
  else levels = null;

  const pick = async (col) => {
    const ref = db.collection(col);
    const snap = levels ? await ref.where('level', 'in', levels).get() : await ref.get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  };
  const [subjects, sheets] = await Promise.all([pick('subjects'), pick('sheets')]);
  const list = [
    ...subjects.map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description || '',
      level: s.level,
      sheet_url: s.sheet_url || s.sheet_link || ''
    })),
    ...sheets.map((s) => ({ id: s.id, title: s.title, description: '', level: s.level, sheet_url: s.link || '' }))
  ];

  let submitted = [];
  if (st) {
    const subs = await db.collection('sheetSubs').where('code', '==', st.code).get();
    submitted = subs.docs.map((d) => d.data().subject_name);
  }
  return { subjects: list, submitted };
}

async function harvest(ctx) {
  const { db, query } = ctx;
  const st = await resolveStudent(ctx, query.code);
  const empty = {
    points: 0,
    bibleCount: 0,
    totalPlanDays: PLAN_TOTAL_DAYS,
    totalSubjects: 0,
    submittedSheets: 0,
    spiritualCount: 0
  };
  if (!st) return { data: empty };

  const year = L.cairoToday().year;
  const [plan, subj, sheets] = await Promise.all([
    db.collection('planReads').where('code', '==', st.code).where('year', '==', year).get(),
    db.collection('subjects').where('level', 'in', [st.level, 'الكل']).get(),
    db.collection('sheets').where('level', 'in', [st.level, 'الكل']).get()
  ]);
  return {
    data: {
      points: Number(st.points || 0),
      bibleCount: plan.size,
      totalPlanDays: PLAN_TOTAL_DAYS,
      totalSubjects: subj.size + sheets.size,
      submittedSheets: Number(st.sheetsCount || 0),
      spiritualCount: Number(st.spiritualDays || 0)
    }
  };
}

async function markPlanRead(ctx) {
  const { db, body } = ctx;
  const st = await resolveStudent(ctx, null, { requireStudentRole: true });
  const p = body.payload && typeof body.payload === 'object' ? body.payload : body;
  const month = toInt(p.month, 1, 12, 'الشهر');
  const day = toInt(p.day, 1, 31, 'اليوم');
  const reading = L.str(p.reading, 200, 'القراءة') || 'قراءة يومية';

  const today = L.cairoToday();
  const cand = new Date(Date.UTC(today.year, month - 1, day));
  if (cand.getUTCMonth() !== month - 1 || cand.getUTCDate() !== day) throw new HttpError(400, 'تاريخ غير صحيح.');
  if (cand.getTime() > Date.UTC(today.year, today.month - 1, today.day)) {
    throw new HttpError(400, 'لا يمكن تسجيل قراءة يوم لم يأتِ بعد.');
  }

  const logRef = db.collection('planReads').doc(L.docId(st.code, today.year, month, day));
  const stRef = db.collection('students').doc(st.code);

  const points = await db.runTransaction(async (tx) => {
    const [logSnap, stSnap] = await Promise.all([tx.get(logRef), tx.get(stRef)]);
    const cur = Number((stSnap.data() || {}).points || 0);
    if (logSnap.exists) throw new HttpError(409, 'تم تسجيل هذه القراءة مسبقًا.', { points: cur });
    const next = cur + PLAN_READ_POINTS;
    tx.set(logRef, { code: st.code, year: today.year, month, day, reading, at: new Date() });
    tx.update(stRef, { points: next, readCount: Number((stSnap.data() || {}).readCount || 0) + 1, updatedAt: new Date() });
    return next;
  });
  return { message: `تم تسجيل القراءة وإضافة ${PLAN_READ_POINTS} نقاط`, points };
}

async function updateReading(ctx) {
  const { db, body } = ctx;
  const st = await resolveStudent(ctx, null, { requireStudentRole: true });
  const book = L.str(body.book, 60, 'السفر');
  if (!book) throw new HttpError(400, 'اسم السفر مطلوب.');
  const chapter = toInt(body.chapter, 1, 200, 'الأصحاح');
  const wantRead = Number(body.status) === 1;

  const ref = db.collection('readingLogs').doc(L.docId(st.code, book, chapter));
  const stRef = db.collection('students').doc(st.code);
  await db.runTransaction(async (tx) => {
    const [snap, stSnap] = await Promise.all([tx.get(ref), tx.get(stRef)]);
    const cnt = Number((stSnap.data() || {}).readCount || 0);
    if (wantRead && !snap.exists) {
      tx.set(ref, { code: st.code, book, chapter, at: new Date() });
      tx.update(stRef, { readCount: cnt + 1 });
    } else if (!wantRead && snap.exists) {
      tx.delete(ref);
      tx.update(stRef, { readCount: Math.max(0, cnt - 1) });
    }
  });
  return { is_read: wantRead };
}

async function spiritualNote(ctx) {
  const { db, body } = ctx;
  const st = await resolveStudent(ctx, null, { requireStudentRole: true });
  const date = L.str(body.date, 10, 'التاريخ');
  if (!validIsoDate(date)) throw new HttpError(400, 'تأكد من إدخال التاريخ بشكل صحيح.');

  const today = L.cairoToday();
  const [y, m, d] = date.split('-').map(Number);
  const target = Date.UTC(y, m - 1, d);
  const todayUtc = Date.UTC(today.year, today.month - 1, today.day);
  if (target > todayUtc) throw new HttpError(400, 'لا يمكن التسجيل في تاريخ مستقبلي.');
  if (todayUtc - target > 30 * 86400000) throw new HttpError(400, 'يمكن التسجيل خلال آخر 30 يومًا فقط.');

  const ref = db.collection('dailyLogs').doc(L.docId(st.code, date));
  const stRef = db.collection('students').doc(st.code);
  await db.runTransaction(async (tx) => {
    const [snap, stSnap] = await Promise.all([tx.get(ref), tx.get(stRef)]);
    tx.set(ref, {
      code: st.code,
      date,
      prayed_baker: body.baker ? 1 : 0,
      prayed_ghoroub: body.ghoroub ? 1 : 0,
      prayed_noam: body.noam ? 1 : 0,
      fasting: body.fasting ? 1 : 0,
      attended_mass: body.mass ? 1 : 0,
      updated_at: new Date()
    });
    if (!snap.exists) tx.update(stRef, { spiritualDays: Number((stSnap.data() || {}).spiritualDays || 0) + 1 });
  });
  return { message: 'تم تسجيل وسائط النعمة بنجاح' };
}

async function submitSheet(ctx) {
  const { db, body } = ctx;
  const st = await resolveStudent(ctx, null, { requireStudentRole: true });
  const subject = L.str(body.subject, 150, 'المادة');
  const q1 = L.str(body.q1, 5000, 'الإجابة الأولى');
  const q2 = L.str(body.q2, 5000, 'الإجابة الثانية');
  if (!subject || !q1 || !q2) throw new HttpError(400, 'تأكد من كتابة جميع الإجابات.');

  const ref = db.collection('sheetSubs').doc(L.docId(st.code, subject));
  const stRef = db.collection('students').doc(st.code);
  const isNew = await db.runTransaction(async (tx) => {
    const [snap, stSnap] = await Promise.all([tx.get(ref), tx.get(stRef)]);
    tx.set(ref, { code: st.code, subject_name: subject, q1_answer: q1, q2_answer: q2, submitted_at: new Date() });
    if (!snap.exists) tx.update(stRef, { sheetsCount: Number((stSnap.data() || {}).sheetsCount || 0) + 1 });
    return !snap.exists;
  });
  return { message: isNew ? 'تم تسليم الشيت بنجاح' : 'تم تحديث إجاباتك بنجاح' };
}

/* ---------------- المشروعات ---------------- */

async function projectsGet(ctx) {
  const { db, session } = ctx;
  const st = session.role === 'student' ? await resolveStudent(ctx, null) : null;
  const snap = await db.collection('projects').orderBy('date').limit(200).get();
  let joined = new Set();
  if (st) {
    const parts = await db.collection('participations').where('code', '==', st.code).get();
    joined = new Set(parts.docs.map((d) => d.data().projectId));
  }
  const data = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((p) => !st || p.level === 'الكل' || p.level === st.level)
    .map((p) => ({
      id: p.id,
      title: p.title,
      date: p.date,
      level: p.level,
      points: Number(p.points || 0),
      description: p.description || '',
      joined: joined.has(p.id)
    }));
  return { data, studentCode: st ? st.code : null, points: st ? Number(st.points || 0) : 0 };
}

async function projectsPost(ctx) {
  const { db, body } = ctx;
  const st = await resolveStudent(ctx, null, { requireStudentRole: true });
  if (body.action !== 'toggle') throw new HttpError(400, 'إجراء غير معروف.');
  const id = L.str(body.id, 100, 'المشروع');
  if (!id) throw new HttpError(400, 'المشروع مطلوب.');

  const pRef = db.collection('projects').doc(id);
  const partRef = db.collection('participations').doc(L.docId(id, st.code));
  const stRef = db.collection('students').doc(st.code);
  const result = await db.runTransaction(async (tx) => {
    const [pSnap, partSnap, stSnap] = await Promise.all([tx.get(pRef), tx.get(partRef), tx.get(stRef)]);
    if (!pSnap.exists) throw new HttpError(404, 'المشروع غير موجود.');
    const proj = pSnap.data();
    if (proj.level !== 'الكل' && proj.level !== st.level) throw new HttpError(403, 'هذا المشروع لفرقة أخرى.');
    const cur = Number((stSnap.data() || {}).points || 0);
    const pts = Number(proj.points || 0);
    if (partSnap.exists) {
      const next = Math.max(0, cur - pts);
      tx.delete(partRef);
      tx.update(stRef, { points: next });
      return { joined: false, points: next };
    }
    const next = cur + pts;
    tx.set(partRef, { projectId: id, code: st.code, points: pts, at: new Date() });
    tx.update(stRef, { points: next });
    return { joined: true, points: next };
  });
  return { ...result, message: result.joined ? 'تم تسجيل مشاركتك' : 'تم إلغاء مشاركتك' };
}

/* ======================= الإدارة ======================= */

function publicStudent(d) {
  return {
    code: d.code,
    name: d.name,
    level: d.level,
    points: Number(d.points || 0),
    readCount: Number(d.readCount || 0),
    spiritualDays: Number(d.spiritualDays || 0),
    sheetsCount: Number(d.sheetsCount || 0),
    active: d.active !== false
  };
}

async function listStudents(db) {
  const snap = await db.collection('students').orderBy('name').limit(2000).get();
  return snap.docs.map((d) => publicStudent(d.data()));
}

async function adminGet(ctx) {
  const { db, query, fb } = ctx;
  const type = query.type || 'dashboard';

  if (type === 'students') return { data: await listStudents(db) };

  if (type === 'sheets') {
    const snap = await db.collection('sheets').get();
    return { data: snap.docs.map((d) => ({ id: d.id, ...d.data() })) };
  }

  if (type === 'projects') {
    const snap = await db.collection('projects').orderBy('date').limit(200).get();
    return { data: snap.docs.map((d) => ({ id: d.id, ...d.data() })) };
  }

  if (type === 'servants') {
    const list = await fb.auth.listUsers(1000);
    const data = list.users
      .filter((u) => u.customClaims && (u.customClaims.servant === true || u.customClaims.admin === true))
      .map((u) => ({
        uid: u.uid,
        email: u.email,
        name: u.displayName || '',
        role: u.customClaims.admin === true ? 'admin' : 'servant'
      }));
    return { data };
  }

  if (type === 'dashboard') {
    const [students, subj, sheets] = await Promise.all([
      listStudents(db),
      db.collection('subjects').get(),
      db.collection('sheets').get()
    ]);
    const byLevel = {};
    students.forEach((s) => {
      byLevel[s.level] = (byLevel[s.level] || 0) + 1;
    });
    const top = [...students]
      .sort((a, b) => b.points - a.points)
      .slice(0, 10)
      .map((s) => ({ code: s.code, name: s.name, level: s.level, points: s.points, readings: s.readCount }));
    return {
      data: {
        totalStudents: students.length,
        totalSubjects: subj.size + sheets.size,
        totalPoints: students.reduce((a, s) => a + s.points, 0),
        readers: students.filter((s) => s.readCount > 0).length,
        spiritualActive: students.filter((s) => s.spiritualDays > 0).length,
        byLevel,
        topStudents: top,
        generatedAt: new Date().toISOString()
      }
    };
  }
  throw new HttpError(400, 'نوع غير معروف.');
}

async function createStudentAccount(ctx, { code, name, level, password }) {
  const { db, fb } = ctx;
  const ref = db.collection('students').doc(code);
  if ((await ref.get()).exists) throw new HttpError(409, 'الكود مستخدم مسبقًا.');

  let generated = false;
  let pw = password;
  if (!pw) {
    pw = L.randomPassword();
    generated = true;
  }
  let user;
  try {
    user = await fb.auth.createUser({ email: L.studentEmail(code), password: pw, displayName: name });
  } catch (e) {
    if (e && e.code === 'auth/email-already-exists') throw new HttpError(409, 'الكود مستخدم مسبقًا.');
    throw e;
  }
  try {
    await fb.auth.setCustomUserClaims(user.uid, { code, role: 'student' });
    await ref.set({
      code,
      name,
      level,
      points: 0,
      readCount: 0,
      spiritualDays: 0,
      sheetsCount: 0,
      active: true,
      uid: user.uid,
      createdAt: new Date(),
      updatedAt: new Date()
    });
  } catch (e) {
    await fb.auth.deleteUser(user.uid).catch(() => {});
    throw e;
  }
  return generated ? pw : null;
}

function cleanStudentInput(p) {
  const code = L.normalizeCode(p.code);
  const name = L.str(p.name, 100, 'الاسم');
  if (!name) throw new HttpError(400, 'الاسم مطلوب.');
  const level = L.validLevel(p.level);
  if (level === 'الكل') throw new HttpError(400, 'اختر فرقة محددة للمخدوم.');
  const password = L.str(p.password, 100, 'كلمة المرور');
  if (password && !L.validPassword(password)) throw new HttpError(400, 'كلمة المرور يجب ألا تقل عن 6 أحرف.');
  return { code, name, level, password };
}

async function findStudentUser(fb, code) {
  try {
    const u = await fb.auth.getUserByEmail(L.studentEmail(code));
    if (u.customClaims && String(u.customClaims.code) === String(code)) return u;
  } catch (e) {
    if (!(e && e.code === 'auth/user-not-found')) throw e;
  }
  return null;
}

async function adminPost(ctx) {
  const { db, fb, body } = ctx;
  const action = body.action;

  if (action === 'add_student') {
    const input = cleanStudentInput(body);
    const tempPassword = await createStudentAccount(ctx, input);
    return {
      message: `تم إضافة ${input.name} وإنشاء حسابه`,
      ...(tempPassword ? { tempPassword } : {})
    };
  }

  if (action === 'import_excel') {
    const rows = Array.isArray(body.students) ? body.students : [];
    if (!rows.length) throw new HttpError(400, 'لا توجد بيانات للاستيراد.');
    if (rows.length > 100) throw new HttpError(400, 'الحد الأقصى 100 مخدوم في الطلب الواحد.');
    let created = 0;
    let updated = 0;
    const failed = [];
    const credentials = [];
    for (const row of rows) {
      let input;
      try {
        input = cleanStudentInput(row || {});
      } catch (e) {
        failed.push({ code: String((row && row.code) || ''), reason: e.message });
        continue;
      }
      try {
        const ref = db.collection('students').doc(input.code);
        if ((await ref.get()).exists) {
          await ref.update({ name: input.name, level: input.level, updatedAt: new Date() });
          updated++;
        } else {
          const temp = await createStudentAccount(ctx, input);
          created++;
          if (temp) credentials.push({ code: input.code, name: input.name, password: temp });
        }
      } catch (e) {
        failed.push({ code: input.code, reason: e instanceof HttpError ? e.message : 'خطأ غير متوقع' });
        if (!(e instanceof HttpError)) console.error('import row', input.code, e);
      }
    }
    return {
      message: `تم إنشاء ${created} وتحديث ${updated}` + (failed.length ? ` وتعذر ${failed.length}` : ''),
      created,
      updated,
      failed,
      credentials
    };
  }

  if (action === 'delete_student') {
    const code = L.normalizeCode(body.code);
    const ref = db.collection('students').doc(code);
    if (!(await ref.get()).exists) throw new HttpError(404, 'المخدوم غير موجود.');
    const user = await findStudentUser(fb, code);
    if (user) await fb.auth.deleteUser(user.uid);
    for (const col of ['readingLogs', 'planReads', 'dailyLogs', 'sheetSubs', 'participations']) {
      await deleteWhere(db, col, 'code', code);
    }
    await ref.delete();
    return { message: 'تم حذف المخدوم وحسابه وبياناته.' };
  }

  if (action === 'reset_password') {
    const code = L.normalizeCode(body.code);
    const pw = L.str(body.password, 100, 'كلمة المرور');
    if (!L.validPassword(pw)) throw new HttpError(400, 'كلمة المرور يجب ألا تقل عن 6 أحرف.');
    const user = await findStudentUser(fb, code);
    if (!user) throw new HttpError(404, 'حساب المخدوم غير موجود.');
    await fb.auth.updateUser(user.uid, { password: pw });
    await fb.auth.revokeRefreshTokens(user.uid);
    return { message: 'تم تغيير كلمة المرور.' };
  }

  if (action === 'promote_students') {
    const from = L.validLevel(body.fromLevel);
    const to = L.validLevel(body.toLevel);
    if (from === 'الكل' || to === 'الكل' || from === to) throw new HttpError(400, 'اختر فرقتين مختلفتين.');
    let n = 0;
    for (;;) {
      const snap = await db.collection('students').where('level', '==', from).limit(400).get();
      if (snap.empty) break;
      const batch = db.batch();
      snap.docs.forEach((d) => batch.update(d.ref, { level: to, updatedAt: new Date() }));
      await batch.commit();
      n += snap.size;
    }
    return { message: `تم ترحيل ${n} مخدوم إلى ${to}`, count: n };
  }

  if (action === 'add_sheet') {
    const title = L.str(body.title, 150, 'العنوان');
    if (!title) throw new HttpError(400, 'عنوان الشيت مطلوب.');
    const link = L.validUrl(body.link);
    if (!link) throw new HttpError(400, 'رابط الشيت مطلوب.');
    const level = L.validLevel(body.level);
    const ref = await db.collection('sheets').add({ title, link, level, createdAt: new Date() });
    return { message: 'تم إضافة الشيت بنجاح', id: ref.id };
  }

  if (action === 'delete_sheet') {
    const id = L.str(body.id, 100, 'المعرّف');
    if (!id) throw new HttpError(400, 'المعرّف مطلوب.');
    await db.collection('sheets').doc(id).delete();
    return { message: 'تم حذف الشيت.' };
  }

  if (action === 'add_project') {
    const title = L.str(body.title, 150, 'العنوان');
    if (!title) throw new HttpError(400, 'عنوان المشروع مطلوب.');
    const date = L.str(body.date, 10, 'التاريخ');
    if (!validIsoDate(date)) throw new HttpError(400, 'تاريخ المشروع غير صحيح.');
    const points = toInt(body.points === undefined || body.points === '' ? 0 : body.points, 0, 1000, 'النقاط');
    const level = L.validLevel(body.level);
    const description = L.str(body.description, 500, 'الوصف');
    const ref = await db.collection('projects').add({ title, date, level, points, description, createdAt: new Date() });
    return { message: 'تم إضافة المشروع.', id: ref.id };
  }

  if (action === 'delete_project') {
    const id = L.str(body.id, 100, 'المعرّف');
    if (!id) throw new HttpError(400, 'المعرّف مطلوب.');
    await deleteWhere(db, 'participations', 'projectId', id);
    await db.collection('projects').doc(id).delete();
    return { message: 'تم حذف المشروع.' };
  }

  if (action === 'add_servant') {
    const email = L.str(body.email, 120, 'البريد').toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.endsWith('@' + 'church.local')) {
      throw new HttpError(400, 'اكتب بريدًا إلكترونيًا صحيحًا.');
    }
    const name = L.str(body.name, 100, 'الاسم');
    if (!name) throw new HttpError(400, 'الاسم مطلوب.');
    const password = L.str(body.password, 100, 'كلمة المرور');
    if (!L.validPassword(password)) throw new HttpError(400, 'كلمة المرور يجب ألا تقل عن 6 أحرف.');
    let user;
    try {
      user = await fb.auth.createUser({ email, password, displayName: name });
    } catch (e) {
      if (e && e.code === 'auth/email-already-exists') throw new HttpError(409, 'هذا البريد مستخدم مسبقًا.');
      throw e;
    }
    await fb.auth.setCustomUserClaims(user.uid, { servant: true });
    return { message: `تم إضافة الخادم ${name}` };
  }

  if (action === 'delete_servant') {
    const uid = L.str(body.uid, 128, 'المعرّف');
    if (!uid) throw new HttpError(400, 'المعرّف مطلوب.');
    if (uid === ctx.session.uid) throw new HttpError(400, 'لا يمكنك حذف حسابك.');
    const user = await fb.auth.getUser(uid);
    if (!(user.customClaims && user.customClaims.servant === true) || (user.customClaims && user.customClaims.admin === true)) {
      throw new HttpError(400, 'هذا الحساب ليس حساب خادم.');
    }
    await fb.auth.deleteUser(uid);
    return { message: 'تم حذف حساب الخادم.' };
  }

  throw new HttpError(400, 'إجراء غير معروف.');
}

/* ======================= جدول المسارات ======================= */

const ROUTES = {
  'GET health': { auth: 'none', fn: health, needsFirebase: false },
  'POST auth-login': { auth: 'none', fn: authLogin },
  'POST auth-logout': { auth: 'none', fn: authLogout, needsFirebase: false },
  'GET auth-me': { auth: 'any', fn: me },
  'GET me': { auth: 'any', fn: me },
  'POST verify-password': { auth: 'any', fn: verifyPassword },
  'POST change-password': { auth: 'any', fn: changePassword },
  'GET get_subjects': { auth: 'any', fn: getSubjects },
  'GET harvest': { auth: 'any', fn: harvest },
  'POST mark_plan_read': { auth: 'student', fn: markPlanRead },
  'POST update_reading': { auth: 'student', fn: updateReading },
  'POST spiritual_note': { auth: 'student', fn: spiritualNote },
  'POST submit_sheet': { auth: 'student', fn: submitSheet },
  'GET projects': { auth: 'any', fn: projectsGet },
  'POST projects': { auth: 'student', fn: projectsPost },
  'GET admin': { auth: STAFF, fn: adminGet },
  'POST admin': { auth: ['admin'], fn: adminPost },
  'GET members': { auth: STAFF, fn: async (ctx) => ({ data: await listStudents(ctx.db) }) }
};

async function handle(req, res) {
  try {
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      return res.end();
    }
    const { route, query } = L.getPath(req);
    const key = `${req.method === 'HEAD' ? 'GET' : req.method} ${route}`;
    const def = ROUTES[key];
    if (!def) {
      const known = Object.keys(ROUTES).some((k) => k.endsWith(' ' + route));
      return L.fail(res, known ? 405 : 404, known ? 'الطريقة غير مسموحة.' : 'المسار غير موجود.');
    }

    L.assertSameOrigin(req);
    L.rateLimit(`ip:${L.clientIp(req)}`, 300, 60 * 1000);

    const ctx = { req, res, query, body: {}, session: null, fb: null, db: null };
    if (req.method === 'POST') ctx.body = L.getBody(req);

    if (def.needsFirebase !== false) {
      ctx.fb = L.getFirebaseAdmin();
      ctx.db = ctx.fb.db;
    }

    if (def.auth !== 'none') {
      ctx.session = await L.requireSession(req);
      if (def.auth === 'student') L.requireRole(ctx.session, ['student']);
      else if (Array.isArray(def.auth)) L.requireRole(ctx.session, def.auth);
    }

    const out = await def.fn(ctx);
    return L.ok(res, out || {});
  } catch (e) {
    if (e instanceof HttpError) {
      res.statusCode = e.status;
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ ok: false, success: false, message: e.message, ...e.data }));
    }
    console.error('api error', e);
    if (e && /not configured/.test(String(e.message))) return L.fail(res, 503, 'الخادم غير مهيأ بعد.');
    return L.fail(res, 500, 'حدث خطأ في الخادم.');
  }
}

module.exports = { handle, ROUTES };

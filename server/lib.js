'use strict';
/**
 * مكتبة الخادم المشتركة — خدمتي برو
 * - تهيئة Firebase Admin
 * - الجلسات (Session Cookie) والأدوار
 * - التحقق من المدخلات
 * - حماية CSRF وتحديد المعدل
 */

const SESSION_COOKIE = '__session';
const SESSION_MAX_AGE_MS = 5 * 24 * 60 * 60 * 1000; // 5 أيام
const STUDENT_EMAIL_DOMAIN = 'church.local';
const LEVELS = ['الفرقة الأولى', 'الفرقة الثانية', 'الفرقة الثالثة', 'الفرقة الرابعة', 'الفرقة الخامسة', 'خريجين'];

class HttpError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    this.data = data || {};
  }
}

/* ---------------- Firebase ---------------- */

let _firebase = null;

function getFirebaseAdmin() {
  if (_firebase) return _firebase;
  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
  if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
    throw new Error('Firebase server environment variables are not configured.');
  }
  const { getApps, initializeApp, cert } = require('firebase-admin/app');
  const { getFirestore, FieldValue } = require('firebase-admin/firestore');
  const { getAuth } = require('firebase-admin/auth');
  const app =
    getApps()[0] ||
    initializeApp({
      credential: cert({
        projectId: FIREBASE_PROJECT_ID,
        clientEmail: FIREBASE_CLIENT_EMAIL,
        privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
      })
    });
  _firebase = { app, db: getFirestore(app), auth: getAuth(app), FieldValue };
  return _firebase;
}

/** للاختبارات فقط */
function setFirebaseForTests(fake) {
  _firebase = fake;
}

/* ---------------- الكوكيز والجلسة ---------------- */

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  const found = raw
    .split(';')
    .map((x) => x.trim())
    .find((x) => x.startsWith(name + '='));
  if (!found) return null;
  try {
    return decodeURIComponent(found.slice(name.length + 1));
  } catch (e) {
    return null;
  }
}

function sessionCookieHeader(value, maxAgeSeconds) {
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

function roleFromClaims(claims) {
  if (claims && claims.admin === true) return 'admin';
  if (claims && claims.servant === true) return 'servant';
  return 'student';
}

/**
 * يتحقق من الجلسة ويُرجع { uid, role, claims, code, email, name }
 * يرمي HttpError(401) عند عدم وجود جلسة صالحة.
 */
async function requireSession(req) {
  const cookie = readCookie(req, SESSION_COOKIE);
  if (!cookie) throw new HttpError(401, 'يجب تسجيل الدخول أولًا.');
  const { auth } = getFirebaseAdmin();
  let decoded;
  try {
    decoded = await auth.verifySessionCookie(cookie, true);
  } catch (e) {
    throw new HttpError(401, 'انتهت الجلسة. سجّل الدخول من جديد.');
  }
  return {
    uid: decoded.uid,
    role: roleFromClaims(decoded),
    claims: decoded,
    code: decoded.code ? String(decoded.code) : null,
    email: decoded.email || null,
    name: decoded.name || null
  };
}

function requireRole(session, roles) {
  if (!roles.includes(session.role)) throw new HttpError(403, 'ليست لديك صلاحية لهذه العملية.');
}

/* ---------------- الطلبات ---------------- */

function getBody(req) {
  const b = req.body;
  if (!b) return {};
  if (typeof b === 'string') {
    try {
      return JSON.parse(b);
    } catch (e) {
      throw new HttpError(400, 'صيغة الطلب غير صحيحة.');
    }
  }
  if (Buffer.isBuffer(b)) {
    try {
      return JSON.parse(b.toString('utf8'));
    } catch (e) {
      throw new HttpError(400, 'صيغة الطلب غير صحيحة.');
    }
  }
  return b;
}

function getPath(req) {
  const url = new URL(req.url, 'http://local');
  let p = url.pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '');
  return { route: p, query: Object.fromEntries(url.searchParams.entries()) };
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/** حماية CSRF: الطلبات المغيِّرة يجب أن تكون من نفس الموقع */
function assertSameOrigin(req) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  const site = req.headers['sec-fetch-site'];
  if (site && !['same-origin', 'none'].includes(site)) {
    throw new HttpError(403, 'طلب مرفوض (مصدر غير موثوق).');
  }
  const origin = req.headers.origin;
  if (origin) {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    let originHost = '';
    try {
      originHost = new URL(origin).host;
    } catch (e) {
      throw new HttpError(403, 'طلب مرفوض (مصدر غير صالح).');
    }
    if (originHost !== host) throw new HttpError(403, 'طلب مرفوض (مصدر غير موثوق).');
  }
}

/* تحديد المعدل (يعمل داخل نسخة الخادم الواحدة؛ حماية أساسية فقط) */
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.reset) {
    b = { count: 0, reset: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (now > v.reset) buckets.delete(k);
  }
  if (b.count > max) {
    throw new HttpError(429, 'محاولات كثيرة. انتظر قليلًا ثم حاول مرة أخرى.');
  }
}
function resetRateLimit(key) {
  buckets.delete(key);
}

/* ---------------- التحقق من المدخلات ---------------- */

function str(v, max, field) {
  if (v === undefined || v === null) return '';
  const s = String(v).trim();
  if (s.length > max) throw new HttpError(400, `الحقل ${field || ''} أطول من المسموح.`);
  return s;
}

function normalizeCode(v) {
  const s = str(v, 32, 'الكود');
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(s)) {
    throw new HttpError(400, 'الكود يجب أن يحتوي على حروف إنجليزية أو أرقام فقط.');
  }
  return s;
}

function studentEmail(code) {
  return `${String(code).toLowerCase()}@${STUDENT_EMAIL_DOMAIN}`;
}

function validPassword(p) {
  return typeof p === 'string' && p.length >= 6 && p.length <= 100;
}

function randomPassword() {
  const crypto = require('crypto');
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) out += chars[bytes[i] % chars.length];
  return out;
}

function validLevel(v) {
  const s = str(v, 40, 'الفرقة');
  if (!s) return LEVELS[0];
  if (s === 'الكل' || s === 'عام للجميع') return 'الكل';
  if (!LEVELS.includes(s)) throw new HttpError(400, 'اسم الفرقة غير معروف.');
  return s;
}

function validUrl(v) {
  const s = str(v, 500, 'الرابط');
  if (!s) return '';
  let u;
  try {
    u = new URL(s);
  } catch (e) {
    throw new HttpError(400, 'الرابط غير صالح.');
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new HttpError(400, 'الرابط يجب أن يبدأ بـ http أو https.');
  return u.toString();
}

/** اليوم بتوقيت القاهرة */
function cairoToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const year = get('year');
  const month = get('month');
  const day = get('day');
  return { year, month, day, iso: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` };
}

function docId(...parts) {
  return parts.map((p) => encodeURIComponent(String(p)).replace(/~/g, '%7E')).join('~');
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function ok(res, payload = {}, status = 200) {
  send(res, status, { ok: true, success: true, ...payload });
}

function fail(res, status, message) {
  send(res, status, { ok: false, success: false, message });
}

module.exports = {
  SESSION_COOKIE,
  SESSION_MAX_AGE_MS,
  LEVELS,
  HttpError,
  getFirebaseAdmin,
  setFirebaseForTests,
  readCookie,
  sessionCookieHeader,
  roleFromClaims,
  requireSession,
  requireRole,
  getBody,
  getPath,
  clientIp,
  assertSameOrigin,
  rateLimit,
  resetRateLimit,
  str,
  normalizeCode,
  studentEmail,
  validPassword,
  randomPassword,
  validLevel,
  validUrl,
  cairoToday,
  docId,
  send,
  ok,
  fail
};

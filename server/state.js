'use strict';
/**
 * مزامنة بيانات لوحة الإدارة (العمل أوف لاين ثم الدمج).
 *
 * كل "سجل" وثيقة مستقلة في المجموعة appRecords:
 *   path : members | servants | attendance | servants_attendance | master_plan | settings
 *   key  : معرّف السجل داخل المسار (id المخدوم، أو "التاريخ|id" للحضور...)
 *   data : نص JSON للسجل
 *   u    : وقت آخر تعديل (ms) حسب جهاز المستخدم بعد تصحيح فرق الساعة
 *   d    : 1 إذا كان السجل محذوفًا (Tombstone)
 *   s    : ترتيب وصول للخادم (يُستخدم للسحب التزايدي)
 *
 * الدمج: آخر تعديل يفوز لكل سجل على حدة. فتسجيل حضور جهازين لمخدومَين مختلفين
 * في نفس اليوم يندمجان معًا بدل أن يمحو أحدهما الآخر.
 */
const L = require('./lib');
const { HttpError } = L;

const COLLECTION = 'appRecords';
const BOTH = ['admin', 'servant'];
const PATHS = {
  members: { write: BOTH },
  attendance: { write: BOTH },
  servants_attendance: { write: BOTH },
  servants: { write: ['admin'] },
  master_plan: { write: ['admin'] },
  settings: { write: ['admin'] }
};
const MAX_RECORDS_PER_PUSH = 200;
const MAX_DATA_CHARS = 30000;
const MAX_PULL = 1000;
const FUTURE_SKEW_MS = 5 * 60 * 1000;

async function statePull(ctx) {
  const { db, query } = ctx;
  const since = Number(query.since) || 0;
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 500, 1), MAX_PULL);
  const snap = await db.collection(COLLECTION).where('s', '>', since).orderBy('s').limit(limit + 1).get();
  const docs = snap.docs.slice(0, limit);
  const more = snap.docs.length > limit;
  const records = docs.map((d) => {
    const r = d.data();
    let data = null;
    if (!r.d) {
      try {
        data = JSON.parse(r.data);
      } catch (e) {
        data = null;
      }
    }
    return { path: r.path, key: r.key, data, u: r.u, d: r.d ? 1 : 0, s: r.s };
  });
  const cursor = records.length ? records[records.length - 1].s : since;
  return { records, cursor, more, serverTime: L.nowMs() };
}

function cleanRecord(r) {
  if (!r || typeof r !== 'object') throw new HttpError(400, 'سجل غير صالح.');
  const path = String(r.path || '');
  if (!PATHS[path]) throw new HttpError(400, 'مسار غير معروف: ' + path.slice(0, 30));
  const key = String(r.key === undefined || r.key === null ? '' : r.key);
  if (!key || key.length > 150) throw new HttpError(400, 'مفتاح سجل غير صالح.');
  const u = Number(r.u);
  if (!Number.isFinite(u) || u <= 0) throw new HttpError(400, 'وقت التعديل غير صالح.');
  const deleted = r.d ? 1 : 0;
  let data = '';
  if (!deleted) {
    if (r.data === undefined || r.data === null || typeof r.data !== 'object') {
      throw new HttpError(400, 'بيانات السجل غير صالحة.');
    }
    data = JSON.stringify(r.data);
    if (data.length > MAX_DATA_CHARS) throw new HttpError(400, 'سجل أكبر من الحد المسموح.');
  }
  return { path, key, u, d: deleted, data };
}

async function statePush(ctx) {
  const { db, body, session } = ctx;
  const list = Array.isArray(body.records) ? body.records : [];
  if (!list.length) return { accepted: [], stale: [], rejected: [], serverTime: L.nowMs() };
  if (list.length > MAX_RECORDS_PER_PUSH) throw new HttpError(400, 'عدد السجلات في الطلب أكبر من المسموح.');

  const now = L.nowMs();
  const recs = list.map(cleanRecord).map((r) => ({ ...r, u: Math.min(r.u, now + FUTURE_SKEW_MS) }));
  const rejected = [];
  const allowed = [];
  for (const r of recs) {
    if (PATHS[r.path].write.includes(session.role)) allowed.push(r);
    else rejected.push({ path: r.path, key: r.key });
  }

  const accepted = [];
  const stale = [];
  if (allowed.length) {
    await db.runTransaction(async (tx) => {
      accepted.length = 0;
      stale.length = 0;
      const refs = allowed.map((r) => db.collection(COLLECTION).doc(L.docId(r.path, r.key)));
      const snaps = await Promise.all(refs.map((ref) => tx.get(ref)));
      allowed.forEach((r, i) => {
        const cur = snaps[i].exists ? snaps[i].data() : null;
        if (cur && cur.u > r.u) {
          let data = null;
          if (!cur.d) {
            try {
              data = JSON.parse(cur.data);
            } catch (e) {
              data = null;
            }
          }
          stale.push({ path: cur.path, key: cur.key, data, u: cur.u, d: cur.d ? 1 : 0 });
          return;
        }
        tx.set(refs[i], {
          path: r.path,
          key: r.key,
          data: r.data,
          u: r.u,
          d: r.d,
          s: now * 1000 + i,
          by: session.uid
        });
        accepted.push({ path: r.path, key: r.key });
      });
    });
  }
  return { accepted, stale, rejected, serverTime: L.nowMs() };
}

module.exports = { statePull, statePush, PATHS };

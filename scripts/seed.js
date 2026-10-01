'use strict';
/**
 * بيانات أولية اختيارية (مقررات ومشروعات تجريبية). لا تكتب فوق بيانات موجودة.
 *   node scripts/seed.js --yes
 */
require('./_env');
const { getFirebaseAdmin } = require('../server/lib');

(async () => {
  if (!process.argv.includes('--yes')) {
    console.log('أضف --yes للتأكيد. سيضيف مقررات ومشروعات نموذجية إذا كانت المجموعات فارغة.');
    return;
  }
  const { db } = getFirebaseAdmin();
  const subjects = [
    { title: 'حياة الصلاة', level: 'الفرقة الأولى', description: 'مبادئ الصلاة والحياة الروحية', sheet_url: '' },
    { title: 'مدخل إلى الكتاب المقدس', level: 'الفرقة الأولى', description: 'مقدمة في دراسة الكتاب المقدس', sheet_url: '' },
    { title: 'العقيدة', level: 'الفرقة الثانية', description: 'مبادئ العقيدة المسيحية', sheet_url: '' }
  ];
  const projects = [
    { title: 'مشروع قراءة الكتاب المقدس', date: '2026-10-01', level: 'الفرقة الأولى', points: 10, description: 'متابعة خطة القراءة اليومية وربط الإنجاز بالنقاط.' },
    { title: 'يوم روحي للخدمة', date: '2026-11-14', level: 'الكل', points: 15, description: 'نشاط روحي عام للمخدومين والخدام.' },
    { title: 'مهرجان الخدمة', date: '2026-12-19', level: 'الكل', points: 20, description: 'نشاط جماعي مرتبط بالحضور والإنجاز.' }
  ];
  for (const [col, items] of [['subjects', subjects], ['projects', projects]]) {
    const snap = await db.collection(col).limit(1).get();
    if (!snap.empty) {
      console.log(`${col}: موجودة مسبقًا — تم التخطي.`);
      continue;
    }
    for (const it of items) await db.collection(col).add({ ...it, createdAt: new Date() });
    console.log(`${col}: تمت إضافة ${items.length}.`);
  }
})().catch((e) => {
  console.error('فشل:', e.message);
  process.exit(1);
});

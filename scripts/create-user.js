'use strict';
/**
 * إنشاء حساب إدارة أو خادم.
 *   USER_EMAIL=... USER_PASSWORD=... USER_NAME="..." node scripts/create-user.js admin
 *   (أو servant)
 * يقرأ متغيرات Firebase من .env المحلي أو من البيئة.
 */
require('./_env');
const { getFirebaseAdmin } = require('../server/lib');

(async () => {
  const role = process.argv[2];
  if (!['admin', 'servant'].includes(role)) {
    console.error('الاستخدام: node scripts/create-user.js <admin|servant>');
    process.exit(1);
  }
  const email = (process.env.USER_EMAIL || '').trim().toLowerCase();
  const password = process.env.USER_PASSWORD || '';
  const name = process.env.USER_NAME || (role === 'admin' ? 'أمين الخدمة' : 'خادم');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.endsWith('@church.local')) {
    console.error('USER_EMAIL يجب أن يكون بريدًا إلكترونيًا حقيقيًا.');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('USER_PASSWORD يجب ألا يقل عن 8 أحرف.');
    process.exit(1);
  }

  const { auth } = getFirebaseAdmin();
  let user;
  try {
    user = await auth.getUserByEmail(email);
    await auth.updateUser(user.uid, { password, displayName: name });
    console.log('الحساب موجود — تم تحديث كلمة المرور والاسم.');
  } catch (e) {
    if (e.code !== 'auth/user-not-found') throw e;
    user = await auth.createUser({ email, password, displayName: name });
    console.log('تم إنشاء الحساب.');
  }
  await auth.setCustomUserClaims(user.uid, role === 'admin' ? { admin: true } : { servant: true });
  await auth.revokeRefreshTokens(user.uid);
  console.log(`تم ضبط الدور: ${role} للحساب ${email}`);
})().catch((e) => {
  console.error('فشل:', e.message);
  process.exit(1);
});

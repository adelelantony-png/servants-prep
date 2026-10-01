# خدمتي برو — الإصدار 3 (دخول حقيقي + قاعدة بيانات مشتركة)

منصة متابعة خدمة: قراءة الكتاب المقدس، النوتة الروحية، المقررات والشيتات، المشروعات، وحصاد المخدوم.
تعمل على **Vercel** (واجهات ثابتة + دالة API واحدة) و**Firebase** (Authentication + Firestore).

## ما الذي تغيّر عن النسخة التجريبية؟
- حُذف المحاكي المحلي (`DemoDB`) والدخول التلقائي كأدمن وكلمة المرور `1234567` المكتوبة في الكود.
- الدخول حقيقي: كوكي جلسة `HttpOnly + Secure + SameSite=Strict` يصدره الخادم، والصلاحيات تُفحص على الخادم في كل طلب.
- البيانات في Firestore فتظهر لكل الأجهزة (النقاط، القراءات، الشيتات...).
- دالة Vercel واحدة `api/[...path].js` (تتوافق مع حد 12 دالة في الخطة المجانية).
- حماية: CSRF (فحص Origin وSec-Fetch-Site)، تحديد معدل الدخول، تحقق صارم من المدخلات، CSP وHSTS، منع XSS في الصفحات المعدّلة.

## الأدوار
| الدور | كيف يدخل | ماذا يستطيع |
|---|---|---|
| مخدوم | الكود + كلمة المرور | بياناته فقط: قراءة، نوتة، شيتات، مشروعات، حصاد |
| خادم | البريد + كلمة المرور | قراءة قائمة المخدومين والإحصاءات |
| أمين الخدمة (admin) | البريد + كلمة المرور | كل شيء: مخدومون، خدام، شيتات، مشروعات، ترحيل، كلمات المرور |

حساب المخدوم يُنشأ داخليًا بالبريد `الكود@church.local` (لا يحتاج بريدًا حقيقيًا ولا يُرسل إليه شيء).

## خطوات التشغيل (مرة واحدة)

### 1) Firebase
1. أنشئ مشروعًا في https://console.firebase.google.com
2. **Authentication → Sign-in method** → فعّل **Email/Password**.
3. **Firestore Database** → Create database (وضع Production). ثم انسخ محتوى `firestore.rules` في تبويب Rules وانشره (يمنع أي وصول مباشر من المتصفح).
4. **Project settings → Service accounts → Generate new private key** (ملف JSON).
5. **Project settings → General** → انسخ **Web API Key**.

### 2) Vercel
أضف في Settings → Environment Variables:

| المتغير | القيمة |
|---|---|
| `FIREBASE_PROJECT_ID` | `project_id` من ملف JSON |
| `FIREBASE_CLIENT_EMAIL` | `client_email` من ملف JSON |
| `FIREBASE_PRIVATE_KEY` | `private_key` من ملف JSON (كما هو، بأسطره أو بـ `\n`) |
| `FIREBASE_WEB_API_KEY` | Web API Key |

ثم ارفع المشروع إلى GitHub واربطه بـ Vercel (Framework: Other، بدون Build Command).

### 3) إنشاء حساب أمين الخدمة الأول (من جهازك)
```bash
npm install
cp .env.example .env        # املأ القيم
USER_EMAIL=you@example.com USER_PASSWORD='كلمة-قوية-8+' USER_NAME='اسمك' npm run create-admin
npm run seed -- --yes        # اختياري: مقررات ومشروعات نموذجية
```
بعدها افتح الموقع → سجّل الدخول بالبريد → من **المقررات والشيتات** أضف الخدام والمخدومين.

## اختبار الخادم
```bash
npm test     # 33 اختبارًا على Firestore/Auth وهميين، بدون إنترنت
```

## مجموعات Firestore
`students`، `subjects`، `sheets`، `projects`، `participations`، `planReads`، `readingLogs`، `dailyLogs`، `sheetSubs`.

## ملاحظات مهمة / حدود معروفة
1. **لوحة `admin-dashboard.html`** (الحضور، الافتقاد، خطة السنة، الخدام المحلية...) ما زالت تحفظ بياناتها داخل متصفح المستخدم (localStorage). أُغلق بابها: لا تفتح إلا لأدمن/خادم بجلسة حقيقية، وأُزيلت كلمة المرور الثابتة (التأكيدات الحساسة تتحقق من كلمة مرور الأدمن على الخادم). لكن **بياناتها غير مشتركة بين الأجهزة** — نقلها إلى Firestore مرحلة قادمة.
2. تحديد المعدل يعمل داخل ذاكرة نسخة الخادم (حماية أساسية). للحماية الأقوى استخدم Upstash/Vercel KV.
3. ملفات HTML نفسها عامة (لا تحمل بيانات)؛ كل البيانات خلف الـ API المحمي.
4. ملفا `bible.json` و`bible_plan.json` مطلوبان لصفحتي الكتاب والخطة وغير موجودين في الحزمة؛ أضفهما بجانب الصفحات. وكذلك `notifier.js` / `sync_engine.js` أُزيل استدعاؤهما لأنهما غير موجودين.
5. أحداث الحضور بالباركود (`barcode.html`) تعرض الكود فقط؛ تسجيل الحضور يتم من لوحة الإدارة المحلية (انظر البند 1).

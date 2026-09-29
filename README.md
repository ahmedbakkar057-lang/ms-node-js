# MS HOST v7 — Node.js Hosting Panel

لوحة استضافة Node.js لإدارة حسابات المستخدمين، السيرفرات، الملفات، الخطط، ومفاتيح API.

## التشغيل

```bash
npm install
npm start
```

أو:

```bash
PORT=5000 node server.js
```

## بيانات الأدمن الافتراضية

- البريد الإلكتروني وكلمة المرور يتم ضبطهما عبر `ADMIN_EMAIL` و`ADMIN_PASSWORD` ولا يتم عرضهما في الواجهة العامة.

## متغيرات البيئة

- `PORT` — المنفذ، افتراضيًا `5000`
- `DB_FILE` — مسار قاعدة البيانات JSON
- `USERS_DIR` — مسار ملفات المستخدمين والسيرفرات
- `SECRET_KEY` — متاح للتوافق، والجلسات الحالية تستخدم كوكيز آمنة
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` — بيانات الأدمن
- `BOT_TOKEN` / `ADMIN_TELEGRAM_ID` — إشعارات تيليجرام

## استضافة تطبيقات Node.js

ينشئ المستخدم سيرفرًا، يرفع ملفات المشروع، ثم يحدد ملف التشغيل الرئيسي مثل `index.js` أو `server.js` أو `app.js`. عند التشغيل يستخدم النظام Node.js مع تمرير `PORT` و`SERVER_PORT` تلقائيًا. إذا وُجد `package.json` يتم تشغيل `npm install --omit=dev` تلقائيًا قبل تشغيل البوت، وتظهر مخرجات التثبيت وstdout وstderr وحالة انتهاء العملية داخل شاشة الأوامر.

## النشر

يستخدم `Procfile` الأمر:

```text
web: node server.js
```

## التسجيل العام

التسجيل العام مفعّل افتراضيًا. لتعطيله مؤقتًا استخدم `PUBLIC_REGISTRATION=false`، ولإعادته استخدم `PUBLIC_REGISTRATION=true`.

## Vercel

النسخة تدعم النشر على Vercel كلوحة تحكم وواجهات API عبر Express Function، وتستخدم مجلد `public/` للصفحات. اضبط `ADMIN_EMAIL` و`ADMIN_PASSWORD` و`PUBLIC_REGISTRATION` في Environment Variables.

> Vercel مناسب للوحة التحكم والـ API، لكنه لا يشغّل بوتات Node.js دائمة ولا يضمن حفظ الملفات؛ لتشغيل البوتات استخدم VPS أو Render أو Railway. راجع `VERCEL.md`.

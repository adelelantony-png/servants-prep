/*
 * خدمتي برو — عميل المصادقة (المتصفح)
 *
 * - الجلسة الحقيقية كوكي HttpOnly يضعه الخادم؛ لا يمكن لأي سكربت قراءتها.
 * - localStorage يُستخدم للعرض فقط (الاسم، النقاط...) وليس دليل صلاحية.
 *   كل API يتحقق من الجلسة والدور على الخادم.
 *
 * طريقة الاستخدام داخل الصفحات:
 *   <script src="auth-client.js"></script>                       // أي مستخدم مسجّل
 *   <script src="auth-client.js" data-require="staff"></script>  // أدمن أو خادم
 *   <script src="auth-client.js" data-require="admin"></script>  // أدمن فقط
 *   <script src="auth-client.js" data-require="none"></script>   // صفحة عامة (الدخول)
 */
(function () {
  'use strict';

  var script = document.currentScript;
  var REQUIRE = (script && script.getAttribute('data-require')) || 'any';
  var LOGIN_URL = 'login.html';
  var HOME_URL = 'index.html';
  var CACHE_KEYS = [
    'student_code',
    'student_name',
    'student_level',
    'student_points',
    'user_role',
    'my_church_active_user'
  ];

  var session = null;

  function clearCache() {
    CACHE_KEYS.forEach(function (k) {
      try {
        localStorage.removeItem(k);
        sessionStorage.removeItem(k);
      } catch (e) {}
    });
  }

  function cacheSession(p) {
    try {
      localStorage.setItem('student_code', p.code || p.role);
      localStorage.setItem('student_name', p.name || '');
      localStorage.setItem('student_level', p.level || '');
      localStorage.setItem('student_points', String(p.points || 0));
      localStorage.setItem('user_role', p.role);
      if (p.role === 'admin' || p.role === 'servant') {
        // تستخدمه لوحة الإدارة لمعرفة المستخدم الحالي (للعرض فقط)
        localStorage.setItem(
          'my_church_active_user',
          JSON.stringify({
            id: p.uid,
            name: p.name || '',
            phone: '',
            code: p.role,
            role: p.role,
            permission: p.role === 'admin' ? 'admin' : 'full',
            roleType: p.role === 'admin' ? 'أمين خدمة عام' : 'خادم'
          })
        );
      } else {
        localStorage.removeItem('my_church_active_user');
        sessionStorage.removeItem('my_church_active_user');
      }
    } catch (e) {}
  }

  function cachedSession() {
    var code = localStorage.getItem('student_code');
    if (!code) return null;
    return {
      role: localStorage.getItem('user_role') || 'student',
      code: code,
      name: localStorage.getItem('student_name') || '',
      level: localStorage.getItem('student_level') || '',
      points: Number(localStorage.getItem('student_points') || 0),
      offline: true
    };
  }

  function onLoginPage() {
    return /\/login\.html$/i.test(location.pathname);
  }

  function goLogin() {
    if (!onLoginPage()) location.replace(LOGIN_URL);
  }

  function reveal() {
    document.documentElement.style.visibility = '';
  }

  function allowed(role) {
    if (REQUIRE === 'admin') return role === 'admin';
    if (REQUIRE === 'staff') return role === 'admin' || role === 'servant';
    return true;
  }

  /** طلب API مع الكوكي. عند 401 تُمسح الجلسة المحلية ويُحوَّل المستخدم لصفحة الدخول. */
  function apiFetch(url, options) {
    options = Object.assign({}, options);
    options.credentials = 'same-origin';
    var headers = new Headers(options.headers || {});
    if (typeof options.body === 'string' && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    options.headers = headers;
    return fetch(url, options).then(function (res) {
      if (res.status === 401) {
        clearCache();
        goLogin();
      }
      return res;
    });
  }

  function json(res) {
    return res.json().catch(function () {
      return { success: false, message: 'استجابة غير متوقعة من الخادم.' };
    });
  }

  function post(url, body) {
    return apiFetch(url, { method: 'POST', body: JSON.stringify(body || {}) }).then(json);
  }

  /* ---------- تحميل الجلسة والتحقق منها ---------- */

  if (REQUIRE !== 'none') document.documentElement.style.visibility = 'hidden';

  var ready = (function () {
    if (REQUIRE === 'none') return Promise.resolve(null);
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl
      ? setTimeout(function () {
          ctrl.abort();
        }, 8000)
      : null;
    return fetch('/api/me', { credentials: 'same-origin', cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
      .then(function (res) {
        if (timer) clearTimeout(timer);
        if (res.status === 401 || res.status === 403) {
          clearCache();
          goLogin();
          return null;
        }
        return res.json().then(function (j) {
          if (!j || !j.success) throw new Error('bad response');
          session = j.data;
          cacheSession(session);
          if (!allowed(session.role)) {
            location.replace(HOME_URL);
            return null;
          }
          reveal();
          return session;
        });
      })
      .catch(function () {
        if (timer) clearTimeout(timer);
        // لا يوجد اتصال: نعرض الصفحة من البيانات المحفوظة (الخادم يرفض أي عملية بدون جلسة)
        var c = cachedSession();
        if (c && allowed(c.role)) {
          session = c;
          reveal();
          return c;
        }
        clearCache();
        goLogin();
        return null;
      });
  })();

  /* ---------- واجهة عامة ---------- */

  function login(identifier, password) {
    return fetch('/api/auth-login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: identifier, password: password })
    })
      .catch(function () {
        throw new Error('تعذر الاتصال بالخادم. تأكد من الإنترنت وحاول مرة أخرى.');
      })
      .then(json)
      .then(function (j) {
        if (!j.success) throw new Error(j.message || 'تعذر تسجيل الدخول.');
        session = j.data;
        cacheSession(session);
        return session;
      });
  }

  function logout() {
    return fetch('/api/auth-logout', { method: 'POST', credentials: 'same-origin' })
      .catch(function () {})
      .then(function () {
        clearCache();
        session = null;
        location.replace(LOGIN_URL);
      });
  }

  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** رابط آمن: http/https فقط */
  function safeUrl(u) {
    try {
      var x = new URL(u, location.href);
      return x.protocol === 'http:' || x.protocol === 'https:' ? x.href : '#';
    } catch (e) {
      return '#';
    }
  }

  window.ChurchAuth = {
    fetch: apiFetch,
    post: post,
    ready: ready,
    session: function () {
      return session;
    },
    login: login,
    logout: logout,
    clear: logout,
    verifyPassword: function (password) {
      return apiFetch('/api/verify-password', { method: 'POST', body: JSON.stringify({ password: password }) })
        .then(json)
        .then(function (j) {
          return j.success === true;
        })
        .catch(function () {
          return false;
        });
    },
    changePassword: function (currentPassword, newPassword) {
      return post('/api/change-password', { currentPassword: currentPassword, newPassword: newPassword }).then(function (j) {
        if (j.success) clearCache();
        return j;
      });
    },
    esc: esc,
    safeUrl: safeUrl
  };
})();

window.ChurchAuth = {
    ready: new Promise(function(resolve) {
        // فحص الذاكرة المحلية لمعرفة ما إذا كان المستخدم مسجلاً
        var sessionRaw = localStorage.getItem('church_auth_session');
        
        if (sessionRaw && sessionRaw !== "null" && sessionRaw !== "undefined") {
            try {
                var session = JSON.parse(sessionRaw);
                if (session && session.role) {
                    resolve(session);
                    return;
                }
            } catch(e) {}
        }
        
        // إذا لم يكن هناك جلسة صالحة، نقوم بتحويله لصفحة الدخول (إلا إذا كان فيها بالفعل لمنع الرقص)
        if (!window.location.href.includes('login.html')) {
            window.location.replace('login.html');
        } else {
            resolve(null);
        }
    }),
    logout: function() {
        localStorage.removeItem('church_auth_session');
        window.location.replace('login.html');
    }
};

window.ChurchAuth = {
    ready: new Promise(function(resolve) {
        // قراءة الجلسة من الذاكرة (سواء تم حفظها باسم user أو church_auth_session)
        var sessionRaw = localStorage.getItem('church_auth_session') || localStorage.getItem('user');
        
        if (sessionRaw && sessionRaw !== "null" && sessionRaw !== "undefined") {
            try {
                var session = JSON.parse(sessionRaw);
                // التأكد من أن الجلسة صالحة وتحتوي على دور (role)
                if (session && (session.role || session.permission)) {
                    // توحيد المسميات لضمان التوافق مع Vercel
                    if(!session.role && session.permission) session.role = session.permission;
                    resolve(session);
                    return;
                }
            } catch(e) {
                console.error("خطأ في قراءة الجلسة:", e);
            }
        }
        
        // إذا لم يجد جلسة، يرجع null لتتعامل معها الصفحة بهدوء
        resolve(null);
    }),
    
    logout: function() {
        // تنظيف شامل وتسجيل خروج
        localStorage.removeItem('church_auth_session');
        localStorage.removeItem('user');
        sessionStorage.clear();
        window.location.replace('login.html');
    }
};

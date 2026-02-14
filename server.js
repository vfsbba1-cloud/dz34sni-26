/**
 * 2AO Selfie Server
 * Deploy on Render: https://dz34sni-26.onrender.com
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
        cookies: body.cookies || '',
        userAgent: body.userAgent || '',
        pageUrl: body.pageUrl || '',
        verificationToken: body.verificationToken || '',
        timestamp: body.timestamp || Date.now()
    };

    console.log(`[TASK] 📥 ${code}: userId=${body.userId.substring(0, 20)}... realIp=${body.realIp || 'none'}`);
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
    const { userId, transactionId, realIp, code, phone } = req.query;
    const clientCode = code || phone || '';
    
    const escJs = (s) => (s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/</g, '\\x3c').replace(/>/g, '\\x3e');
    const uid = escJs(userId);
    const tid = escJs(transactionId);
    const ip = escJs(realIp);
    const cd = escJs(clientCode);

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

<script>
try { history.replaceState({}, '', '/dza/appointment/LivenessRequest'); } catch(e) {}
</script>

<script>
(function(){
    var REAL_IP = '${ip}';
    if (!REAL_IP) return;
    function isOzApi(u){ return typeof u==='string' && u.indexOf('ozforensics.com')!==-1 && u.indexOf('web-sdk.prod.cdn')===-1 && u.indexOf('.php')===-1 && u.indexOf('.js')===-1; }
    var _f = window.fetch;
    window.fetch = function(u, o) {
        o = o || {};
        if (isOzApi(u)) {
            if (!o.headers) o.headers = {};
            if (o.headers instanceof Headers) {
                o.headers.set('X-Forwarded-For', REAL_IP);
                o.headers.set('X-Real-IP', REAL_IP);
            } else {
                o.headers['X-Forwarded-For'] = REAL_IP;
                o.headers['X-Real-IP'] = REAL_IP;
            }
        }
        return _f.call(this, u, o);
    };
    var _xo = XMLHttpRequest.prototype.open;
    var _xs = XMLHttpRequest.prototype.send;
    var _xh = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function(m, u) { this._dzUrl = u; return _xo.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function() {
        if (isOzApi(this._dzUrl)) {
            try { _xh.call(this, 'X-Forwarded-For', REAL_IP); } catch(e) {}
            try { _xh.call(this, 'X-Real-IP', REAL_IP); } catch(e) {}
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

<script src="https://web-sdk.prod.cdn.spain.ozforensics.com/blsinternational/plugin_liveness.php"></script>

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
            OzLiveness.open({
                lang: 'en',
                meta: { 'user_id': '${uid}', 'transaction_id': '${tid}' },
                overlay_options: false,
                action: ['video_selfie_blank'],
                result_mode: 'safe',
                on_complete: function(r) {
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
                },
                on_error: function(e) {
                    var msg = e && e.message ? e.message : String(e);
                    document.getElementById('st').textContent = 'Erreur: ' + msg;
                    if (window.Android) window.Android.onSelfieError(msg);
                }
            });
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
        version: '1.0',
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
    console.log(`\n🔥 2AO Selfie Server v1.0`);
    console.log(`   Port: ${PORT}`);
    console.log(`   Ready!\n`);
});

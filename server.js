/**
 * DZ34SNI Server — Complete
 * Deploy on Render: https://dz34sni-26.onrender.com
 * 
 * Flow:
 * 1. Extension (agent) captures userId + transactionId from BLS liveness page
 * 2. Extension POSTs task to /task/:phone
 * 3. APK (client) polls GET /task/:phone → receives task
 * 4. APK navigates to GET /oz-page?... → loads OZ SDK → does selfie
 * 5. APK POSTs result to /result/:phone
 * 6. Extension polls GET /result/:phone → gets event_session_id → injects into page
 * 7. Extension DELETEs /clear/:phone → cleanup
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

// Request logging
app.use((req, res, next) => {
    const ts = new Date().toISOString().substring(11, 19);
    console.log(`[${ts}] ${req.method} ${req.path}`);
    next();
});

// ═══════════════════════════════════════════
// IN-MEMORY STORAGE
// ═══════════════════════════════════════════
// tasks[phone] = { userId, transactionId, realIp, cookies, userAgent, pageUrl, verificationToken, timestamp }
const tasks = {};
// results[phone] = { event_session_id, status, realIp, timestamp }
const results = {};

// Auto-cleanup: remove entries older than 30 minutes
setInterval(() => {
    const now = Date.now();
    const MAX_AGE = 30 * 60 * 1000; // 30 min
    for (const phone in tasks) {
        if (now - (tasks[phone].timestamp || 0) > MAX_AGE) {
            delete tasks[phone];
            console.log(`[CLEANUP] Task removed: ${phone}`);
        }
    }
    for (const phone in results) {
        if (now - (results[phone].timestamp || 0) > MAX_AGE) {
            delete results[phone];
            console.log(`[CLEANUP] Result removed: ${phone}`);
        }
    }
}, 5 * 60 * 1000); // every 5 min

// ═══════════════════════════════════════════
// ROUTES: TASK (Extension → APK)
// ═══════════════════════════════════════════

/**
 * POST /task/:phone — Extension sends a liveness task
 * Body: { userId, transactionId, realIp, cookies, userAgent, pageUrl, verificationToken, timestamp }
 */
app.post('/task/:phone', (req, res) => {
    const phone = req.params.phone;
    const body = req.body || {};
    
    if (!body.userId || !body.transactionId) {
        return res.status(400).json({ ok: false, error: 'Missing userId or transactionId' });
    }

    tasks[phone] = {
        userId: body.userId,
        transactionId: body.transactionId,
        realIp: body.realIp || '',
        cookies: body.cookies || '',
        userAgent: body.userAgent || '',
        pageUrl: body.pageUrl || '',
        verificationToken: body.verificationToken || '',
        timestamp: body.timestamp || Date.now()
    };

    console.log(`[TASK] 📥 ${phone}: userId=${body.userId.substring(0, 20)}... realIp=${body.realIp || 'none'}`);
    res.json({ ok: true });
});

/**
 * GET /task/:phone — APK polls for pending task
 */
app.get('/task/:phone', (req, res) => {
    const phone = req.params.phone;
    const task = tasks[phone];

    if (task) {
        console.log(`[TASK] 📤 ${phone}: sending task`);
        // Don't delete yet — APK might need to re-fetch
        res.json({ ok: true, task: task });
    } else {
        res.json({ ok: false, task: null });
    }
});

// ═══════════════════════════════════════════
// ROUTES: RESULT (APK → Extension)
// ═══════════════════════════════════════════

/**
 * POST /result/:phone — APK sends selfie result
 * Body: { event_session_id, status, realIp, timestamp }
 */
app.post('/result/:phone', (req, res) => {
    const phone = req.params.phone;
    const body = req.body || {};

    if (!body.event_session_id) {
        return res.status(400).json({ ok: false, error: 'Missing event_session_id' });
    }

    results[phone] = {
        event_session_id: body.event_session_id,
        status: body.status || 'completed',
        realIp: body.realIp || '',
        timestamp: body.timestamp || Date.now()
    };

    // Clear the task since it's been completed
    delete tasks[phone];

    console.log(`[RESULT] ✅ ${phone}: session=${body.event_session_id.substring(0, 20)}...`);
    res.json({ ok: true });
});

/**
 * GET /result/:phone — Extension polls for selfie result
 */
app.get('/result/:phone', (req, res) => {
    const phone = req.params.phone;
    const result = results[phone];

    if (result) {
        console.log(`[RESULT] 📤 ${phone}: sending result`);
        res.json({ ok: true, result: result });
    } else {
        res.json({ ok: false, result: null });
    }
});

// ═══════════════════════════════════════════
// ROUTES: CLEANUP
// ═══════════════════════════════════════════

/**
 * DELETE /clear/:phone — Extension clears data after injection
 */
app.delete('/clear/:phone', (req, res) => {
    const phone = req.params.phone;
    delete tasks[phone];
    delete results[phone];
    console.log(`[CLEAR] 🗑️ ${phone}`);
    res.json({ ok: true });
});

// ═══════════════════════════════════════════
// ROUTE: OZ-PAGE (APK loads this for real selfie)
// ═══════════════════════════════════════════

/**
 * GET /oz-page — Serves the OZ liveness HTML page
 * The APK WebView loads this page. shouldInterceptRequest in the APK
 * intercepts the SDK script and prepends origin spoofing code.
 * 
 * Query params: userId, transactionId, realIp, phone
 */
app.get('/oz-page', (req, res) => {
    const { userId, transactionId, realIp, phone } = req.query;
    
    // Escape for safe HTML/JS embedding
    const escJs = (s) => (s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/</g, '\\x3c').replace(/>/g, '\\x3e');
    const uid = escJs(userId);
    const tid = escJs(transactionId);
    const ip = escJs(realIp);
    const ph = escJs(phone);

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>BLS Liveness Check</title>
<style>
body { margin: 0; background: #fff; font-family: 'Segoe UI', Arial, sans-serif; }
#st {
    position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
    background: rgba(0,0,0,.85); color: #fff; padding: 12px 24px; border-radius: 10px;
    font-size: 14px; z-index: 99999; text-align: center; font-weight: 600;
    box-shadow: 0 4px 20px rgba(0,0,0,.3);
}
</style>
</head>
<body>
<div id="oz-container"></div>
<div id="st">Chargement SDK...</div>

<!-- URL bar spoof -->
<script>
try { history.replaceState({}, '', '/dza/appointment/LivenessRequest'); } catch(e) {}
</script>

<!-- Patch fetch/XHR for X-Forwarded-For on OZ POST requests (video upload) -->
<script>
(function(){
    var REAL_IP = '${ip}';
    if (!REAL_IP) return;
    
    var _f = window.fetch;
    window.fetch = function(u, o) {
        o = o || {};
        if (typeof u === 'string' && u.indexOf('ozforensics.com') !== -1) {
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
        if (this._dzUrl && this._dzUrl.indexOf('ozforensics.com') !== -1) {
            try { _xh.call(this, 'X-Forwarded-For', REAL_IP); } catch(e) {}
            try { _xh.call(this, 'X-Real-IP', REAL_IP); } catch(e) {}
        }
        return _xs.apply(this, arguments);
    };
})();
</script>

<!-- Form for compatibility -->
<form id="formLiveness" method="post" action="/dza/appointment/LivenessResponse">
    <input type="hidden" name="event_session_id" id="event_session_id" value="">
    <input type="hidden" name="LivenessId" id="LivenessId" value="">
    <input type="hidden" name="__RequestVerificationToken" value="">
</form>

<!-- Load OZ SDK -->
<!-- APK's shouldInterceptRequest will intercept this request, -->
<!-- prepend origin spoofing JS, and proxy it with correct headers -->
<script src="https://web-sdk.prod.cdn.spain.ozforensics.com/blsinternational/plugin_liveness.php"></script>

<!-- Launch liveness after SDK loads -->
<script>
window.addEventListener('load', function() {
    document.getElementById('st').textContent = 'Lancement...';
    setTimeout(function() {
        try {
            if (typeof OzLiveness === 'undefined') {
                document.getElementById('st').textContent = 'SDK non chargé';
                if (window.Android) window.Android.onSelfieError('SDK not loaded');
                return;
            }
            document.getElementById('st').textContent = 'Démarrage selfie...';
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
                        if (window.Android) window.Android.onSelfieComplete(sid);
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
        service: 'DZ34SNI',
        version: '2.0',
        status: 'running',
        activeTasks: Object.keys(tasks).length,
        activeResults: Object.keys(results).length,
        uptime: Math.floor(process.uptime()) + 's'
    });
});

app.get('/health', (req, res) => {
    res.json({ ok: true, timestamp: Date.now() });
});

// Debug: list all active entries
app.get('/debug', (req, res) => {
    res.json({
        tasks: Object.keys(tasks).map(p => ({ phone: p, userId: (tasks[p].userId || '').substring(0, 10) + '...', age: Math.floor((Date.now() - tasks[p].timestamp) / 1000) + 's' })),
        results: Object.keys(results).map(p => ({ phone: p, sessionId: (results[p].event_session_id || '').substring(0, 10) + '...', age: Math.floor((Date.now() - results[p].timestamp) / 1000) + 's' }))
    });
});

// ═══════════════════════════════════════════
// START
// ═══════════════════════════════════════════
app.listen(PORT, () => {
    console.log(`\n🐉 DZ34SNI Server v2.0`);
    console.log(`   Port: ${PORT}`);
    console.log(`   Ready!\n`);
});

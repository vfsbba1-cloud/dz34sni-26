const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

const store = {};

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "DZ34SNI Relay", clients: Object.keys(store).length, time: new Date().toISOString() });
});

// ═══ EXTENSION → SERVER: Post liveness task ═══
app.post("/task/:phone", (req, res) => {
  const phone = req.params.phone;
  if (!phone) return res.status(400).json({ error: "phone required" });
  if (!store[phone]) store[phone] = {};
  store[phone].task = req.body;
  store[phone].taskTime = Date.now();
  delete store[phone].result;
  delete store[phone].resultTime;
  console.log(`[TASK] ${phone} — userId: ${req.body.userId}`);
  res.json({ ok: true, phone });
});

// ═══ APK → SERVER: Get pending task ═══
app.get("/task/:phone", (req, res) => {
  const phone = req.params.phone;
  const entry = store[phone];
  if (!entry || !entry.task) return res.json({ ok: false, task: null });
  res.json({ ok: true, task: entry.task });
});

// ═══ APK → SERVER: Post selfie result ═══
app.post("/result/:phone", (req, res) => {
  const phone = req.params.phone;
  if (!phone) return res.status(400).json({ error: "phone required" });
  if (!store[phone]) store[phone] = {};
  store[phone].result = req.body;
  store[phone].resultTime = Date.now();
  console.log(`[RESULT] ${phone} — session: ${req.body.event_session_id}`);
  res.json({ ok: true, phone });
});

// ═══ EXTENSION → SERVER: Get selfie result ═══
app.get("/result/:phone", (req, res) => {
  const phone = req.params.phone;
  const entry = store[phone];
  if (!entry || !entry.result) return res.json({ ok: false, result: null });
  res.json({ ok: true, result: entry.result });
});

app.delete("/clear/:phone", (req, res) => {
  delete store[req.params.phone];
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════
// ═══ NEW: OZ LIVENESS PAGE — served as real HTML ═══
// APK navigates to: /oz-page?userId=X&transactionId=Y&realIp=Z&phone=P
// ═══════════════════════════════════════════════════════════════
app.get("/oz-page", (req, res) => {
  const { userId, transactionId, realIp, phone } = req.query;
  if (!userId || !transactionId) {
    return res.status(400).send("Missing userId or transactionId");
  }

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
  <title>BLS Liveness</title>
  <style>
    body{margin:0;background:#fff;font-family:Arial,sans-serif}
    #st{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);
        background:rgba(0,0,0,.8);color:#fff;padding:10px 20px;
        border-radius:8px;font-size:14px;z-index:99999;text-align:center}
  </style>
</head>
<body>
<div id="oz-container"></div>
<div id="st">Chargement SDK...</div>

<script>
// Spoof history to look like BLS page
try { history.replaceState(null, "", "/dza/appointment/liveness"); } catch(e){}
</script>

<form id="formLiveness" method="post" action="/dza/appointment/liveness">
  <input type="hidden" name="event_session_id" id="event_session_id" value="">
  <input type="hidden" name="__RequestVerificationToken" value="x">
</form>

<script src="https://web-sdk.prod.cdn.spain.ozforensics.com/blsinternational/plugin_liveness.php"></script>
<script>
window.addEventListener("load", function(){
  document.getElementById("st").textContent = "Lancement...";
  
  // Try multiple times with increasing delay
  var attempts = 0;
  var maxAttempts = 10;
  
  function tryLaunch() {
    attempts++;
    document.getElementById("st").textContent = "Lancement... (" + attempts + ")";
    
    if (typeof OzLiveness !== "undefined") {
      document.getElementById("st").textContent = "SDK OK - Démarrage caméra...";
      OzLiveness.open({
        lang: "en",
        meta: {
          "user_id": "${userId}",
          "transaction_id": "${transactionId}"
        },
        overlay_options: false,
        action: ["video_selfie_blank"],
        result_mode: "safe",
        on_complete: function(r) {
          var s = r && r.event_session_id ? r.event_session_id : "";
          if (s) {
            document.getElementById("st").textContent = "✅ OK: " + s.substring(0,8) + "...";
            if (window.Android) window.Android.onSelfieComplete(s);
          } else {
            document.getElementById("st").textContent = "❌ No session ID";
            if (window.Android) window.Android.onSelfieError("No session ID");
          }
        },
        on_error: function(e) {
          document.getElementById("st").textContent = "❌ " + (e.message || e);
          if (window.Android) window.Android.onSelfieError(e.message || String(e));
        }
      });
    } else if (attempts < maxAttempts) {
      setTimeout(tryLaunch, 2000);
    } else {
      document.getElementById("st").textContent = "❌ SDK non chargé après " + attempts + " tentatives";
      if (window.Android) window.Android.onSelfieError("SDK not loaded after " + attempts + " attempts");
    }
  }
  
  setTimeout(tryLaunch, 2000);
});
</script>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

// Auto-cleanup
setInterval(() => {
  const now = Date.now();
  const TTL = 10 * 60 * 1000;
  for (const phone in store) {
    const entry = store[phone];
    const lastActivity = Math.max(entry.taskTime || 0, entry.resultTime || 0);
    if (now - lastActivity > TTL) { delete store[phone]; console.log(`[CLEANUP] ${phone}`); }
  }
}, 60000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`DZ34SNI Relay on port ${PORT}`); });

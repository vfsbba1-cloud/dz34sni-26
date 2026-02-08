const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

// ═══ In-memory store ═══
// Key: phone number
// Value: { task: {...}, result: {...}, taskTime: Date, resultTime: Date }
const store = {};

// ═══ HEALTH CHECK ═══
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "DZ34SNI Relay",
    clients: Object.keys(store).length,
    time: new Date().toISOString()
  });
});

// ═══ EXTENSION → SERVER: Post liveness task ═══
// POST /task/:phone
app.post("/task/:phone", (req, res) => {
  const phone = req.params.phone;
  if (!phone) return res.status(400).json({ error: "phone required" });

  if (!store[phone]) store[phone] = {};
  store[phone].task = req.body;
  store[phone].taskTime = Date.now();
  // Clear any old result when new task arrives
  delete store[phone].result;
  delete store[phone].resultTime;

  console.log(`[TASK] ${phone} — userId: ${req.body.userId}`);
  res.json({ ok: true, phone });
});

// ═══ APK → SERVER: Get pending task ═══
// GET /task/:phone
app.get("/task/:phone", (req, res) => {
  const phone = req.params.phone;
  const entry = store[phone];

  if (!entry || !entry.task) {
    return res.json({ ok: false, task: null });
  }

  res.json({ ok: true, task: entry.task });
});

// ═══ APK → SERVER: Post selfie result ═══
// POST /result/:phone
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
// GET /result/:phone
app.get("/result/:phone", (req, res) => {
  const phone = req.params.phone;
  const entry = store[phone];

  if (!entry || !entry.result) {
    return res.json({ ok: false, result: null });
  }

  res.json({ ok: true, result: entry.result });
});

// ═══ DELETE task+result after consumption ═══
// DELETE /clear/:phone
app.delete("/clear/:phone", (req, res) => {
  const phone = req.params.phone;
  delete store[phone];
  res.json({ ok: true });
});

// ═══ Auto-cleanup: remove entries older than 10 minutes ═══
setInterval(() => {
  const now = Date.now();
  const TTL = 10 * 60 * 1000; // 10 min
  for (const phone in store) {
    const entry = store[phone];
    const lastActivity = Math.max(entry.taskTime || 0, entry.resultTime || 0);
    if (now - lastActivity > TTL) {
      delete store[phone];
      console.log(`[CLEANUP] ${phone} expired`);
    }
  }
}, 60000);

// ═══ START ═══
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`DZ34SNI Relay running on port ${PORT}`);
});

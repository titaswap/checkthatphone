const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
const { ProxyAgent } = require('proxy-agent');

const app = express();
const PORT = process.env.PORT || 8888;

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// User-Agent Pool for Fingerprint Rotation
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/120.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/605.1.15"
];

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Phone lookup proxy ───────────────────────────────────────────────────────
app.post('/api/check-phone', async (req, res) => {
  const { phone, turnstileToken, clientUserAgent, proxy } = req.body;

  if (!phone) return res.status(400).json({ error: "Phone number is required" });
  if (!turnstileToken) return res.status(400).json({ error: "Turnstile verification token is missing" });

  const cleanedPhone = phone.replace(/\D/g, '');
  const userAgent = clientUserAgent || req.headers['user-agent'] || USER_AGENTS[0];

  const fetchOptions = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": userAgent,
      "Accept": "*/*",
      "Origin": "https://checkthatphone.com",
      "Referer": "https://checkthatphone.com/"
    },
    body: JSON.stringify({ phone: cleanedPhone, turnstileToken })
  };

  if (proxy) {
    fetchOptions.agent = new ProxyAgent(proxy);
  }

  try {
    const response = await fetch("https://api.checkthatphone.com/v1/lookup-demo", fetchOptions);
    const status = response.status;
    const responseText = await response.text();
    let data;
    try { data = JSON.parse(responseText); }
    catch (e) { data = { error: "Failed to parse API response", raw: responseText }; }
    res.status(status).json(data);
  } catch (error) {
    console.error("Backend proxy error:", error);
    res.status(500).json({ error: "Internal server error occurred while connecting to validation service" });
  }
});

// ─── Global shared token pool ─────────────────────────────────────────────────
// Tokens are solved locally by background Chrome tabs (reliable, fast).
// The API calls go through rotating proxies independently — rate limit is IP-based
// on the API side, not on the token-solving side.
let globalTokens = [];     // { token, userAgent, timestamp }
let pendingResolvers = []; // resolve functions waiting for a token

app.post('/api/submit-token', (req, res) => {
  const { token, userAgent } = req.body;
  if (!token) return res.status(400).send("No token");

  const payload = { token, userAgent: userAgent || '', timestamp: Date.now() };

  if (pendingResolvers.length > 0) {
    const resolve = pendingResolvers.shift();
    resolve(payload);
  } else {
    globalTokens.push(payload);
    if (globalTokens.length > 500) globalTokens.shift();
  }
  res.sendStatus(200);
});

// Endpoint for CLI to monitor pool size during pre-warm
app.get('/api/token-stats', (req, res) => {
  const now = Date.now();
  // Clear expired first so stats are accurate
  globalTokens = globalTokens.filter(t => (now - t.timestamp) < 110000);
  res.json({ buffered: globalTokens.length });
});

app.get('/api/get-token', async (req, res) => {
  const now = Date.now();
  // Discard tokens older than 110s (Cloudflare tokens expire at 120s)
  globalTokens = globalTokens.filter(t => (now - t.timestamp) < 110000);

  if (globalTokens.length > 0) {
    return res.json(globalTokens.shift());
  }

  // Long poll — wait up to 90s for a background solver tab to submit a token.
  // 90s is chosen to survive Cloudflare's throttle window (~90s) without timing out.
  new Promise((resolve) => {
    pendingResolvers.push(resolve);
    setTimeout(() => {
      const idx = pendingResolvers.indexOf(resolve);
      if (idx !== -1) { pendingResolvers.splice(idx, 1); resolve(null); }
    }, 90000);
  }).then(payload => {
    if (payload) res.json(payload);
    else res.status(503).json({ error: "Timeout waiting for token" });
  });
});

// ─── Token pool stats (for debugging) ────────────────────────────────────────
app.get('/api/token-stats', (req, res) => {
  res.json({
    buffered: globalTokens.length,
    waiting: pendingResolvers.length
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running at http://checkthatphone.com:${PORT}/`);
});

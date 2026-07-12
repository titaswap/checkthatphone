const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');
const fetch = require('node-fetch');
const { ProxyAgent } = require('proxy-agent');

// Configuration
const SERVER_URL = 'http://127.0.0.1:8888';
const INPUT_FILE = path.join(__dirname, 'phone_lists.txt');
const OUTPUT_FILE = path.join(__dirname, 'results.csv');
const PROXY_FILE = path.join(__dirname, 'valid_proxies.txt');

// Standard Windows paths for Google Chrome
const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.USERPROFILE || 'C:', 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe')
];

// Sleep helper
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Get formatted current time [HH:MM:SS AM/PM]
function getTimestamp() {
  const now = new Date();
  let hours = now.getHours();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  hours = hours ? hours : 12; // the hour '0' should be '12'
  const h = String(hours).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  return `\x1b[90m[${h}:${m}:${s} ${ampm}]\x1b[0m`;
}

// Helper to extract raw IP address from proxy string (ignoring port, protocol, credentials)
function getProxyIp(proxyStr) {
  if (!proxyStr) return null;
  let urlStr = proxyStr;
  if (!urlStr.includes('://')) {
    urlStr = 'socks5://' + urlStr;
  }
  try {
    const parsed = new URL(urlStr);
    return parsed.hostname;
  } catch (e) {
    const match = proxyStr.match(/(?:@|^)([^:]+):/);
    return match ? match[1] : proxyStr;
  }
}

// Global IP usage tracking for cooldown
const lastUsedIpTimes = new Map();

// Find chrome.exe
let chromePath = null;
for (const p of CHROME_PATHS) {
  if (fs.existsSync(p)) {
    chromePath = p;
    break;
  }
}

// Test if proxy can reach Cloudflare (enough to confirm it works for API calls)
const isProxyAlive = async (proxyUrl) => {
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 3000); // 3s is fast enough
    const res = await fetch('https://challenges.cloudflare.com/cdn-cgi/trace', {
      agent: new ProxyAgent(proxyUrl),
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    clearTimeout(id);
    return res.status === 200;
  } catch (e) {
    return false;
  }
};

// Readline setup for CLI inputs
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));

async function main() {
  console.log("\n==================================================");
  console.log("   PhoneValidator CLI Batch Processor (Incognito)");
  console.log("==================================================");
  
  if (!chromePath) {
    console.error(`\x1b[31mError: Google Chrome not found! Please make sure Google Chrome is installed.\x1b[0m`);
    rl.close();
    process.exit(1);
  }

  // Check if input file exists
  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`\x1b[31mError: Input file "${INPUT_FILE}" not found! Please create it.\x1b[0m`);
    rl.close();
    process.exit(1);
  }

  // Load numbers
  const rawContent = fs.readFileSync(INPUT_FILE, 'utf-8');
  const lines = rawContent.split(/[\r\n,]+/);
  const phones = [];
  
  lines.forEach(line => {
    const trimmed = line.trim();
    if (trimmed) {
      const digits = trimmed.replace(/\D/g, '');
      if (digits.length > 0) {
        phones.push({ raw: trimmed, cleaned: digits });
      }
    }
  });

  if (phones.length === 0) {
    console.log("\x1b[33mNo phone numbers found in phone_lists.txt.\x1b[0m");
    rl.close();
    process.exit(0);
  }

  console.log(`\x1b[36mLoaded ${phones.length} phone numbers from phone_lists.txt.\x1b[0m`);
  
  // Load proxies
  let proxies = [];
  if (fs.existsSync(PROXY_FILE)) {
    const content = fs.readFileSync(PROXY_FILE, 'utf-8');
    proxies = content.split(/[\r\n]+/)
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('#'));
  }
  console.log(`\x1b[36mLoaded ${proxies.length} proxies from valid_proxies.txt.\x1b[0m`);

  // ─── Load settings from config.json (if it exists) ──────────────────────────
  const CONFIG_FILE = path.join(__dirname, 'config.json');
  let cfg = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      console.log(`\x1b[32m✓ Loaded settings from config.json (no prompts needed)\x1b[0m`);
    } catch(e) {
      console.log(`\x1b[33mWarning: config.json is invalid JSON, falling back to prompts.\x1b[0m`);
      cfg = {};
    }
  }

  let useProxies, concurrency, delay, maxRetries, retryDelay, browserSolvers, solverTabs, maxConcurrentBrowsers, proxyIpCooldown;

  // Use config values directly if all keys are present, otherwise prompt for missing ones
  if (cfg.useProxies !== undefined && cfg.concurrency !== undefined &&
      cfg.pacingDelay !== undefined && cfg.maxRetries !== undefined && cfg.retryDelay !== undefined) {
    useProxies            = !!cfg.useProxies;
    concurrency           = Math.min(Math.max(parseInt(cfg.concurrency, 10) || 1, 1), 500);
    delay                 = parseFloat(cfg.pacingDelay) >= 0 ? parseFloat(cfg.pacingDelay) : 6.5;
    maxRetries            = Math.min(Math.max(parseInt(cfg.maxRetries, 10) || 3, 0), 100);
    retryDelay            = parseFloat(cfg.retryDelay) >= 1 ? parseFloat(cfg.retryDelay) : 8;
    browserSolvers        = parseInt(cfg.browserSolvers, 10) >= 0 ? parseInt(cfg.browserSolvers, 10) : 1;
    solverTabs            = parseInt(cfg.solverTabs, 10) >= 1 ? parseInt(cfg.solverTabs, 10) : 5;
    maxConcurrentBrowsers = parseInt(cfg.maxConcurrentBrowsers, 10) >= 1 ? parseInt(cfg.maxConcurrentBrowsers, 10) : 5;
    proxyIpCooldown       = parseInt(cfg.proxyIpCooldown, 10) >= 0 ? parseInt(cfg.proxyIpCooldown, 10) : 30;  } else {
    // Interactive prompts (fallback when config.json is missing or incomplete)
    const useProxiesInput = await askQuestion(`\x1b[35mUse proxies from valid_proxies.txt? (y/n) [default n]: \x1b[0m`);
    useProxies = useProxiesInput.toLowerCase().trim() === 'y';

    const concurrencyInput = await askQuestion(`\x1b[35mEnter concurrency (parallel threads, e.g. 1-100) [default 1]: \x1b[0m`);
    concurrency = parseInt(concurrencyInput, 10);
    if (isNaN(concurrency) || concurrency <= 0) concurrency = 1;
    concurrency = Math.min(concurrency, 500);

    const delayInput = await askQuestion(`\x1b[35mEnter pacing delay in seconds (e.g. 2-10) [default 6.5]: \x1b[0m`);
    delay = parseFloat(delayInput);
    if (isNaN(delay) || delay < 0) delay = 6.5;

    const retryInput = await askQuestion(`\x1b[35mEnter maximum retries on rate limit (e.g. 0-5) [default 3]: \x1b[0m`);
    maxRetries = parseInt(retryInput, 10);
    if (isNaN(maxRetries) || maxRetries < 0) maxRetries = 3;
    maxRetries = Math.min(maxRetries, 100);

    const retryDelayInput = await askQuestion(`\x1b[35mEnter retry delay on rate limit in seconds [default 8]: \x1b[0m`);
    retryDelay = parseFloat(retryDelayInput);
    if (isNaN(retryDelay) || retryDelay < 1) retryDelay = 8;

    browserSolvers = 1;
    solverTabs = 5;
    maxConcurrentBrowsers = 5;
    proxyIpCooldown = 30;
  }

  rl.close();

  console.log(`\n\x1b[36mSettings: Use Proxies=${useProxies} | Concurrency=${concurrency} threads | Pacing Delay=${delay}s | Max Retries=${maxRetries} (Delay ${retryDelay}s)\x1b[0m`);
  console.log(`\x1b[36mSolvers: ${browserSolvers} browser(s) × ${solverTabs} tabs | IP Cooldown=${proxyIpCooldown}s\x1b[0m`);
  console.log(`\x1b[36mResults will be appended instantly to: ${OUTPUT_FILE}\x1b[0m`);
  console.log("\nStarting in 3 seconds...");
  await sleep(3000);

  // Always ensure CSV has correct header (even if file was manually edited)
  const CSV_HEADER = '#,Phone Number,Line Type,Fake Number,Carrier Name,Original Carrier,Deliverability,Ported,Region,City,Timezone,TCPA Litigator';
  let existingContent = '';
  try { existingContent = fs.readFileSync(OUTPUT_FILE, 'utf-8'); } catch(e) {}
  
  const firstLine = existingContent.split('\n')[0] || '';
  const hasHeader = firstLine.startsWith('#,Phone');
  
  if (!hasHeader) {
    // Prepend header — keep any existing data rows below it
    const dataRows = existingContent.trim() ? ('\n' + existingContent.trim()) : '';
    fs.writeFileSync(OUTPUT_FILE, CSV_HEADER + dataRows + '\n', 'utf-8');
    existingContent = fs.readFileSync(OUTPUT_FILE, 'utf-8');
  }

  // Read current row count (excluding header and blank lines)
  let currentCSVRowCount = 0;
  try {
    currentCSVRowCount = existingContent.split('\n')
      .filter(line => line.trim().length > 0 && !line.startsWith('#'))
      .length;
    if (currentCSVRowCount < 0) currentCSVRowCount = 0;
  } catch(e) {}
  // Build set of already-processed phone numbers (digits-only) from CSV to avoid duplicates
  const alreadyProcessed = new Set();
  try {
    existingContent.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      // CSV format: index,"phone number",...  — extract phone from 2nd column
      const match = trimmed.match(/^\d+,"([^"]+)"/);
      if (match) {
        alreadyProcessed.add(match[1].replace(/\D/g, '')); // store digits-only
      }
    });
  } catch(e) {}

  // Filter out already-processed phones from the queue
  const originalCount = phones.length;
  const phonesToProcess = phones.filter(p => !alreadyProcessed.has(p.cleaned));
  if (alreadyProcessed.size > 0) {
    console.log(`\x1b[33m⚡ Skipping ${originalCount - phonesToProcess.length} already-processed numbers. ${phonesToProcess.length} remaining.\x1b[0m`);
  }
  if (phonesToProcess.length === 0) {
    console.log(`\x1b[32m✓ All phone numbers already processed! Check ${OUTPUT_FILE}\x1b[0m`);
    process.exit(0);
  }

  // Thread-safe CSV writing
  let nextPhoneIndex = 0;
  let writtenCount = 0;
  const appendToCSV = (phone, type, fake, carrier='', subType='', deliver='', ported='', region='', city='', tz='', tcpa='') => {
    writtenCount++;
    const index = currentCSVRowCount + writtenCount;
    const row = [
      index,
      `"${phone}"`,
      `"${type}"`,
      `"${fake}"`,
      `"${carrier.replace(/"/g, '""')}"`,
      `"${subType.replace(/"/g, '""')}"`,
      `"${deliver}"`,
      `"${ported}"`,
      `"${region}"`,
      `"${city.replace(/"/g, '""')}"`,
      `"${tz}"`,
      `"${tcpa}"\n`
    ];
    fs.appendFileSync(OUTPUT_FILE, row.join(','), 'utf-8');
  };

  // ─── Background Chrome solver windows (local IP — reliable Turnstile solving) ───
  // Tokens go into global pool; API calls use rotating proxies for rate limit spreading.
  const activeBrowsers = [];
  const tempProfileDirs = [];

  const cleanupBrowsers = async () => {
    if (activeBrowsers.length === 0) return;
    console.log('\n\x1b[35mCleaning up background solver browsers...\x1b[0m');
    for (const proc of activeBrowsers) {
      try { proc.kill(); } catch(e) {}
    }
    await sleep(1500);
    for (const dir of tempProfileDirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch(e) {}
    }
  };

  process.on('SIGINT', async () => { await cleanupBrowsers(); process.exit(0); });
  process.on('SIGTERM', async () => { await cleanupBrowsers(); process.exit(0); });

  if (browserSolvers > 0) {
    console.log(`\x1b[35mStarting ${browserSolvers} background Chrome solver window(s) with ${solverTabs} tab(s) each...\x1b[0m`);
    for (let b = 1; b <= browserSolvers; b++) {
      const tempProfileDir = path.join(__dirname, 'scratch', `solver-bg-${b}-${Date.now()}`);
      tempProfileDirs.push(tempProfileDir);

      const chromeArgs = [
        '--incognito',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-default-apps',
        '--window-size=1,1',
        '--window-position=-32000,-32000',
        '--minimized',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--host-resolver-rules=MAP checkthatphone.com 127.0.0.1',
        `--user-data-dir=${tempProfileDir}`
      ];

      for (let t = 1; t <= solverTabs; t++) {
        chromeArgs.push(`http://127.0.0.1:8888/solver.html?tab=${t}&solver=${b}`);
      }

      try {
        const proc = spawn(chromePath, chromeArgs, { windowsHide: true });
        proc.on('error', (err) => console.error(`\x1b[31m[Solver ${b}] Error: ${err.message}\x1b[0m`));
        activeBrowsers.push(proc);
        console.log(`\x1b[32m✓ [Solver ${b}] Started with ${solverTabs} tab(s) via Local IP\x1b[0m`);
      } catch (err) {
        console.error(`\x1b[31mFailed to start solver ${b}: ${err.message}\x1b[0m`);
      }
    }
    // Smart pre-warm: wait until the token pool reaches the target size before starting workers.
    // Tokens expire in 120s, so we wait at most 100s to avoid buffering stale tokens.
    const prewarmTarget = parseInt(cfg.prewarmTokens, 10) >= 1 ? parseInt(cfg.prewarmTokens, 10) : 50;
    const prewarmMax    = 100; // seconds — stop waiting even if pool isn't full yet

    console.log(`\x1b[35m⏳ Pre-warming token pool. Waiting for ${prewarmTarget} fresh tokens (max ${prewarmMax}s)...\x1b[0m`);
    const prewarmStart = Date.now();
    let lastPoolSize = -1;

    while (true) {
      let poolSize = 0;
      try {
        const statsRes = await fetch(`${SERVER_URL}/api/token-stats`);
        if (statsRes.ok) {
          const stats = await statsRes.json();
          poolSize = stats.buffered || 0;
        }
      } catch(e) {}

      if (poolSize !== lastPoolSize) {
        const elapsed = Math.round((Date.now() - prewarmStart) / 1000);
        process.stdout.write(`\r\x1b[35m   Pool: [${poolSize}/${prewarmTarget}] tokens | Elapsed: ${elapsed}s / ${prewarmMax}s \x1b[0m`);
        lastPoolSize = poolSize;
      }

      const elapsed = (Date.now() - prewarmStart) / 1000;
      if (poolSize >= prewarmTarget || elapsed >= prewarmMax) {
        const finalPool = lastPoolSize;
        console.log(`\n\x1b[32m✓ Pre-warm complete! Pool has ${finalPool} tokens. Starting workers now.\x1b[0m`);
        break;
      }

      await sleep(500);
    }
  } else {
    console.log(`\x1b[33mNo background browsers started. Open http://checkthatphone.com:8888/solver.html manually.\x1b[0m`);
  }

  // Worker task implementation
  async function worker(workerId) {
    const totalLen = String(phonesToProcess.length).length;
    while (true) {
      let currentIdx;
      // Get next phone index
      if (nextPhoneIndex >= phonesToProcess.length) {
        break; // No more numbers
      }
      currentIdx = nextPhoneIndex++;
      const item = phonesToProcess[currentIdx];

      const threadStr = String(workerId).padStart(3, ' ');
      const progressStr = String(currentIdx + 1).padStart(totalLen, ' ');
      const prefix = `\x1b[90m[Thread ${threadStr}] [${progressStr}/${phonesToProcess.length}]\x1b[0m`;
      
      let success = false;
      let checkAttempts = 0;
      const maxAttempts = maxRetries + 1;

      while (checkAttempts < maxAttempts && !success) {
        checkAttempts++;

        // Find a SOCKS/HTTP proxy that is actually alive and not on IP cooldown (if enabled)
        let proxy = null;
        if (useProxies && proxies.length > 0) {
          let attempts = 0;
          let fallbackCandidateIdx = -1;
          
          while (attempts < 20 && proxies.length > 0) {
            attempts++;
            const idx = Math.floor(Math.random() * proxies.length);
            const candidate = proxies[idx];
            
            const ip = getProxyIp(candidate);
            const lastUsed = lastUsedIpTimes.get(ip) || 0;
            const elapsed = (Date.now() - lastUsed) / 1000;
            
            if (elapsed < proxyIpCooldown) {
              // Store as fallback if we don't find any off-cooldown proxy
              if (fallbackCandidateIdx === -1) {
                fallbackCandidateIdx = idx;
              }
              continue;
            }
            
            // Remove from array since it's off cooldown
            proxies.splice(idx, 1);
            
            const alive = await isProxyAlive(candidate);
            if (alive) {
              proxy = candidate;
              lastUsedIpTimes.set(ip, Date.now());
              break;
            }
          }
          
          // Fallback if no off-cooldown proxy is found/alive: use the first on-cooldown fallback
          if (!proxy && fallbackCandidateIdx !== -1 && proxies.length > 0) {
            const idx = Math.min(fallbackCandidateIdx, proxies.length - 1);
            const candidate = proxies[idx];
            proxies.splice(idx, 1);
            
            const alive = await isProxyAlive(candidate);
            if (alive) {
              proxy = candidate;
              const ip = getProxyIp(candidate);
              lastUsedIpTimes.set(ip, Date.now());
            }
          }
        }

        const cleanProxy = proxy ? proxy : 'Local IP';
        console.log(`${getTimestamp()} ${prefix} \x1b[36m[🔍 Checking] \x1b[0m| Number: \x1b[1m${item.raw}\x1b[0m | Proxy: ${cleanProxy} (Attempt ${checkAttempts}/${maxAttempts})`);

        // If we ran out of live proxies, assign a final random one from the remaining list and remove it
        if (useProxies && proxies.length > 0 && !proxy) {
          console.warn(`${getTimestamp()} ${prefix} \x1b[33m[⚠ ProxyWarn] \x1b[0m| Checked 15 proxies but all were offline. Retrying with random proxy...`);
          const idx = Math.floor(Math.random() * proxies.length);
          proxy = proxies[idx];
          proxies.splice(idx, 1);
        }

        let token = null;
        let userAgent = null;

        // Fetch token from global pool (solved by background Chrome via local IP)
        try {
          const res = await fetch(`${SERVER_URL}/api/get-token`);
          if (res.status === 200) {
            const data = await res.json();
            token = data.token;
            userAgent = data.userAgent;
          }
        } catch (err) {
          // Server unreachable
        }

        if (!token) {
          console.error(`${getTimestamp()} ${prefix} \x1b[35m[\u23f1 TIMEOUT]  \x1b[0m| Number: \x1b[1m${item.raw}\x1b[0m | Turnstile token unavailable. Retrying in ${retryDelay} seconds...`);
          await sleep(retryDelay * 1000);
          continue;
        }

        // Call local server lookup proxy
        try {
          const res = await fetch(`${SERVER_URL}/api/check-phone`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              phone: item.cleaned, 
              turnstileToken: token,
              clientUserAgent: userAgent,
              proxy: proxy
            })
          });

          const data = await res.json();

          if (res.status === 429) {
            console.warn(`${getTimestamp()} ${prefix} \x1b[33m[⚠ RATELIMIT]\x1b[0m | Number: \x1b[1m${item.raw}\x1b[0m | Proxy: ${proxy || 'Local IP'} | Retrying in ${retryDelay} seconds...`);
            await sleep(retryDelay * 1000);
            continue; 
          }

          if (res.ok) {
            success = true;
            const info = data.data || {};
            const type = info.nanpType || 'Unknown';
            const fake = (info.deliverable === 'false' || type === 'INVALID') ? 'YES' : 'NO';
            const carrier = info.dipCarrier || '';
            const subType = info.dipCarrierSubType || '';
            const deliver = info.deliverable || '';
            const ported = info.dipPorted === 'true' ? 'YES' : 'NO';
            const region = info.geoState || '';
            const city = info.geoCity || '';
            const tz = info.timezone || '';
            const tcpa = info.blackList === 'true' ? 'HIGH RISK' : 'SAFE';

            appendToCSV(item.raw, type, fake, carrier, subType, deliver, ported, region, city, tz, tcpa);
            
            const fakeColor = fake === 'YES' ? '\x1b[31mYES\x1b[0m' : '\x1b[32mNO\x1b[0m';
            console.log(`${getTimestamp()} ${prefix} \x1b[32m[✔ SUCCESS]  \x1b[0m| Number: \x1b[1m${item.raw}\x1b[0m | Type: \x1b[36m${type}\x1b[0m | Carrier: \x1b[34m${carrier}\x1b[0m | Fake: ${fakeColor} | Proxy: \x1b[90m${proxy || 'Local IP'}\x1b[0m`);
          } else {
            success = true; // Stop retry on standard bad requests
            console.error(`${getTimestamp()} ${prefix} \x1b[31m[❌ APIERROR]\x1b[0m | Number: \x1b[1m${item.raw}\x1b[0m | Error: ${data.error || 'Failed validation'} | Proxy: \x1b[90m${proxy || 'Local IP'}\x1b[0m`);
            appendToCSV(item.raw, 'ERROR', 'YES', data.error || 'API Error');
          }
        } catch (err) {
          console.error(`${getTimestamp()} ${prefix} \x1b[31m[❌ REQERROR]\x1b[0m | Number: \x1b[1m${item.raw}\x1b[0m | Error: ${err.message} | Proxy: \x1b[90m${proxy || 'Local IP'}\x1b[0m`);
          if (checkAttempts >= maxAttempts) {
            appendToCSV(item.raw, 'ERROR', 'YES', 'Network/Proxy Error');
          } else {
            await sleep(3000);
          }
        }
      }

      if (!success && checkAttempts >= maxAttempts) {
        console.error(`${getTimestamp()} ${prefix} \x1b[31m[💀 FAILED]  \x1b[0m| Number: \x1b[1m${item.raw}\x1b[0m | Failed checking after ${maxRetries} retries.`);
        appendToCSV(item.raw, 'SKIPPED', 'YES', 'Rate Limited / Timeout');
      }

      // Dynamic pacing delay for this thread
      await sleep(delay * 1000);
    }
  }

  // Start parallel workers
  const workerPromises = [];
  for (let w = 1; w <= concurrency; w++) {
    workerPromises.push(worker(w));
  }

  // Wait for all workers to finish
  await Promise.all(workerPromises);

  await cleanupBrowsers();

  console.log("\n==================================================");
  console.log("\x1b[32m   Batch Processing Complete!\x1b[0m");
  console.log(`   Results appended to: \x1b[36m${OUTPUT_FILE}\x1b[0m`);
  console.log("==================================================");
  process.exit(0);
}

main();

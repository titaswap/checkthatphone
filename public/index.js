// Global state
let turnstileWidgetId = null;
let currentToken = null;
let turnstileResolve = null;
let isProcessing = false;
let isPaused = false;
let isStopped = false;
let phoneQueue = [];
let lookupResults = {}; // Map of phone -> API response data

// LocalStorage key
const HISTORY_STORAGE_KEY = 'phone_validator_history';

// Initialize and render Cloudflare Turnstile widget
window.onTurnstileLoad = function() {
  try {
    turnstileWidgetId = turnstile.render('#turnstile-widget', {
      sitekey: '0x4AAAAAADrGEecQvx6k5_Vl',
      callback: function(token) {
        currentToken = token;
        if (!isProcessing) {
          document.getElementById('btn-start').disabled = false;
        }
        if (turnstileResolve) {
          const res = turnstileResolve;
          turnstileResolve = null;
          res(token);
        }
      },
      'expired-callback': function() {
        currentToken = null;
        document.getElementById('btn-start').disabled = true;
      },
      'error-callback': function() {
        currentToken = null;
        document.getElementById('btn-start').disabled = true;
        if (turnstileResolve) {
          const res = turnstileResolve;
          turnstileResolve = null;
          res(null);
        }
      }
    });
  } catch (e) {
    console.error("Failed to render turnstile widget:", e);
  }
};

// Retrieve next Turnstile token dynamically
function getNextTurnstileToken() {
  return new Promise((resolve) => {
    if (currentToken) {
      const tok = currentToken;
      currentToken = null;
      resolve(tok);
    } else {
      turnstileResolve = resolve;
      turnstile.reset(turnstileWidgetId);
    }
  });
}

// Sleep helper
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Format number (XXX) XXX-XXXX -> clean display
function formatPhoneDisplay(numStr) {
  const cleaned = numStr.replace(/\D/g, '');
  if (cleaned.length === 10) {
    return `${cleaned.slice(0, 3)} ${cleaned.slice(3, 6)} ${cleaned.slice(6)}`;
  }
  return numStr;
}

// Update the Top 5 Statistics Tiles
function updateStatsTiles() {
  const total = phoneQueue.length;
  let remaining = 0;
  let processed = 0;
  let cells = 0;
  let fakes = 0;

  phoneQueue.forEach(item => {
    if (item.status === 'pending' || item.status === 'checking') {
      remaining++;
    } else {
      processed++;
    }

    if (item.status === 'success' && item.result && item.result.data) {
      const info = item.result.data;
      const type = (info.nanpType || '').toUpperCase();
      if (type.includes('CELL') || type.includes('MOBILE')) {
        cells++;
      }
      
      const deliver = (info.deliverable || '').toLowerCase();
      if (deliver === 'false' || type === 'INVALID') {
        fakes++;
      }
    } else if (item.status === 'failed') {
      fakes++; // Treat failed checks or connection errors as fake/invalid for visual stats
    }
  });

  document.getElementById('tile-total').innerText = total;
  document.getElementById('tile-remaining').innerText = remaining;
  document.getElementById('tile-processed').innerText = processed;
  document.getElementById('tile-cells').innerText = cells;
  document.getElementById('tile-fakes').innerText = fakes;
}

// Render Table Rows
function renderTable() {
  const tbody = document.getElementById('results-body');
  
  if (phoneQueue.length === 0) {
    tbody.innerHTML = `
      <tr class="empty-state">
        <td colspan="9">No phone numbers analyzed yet. Input numbers and verify to begin.</td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = '';
  phoneQueue.forEach((item, index) => {
    const tr = document.createElement('tr');
    tr.id = `row-${index}`;
    
    // Status Badge
    let statusHtml = '<span class="badge-status">Pending</span>';
    if (item.status === 'checking') {
      statusHtml = '<span class="badge-status checking">Checking...</span>';
    } else if (item.status === 'success') {
      statusHtml = `
        <span class="badge-status success">
          SUCCESS
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="width: 11px; height: 11px; display: inline-block;">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </span>
      `;
    } else if (item.status === 'failed') {
      statusHtml = '<span class="badge-status failed">FAILED</span>';
    }

    // Line Type and Carrier styling
    let lineTypeHtml = '-';
    let deliverableHtml = '-';
    let smsEligibleHtml = '-';
    let actionHtml = '-';
    let fakeHtml = '-';
    let detailBtnHtml = '';

    if (item.status === 'success' && item.result && item.result.data) {
      const info = item.result.data;
      const type = (info.nanpType || 'Unknown').toUpperCase();
      let iconSvg = '';
      let badgeClass = 'line-type-voip';

      if (type.includes('CELL') || type.includes('MOBILE')) {
        badgeClass = 'line-type-cell';
        iconSvg = `
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width: 14px; height: 14px; vertical-align: middle;">
            <rect x="5" y="2" width="14" height="20" rx="2" ry="2"/>
            <line x1="12" y1="18" x2="12.01" y2="18"/>
          </svg>
        `;
      } else if (type.includes('LAND')) {
        badgeClass = 'line-type-landline';
        iconSvg = `
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width: 14px; height: 14px; vertical-align: middle;">
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
          </svg>
        `;
      } else {
        iconSvg = `
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width: 14px; height: 14px; vertical-align: middle;">
            <path d="M23 7a2 2 0 0 0-2.45-1.45L11 8 1 5 1 19l10 3 12-3V7z"/>
          </svg>
        `;
      }

      lineTypeHtml = `<span class="line-type-badge ${badgeClass}">${iconSvg} ${type}</span>`;

      // Deliverable
      const isDeliverable = info.deliverable === 'true';
      deliverableHtml = isDeliverable 
        ? '<span class="badge-fake no">TRUE</span>' 
        : '<span class="badge-fake yes">FALSE</span>';

      // SMS Eligible
      const isSms = info.smsEligible === 'true';
      smsEligibleHtml = isSms 
        ? '<span class="badge-fake no">TRUE</span>' 
        : '<span class="badge-fake yes">FALSE</span>';

      // Action Type
      const act = (info.action || 'send').toUpperCase();
      actionHtml = `<span class="badge-status checking" style="background:#eff6ff; border-color:#bfdbfe; color:#1d4ed8; animation:none; font-weight:700;">${act}</span>`;

      // Fake check
      const deliver = (info.deliverable || '').toLowerCase();
      if (deliver === 'false' || type === 'INVALID') {
        fakeHtml = '<span class="badge-fake yes">YES</span>';
      } else {
        fakeHtml = '<span class="badge-fake no">NO</span>';
      }

      // Details button
      detailBtnHtml = `<button class="btn-view-detail" onclick="viewDetails('${item.cleaned}')">Details</button>`;
    } else if (item.status === 'failed') {
      const errMsg = item.result && item.result.error ? item.result.error : 'Failed';
      lineTypeHtml = `<span class="text-danger">${errMsg}</span>`;
      fakeHtml = '<span class="badge-fake yes">YES</span>';
    }

    tr.innerHTML = `
      <td>${index + 1}</td>
      <td><strong>${item.display}</strong></td>
      <td>${lineTypeHtml}</td>
      <td>${deliverableHtml}</td>
      <td>${smsEligibleHtml}</td>
      <td>${actionHtml}</td>
      <td>${fakeHtml}</td>
      <td>${statusHtml}</td>
      <td>${detailBtnHtml}</td>
    `;
    tbody.appendChild(tr);
  });

  // Re-run the active search filter if any
  applyTableFilter();
}

// Live filter the records table
function applyTableFilter() {
  const filterVal = document.getElementById('table-filter').value.toLowerCase().trim();
  const rows = document.querySelectorAll('#results-body tr');

  rows.forEach(row => {
    if (row.classList.contains('empty-state')) return;
    const text = row.innerText.toLowerCase();
    if (text.includes(filterVal)) {
      row.classList.remove('hidden');
    } else {
      row.classList.add('hidden');
    }
  });
}

// Parse inputs from textarea
function getPhoneQueueFromInputs() {
  const rawInput = document.getElementById('phones-input').value;
  const rawLines = rawInput.split(/[\n\r,]+/);
  
  const queue = [];
  rawLines.forEach(line => {
    const trimmed = line.trim();
    if (trimmed) {
      const digits = trimmed.replace(/\D/g, '');
      if (digits.length > 0) {
        queue.push({
          raw: trimmed,
          cleaned: digits,
          display: formatPhoneDisplay(digits),
          status: 'pending',
          result: null
        });
      }
    }
  });
  return queue;
}

// Pause/Resume actions
function pauseValidation() {
  if (!isProcessing || isPaused) return;
  isPaused = true;
  
  // UI Changes on Pause
  document.getElementById('start-btn-text').innerText = 'Resume';
  document.getElementById('btn-start').disabled = false;
  document.getElementById('btn-start').classList.remove('hidden');
  document.getElementById('btn-clear').classList.remove('hidden');
  document.getElementById('btn-clear').disabled = false;
  document.getElementById('btn-pause').classList.add('hidden');
}

function resumeValidation() {
  if (!isProcessing || !isPaused) return;
  isPaused = false;
  
  // UI Changes on Resume
  document.getElementById('btn-start').classList.add('hidden');
  document.getElementById('btn-clear').classList.add('hidden');
  document.getElementById('btn-pause').classList.remove('hidden');
}

function stopValidationAction() {
  if (!isProcessing) return;
  isStopped = true;
  isPaused = false; // Unblock loop if paused
}

// Start Processing Queue sequentially
async function startValidation() {
  if (isPaused) {
    resumeValidation();
    return;
  }
  if (isProcessing) return;

  const queue = getPhoneQueueFromInputs();
  if (queue.length === 0) {
    alert("Please input phone numbers first.");
    return;
  }

  phoneQueue = queue;
  isProcessing = true;
  isPaused = false;
  isStopped = false;

  document.getElementById('start-btn-text').innerText = 'Start';
  document.getElementById('btn-start').classList.add('hidden');
  document.getElementById('btn-clear').classList.add('hidden');
  document.getElementById('btn-pause').classList.remove('hidden');
  document.getElementById('btn-stop').classList.remove('hidden');

  document.getElementById('phones-input').disabled = true;
  document.getElementById('batch-name').disabled = true;
  document.getElementById('request-delay').disabled = true;

  updateStatsTiles();
  renderTable();

  const total = phoneQueue.length;

  for (let i = 0; i < total; i++) {
    if (isStopped) break;

    while (isPaused && !isStopped) {
      await sleep(250);
    }
    if (isStopped) break;

    const item = phoneQueue[i];

    // Spacing between requests (pacing delay) configured by user
    if (i > 0) {
      item.status = 'pending';
      updateStatsTiles();
      renderTable();
      const delay = parseInt(document.getElementById('request-delay').value) || 6000;
      await sleep(delay);
    }

    if (isStopped) break;
    while (isPaused && !isStopped) {
      await sleep(250);
    }
    if (isStopped) break;

    item.status = 'checking';
    updateStatsTiles();
    renderTable();

    let attempts = 0;
    let success = false;

    while (attempts < 3 && !success) {
      if (isStopped) break;
      attempts++;

      // Retrieve single Turnstile token
      let token = currentToken;
      if (!token) {
        token = await getNextTurnstileToken();
      }
      // Consume token
      currentToken = null;

      if (!token) {
        item.status = 'failed';
        item.result = { error: "Turnstile Expired/Failed" };
        updateStatsTiles();
        renderTable();
        break; // Stop retry
      }

      try {
        const res = await fetch('/api/check-phone', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            phone: item.cleaned,
            turnstileToken: token
          })
        });

        const data = await res.json();

        if (res.status === 429) {
          console.warn(`Rate limited (429) on attempt ${attempts} for ${item.cleaned}. Retrying in 5 seconds...`);
          await sleep(5000);
          continue;
        }

        if (res.ok) {
          success = true;
          item.status = 'success';
          item.result = data;
          lookupResults[item.cleaned] = data;
        } else {
          success = true;
          item.status = 'failed';
          item.result = { error: data.error || data.detail || `HTTP ${res.status}` };
        }
      } catch (error) {
        console.error(error);
        if (attempts >= 3) {
          success = true;
          item.status = 'failed';
          item.result = { error: "Proxy Request Error" };
        } else {
          await sleep(2000);
        }
      }
    }

    updateStatsTiles();
    renderTable();
  }

  // Finished or stopped Batch
  isProcessing = false;
  isPaused = false;
  isStopped = false;

  document.getElementById('phones-input').disabled = false;
  document.getElementById('batch-name').disabled = false;
  document.getElementById('request-delay').disabled = false;
  
  // Restore default UI state
  document.getElementById('start-btn-text').innerText = 'Start';
  document.getElementById('btn-start').classList.remove('hidden');
  document.getElementById('btn-start').disabled = currentToken ? false : true;
  document.getElementById('btn-clear').classList.remove('hidden');
  document.getElementById('btn-clear').disabled = false;
  document.getElementById('btn-pause').classList.add('hidden');
  document.getElementById('btn-stop').classList.add('hidden');

  // Save to history list
  saveBatchToHistory();
  
  // Reset widget to get a fresh token for next runs
  if (turnstileWidgetId) turnstile.reset(turnstileWidgetId);
}

// Clear form inputs and stats
function clearForm() {
  if (isProcessing) {
    if (!confirm("Are you sure you want to cancel the active run?")) return;
  }
  isProcessing = false;
  isPaused = false;
  isStopped = false;
  phoneQueue = [];
  lookupResults = {};
  
  document.getElementById('phones-input').value = '';
  document.getElementById('phones-input').disabled = false;
  document.getElementById('batch-name').value = 'Batch Run';
  document.getElementById('batch-name').disabled = false;
  document.getElementById('btn-start').disabled = true;
  document.getElementById('btn-clear').disabled = false;

  updateStatsTiles();
  renderTable();

  // Reset widget
  if (turnstileWidgetId) turnstile.reset(turnstileWidgetId);
}

// Export CSV of Table Results
function exportCSV() {
  if (phoneQueue.length === 0) {
    alert("No records to export.");
    return;
  }

  const batchName = document.getElementById('batch-name').value.trim() || 'Batch_Export';
  const csvHeaders = ['#', 'Phone Number', 'Line Type', 'Fake Number', 'Carrier Name', 'Original Carrier', 'Deliverability', 'Ported', 'Region', 'City', 'Timezone', 'TCPA Litigator'];
  
  const csvRows = [csvHeaders.join(',')];

  phoneQueue.forEach((item, index) => {
    let type = '-';
    let fake = '-';
    let carrier = '-';
    let origCarrier = '-';
    let deliver = '-';
    let ported = '-';
    let region = '-';
    let city = '-';
    let tz = '-';
    let tcpa = '-';

    if (item.status === 'success' && item.result && item.result.data) {
      const d = item.result.data;
      type = d.nanpType || 'Unknown';
      fake = (d.deliverable === 'false' || type === 'INVALID') ? 'YES' : 'NO';
      carrier = d.dipCarrier || '';
      origCarrier = d.dipCarrierSubType || '';
      deliver = d.deliverable || '';
      ported = d.dipPorted !== undefined ? (d.dipPorted === 'true' ? 'YES' : 'NO') : '';
      region = d.geoState || '';
      city = d.geoCity || '';
      tz = d.timezone || '';
      tcpa = d.blackList === 'true' ? 'HIGH RISK' : 'SAFE';
    } else if (item.status === 'failed') {
      type = 'ERROR';
      fake = 'YES';
      carrier = item.result ? item.result.error : 'Request Failed';
    }

    // Escape commas in fields
    const row = [
      index + 1,
      `"${item.display}"`,
      `"${type}"`,
      `"${fake}"`,
      `"${carrier.replace(/"/g, '""')}"`,
      `"${origCarrier.replace(/"/g, '""')}"`,
      `"${deliver}"`,
      `"${ported}"`,
      `"${region}"`,
      `"${city.replace(/"/g, '""')}"`,
      `"${tz}"`,
      `"${tcpa}"`
    ];
    csvRows.push(row.join(','));
  });

  const csvContent = "data:text/csv;charset=utf-8," + csvRows.join("\n");
  const encodedUri = encodeURI(csvContent);
  const downloadLink = document.createElement("a");
  
  const dateStr = new Date().toISOString().slice(0,10);
  downloadLink.setAttribute("href", encodedUri);
  downloadLink.setAttribute("download", `${batchName.replace(/\s+/g, '_')}_${dateStr}.csv`);
  document.body.appendChild(downloadLink);
  downloadLink.click();
  document.body.removeChild(downloadLink);
}

// LocalStorage History Operations
function saveBatchToHistory() {
  const name = document.getElementById('batch-name').value.trim() || 'Batch Run';
  const total = phoneQueue.length;
  if (total === 0) return;

  let valid = 0;
  let cells = 0;
  let fakes = 0;

  phoneQueue.forEach(item => {
    if (item.status === 'success' && item.result && item.result.data) {
      valid++;
      const info = item.result.data;
      const type = (info.nanpType || '').toUpperCase();
      if (type.includes('CELL') || type.includes('MOBILE')) cells++;
      
      const deliver = (info.deliverable || '').toLowerCase();
      if (deliver === 'false' || type === 'INVALID') fakes++;
    } else if (item.status === 'failed') {
      fakes++;
    }
  });

  const runRecord = {
    id: 'batch-' + Date.now(),
    batchName: name,
    date: new Date().toLocaleString(),
    total: total,
    valid: valid,
    cells: cells,
    fakes: fakes,
    phoneQueue: phoneQueue,
    lookupResults: lookupResults
  };

  const history = getHistory();
  history.unshift(runRecord); // Add to beginning
  localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
  
  renderHistory();
}

function getHistory() {
  const data = localStorage.getItem(HISTORY_STORAGE_KEY);
  return data ? JSON.parse(data) : [];
}

function renderHistory() {
  const historyList = document.getElementById('history-list');
  const history = getHistory();

  if (history.length === 0) {
    historyList.innerHTML = '<p class="history-empty">No validation history yet.</p>';
    return;
  }

  historyList.innerHTML = '';
  history.forEach(item => {
    const div = document.createElement('div');
    div.className = 'history-item';
    div.innerHTML = `
      <div class="history-item-top">
        <strong>${item.batchName}</strong>
        <div class="history-badges">
          <span class="history-badge blue">Total: ${item.total}</span>
          <span class="history-badge green">Valid: ${item.valid}</span>
        </div>
      </div>
      <div class="history-item-meta">
        Date: ${item.date} <br/>
        Cell: ${item.cells} | Fake: ${item.fakes}
      </div>
      <div class="history-item-actions">
        <button class="btn-history-load" onclick="loadHistoryItem('${item.id}')">Load</button>
        <button class="btn-history-delete" onclick="deleteHistoryItem('${item.id}')">Delete</button>
      </div>
    `;
    historyList.appendChild(div);
  });
}

window.loadHistoryItem = function(id) {
  if (isProcessing) {
    if (!confirm("A validation run is currently active. Cancel it and load this history item?")) return;
    isProcessing = false;
  }

  const history = getHistory();
  const found = history.find(item => item.id === id);
  if (!found) return;

  // Restore states
  phoneQueue = found.phoneQueue;
  lookupResults = found.lookupResults;
  
  // Set UI elements
  document.getElementById('batch-name').value = found.batchName;
  
  // Populate numbers back into textarea for ease of use
  const numberLines = phoneQueue.map(item => item.raw).join('\n');
  document.getElementById('phones-input').value = numberLines;

  updateStatsTiles();
  renderTable();
};

window.deleteHistoryItem = function(id) {
  let history = getHistory();
  history = history.filter(item => item.id !== id);
  localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
  renderHistory();
};

function clearAllHistory() {
  if (confirm("Are you sure you want to wipe all local validation history?")) {
    localStorage.removeItem(HISTORY_STORAGE_KEY);
    renderHistory();
  }
}

// Drawer Detailed Overlay Actions
window.viewDetails = function(phoneNum) {
  const data = lookupResults[phoneNum];
  if (!data) return;

  document.getElementById('drawer-phone-title').innerText = formatPhoneDisplay(phoneNum);
  document.getElementById('drawer-phone-subtitle').innerText = `Carrier Network Intelligence Report`;

  const info = data.data || {};

  document.getElementById('detail-line-type').innerText = info.nanpType || 'Unknown';
  document.getElementById('detail-carrier').innerText = info.dipCarrier || 'Unknown';
  document.getElementById('detail-sms').innerText = info.smsEligible === 'true' ? 'Eligible' : 'Ineligible';

  const tcpaTile = document.getElementById('tile-tcpa');
  const tcpaVal = document.getElementById('detail-tcpa');
  if (info.blackList === 'true') {
    tcpaVal.innerText = 'HIGH RISK (Litigator)';
    tcpaTile.style.backgroundColor = 'var(--color-danger-bg)';
    tcpaTile.style.borderColor = 'var(--color-danger)';
    tcpaVal.style.color = 'var(--color-danger)';
  } else {
    tcpaVal.innerText = 'SAFE (Clean)';
    tcpaTile.style.backgroundColor = 'var(--color-cell-bg)';
    tcpaTile.style.borderColor = 'var(--color-primary)';
    tcpaVal.style.color = 'var(--color-cell)';
  }

  // Setup Details lists
  document.getElementById('detail-deliverable').innerText = info.deliverable === 'true' ? 'Deliverable' : 'Undeliverable';
  document.getElementById('detail-carrier-name').innerText = info.dipCarrier || '-';
  document.getElementById('detail-subtype').innerText = info.dipCarrierSubType || '-';
  document.getElementById('detail-ocn').innerText = info.dipOcn || '-';
  document.getElementById('detail-lrn').innerText = info.dipLrn || '-';
  document.getElementById('detail-ported').innerText = info.dipPorted === 'true' ? 'Yes' : 'No';

  document.getElementById('detail-region').innerText = info.geoState || '-';
  document.getElementById('detail-city').innerText = info.geoCity || '-';
  document.getElementById('detail-county').innerText = info.geoSource || 'area-code';
  document.getElementById('detail-timezone').innerText = info.timezone || '-';
  document.getElementById('detail-zip').innerText = info.geoCountry || '-';

  // Format code text inside codeblock
  document.getElementById('detail-raw-code').innerText = JSON.stringify(data, null, 2);

  // Show Drawer
  document.getElementById('detail-drawer').classList.remove('hidden');
};

function closeDrawer() {
  document.getElementById('detail-drawer').classList.add('hidden');
}

// Initial Events Binding
document.addEventListener('DOMContentLoaded', () => {
  // Input trigger buttons
  document.getElementById('btn-start').addEventListener('click', startValidation);
  document.getElementById('btn-clear').addEventListener('click', clearForm);
  document.getElementById('btn-pause').addEventListener('click', pauseValidation);
  document.getElementById('btn-stop').addEventListener('click', stopValidationAction);
  document.getElementById('btn-export').addEventListener('click', exportCSV);

  // Table Filter input keyup
  document.getElementById('table-filter').addEventListener('keyup', applyTableFilter);

  // History Actions
  document.getElementById('btn-clear-history').addEventListener('click', clearAllHistory);

  // Modal drawer overlay handlers
  document.getElementById('btn-close-drawer').addEventListener('click', closeDrawer);
  document.getElementById('detail-drawer').addEventListener('click', (e) => {
    if (e.target.id === 'detail-drawer') closeDrawer();
  });

  // Details modal tab selectors
  const tabBtns = document.querySelectorAll('.tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      const paneId = btn.getAttribute('data-tab');
      document.getElementById(paneId).classList.add('active');
    });
  });

  // Render base validation history list
  renderHistory();
});

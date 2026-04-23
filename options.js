// Options page script.
// Handles settings persistence, Salesforce OAuth, connection testing,
// AI provider model lists, and the in-page log viewer.

import { connectSalesforce, disconnectSalesforce, checkConnection } from './lib/salesforce.js';
import { log } from './lib/logger.js';

// ---------------------------------------------------------------------------
// Model lists per provider
// ---------------------------------------------------------------------------
const MODELS = {
  openai: [
    { value: 'gpt-4o',              label: 'GPT-4o (recommended)' },
    { value: 'gpt-4o-mini',         label: 'GPT-4o mini' },
    { value: 'gpt-4-turbo',         label: 'GPT-4 Turbo' },
    { value: 'gpt-4',               label: 'GPT-4' },
    { value: 'gpt-3.5-turbo',       label: 'GPT-3.5 Turbo' },
  ],
  anthropic: [
    { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet (recommended)' },
    { value: 'claude-3-opus-20240229',     label: 'Claude 3 Opus' },
    { value: 'claude-3-haiku-20240307',    label: 'Claude 3 Haiku' },
  ],
  custom: [
    { value: 'custom-model', label: 'Custom model (enter manually)' },
  ],
};

// ---------------------------------------------------------------------------
// Default settings
// ---------------------------------------------------------------------------
const DEFAULTS = {
  aiProvider:    'openai',
  aiModel:       'gpt-4o',
  aiApiKey:      '',
  aiBaseUrl:     '',
  aiMaxTokens:   4096,
  aiTemperature: 0.2,
  aiTimeout:     60,
  sfInstanceUrl: '',
  sfClientId:    '',
  sfApiVersion:  '62.0',
  pollInterval:  5,
  sfTimeout:     30,
  debugLogging:  false,
};

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const $ = id => document.getElementById(id);

const els = {
  aiProvider:         $('aiProvider'),
  aiModel:            $('aiModel'),
  aiApiKey:           $('aiApiKey'),
  aiBaseUrl:          $('aiBaseUrl'),
  customEndpointGroup:$('customEndpointGroup'),
  aiMaxTokens:        $('aiMaxTokens'),
  aiTemperature:      $('aiTemperature'),
  aiTimeout:          $('aiTimeout'),
  sfInstanceUrl:      $('sfInstanceUrl'),
  sfClientId:         $('sfClientId'),
  sfApiVersion:       $('sfApiVersion'),
  pollInterval:       $('pollInterval'),
  sfTimeout:          $('sfTimeout'),
  debugLogging:       $('debugLogging'),
  connStatus:         $('connStatus'),
  connDetail:         $('connDetail'),
  redirectUri:        $('redirectUriDisplay'),
  btnConnect:         $('btnConnect'),
  btnTestConn:        $('btnTestConn'),
  btnDisconnect:      $('btnDisconnect'),
  btnSave:            $('btnSave'),
  btnReset:           $('btnReset'),
  btnRefreshLogs:     $('btnRefreshLogs'),
  btnClearLogs:       $('btnClearLogs'),
  btnDownloadLogs:    $('btnDownloadLogs'),
  logBox:             $('logBox'),
  savedMsg:           $('savedMsg'),
};

// ---------------------------------------------------------------------------
// Toast notifications
// ---------------------------------------------------------------------------
function toast(message, type = 'info', durationMs = 3500) {
  const container = $('toastContainer');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .3s';
    setTimeout(() => el.remove(), 350);
  }, durationMs);
}

// ---------------------------------------------------------------------------
// Model list management
// ---------------------------------------------------------------------------
function populateModels(provider, selected) {
  const models = MODELS[provider] || MODELS.openai;
  els.aiModel.innerHTML = '';
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.value;
    opt.textContent = m.label;
    if (m.value === selected) opt.selected = true;
    els.aiModel.appendChild(opt);
  }
  // For custom provider, allow free-text model entry
  if (provider === 'custom') {
    els.aiModel.insertAdjacentHTML('beforeend', '<option value="_custom_">— type below —</option>');
  }
}

// ---------------------------------------------------------------------------
// Connection status UI
// ---------------------------------------------------------------------------
function setConnStatus(state, detail = '') {
  const el = els.connStatus;
  el.className = `conn-status ${state}`;
  const labels = {
    ok:       '✓ Connected',
    error:    '✗ Disconnected',
    unknown:  '● Not configured',
    checking: '… Checking',
  };
  el.innerHTML = `<span class="dot"></span> ${labels[state] || state}`;
  els.connDetail.textContent = detail;
}

async function refreshConnectionStatus() {
  setConnStatus('checking');
  const result = await checkConnection();
  if (result.ok) {
    const lastVersion = result.apiVersions?.length ? result.apiVersions.slice(-1)[0] : null;
    const versions = lastVersion ? `Latest API: v${lastVersion}` : '';
    setConnStatus('ok', versions);
    els.btnDisconnect.style.display = '';
  } else {
    setConnStatus('error', result.error || 'Unknown error');
    els.btnDisconnect.style.display = 'none';
  }
}

// ---------------------------------------------------------------------------
// Load settings from chrome.storage.local
// ---------------------------------------------------------------------------
async function loadSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const s = { ...DEFAULTS, ...stored };

  els.aiProvider.value     = s.aiProvider;
  els.aiApiKey.value       = s.aiApiKey;
  els.aiBaseUrl.value      = s.aiBaseUrl;
  els.aiMaxTokens.value    = s.aiMaxTokens;
  els.aiTemperature.value  = s.aiTemperature;
  els.aiTimeout.value      = s.aiTimeout;
  els.sfInstanceUrl.value  = s.sfInstanceUrl;
  els.sfClientId.value     = s.sfClientId;
  els.sfApiVersion.value   = s.sfApiVersion;
  els.pollInterval.value   = s.pollInterval;
  els.sfTimeout.value      = s.sfTimeout;
  els.debugLogging.checked = s.debugLogging;

  populateModels(s.aiProvider, s.aiModel);
  toggleCustomEndpoint(s.aiProvider);

  // Show redirect URI
  els.redirectUri.textContent = `https://${chrome.runtime.id}.chromiumapp.org/`;

  await refreshConnectionStatus();
}

// ---------------------------------------------------------------------------
// Save settings
// ---------------------------------------------------------------------------
async function saveSettings() {
  const values = {
    aiProvider:    els.aiProvider.value,
    aiModel:       els.aiModel.value,
    aiApiKey:      els.aiApiKey.value.trim(),
    aiBaseUrl:     els.aiBaseUrl.value.trim(),
    aiMaxTokens:   parseInt(els.aiMaxTokens.value, 10) || 4096,
    aiTemperature: parseFloat(els.aiTemperature.value) || 0.2,
    aiTimeout:     parseInt(els.aiTimeout.value, 10) || 60,
    sfInstanceUrl: els.sfInstanceUrl.value.trim().replace(/\/$/, ''),
    sfClientId:    els.sfClientId.value.trim(),
    sfApiVersion:  els.sfApiVersion.value,
    pollInterval:  parseInt(els.pollInterval.value, 10) || 5,
    sfTimeout:     parseInt(els.sfTimeout.value, 10) || 30,
    debugLogging:  els.debugLogging.checked,
  };

  await chrome.storage.local.set(values);

  // Apply debug level to logger
  log.setMinLevel(values.debugLogging ? 'debug' : 'info');

  // Update alarm period if changed
  chrome.runtime.sendMessage({ type: 'UPDATE_POLL_INTERVAL', interval: values.pollInterval }).catch(() => {});

  log.info('Settings saved');
  toast('Settings saved successfully', 'success');

  // Show "saved" label briefly
  els.savedMsg.classList.add('visible');
  setTimeout(() => els.savedMsg.classList.remove('visible'), 2500);
}

// ---------------------------------------------------------------------------
// Toggle custom endpoint field
// ---------------------------------------------------------------------------
function toggleCustomEndpoint(provider) {
  els.customEndpointGroup.style.display = provider === 'custom' ? '' : 'none';
}

// ---------------------------------------------------------------------------
// Log viewer
// ---------------------------------------------------------------------------
async function refreshLogs() {
  let entries = [];
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'GET_LOGS' });
    entries = resp?.logs || [];
  } catch {
    entries = log.getEntries();
  }

  if (entries.length === 0) {
    els.logBox.textContent = 'No log entries yet.';
    return;
  }

  els.logBox.innerHTML = entries
    .map(e => `<span class="log-${e.level}">${e.ts} [${e.level.toUpperCase()}] ${escHtml(e.message)}</span>`)
    .join('\n');

  els.logBox.scrollTop = els.logBox.scrollHeight;
}

function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function downloadLogs() {
  const entries = log.getEntries();
  const text = entries.map(e => `${e.ts} [${e.level.toUpperCase()}] ${e.message}`).join('\n');
  const blob = new Blob([text], { type: 'text/plain' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14); // yyyyMMddHHmmss
  a.download = `flow-drafter-logs-${ts}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------
els.aiProvider.addEventListener('change', () => {
  const p = els.aiProvider.value;
  populateModels(p, '');
  toggleCustomEndpoint(p);
});

els.btnSave.addEventListener('click', saveSettings);

els.btnReset.addEventListener('click', async () => {
  if (!confirm('Reset all settings to defaults? Your API keys and Salesforce credentials will be cleared.')) return;
  await chrome.storage.local.remove(Object.keys(DEFAULTS));
  await loadSettings();
  toast('Settings reset to defaults', 'info');
});

els.btnConnect.addEventListener('click', async () => {
  // Auto-save before connecting so the latest URL/client-id is used
  await saveSettings();

  const instanceUrl = els.sfInstanceUrl.value.trim().replace(/\/$/, '');
  const clientId    = els.sfClientId.value.trim();

  if (!instanceUrl) { toast('Please enter a Salesforce instance URL', 'error'); return; }
  if (!clientId)    { toast('Please enter a Connected App Consumer Key', 'error'); return; }

  els.btnConnect.disabled = true;
  setConnStatus('checking', 'Launching OAuth flow…');

  try {
    const { userId, orgId } = await connectSalesforce(instanceUrl, clientId);
    log.info(`Connected to Salesforce – orgId: ${orgId}, userId: ${userId}`);
    setConnStatus('ok', `Org: ${orgId}`);
    els.btnDisconnect.style.display = '';
    toast('Connected to Salesforce!', 'success');
  } catch (err) {
    log.error('Connect failed:', err);
    setConnStatus('error', err.message);
    toast(`Connection failed: ${err.message}`, 'error', 6000);
  } finally {
    els.btnConnect.disabled = false;
  }
});

els.btnTestConn.addEventListener('click', async () => {
  els.btnTestConn.disabled = true;
  try {
    await refreshConnectionStatus();
    const result = await checkConnection();
    if (result.ok) {
      toast('Connection is healthy ✓', 'success');
    } else {
      toast(`Connection failed: ${result.error}`, 'error', 5000);
    }
  } finally {
    els.btnTestConn.disabled = false;
  }
});

els.btnDisconnect.addEventListener('click', async () => {
  if (!confirm('Disconnect from Salesforce? You will need to re-authenticate to deploy flows.')) return;
  try {
    await disconnectSalesforce();
    setConnStatus('unknown');
    els.btnDisconnect.style.display = 'none';
    toast('Disconnected from Salesforce', 'info');
  } catch (err) {
    toast(`Disconnect error: ${err.message}`, 'error');
  }
});

els.btnRefreshLogs.addEventListener('click', refreshLogs);
els.btnClearLogs.addEventListener('click', () => {
  log.clear();
  els.logBox.textContent = 'Logs cleared.';
  toast('Logs cleared', 'info');
});
els.btnDownloadLogs.addEventListener('click', downloadLogs);

// Listen for health updates from background service worker
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'HEALTH_UPDATE') {
    if (msg.status?.ok) {
      setConnStatus('ok');
    } else if (msg.status) {
      setConnStatus('error', msg.status.error || '');
    }
  }
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
loadSettings();
refreshLogs();

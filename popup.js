// Popup script.
// Orchestrates the chat UI, AI calls, XML preview, deploy, and history.

import { sendPrompt, extractXml, extractFlowName } from './lib/ai.js';
import { deployFlow, checkConnection }              from './lib/salesforce.js';
import { log }                                      from './lib/logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MAX_HISTORY_SESSIONS = 30;
const MAX_CHAT_TURNS        = 20;  // keep memory bounded

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let chatHistory  = [];   // Array<{role, content}>  (current session)
let currentXml   = '';
let currentFlowName = '';
let cancelRequested = false;
let isBusy       = false;

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const $ = id => document.getElementById(id);

const el = {
  connPill:        $('connPill'),
  statusMsg:       $('statusMsg'),
  chatMessages:    $('chatMessages'),
  typingIndicator: $('typingIndicator'),
  chatInput:       $('chatInput'),
  btnSend:         $('btnSend'),
  btnNewChat:      $('btnNewChat'),
  btnSettings:     $('btnSettings'),
  btnRefreshConn:  $('btnRefreshConn'),
  xmlEditor:       $('xmlEditor'),
  xmlFlowName:     $('xmlFlowName'),
  btnCopyXml:      $('btnCopyXml'),
  btnEditXml:      $('btnEditXml'),
  btnClearXml:     $('btnClearXml'),
  deployFlowName:  $('deployFlowName'),
  btnDeploy:       $('btnDeploy'),
  historyList:     $('historyList'),
  btnClearHistory: $('btnClearHistory'),
  progressOverlay: $('progressOverlay'),
  progressMsg:     $('progressMsg'),
  btnCancelOp:     $('btnCancelOp'),
};

// ---------------------------------------------------------------------------
// Tab management
// ---------------------------------------------------------------------------
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    $(`panel-${tab.dataset.tab}`).classList.add('active');
  });
});

function switchTab(name) {
  document.querySelector(`.tab[data-tab="${name}"]`)?.click();
}

// ---------------------------------------------------------------------------
// Status bar helpers
// ---------------------------------------------------------------------------
function setStatus(msg, type = '') {
  el.statusMsg.textContent = msg;
  el.statusMsg.className   = `status-msg ${type}`;
}

function setConnPill(state, label) {
  const labels = { ok: '● Connected', error: '● Disconnected', unknown: '● Not configured', checking: '… Checking' };
  el.connPill.className    = `conn-pill ${state}`;
  el.connPill.innerHTML    = `<span class="dot"></span> ${label || labels[state] || state}`;
}

// ---------------------------------------------------------------------------
// Progress overlay
// ---------------------------------------------------------------------------
function showProgress(msg) {
  cancelRequested = false;
  el.progressMsg.textContent = msg || 'Working…';
  el.progressOverlay.classList.add('visible');
  isBusy = true;
}

function updateProgress(msg) {
  if (el.progressOverlay.classList.contains('visible')) {
    el.progressMsg.textContent = msg;
  }
  setStatus(msg, 'busy');
  log.debug('Progress:', msg);
}

function hideProgress() {
  el.progressOverlay.classList.remove('visible');
  isBusy = false;
}

// ---------------------------------------------------------------------------
// Chat message rendering
// ---------------------------------------------------------------------------
function appendMessage(role, content) {
  const div = document.createElement('div');
  div.className = `msg msg-${role}`;
  div.textContent = content;
  el.chatMessages.appendChild(div);
  el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
  return div;
}

function appendErrorMessage(content) {
  const div = document.createElement('div');
  div.className = 'msg msg-error';
  div.textContent = `⚠ ${content}`;
  el.chatMessages.appendChild(div);
  el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
}

function showTyping(visible) {
  el.typingIndicator.classList.toggle('visible', visible);
  el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
}

// ---------------------------------------------------------------------------
// XML syntax highlighting (lightweight, regex-based)
// ---------------------------------------------------------------------------
function highlightXml(raw) {
  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return esc(raw)
    // XML declaration
    .replace(/(&lt;\?xml[^?]*\?&gt;)/g, '<span class="xml-decl">$1</span>')
    // Comments
    .replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="xml-comment">$1</span>')
    // Closing tags
    .replace(/(&lt;\/[\w:.-]+&gt;)/g, '<span class="xml-tag">$1</span>')
    // Opening/self-closing tags with attributes
    .replace(/(&lt;[\w:.-]+)((?:\s+[\w:.-]+="[^"]*")*)(\/?)(&gt;)/g,
      (_, tag, attrs, slash, close) => {
        const coloredAttrs = attrs.replace(/([\w:.-]+)="([^"]*)"/g,
          '<span class="xml-attr">$1</span>=<span class="xml-value">"$2"</span>');
        return `<span class="xml-tag">${tag}${coloredAttrs}${slash}${close}</span>`;
      })
    // Remaining opening tags without attrs
    .replace(/(&lt;[\w:.-]+&gt;)/g, '<span class="xml-tag">$1</span>');
}

function setXml(xml) {
  currentXml = xml;
  currentFlowName = extractFlowName(xml);
  el.xmlEditor.innerHTML = xml ? highlightXml(xml) : '';
  el.xmlFlowName.textContent = xml ? `Flow: ${currentFlowName}` : 'No XML generated yet';
  el.deployFlowName.value = currentFlowName || '';
  el.xmlEditor.contentEditable = 'false';
}

// ---------------------------------------------------------------------------
// Load / Save settings
// ---------------------------------------------------------------------------
async function loadSettings() {
  return chrome.storage.local.get([
    'aiProvider', 'aiModel', 'aiApiKey', 'aiBaseUrl',
    'aiMaxTokens', 'aiTemperature', 'aiTimeout',
    'sfApiVersion',
  ]);
}

// ---------------------------------------------------------------------------
// Connection check
// ---------------------------------------------------------------------------
async function refreshConnection(showMsg = true) {
  setConnPill('checking');
  if (showMsg) setStatus('Checking Salesforce connection…', 'busy');

  try {
    const result = await checkConnection();
    if (result.ok) {
      setConnPill('ok');
      if (showMsg) setStatus('Salesforce connected', 'ok');
    } else {
      setConnPill('error');
      setStatus(result.error || 'Not connected', 'error');
    }
  } catch (err) {
    setConnPill('error');
    setStatus(err.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Send prompt to AI
// ---------------------------------------------------------------------------
async function handleSend() {
  const userMsg = el.chatInput.value.trim();
  if (!userMsg || isBusy) return;

  const settings = await loadSettings();
  if (!settings.aiApiKey) {
    appendErrorMessage('No AI API key configured. Open Settings (⚙️) to add one.');
    return;
  }

  // Append user bubble
  appendMessage('user', userMsg);
  el.chatInput.value = '';
  adjustTextarea();

  // Truncate history to keep memory bounded
  if (chatHistory.length > MAX_CHAT_TURNS * 2) {
    chatHistory = chatHistory.slice(-MAX_CHAT_TURNS * 2);
    log.warn(`Chat history truncated to ${chatHistory.length} entries`);
  }

  showTyping(true);
  el.btnSend.disabled = true;

  try {
    const reply = await sendPrompt({
      provider:    settings.aiProvider    || 'openai',
      apiKey:      settings.aiApiKey,
      model:       settings.aiModel       || 'gpt-4o',
      baseUrl:     settings.aiBaseUrl     || undefined,
      maxTokens:   settings.aiMaxTokens   || 4096,
      temperature: settings.aiTemperature ?? 0.2,
      timeoutMs:   (settings.aiTimeout    || 60) * 1000,
      apiVersion:  settings.sfApiVersion  || '62.0',
      history:     [...chatHistory],
      userMessage: userMsg,
    });

    // Update history (both sides)
    chatHistory.push({ role: 'user',      content: userMsg });
    chatHistory.push({ role: 'assistant', content: reply  });

    // Extract XML from the reply
    const xml = extractXml(reply);
    const hasXml = xml.startsWith('<?xml') || xml.includes('<Flow');

    // Show short assistant message with action hint
    if (hasXml) {
      appendMessage('assistant', '✅ Flow XML generated! Switch to the XML Preview tab to review and deploy it.');
      setXml(xml);
      switchTab('xml');
      setStatus('XML ready – review then deploy', 'ok');

      // Save to history
      await saveToHistory(userMsg, xml);
    } else {
      // Conversational response (no XML)
      appendMessage('assistant', reply.slice(0, 800) + (reply.length > 800 ? '…' : ''));
      setStatus('Response received', '');
    }
  } catch (err) {
    log.error('AI request failed:', err);
    appendErrorMessage(err.message);
    setStatus('AI request failed', 'error');
  } finally {
    showTyping(false);
    el.btnSend.disabled = false;
    el.chatInput.focus();
  }
}

// ---------------------------------------------------------------------------
// Deploy
// ---------------------------------------------------------------------------
async function handleDeploy() {
  if (!currentXml) {
    setStatus('No XML to deploy. Generate a flow first.', 'error');
    return;
  }
  if (isBusy) return;

  const settings = await loadSettings();
  const apiVersion = settings.sfApiVersion || '62.0';

  // Allow manual override of flow name
  const nameOverride = el.deployFlowName.value.trim();
  let xmlToDeploy = currentXml;
  if (nameOverride && nameOverride !== currentFlowName) {
    // Replace the <fullName> or inject one
    if (/<fullName>/.test(xmlToDeploy)) {
      xmlToDeploy = xmlToDeploy.replace(/<fullName>[^<]*<\/fullName>/, `<fullName>${nameOverride}</fullName>`);
    } else {
      xmlToDeploy = xmlToDeploy.replace(/<Flow[^>]*>/, `$&\n    <fullName>${nameOverride}</fullName>`);
    }
    // Update label too
    if (/<label>/.test(xmlToDeploy)) {
      xmlToDeploy = xmlToDeploy.replace(/<label>[^<]*<\/label>/, `<label>${nameOverride.replace(/_/g,' ')}</label>`);
    }
  }

  showProgress(`Deploying Flow to Salesforce (API v${apiVersion})…`);
  el.btnDeploy.disabled = true;

  try {
    const { flowName, jobId } = await deployFlow(
      xmlToDeploy,
      apiVersion,
      (msg) => {
        if (cancelRequested) throw new Error('Deployment cancelled by user.');
        updateProgress(msg);
      }
    );

    hideProgress();
    setStatus(`✅ Flow "${flowName}" deployed successfully (job: ${jobId})`, 'ok');
    appendMessage('system', `✅ Flow "${flowName}" deployed to Salesforce (API v${apiVersion})`);
    switchTab('chat');
    log.info(`Flow "${flowName}" deployed successfully, job ${jobId}`);
  } catch (err) {
    hideProgress();
    log.error('Deploy failed:', err);
    setStatus(`Deploy failed: ${err.message}`, 'error');
    appendErrorMessage(`Deploy failed: ${err.message}`);
    switchTab('chat');
  } finally {
    el.btnDeploy.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// History management
// ---------------------------------------------------------------------------
async function loadHistory() {
  const { flowHistory = [] } = await chrome.storage.local.get('flowHistory');
  return flowHistory;
}

async function saveToHistory(prompt, xml) {
  const history = await loadHistory();
  history.unshift({
    id:        Date.now(),
    prompt:    prompt.slice(0, 120),
    xml,
    flowName:  extractFlowName(xml),
    savedAt:   new Date().toISOString(),
  });
  // Keep bounded
  const trimmed = history.slice(0, MAX_HISTORY_SESSIONS);
  await chrome.storage.local.set({ flowHistory: trimmed });
  await renderHistory(trimmed);
}

async function renderHistory(items = null) {
  const history = items || await loadHistory();
  if (history.length === 0) {
    el.historyList.innerHTML = '<div class="history-empty">No previous flows yet. Generate a flow using the Chat tab.</div>';
    return;
  }

  el.historyList.innerHTML = '';
  for (const item of history) {
    const div = document.createElement('div');
    div.className = 'history-item';
    div.innerHTML = `
      <div class="hi-prompt">${escHtml(item.flowName || 'Unnamed Flow')}</div>
      <div class="hi-meta">${escHtml(item.prompt)} · ${new Date(item.savedAt).toLocaleString()}</div>
    `;
    div.addEventListener('click', () => {
      setXml(item.xml);
      switchTab('xml');
      setStatus(`Loaded: ${item.flowName}`, 'ok');
    });
    el.historyList.appendChild(div);
  }
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ---------------------------------------------------------------------------
// New chat
// ---------------------------------------------------------------------------
function newChat() {
  chatHistory = [];
  // Keep welcome message, remove others
  const msgs = el.chatMessages.querySelectorAll('.msg:not(.msg-system)');
  msgs.forEach(m => m.remove());
  setStatus('New conversation started.', '');
  switchTab('chat');
  el.chatInput.focus();
}

// ---------------------------------------------------------------------------
// Textarea auto-resize
// ---------------------------------------------------------------------------
function adjustTextarea() {
  const ta = el.chatInput;
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, 100)}px`;
}

// ---------------------------------------------------------------------------
// XML editing
// ---------------------------------------------------------------------------
let xmlEditMode = false;
el.btnEditXml.addEventListener('click', () => {
  xmlEditMode = !xmlEditMode;
  if (xmlEditMode) {
    // Switch to plain-text mode for editing
    el.xmlEditor.textContent = currentXml;
    el.xmlEditor.contentEditable = 'true';
    el.btnEditXml.textContent = '✅ Done';
    el.xmlEditor.focus();
  } else {
    // Commit edits
    const edited = el.xmlEditor.innerText;
    setXml(edited);
    el.btnEditXml.textContent = '✏️ Edit';
  }
});

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------
el.btnSend.addEventListener('click', handleSend);

el.chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    handleSend();
  }
});

el.chatInput.addEventListener('input', adjustTextarea);

el.btnNewChat.addEventListener('click', newChat);

el.btnSettings.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

el.btnRefreshConn.addEventListener('click', () => refreshConnection(true));

el.btnDeploy.addEventListener('click', handleDeploy);

el.btnCancelOp.addEventListener('click', () => {
  cancelRequested = true;
  hideProgress();
  setStatus('Operation cancelled', '');
  el.btnDeploy.disabled = false;
});

el.btnCopyXml.addEventListener('click', async () => {
  if (!currentXml) return;
  try {
    await navigator.clipboard.writeText(currentXml);
    el.btnCopyXml.textContent = '✅ Copied';
    setTimeout(() => { el.btnCopyXml.textContent = '📋 Copy'; }, 2000);
  } catch {
    setStatus('Copy failed – try Ctrl+A / Ctrl+C in the editor', 'error');
  }
});

el.btnClearXml.addEventListener('click', () => {
  setXml('');
  setStatus('XML cleared', '');
});

el.btnClearHistory.addEventListener('click', async () => {
  if (!confirm('Clear all saved flow history?')) return;
  await chrome.storage.local.remove('flowHistory');
  await renderHistory([]);
});

// Listen for background health updates
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'HEALTH_UPDATE') {
    if (msg.status?.ok) {
      setConnPill('ok');
    } else if (msg.status) {
      setConnPill('error');
      setStatus(msg.status.error || 'Disconnected', 'error');
    }
  }
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
  await refreshConnection(false);
  await renderHistory();

  // Prompt user if not configured
  const { aiApiKey, sfInstanceUrl } = await chrome.storage.local.get(['aiApiKey', 'sfInstanceUrl']);
  if (!aiApiKey || !sfInstanceUrl) {
    setStatus('⚠ Open Settings (⚙️) to configure AI and Salesforce', 'error');
  }

  el.chatInput.focus();
}

init();

// Background service worker (Manifest V3).
// Responsibilities:
//   • Periodic Salesforce connection health polling (chrome.alarms)
//   • Badge updates to show connection status at a glance
//   • Token expiry checks
//   • Message routing between popup <-> service worker

import { checkConnection } from './lib/salesforce.js';
import { log } from './lib/logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ALARM_NAME        = 'sf-health-poll';
const POLL_INTERVAL_MIN = 5;   // minutes

const BADGE = {
  connected:     { text: '✓',  color: '#1589EE' },
  disconnected:  { text: '✗',  color: '#C23934' },
  checking:      { text: '…',  color: '#706E6B' },
  error:         { text: '!',  color: '#FF8800' },
};

// ---------------------------------------------------------------------------
// Alarm setup
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(({ reason }) => {
  log.info(`Extension installed/updated. Reason: ${reason}`);
  scheduleAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  log.info('Browser started – scheduling health alarm');
  scheduleAlarm();
});

function scheduleAlarm() {
  chrome.alarms.get(ALARM_NAME, (existing) => {
    if (!existing) {
      chrome.alarms.create(ALARM_NAME, {
        delayInMinutes:  0.1,        // first check in ~6 s
        periodInMinutes: POLL_INTERVAL_MIN,
      });
      log.info(`Alarm "${ALARM_NAME}" created (every ${POLL_INTERVAL_MIN} min)`);
    }
  });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    await runHealthCheck();
  }
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

let lastStatus = null;

async function runHealthCheck() {
  setBadge(BADGE.checking);
  log.debug('Running Salesforce health check…');

  const result = await checkConnection();

  if (result.ok) {
    setBadge(BADGE.connected);
    lastStatus = { ok: true, checkedAt: Date.now() };
    log.info('Health check: connected');
  } else {
    setBadge(BADGE.disconnected);
    lastStatus = { ok: false, error: result.error, checkedAt: Date.now() };
    log.warn('Health check: disconnected –', result.error);
  }

  // Notify open popups so they can refresh status indicators
  broadcastToPopup({ type: 'HEALTH_UPDATE', status: lastStatus });
}

function setBadge({ text, color }) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleMessage(msg).then(sendResponse).catch(err => {
    log.error('Message handler error:', err);
    sendResponse({ error: err.message });
  });
  return true; // keep channel open for async response
});

async function handleMessage(msg) {
  switch (msg.type) {
    case 'GET_STATUS':
      return { status: lastStatus };

    case 'FORCE_HEALTH_CHECK':
      await runHealthCheck();
      return { status: lastStatus };

    case 'GET_LOGS':
      return { logs: log.getEntries() };

    default:
      return { error: `Unknown message type: ${msg.type}` };
  }
}

function broadcastToPopup(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // No popup open – ignore
  });
}

// Run an initial health check when the service worker wakes
runHealthCheck();

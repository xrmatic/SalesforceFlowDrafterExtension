// Salesforce API client.
// Handles OAuth 2.0 (PKCE), token storage, Tooling API deployRequest,
// and connection-health polling with retry logic.

import { log } from './logger.js';
import { createZip, toBase64 } from './zip.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const TOKEN_REFRESH_BUFFER_MS = 10 * 60 * 1000; // refresh 10 min before expiry
const DEFAULT_TIMEOUT_MS       = 30_000;
const MAX_DEPLOY_POLL_ATTEMPTS = 20;
const DEPLOY_POLL_INTERVAL_MS  = 3_000;

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

function base64UrlEncode(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function generatePKCE() {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = base64UrlEncode(verifierBytes);
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = base64UrlEncode(hashBuffer);
  return { verifier, challenge };
}

// ---------------------------------------------------------------------------
// Storage helpers (always use chrome.storage.local – never synced)
// ---------------------------------------------------------------------------

async function loadTokens() {
  const keys = ['sfAccessToken', 'sfRefreshToken', 'sfInstanceUrl', 'sfTokenExpiry', 'sfUserId', 'sfOrgId'];
  return chrome.storage.local.get(keys);
}

async function saveTokens(tokens) {
  await chrome.storage.local.set(tokens);
}

async function clearTokens() {
  await chrome.storage.local.remove(['sfAccessToken', 'sfRefreshToken', 'sfInstanceUrl', 'sfTokenExpiry', 'sfUserId', 'sfOrgId']);
}

// ---------------------------------------------------------------------------
// Token exchange helpers
// ---------------------------------------------------------------------------

async function exchangeCodeForToken(instanceUrl, clientId, code, verifier) {
  const params = new URLSearchParams({
    grant_type:    'authorization_code',
    code,
    client_id:     clientId,
    redirect_uri:  `https://${chrome.runtime.id}.chromiumapp.org/`,
    code_verifier: verifier,
  });

  const resp = await fetchWithTimeout(`${instanceUrl}/services/oauth2/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    params.toString(),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Token exchange failed (${resp.status}): ${body}`);
  }

  const data = await resp.json();
  return data;
}

async function refreshAccessToken(instanceUrl, clientId, refreshToken) {
  const params = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: refreshToken,
    client_id:     clientId,
  });

  const resp = await fetchWithTimeout(`${instanceUrl}/services/oauth2/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    params.toString(),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Token refresh failed (${resp.status}): ${body}`);
  }

  return resp.json();
}

// ---------------------------------------------------------------------------
// Fetch wrapper with timeout
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs / 1000}s: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Authenticated fetch – auto-refreshes token when needed
// ---------------------------------------------------------------------------

async function authedFetch(url, options = {}, settings = null) {
  let { sfAccessToken, sfRefreshToken, sfInstanceUrl, sfTokenExpiry } = await loadTokens();

  if (!sfAccessToken) throw new Error('Not authenticated. Please connect to Salesforce in Settings.');

  // Proactively refresh if close to expiry
  if (sfTokenExpiry && Date.now() > sfTokenExpiry - TOKEN_REFRESH_BUFFER_MS) {
    log.info('Access token near expiry – refreshing…');
    const cfg = settings || await chrome.storage.local.get(['sfClientId']);
    const freshData = await refreshAccessToken(sfInstanceUrl, cfg.sfClientId, sfRefreshToken);
    sfAccessToken = freshData.access_token;
    const expiryMs = freshData.expires_in ? Date.now() + freshData.expires_in * 1000 : null;
    await saveTokens({
      sfAccessToken,
      sfTokenExpiry: expiryMs,
      ...(freshData.refresh_token ? { sfRefreshToken: freshData.refresh_token } : {}),
    });
    log.info('Token refreshed successfully');
  }

  const resp = await fetchWithTimeout(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${sfAccessToken}`,
    },
  });

  // If still 401, tokens are invalid – clear them
  if (resp.status === 401) {
    await clearTokens();
    throw new Error('Salesforce session expired. Please reconnect in Settings.');
  }

  return resp;
}

// ---------------------------------------------------------------------------
// Public: OAuth flow
// ---------------------------------------------------------------------------

/**
 * Launch the Salesforce OAuth PKCE flow via chrome.identity.
 * @param {string} instanceUrl   e.g. https://myorg.my.salesforce.com
 * @param {string} clientId      Connected App consumer key
 * @returns {Promise<{userId:string, orgId:string}>}
 */
export async function connectSalesforce(instanceUrl, clientId) {
  if (!instanceUrl) throw new Error('Salesforce instance URL is required.');
  if (!clientId)    throw new Error('Connected App Client ID (Consumer Key) is required.');

  const cleanUrl = instanceUrl.replace(/\/$/, '');
  const { verifier, challenge } = await generatePKCE();
  const redirectUri = `https://${chrome.runtime.id}.chromiumapp.org/`;

  // Persist verifier temporarily (service worker may restart between calls)
  await chrome.storage.local.set({ _pkceVerifier: verifier });

  const authParams = new URLSearchParams({
    response_type:         'code',
    client_id:             clientId,
    redirect_uri:          redirectUri,
    scope:                 'api refresh_token',
    code_challenge:        challenge,
    code_challenge_method: 'S256',
  });

  const authUrl = `${cleanUrl}/services/oauth2/authorize?${authParams}`;
  log.info('Launching OAuth flow…');

  const responseUrl = await new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: authUrl, interactive: true },
      (url) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(url);
        }
      }
    );
  });

  if (!responseUrl) throw new Error('OAuth flow was cancelled or failed.');

  const params = new URL(responseUrl).searchParams;
  const code  = params.get('code');
  const error = params.get('error');

  if (error) throw new Error(`OAuth error: ${error} – ${params.get('error_description') || ''}`);
  if (!code)  throw new Error('No authorization code received from Salesforce.');

  const { _pkceVerifier: storedVerifier } = await chrome.storage.local.get('_pkceVerifier');
  await chrome.storage.local.remove('_pkceVerifier');

  const tokenData = await exchangeCodeForToken(cleanUrl, clientId, code, storedVerifier);
  log.info('OAuth token exchange successful');

  const expiryMs = tokenData.expires_in ? Date.now() + tokenData.expires_in * 1000 : null;
  await saveTokens({
    sfAccessToken:  tokenData.access_token,
    sfRefreshToken: tokenData.refresh_token || null,
    sfInstanceUrl:  cleanUrl,
    sfTokenExpiry:  expiryMs,
    sfUserId:       tokenData.id?.split('/').pop() || null,
    sfOrgId:        tokenData.id?.split('/').slice(-2)[0] || null,
  });
  await chrome.storage.local.set({ sfClientId: clientId });

  return {
    userId: tokenData.id?.split('/').pop(),
    orgId:  tokenData.id?.split('/').slice(-2)[0],
  };
}

/**
 * Revoke tokens and clear stored credentials.
 */
export async function disconnectSalesforce() {
  const { sfAccessToken, sfInstanceUrl } = await loadTokens();
  if (sfAccessToken && sfInstanceUrl) {
    try {
      await fetchWithTimeout(`${sfInstanceUrl}/services/oauth2/revoke`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    `token=${encodeURIComponent(sfAccessToken)}`,
      }, 10_000);
    } catch (e) {
      log.warn('Token revocation request failed (ignored):', e.message);
    }
  }
  await clearTokens();
  log.info('Disconnected from Salesforce');
}

// ---------------------------------------------------------------------------
// Public: Connection health check
// ---------------------------------------------------------------------------

/**
 * Check whether the stored access token can reach Salesforce.
 * @returns {Promise<{ok: boolean, apiVersions?: string[], error?: string}>}
 */
export async function checkConnection() {
  try {
    const { sfAccessToken, sfInstanceUrl } = await loadTokens();
    if (!sfAccessToken || !sfInstanceUrl) {
      return { ok: false, error: 'Not authenticated' };
    }

    const resp = await authedFetch(`${sfInstanceUrl}/services/data/`);

    if (resp.ok) {
      const versions = await resp.json();
      return { ok: true, apiVersions: versions.map(v => v.version) };
    }
    return { ok: false, error: `HTTP ${resp.status}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Public: Deploy Flow metadata XML via Tooling API
// ---------------------------------------------------------------------------

/**
 * Build the package.xml required by the Metadata deploy.
 */
function buildPackageXml(apiVersion) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
    <types>
        <members>*</members>
        <name>Flow</name>
    </types>
    <version>${apiVersion}</version>
</Package>`;
}

/**
 * Poll a deployRequest async result until complete or timed-out.
 * @param {string} instanceUrl
 * @param {string} apiVersion
 * @param {string} jobId
 * @param {Function} onProgress  callback(message: string)
 * @returns {Promise<object>} deploy result
 */
async function pollDeployResult(instanceUrl, apiVersion, jobId, onProgress) {
  for (let attempt = 1; attempt <= MAX_DEPLOY_POLL_ATTEMPTS; attempt++) {
    await new Promise(r => setTimeout(r, DEPLOY_POLL_INTERVAL_MS));

    const resp = await authedFetch(
      `${instanceUrl}/services/data/v${apiVersion}/tooling/deployRequest/${jobId}?includeDetails=true`
    );

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Deploy poll failed (${resp.status}): ${body}`);
    }

    const result = await resp.json();
    const status = result?.deployResult?.status || result?.status;
    const done   = result?.deployResult?.done   ?? result?.done;

    onProgress(`Deploy status: ${status} (attempt ${attempt}/${MAX_DEPLOY_POLL_ATTEMPTS})`);
    log.info(`Deploy poll ${attempt}: status=${status} done=${done}`);

    if (done) {
      const success = result?.deployResult?.success ?? result?.success;
      if (!success) {
        const failures = result?.deployResult?.details?.componentFailures;
        const msg = Array.isArray(failures)
          ? failures.map(f => f.problem).join('; ')
          : JSON.stringify(result);
        throw new Error(`Deployment failed: ${msg}`);
      }
      return result;
    }
  }
  throw new Error(`Deployment timed out after ${MAX_DEPLOY_POLL_ATTEMPTS} polls (${(MAX_DEPLOY_POLL_ATTEMPTS * DEPLOY_POLL_INTERVAL_MS) / 1000}s).`);
}

/**
 * Deploy a Flow Metadata XML string to Salesforce via the Tooling API deployRequest.
 *
 * @param {string} flowXml        Complete Flow metadata XML
 * @param {string} apiVersion     e.g. '62.0'
 * @param {Function} onProgress   callback(message: string) for status updates
 * @returns {Promise<{flowName: string, jobId: string, result: object}>}
 */
export async function deployFlow(flowXml, apiVersion, onProgress = () => {}) {
  const { sfInstanceUrl } = await loadTokens();
  if (!sfInstanceUrl) throw new Error('Not connected to Salesforce.');

  // Derive the flow API name from the XML
  const fullNameMatch = flowXml.match(/<fullName>([^<]+)<\/fullName>/);
  const labelMatch    = flowXml.match(/<label>([^<]+)<\/label>/);
  let flowName =
    fullNameMatch?.[1]?.trim() ||
    labelMatch?.[1]?.trim().replace(/[^a-zA-Z0-9_]/g, '_') ||
    `GeneratedFlow_${Date.now()}`;

  // Sanitise: no spaces, valid API name characters
  flowName = flowName.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
  if (!flowName) flowName = `GeneratedFlow_${Date.now()}`;

  onProgress(`Preparing ZIP for Flow "${flowName}"…`);
  log.info(`Deploying flow: ${flowName}, API v${apiVersion}`);

  const packageXml = buildPackageXml(apiVersion);

  // Inject apiVersion into the XML if not already present
  let finalXml = flowXml;
  if (!/<apiVersion>/.test(finalXml)) {
    finalXml = finalXml.replace(
      /(<Flow[^>]*>)/,
      `$1\n    <apiVersion>${apiVersion}</apiVersion>`
    );
  }

  const zipBytes = createZip([
    { name: 'package.xml',                        content: packageXml },
    { name: `flows/${flowName}.flow-meta.xml`,     content: finalXml  },
  ]);

  const zipBase64 = toBase64(zipBytes);
  onProgress('Sending deploy request to Salesforce…');

  const resp = await authedFetch(
    `${sfInstanceUrl}/services/data/v${apiVersion}/tooling/deployRequest`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        zipFile: zipBase64,
        deployOptions: {
          allowMissingFiles:   false,
          autoUpdatePackage:   false,
          checkOnly:           false,
          ignoreWarnings:      false,
          rollbackOnError:     true,
          runTests:            [],
          testLevel:           'NoTestRun',
          singlePackage:       true,
        },
      }),
    }
  );

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Deploy request failed (${resp.status}): ${body}`);
  }

  const jobData = await resp.json();
  const jobId   = jobData?.id || jobData?.deployResult?.id;
  if (!jobId) throw new Error('No job ID returned from deploy request.');

  onProgress(`Deploy job started (ID: ${jobId}). Monitoring…`);
  log.info(`Deploy job ID: ${jobId}`);

  const result = await pollDeployResult(sfInstanceUrl, apiVersion, jobId, onProgress);
  log.info('Deploy completed successfully');

  return { flowName, jobId, result };
}

/**
 * Retrieve the list of existing Flow API names from the org (for context/autocomplete).
 * @param {string} apiVersion
 * @returns {Promise<Array<{id:string, label:string, apiName:string}>>}
 */
export async function listFlows(apiVersion) {
  const { sfInstanceUrl } = await loadTokens();
  if (!sfInstanceUrl) return [];

  try {
    const resp = await authedFetch(
      `${sfInstanceUrl}/services/data/v${apiVersion}/tooling/query?q=${encodeURIComponent(
        'SELECT Id, DeveloperName, MasterLabel FROM FlowDefinition ORDER BY MasterLabel LIMIT 200'
      )}`
    );
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data?.records || []).map(r => ({
      id:      r.Id,
      label:   r.MasterLabel,
      apiName: r.DeveloperName,
    }));
  } catch (err) {
    log.warn('listFlows failed:', err.message);
    return [];
  }
}

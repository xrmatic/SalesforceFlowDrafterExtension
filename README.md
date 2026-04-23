# Salesforce Flow Drafter – Chrome / Edge Extension

> **AI-powered Salesforce Flow builder.** Describe a Flow in plain language, receive deployable Flow Metadata XML from your AI of choice, and push it directly to your Salesforce org via the Tooling API – all from one browser extension.

---

## Features

| Feature | Details |
|---|---|
| **Chat with AI** | Describe your Flow in natural language; the AI returns ready-to-deploy XML |
| **Multiple AI providers** | OpenAI (GPT-4o, GPT-4), Anthropic (Claude 3.5 Sonnet, Claude 3 Opus), or any OpenAI-compatible endpoint (Ollama, LM Studio, vLLM…) |
| **Salesforce API version picker** | Choose from API v55–v63; version is applied to the XML and all Tooling API calls |
| **One-click deploy** | Creates a ZIP, posts to Tooling API `deployRequest`, and polls until complete |
| **XML editor** | Review, syntax-highlight, and edit generated XML before deploying |
| **Session history** | Last 30 generated flows are saved locally for quick re-use |
| **Connection health polling** | Background service worker checks the SF connection every 5 minutes and updates the badge |
| **Token management** | OAuth 2.0 with PKCE (no client secret stored), automatic proactive token refresh |
| **Secure credential storage** | All keys/tokens stored in `chrome.storage.local` – never synced to the cloud |
| **Bounded memory** | Log ring-buffer capped at 500 entries; chat history truncated at 40 turns |
| **Cancellable operations** | Cancel long-running deploys mid-flight |
| **Debug log viewer** | Download extension logs as a `.txt` file from the Settings page |

---

## Quick Start

### 1 · Install the extension

1. Clone or download this repository.
2. Open Chrome / Edge and navigate to `chrome://extensions` (or `edge://extensions`).
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the repository folder.
5. The extension icon (🔵 circle) appears in the toolbar.

### 2 · Create a Salesforce Connected App

1. In Salesforce Setup, search for **App Manager** → **New Connected App**.
2. Enable **OAuth Settings**.
3. Set the **Callback URL** to:
   ```
   https://<your-extension-id>.chromiumapp.org/
   ```
   *(Your extension ID is shown on `chrome://extensions`.)*
4. Select OAuth scopes: `api`, `refresh_token / offline_access`.
5. Save and copy the **Consumer Key** (Client ID).

> **PKCE is used** – no client secret is required or stored in the extension.

### 3 · Configure the extension

Click the **⚙️ Settings** button (or right-click the icon → *Options*):

| Section | What to fill in |
|---|---|
| AI Provider | Choose OpenAI / Anthropic / Custom |
| API Key | Your `sk-…` or `sk-ant-…` key |
| Model | Select the model (e.g. GPT-4o) |
| Salesforce Instance URL | e.g. `https://myorg.my.salesforce.com` |
| Consumer Key | From your Connected App |
| API Version | Choose the Salesforce API version |

Click **Connect to Salesforce** – a browser window opens for OAuth login.

### 4 · Generate and deploy a Flow

1. Click the extension icon to open the popup.
2. Type a description in the chat box, e.g.:
   > *"Create a screen flow that collects an Account name and creates a new Account record."*
3. The AI generates Flow Metadata XML.  Switch to the **XML Preview** tab to review it.
4. Optionally edit the Flow API name in the text field at the bottom.
5. Click **🚀 Deploy to Salesforce** – progress is shown while the deploy polls for completion.
6. A success/failure message appears in the chat.

---

## Architecture

```
SalesforceFlowDrafterExtension/
├── manifest.json          Manifest V3 – permissions, background SW, popup/options
├── background.js          Service worker: health polling, badge, token refresh
├── popup.html/js/css      Chat UI, XML preview, deploy, history
├── options.html/js/css    Settings: AI config, SF OAuth, API version, log viewer
└── lib/
    ├── ai.js              AI provider abstraction (OpenAI, Anthropic, Custom)
    ├── salesforce.js      Salesforce OAuth PKCE + Tooling API deploy client
    ├── zip.js             Pure-JS minimal ZIP creator (no external deps)
    └── logger.js          Memory-bounded, levelled logger
```

### Security model

* **Keys never leave your device** to any server except your chosen AI provider and Salesforce.
* Salesforce tokens are stored only in `chrome.storage.local` (not `chrome.storage.sync`).
* OAuth 2.0 PKCE flow – no client secret is required.
* The extension CSP blocks inline scripts and remote script loading.

---

## Supported AI Providers

| Provider | Models |
|---|---|
| OpenAI | gpt-4o, gpt-4o-mini, gpt-4-turbo, gpt-4, gpt-3.5-turbo |
| Anthropic | claude-3-5-sonnet-20241022, claude-3-opus-20240229, claude-3-haiku-20240307 |
| Custom | Any OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, Azure OpenAI, …) |

For custom endpoints, enter the **Base URL** (e.g. `http://localhost:11434`) and the model name.

---

## Supported Salesforce API Versions

63.0 (Spring '25) through 55.0 (Summer '22). The selected version is:
- Embedded in the generated XML as `<apiVersion>`
- Used for all Tooling API calls (`/services/data/v{version}/tooling/…`)

---

## Permissions Used

| Permission | Why |
|---|---|
| `storage` | Store settings and tokens locally |
| `identity` | OAuth browser flow via `chrome.identity.launchWebAuthFlow` |
| `alarms` | Periodic Salesforce health polling (every 5 min) |
| `notifications` | (reserved for future use) |

---

## Development

No build step is required – the extension is pure ES Modules (no bundler).

To reload after code changes: go to `chrome://extensions` and click the **↻ Reload** button on the extension card.

---

## Privacy

All data (API keys, Salesforce tokens, generated XML, chat history) is stored locally in your browser profile. Nothing is transmitted to any third-party server operated by this extension. Your prompts are sent to your configured AI provider; your Flow XML is sent to your Salesforce org.
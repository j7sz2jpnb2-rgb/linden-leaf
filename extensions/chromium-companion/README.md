# Linden Leaf AI Companion (Chromium Manifest V3 Extension)

The **Linden Leaf AI Companion** extension bridges the Windows desktop reader with your own logged-in web AI sessions in Chromium-based browsers (Chrome, Edge, Brave, etc.), enabling continuous per-book reading conversations without API keys, third-party relay servers, or fragile embedded WebViews.

## Why an External Browser Companion?

- **No login breakage or anti-bot walls**: Google/OpenAI/DeepSeek OAuth and Cloudflare checks run inside your normal browser profile rather than a restricted WebView.
- **Persistent per-book conversation threads**: Selected book passages, follow-up prompts, and custom instructions route back into the active book's browser conversation tab instead of spawning new tabs on every query.
- **Two-way workflow**: Send selected text or context prompts from Linden Leaf and capture replies back into Linden Leaf book notes via `Alt+Shift+S` or the extension popup/dock action.

## Supported Sites

Built-in rules in [`adapters/rules.json`](adapters/rules.json) support:
- **ChatGPT** (`https://chatgpt.com/*`, `https://chat.openai.com/*`)
- **Gemini** (`https://gemini.google.com/*`)
- **Google AI Studio** (`https://aistudio.google.com/*`)
- **DeepSeek** (`https://chat.deepseek.com/*`)
- Custom HTTPS endpoints when explicitly granted by the user via `optional_host_permissions`.

## Setup (Windows Desktop)

1. Open Chrome or Edge and navigate to `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode** in the top-right corner.
3. Click **Load unpacked** and select this `extensions/chromium-companion` directory (in an installed build, you can click **Open Extension Folder** directly inside Linden Leaf's AI Companion settings).
4. Copy the generated **Extension ID** shown on the card.
5. In Linden Leaf **Settings → AI Companion (External Browser)**:
   - Choose your browser & profile and paste the Extension ID.
   - Click **Install Native Messaging Host** to register `com.lindenleaf.companion` for your user account.
   - Toggle **Side-by-Side Docking** if you want Linden Leaf and the companion browser window to snap neatly side by side.

## Security & Privacy Model

- **Local-only IPC**: Communication uses Chromium **Native Messaging** (`com.lindenleaf.companion`) over Windows user-SID DACL-protected IPC, with an authenticated `127.0.0.1` pair-token loopback fallback when needed, capped at strict 1 MiB message framing (`MAX_IPC_MESSAGE_BYTES` in `src-tauri/src/commands/ai_companion.rs`).
- **Least-privilege permissions**: Only requests `nativeMessaging`, `scripting`, `tabs`, `contextMenus`, `storage`, and explicit hosts for the four built-in AI providers (`optional_host_permissions` requires explicit runtime grant).
- **No external relay**: Linden Leaf does not proxy, store, or transmit your AI web session cookies or credentials.

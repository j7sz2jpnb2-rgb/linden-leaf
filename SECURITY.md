# Security Policy · 安全政策

## Supported Versions

Security fixes apply to the latest `1.0.x` line on the `main` branch.

| Version | Supported |
| --- | --- |
| `1.0.x` | Yes |

## Security Design Overview

- **Sandboxed Rendering**: Reflowable ebook content (`EPUB`, `MOBI`, `TXT`, `DOCX`, etc.) is isolated inside script-disabled frames.
- **Credential Protection**: Cloud sync tokens, WebDAV passwords, AI keys, TTS keys, and OAuth tokens are encrypted locally via **Windows DPAPI** and **Android Keystore (AES-GCM)** and excluded from exported sync/backup data.
- **IPC & Redirect Hardening**:
  - Public HTTPS download commands enforce strict redirect depth limits and block HTTP downgrades as well as loopback/RFC1918/link-local SSRF targets (`src-tauri/src/commands/mod.rs`).
  - Windows External Browser AI Companion IPC restricts named pipes to the current user SID DACL and enforces 1 MiB message framing (`src-tauri/src/commands/ai_companion.rs`).
  - Pre-built MuPDF 1.25.4 binaries include backported fixes documented in [patches/README.md](patches/README.md) (`CVE-2026-7233`, `CVE-2026-3308`, `CVE-2026-25556`).

## Reporting a Vulnerability / 报告安全漏洞

If you discover a security vulnerability (such as XSS/script escape in document rendering, IPC privilege escalation, path traversal, or credential leakage):

1. **Please do NOT open a public GitHub issue with exploit details.**
2. Use GitHub **Private Vulnerability Reporting** (**Security → Advisories → Report a vulnerability**) on this repository if enabled, or contact the maintainer privately through the profile listed on the repository page.
3. Please include:
   - Affected component (`src-tauri`, MuPDF bridge, Foliate sandbox, sync, OCR, or Chromium companion) and platform (Windows / Android).
   - Minimal reproduction steps or proof-of-concept file/input (without sensitive user data).
   - Impact assessment and suggested remediation if known.

We aim to acknowledge reports within 72 hours and coordinate a fix before public disclosure.

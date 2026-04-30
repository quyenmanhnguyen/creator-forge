# E2E AutoGrok image-generate test (PR-9 + PR-11)

A standalone Node script (`scripts/e2e_autogrok_image.js`) that exercises the
real Grok Imagine WebSocket from your local machine and verifies the two
regression fixes shipped in this repo:

| Fix | What it asserts |
| --- | --- |
| **PR-9** — `enable_pro` default OFF | Requesting `imageGenerationCount: 4` actually returns **4** images (Pro mode would force 1). |
| **PR-9** — WS `completed` handler rejects `<50KB` blobs | None of the saved files are blur / moderation placeholders. |
| **PR-11** — persistent userDataDir | Cookies live in `GROK_PROFILE_DIR` and survive across script runs (no re-login on the second invocation). |
| **PR-11** — `openManualLogin` headful flow | If no session exists, the script opens Chrome for you to sign in by hand — no email/password is stored anywhere. |

> Why local? The Devin VM IP is in an Azure datacenter range that Cloudflare
> currently 403s on `accounts.x.ai/sign-in`. Grok login from a residential
> IP works fine, so the live test runs on your machine.

---

## 1. Prerequisites

- **Node.js 20+** (`node --version`).
- **Google Chrome or Microsoft Edge** installed somewhere
  `findChromePath` can locate (default install paths on macOS / Windows / Linux,
  or set `CHROME_EXECUTABLE_PATH=/path/to/chrome`).
- **Git**.
- A working **Grok account** (https://grok.com).
- ~500 MB free disk for `desktop/node_modules` (Puppeteer + Chrome cache).

You do **not** need ffmpeg, the Python sidecar, the YouTube/DeepSeek API
keys, or Electron — the harness drives `ImageService` directly via Node.

---

## 2. One-time setup

```bash
git clone https://github.com/quyenmanhnguyen/creator-forge.git
cd creator-forge
git pull --ff-only origin main      # always run on the latest main
cd desktop
npm install                          # installs puppeteer-extra + stealth + axios
cd ..
```

Pick a stable persistent profile location (anywhere outside the repo is
fine). Recommended:

```bash
# macOS / Linux
export GROK_PROFILE_DIR="$HOME/.creator-forge/grok-profile"

# Windows (PowerShell)
$env:GROK_PROFILE_DIR = "$env:USERPROFILE\.creator-forge\grok-profile"
```

Optional: pin Chrome path if auto-detect fails.

```bash
export CHROME_EXECUTABLE_PATH="/usr/bin/google-chrome"     # Linux
# export CHROME_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"  # macOS
# $env:CHROME_EXECUTABLE_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe"          # Windows
```

---

## 3. Run the harness

```bash
GROK_EMAIL="you@example.com" \
  node scripts/e2e_autogrok_image.js
```

(Windows PowerShell:
`$env:GROK_EMAIL="you@example.com"; node scripts\e2e_autogrok_image.js`)

### What happens

1. The script resolves the **per-account profile dir**:
   `<GROK_PROFILE_DIR>/<emailWithUnderscores>` (this matches the path
   `setupAccount` uses, so the cookies you save here are reused on every
   subsequent run of the app and the harness).
2. If that dir has no Grok cookies yet, **a Chrome window opens at the Grok
   sign-in page**. Sign in by hand. You do **not** type your password into
   the script — the script never sees it. The window auto-closes once you
   reach `grok.com`.
3. The script then re-launches Puppeteer with the same userDataDir,
   navigates to `accounts.x.ai/account` (no redirect → session OK), then
   `grok.com/`, and captures the `x-statsig-id` request header that the
   real ImageService needs.
4. `ImageService.generateBatch` is called once with:

   ```js
   { imageGenerationCount: 4, enablePro: false,
     outputFolder: ./e2e-output/<timestamp>/,
     aspectRatio: "1:1", batchSize: 1 }
   ```

   on the prompt `"A serene mountain lake at dawn, photorealistic, soft
   volumetric light, mist rising from water, ultra-detailed, 8k"`
   (override with `GROK_E2E_PROMPT`).
5. Saved files are written to `./e2e-output/<ISO-timestamp>/`. The script
   prints each filename, byte size, and a `⚠️ <50KB (BLUR/MOD)` flag if
   anything looks like a blur/moderation placeholder.

### Expected output (PASS)

```
[E2E ...] ✅ Existing Grok session found at account profile dir — reusing cookies.
[E2E ...] → Capturing x-statsig-id + cookies via setupAccount(...)
[E2E ...] ✅ Headers captured (x-statsig-id len: 188 )
[E2E ...] ✅ Cookies for grok.com: 23
[E2E ...] → ImageService.generateBatch — 1 prompt × 1 batch (count=4)
[E2E ...] → progress 100% — OK (#1)
[E2E ...] → Generation finished in 18.4 s
[E2E ...] Result: success= true title= 'Mountain Lake Dawn' error= undefined
[E2E ...] savedFiles count : 4 (requested: 4)
[E2E ...]   [1/4] shot0001_..._i0.png — 612345 bytes
[E2E ...]   [2/4] shot0001_..._i1.png — 588120 bytes
[E2E ...]   [3/4] shot0001_..._i2.png — 605998 bytes
[E2E ...]   [4/4] shot0001_..._i3.png — 599441 bytes
[E2E ...] Summary
[E2E ...]   Requested        : 4
[E2E ...]   Returned         : 4
[E2E ...]   Usable (≥ 50KB)  : 4
[E2E ...]   Suspicious < 50KB: 0
[E2E ...] ✅ PASS — PR-9 + PR-11 verified end-to-end.
```

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | All assertions passed (PR-9 + PR-11 verified). |
| `1` | Generic / setup error (read the stack trace). |
| `2` | Manual login window timed out or was closed early. |
| `3` | `setupAccount` could not capture `x-statsig-id` — usually session expired or Cloudflare turnstile blocked the relaunch. |
| `4` | Returned fewer images than requested (PR-9 regression). |
| `5` | Some images were `<50KB` (PR-9 blur-rejection regression). |

---

## 4. Optional knobs

| Env | Default | Purpose |
| --- | --- | --- |
| `GROK_PROFILE_DIR` | `~/.creator-forge/grok-profile` | Persistent userDataDir root (per-account subdir is auto-derived from `GROK_EMAIL`). |
| `GROK_E2E_COUNT` | `4` | `imageGenerationCount` passed to ImageService. |
| `GROK_E2E_PROMPT` | (mountain lake prompt) | Override the test prompt. |
| `GROK_E2E_OUTPUT_DIR` | `<repo>/e2e-output/<timestamp>` | Where saved images are written. |
| `GROK_E2E_TIMEOUT_MS` | `600000` (10 min) | How long the manual-login window waits before giving up. |
| `CHROME_EXECUTABLE_PATH` | (auto-detect) | Pin Chrome / Edge binary. |

---

## 5. Troubleshooting

### `Sorry, you have been blocked` / Cloudflare 403 on `accounts.x.ai`
Your IP is on Cloudflare's datacenter / VPN block list. Move to a
residential IP (turn off VPN, use mobile hotspot, etc.) and retry. There
is no automation bypass for this — Cloudflare blocks at the WAF, before
any cookie is sent.

### Manual login window never auto-closes
The harness watches for the URL leaving `/sign-in` **and** containing
`grok.com` or `x.ai`. If you got bounced into a non-Grok property
(`google.com` for SSO, `apple.com` for AppleID, etc.) finish that step
and explicitly navigate to `https://grok.com/`. The polling loop will
detect it on the next 1.5s tick.

### `setupAccount returned no headers` (exit 3)
Two common causes:
- **Session expired.** Delete the profile dir and re-run; the harness
  will pop up the manual-login window again.

  ```bash
  rm -rf "$GROK_PROFILE_DIR/<email_with_underscores>"
  ```

- **Cloudflare turnstile** on the relaunched Chrome. The auto-handler
  in `desktop/src/browser.js::handleCf` clicks the checkbox and waits up
  to 30s. If the challenge actually requires "Verify you are human" with
  an image puzzle, do it by hand in the headful window — the header
  capture will continue once the page is past the challenge.

### Returned exactly 1 image (exit 4)
This is the original PR-9 bug. Sanity checks:
- `enablePro: false` is what the harness passes; if you forked the
  script and changed it, change it back.
- Make sure you're on **`main`** (post-merge of PR #13). `git log -1`
  should show a commit at or after `61687e6 PR-9: fix AutoGrok bugs`.
- Inspect the WS log lines (`[ImageService] [Acc1] ...`); a Pro-mode
  response will say `enable_pro=true`. If you see that, the harness
  config didn't take effect.

### Returned 4 images but they're all `<50KB` / blurry (exit 5)
PR-9 added a 50KB filter on the WS `completed` handler — but Grok will
still emit blur previews for moderated prompts. Try a less ambiguous
prompt (`GROK_E2E_PROMPT="A peaceful library at golden hour, ..."`) and
re-run. If the failure persists with a clearly safe prompt, the
50KB-reject path is regressing.

### `desktop/node_modules missing`
```bash
cd desktop && npm install && cd ..
```

### `Chrome/Edge not found on this machine`
Set `CHROME_EXECUTABLE_PATH` (see §2) to your browser binary path.

### Output folder is empty
The script logs its `OUTPUT_DIR` early (search for `Output folder` in
the log). On Windows that's something like
`C:\Users\you\code\creator-forge\e2e-output\2026-04-30T...`.

---

## 6. Cleanup

Cookies persist between runs, which is the whole point of PR-11. To
reset (e.g. switch accounts, force a fresh login):

```bash
rm -rf "$GROK_PROFILE_DIR/<email_with_underscores>"
```

Generated images can be deleted any time:

```bash
rm -rf e2e-output/
```

`.gitignore` already excludes both directories. Never commit either —
the profile contains live session cookies.

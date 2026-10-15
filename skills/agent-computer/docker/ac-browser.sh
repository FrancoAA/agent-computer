#!/bin/bash
# Opens Chromium on the desktop with DevTools on 9222 (relayed to 9223 for Playwright/CDP clients).
# Reuses the running browser if there is one.
url="${1:-}"
devtools=http://127.0.0.1:9222

if curl -sf "$devtools/json/version" >/dev/null; then
  # Already running with DevTools: open the URL as a new tab through it.
  [ -n "$url" ] && curl -sf -X PUT "$devtools/json/new?$url" >/dev/null
  exit 0
fi

nohup chromium \
  --user-data-dir="$HOME/.config/ac-chromium" \
  --remote-debugging-port=9222 \
  --no-first-run --no-default-browser-check --password-store=basic \
  --no-sandbox --test-type \
  --start-maximized \
  "${url:-about:blank}" >/tmp/chromium.log 2>&1 &
for _ in $(seq 50); do curl -sf "$devtools/json/version" >/dev/null && exit 0; sleep 0.2; done
echo "chromium did not open DevTools on :9222 (see /tmp/chromium.log)" >&2
exit 1

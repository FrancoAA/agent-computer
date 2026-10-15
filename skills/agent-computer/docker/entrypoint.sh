#!/bin/bash
# Starts the virtual display, desktop, VNC and noVNC, then waits.
set -euo pipefail
export DISPLAY=:1

Xvfb :1 -screen 0 "${AC_RESOLUTION}x24" -nolisten tcp -ac &
for _ in $(seq 100); do xdpyinfo >/dev/null 2>&1 && break; sleep 0.1; done

dbus-launch --exit-with-session startxfce4 >/tmp/xfce.log 2>&1 &

# VNC is only reachable inside the container; noVNC (6080) is what gets published.
x11vnc -display :1 -forever -shared -nopw -localhost -quiet -rfbport 5900 >/tmp/x11vnc.log 2>&1 &
websockify --web /usr/share/novnc 6080 localhost:5900 >/tmp/novnc.log 2>&1 &

# Chromium only binds DevTools to 127.0.0.1, so relay it for the published port.
socat TCP-LISTEN:9223,fork,reuseaddr TCP:127.0.0.1:9222 >/dev/null 2>&1 &

touch /tmp/ac-ready
wait -n

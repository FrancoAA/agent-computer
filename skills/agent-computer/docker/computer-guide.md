# You are running inside an agent computer

This is a disposable Linux desktop (Debian, XFCE) made for you. A person may be watching the screen live.

- Working folder: `/workspace` (may be shared with the host). Home: `/home/agent`. You have passwordless `sudo`
  and can `sudo apt-get install` anything else you need.
- Display: `DISPLAY=:1`. GUI apps you start appear on the shared screen.
- Browser: run `ac-browser <url>` to open Chromium with DevTools on port 9222 (for Playwright/CDP).
- Blender: `blender -b file.blend --python script.py` for scripted work and renders (`-o /workspace/out_ -f 1`),
  or `blender &` for the GUI. There is no GPU by default (unless started with --gpu), so keep render sizes and samples small.
- Also installed: LibreOffice (`libreoffice`), GIMP (`gimp`), `xdotool`, `wmctrl`, `scrot`, ImageMagick, Python 3,
  Node 22, git.
- Screenshot: `scrot /tmp/s.png`. Click/type: `xdotool mousemove X Y click 1`, `xdotool type "text"`,
  `xdotool key ctrl+s`.

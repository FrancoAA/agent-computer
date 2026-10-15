---
name: agent-computer
description: Gives you your own Linux desktop computer (Chromium, Blender, LibreOffice, GIMP, a shell with sudo) running in Docker, which the user can watch live. Use it when a task needs a real browser, a GUI app, 3D modeling or rendering in Blender, office documents, or a disposable machine to install and run things without touching the user's system.
license: MIT
compatibility: Local agents only. Requires Docker (daemon reachable from the agent's shell) and Node.js 20+ on the host.
---

# agent-computer

A personal Linux desktop (Debian + XFCE) in a Docker container. The current project folder is shared at
`/workspace` (except `$HOME` and `/`, which get a private volume). Requires Docker and Node.js 20+ on the host.

Run the CLI from this skill's folder. Below, `ac` stands for:

```bash
node <this skill's folder>/scripts/agent-computer.mjs
```

Use the full path in every command (shell state may not persist between your tool calls). The CLI talks to
Docker, so if you run in a sandbox that blocks it (e.g. Codex's workspace-write mode), request escalated /
unsandboxed permission for these commands.

## First run

`ac up` starts the computer. The first time, it starts building the image in the background (~10 minutes,
~9 GB) and exits with a "still building" message. Tell the user, then check with `ac image status` every minute
or two (e.g. `sleep 60 && ac image status`) and run `ac up` again once it says `ready`.

After `ac up`, share the `desktop:` URL with the user so they can watch (or run `ac view` to open it for them).

## Look and act

```bash
ac screenshot -o /tmp/screen.png      # then read the PNG to see the screen (1280x800)
ac click 640 400                      # --double, --right, --middle
ac type "hello world"
ac key ctrl+l                         # xdotool names: Return, Escape, Tab, ctrl+s, alt+F4
ac scroll 640 400 down 5
ac drag 100 100 400 300
ac open https://example.com           # Chromium; or an app: ac open "blender /workspace/scene.blend"
```

Take a fresh screenshot before every click. Coordinates are screen pixels.

## Run things

```bash
ac exec -- bash -lc 'wmctrl -l'                          # list windows
ac exec -- bash -lc 'sudo apt-get install -y inkscape'   # install anything
ac exec -- blender -b --python /workspace/scene.py       # headless Blender (bpy); renders work on CPU
ac exec -- libreoffice --headless --convert-to pdf /workspace/report.docx --outdir /workspace
ac cp computer:/home/agent/out.png ./out.png             # copy out (paths under /workspace are already shared)
```

Prefer scripts over clicking when the app supports them (Blender `--python`, LibreOffice `--headless`,
Chromium DevTools on port 9222 inside the computer). Keep renders small (e.g. 640x360, 16–64 samples): there is
no GPU unless the user started the computer with `--gpu`.

## Lifecycle

`ac status`, `ac list`, `ac down` (stop), `ac destroy` (delete it and its private volume). One computer per
project folder; use `--name NAME` to pick another. Logins are only copied in when the user runs an agent inside
the computer (`ac run -- <agent>`); never copy credentials in yourself.

## Optional: MCP tools

For agents that support MCP, the same features are available as tools (`screenshot`, `click`, `type_text`,
`press_keys`, `shell`, `open`, `blender`, `view_image`, …). The user can register them once with
`ac setup claude` (or `codex`, `pi`; `ac setup cursor` prints the JSON).

# agent-computer

[![skills.sh](https://skills.sh/b/FrancoAA/agent-computer)](https://skills.sh/FrancoAA/agent-computer)

```bash
npx skills add FrancoAA/agent-computer
```

Give any coding agent its own Linux desktop: a Docker container with XFCE, Chromium, Blender, LibreOffice, GIMP,
a shell with `sudo`, and your project folder at `/workspace`. You can watch it live in your browser.

It isn't tied to one agent. The same computer can be used three ways:

| How | Command | Works with |
|---|---|---|
| **MCP tools** (agent on your machine, operating the computer) | `agent-computer mcp` | Claude Code, Codex, Cursor, pi, T3 Code, any MCP client |
| **CLI + skill** (agent drives it from bash) | `agent-computer screenshot`, `click`, `type`, `exec`… | pi, Claude Code skills, any agent with a shell |
| **Agent inside the computer** (stdio passthrough) | `agent-computer run -- <agent>` | ACP clients (T3 Code, Zed, Open Codex), interactive TUIs |

## Install as a skill (recommended)

`npx skills add FrancoAA/agent-computer` installs it for Claude Code, Codex, pi, Cursor and other agents (add `-g` for
all projects). Manual alternatives:

The skill folder `skills/agent-computer/` is self-contained: `SKILL.md`, a single bundled CLI
(`scripts/agent-computer.mjs`, no `npm install` needed) and the Dockerfile. Requirements: Docker and Node.js 20+.

```bash
node skills/agent-computer/scripts/agent-computer.mjs install-skill all   # Claude Code, Codex (~/.agents), pi
# or one target: install-skill claude | codex | pi | agents | <folder>
```

Or unzip `release/agent-computer-skill.zip` (`npm run pack:skill`) into any of:

| Agent | Skill folder |
|---|---|
| Claude Code (and T3 Code's Claude sessions) | `~/.claude/skills/` or `<project>/.claude/skills/` |
| Codex (and T3 Code's Codex sessions) | `~/.agents/skills/` or `<project>/.agents/skills/` |
| pi | `~/.pi/agent/skills/`, or `pi --skill <folder>` |

Claude Code can also install it as a plugin:
`/plugin install agent-computer --marketplace FrancoAA/agent-computer` (Claude Code 2.1.275+).

On first use the skill builds the desktop image in the background (~10 minutes, ~9 GB) and tells the agent to
retry; `agent-computer image status` shows progress.

**Sandboxed agents:** the CLI needs the Docker socket. Codex's `workspace-write` sandbox blocks it, so Codex asks
you to approve running `agent-computer` commands outside the sandbox (non-interactive `codex exec` can't, and
reports that clearly).

Skills that run on hosted sandboxes (claude.ai, the API's code execution) won't work: they have no Docker.

## Install the CLI (for MCP and run-inside)

```bash
npm install && npm run build && npm link     # `agent-computer` on your PATH (bundled CLI)
agent-computer image build                   # optional: build the image now instead of on first use
agent-computer up && agent-computer view     # start it and watch the desktop
agent-computer setup claude                  # MCP: claude | codex | pi; `setup cursor` prints the JSON
```

**T3 Code** runs Claude Code and Codex with their own configs, so the skill or `setup claude` / `setup codex` covers
T3 sessions too. To run an agent *entirely inside* the computer from T3 Code (or Zed, or Open Codex), add a custom
ACP agent with command `agent-computer` and arguments `run -- claude-agent-acp` (or `run -- codex-acp`, or
`run -- cursor-agent acp` with a Cursor-enabled image).

### MCP tools

`computer_info`, `screenshot`, `click`, `move_mouse`, `drag`, `type_text`, `press_keys`, `scroll`, `shell`,
`open` (URL or GUI app), `list_windows`, `focus_window`, `read_file`, `write_file`, `view_image`, `blender`
(headless bpy scripts and renders).

For DOM-level browser automation, add Playwright's MCP server attached to the computer's Chromium:
`claude mcp add agent-computer-browser -- agent-computer browser-mcp`.

## Which computer?

One per project folder by default (named after the folder), so agents in different repos don't share a desktop.
Override with `--name NAME` or `AGENT_COMPUTER=NAME`. The project folder is shared at `/workspace`, except `$HOME`
and `/`, which get a private volume instead (also forced with `--no-workspace`).

```bash
agent-computer list
agent-computer --name blender-lab up --gpu --cpus 8 --memory 16g
agent-computer --name blender-lab destroy
```

`--gpu` shares `/dev/dri` (Mesa/AMD/Intel) for hardware-accelerated Blender viewports and EEVEE.

## Running agents inside

`run` copies the matching host login into the computer (`~/.claude/.credentials.json`, `~/.codex/auth.json`,
Cursor's `auth.json`, Gemini's OAuth file), forwards common API-key variables, and passes stdio through. Interactive
TUIs get a TTY; Ctrl-C goes to the agent. When the caller stops `run` (SIGTERM/SIGHUP), the agent's whole process
group is killed inside the container.

The image includes Claude Code, Codex, `claude-agent-acp`, `codex-acp` and Playwright MCP. Cursor's agent CLI is
only distributed as a remote install script, so it is opt-in: build with `AGENT_COMPUTER_WITH_CURSOR=1 agent-computer image build`.

## Security model

- This is a container, not a VM: it shares the host kernel. It contains mistakes and sprawl well; it is not a
  hard boundary against a hostile workload. For stronger isolation install gVisor or Kata Containers and set
  `AGENT_COMPUTER_RUNTIME=runsc` (or `kata-runtime`); new computers then start under that runtime.
- The shared `/workspace` folder is read-write. Use `--no-workspace` for a fully private computer.
- Logins copied in with `run`/`auth` are readable by anything running inside the computer.
- The desktop (noVNC) and DevTools ports are bound to `127.0.0.1` on random ports and have no password. Anyone with
  access to your machine's localhost can view and control the desktop.
- No Docker socket is mounted, and the container is not privileged. The agent has `sudo` *inside* the container.

## How it works

`skills/agent-computer/docker/` builds a Debian trixie image. Its entrypoint starts Xvfb (`:1`), an XFCE session, x11vnc (container-local)
and noVNC on port 6080, plus a relay for Chromium DevTools on 9223. The CLI talks to Docker directly:
`docker exec` + `xdotool`/`scrot` for input and screenshots, `docker cp` for files, and `docker exec -i` with a
per-command process group for `run`/`exec`.

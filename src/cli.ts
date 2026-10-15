#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as computer from "./computer.js";
import { serveMcp } from "./mcp.js";

const SKILL_TARGETS: Record<string, string> = {
  claude: ".claude/skills",
  agents: ".agents/skills", // shared location read by Codex and other Agent Skills clients
  codex: ".agents/skills",
  pi: ".pi/agent/skills",
};

const HELP = `agent-computer — give any coding agent its own Linux desktop (browser, Blender, office apps)

Usage: agent-computer [options] <command> [args]

Lifecycle
  up                        Create/start the computer and print its details
  status | list             Show this computer / all computers
  view                      Open the live desktop in your browser (url: print it)
  down | destroy            Stop it / delete it and its private workspace volume
  image build | status      Build the desktop image now (Debian + XFCE + Chromium + Blender + LibreOffice + GIMP),
                            or show build progress. \`up\` starts the build automatically on first use.

Use it from an agent
  mcp                       MCP server over stdio (screenshot, click, type, keys, shell, files, open, blender)
  browser-mcp               Playwright MCP server attached to the computer's Chromium
  setup <agent>             Register the MCP server with claude | codex | pi | cursor (prints config for others)
  install-skill TARGET      Copy this skill to claude | codex | pi | agents | all | a folder

Use it from a terminal or script
  screenshot [-o file]      Save the screen as PNG (default ./screenshot.png)
  click X Y [--right|--middle] [--double]     move X Y     drag X1 Y1 X2 Y2
  type TEXT                 key KEYS (e.g. ctrl+s)      scroll X Y up|down [N]
  open URL|COMMAND          Open a URL in Chromium or start a GUI app
  exec -- CMD...            Run a command (interactive TTY when attached to one)
  shell                     Interactive bash
  cp SRC DEST               Copy files; prefix computer paths with "computer:"
  auth claude,codex,...     Copy your host logins into the computer

Run an agent inside it
  run [--auth LIST|--no-auth] [--env NAME]... -- CMD...
                            Runs CMD in /workspace with stdio passed through, e.g.
                              agent-computer run -- claude-agent-acp      (ACP, for T3 Code / Zed / Open Codex)
                              agent-computer run -- codex                 (interactive TUI)
                            Cursor's CLI is only in the image if built with AGENT_COMPUTER_WITH_CURSOR=1.
                            Logins for claude/codex/cursor/gemini are copied in automatically.

Options
  --name NAME               Computer name (default: $AGENT_COMPUTER, else one per project folder)
  --workspace PATH          Host folder shared at /workspace (default: current folder, unless it is $HOME or /)
  --no-workspace            Use a private volume for /workspace
  --gpu                     Share /dev/dri for hardware-accelerated rendering
  --cpus N  --memory SIZE   Resource limits, e.g. --cpus 4 --memory 8g
  --resolution WxH          Screen size (default 1280x800)
`;

type Parsed = {
  name?: string;
  up: computer.UpOptions;
  flags: Set<string>;
  values: Map<string, string[]>;
  positional: string[];
  rest: string[];
};

/** Minimal parser: known options anywhere before `--`; everything after `--` is passed through untouched. */
function parse(argv: string[]): Parsed {
  const parsed: Parsed = { up: {}, flags: new Set(), values: new Map(), positional: [], rest: [] };
  const withValue = new Set(["--name", "--workspace", "--cpus", "--memory", "--resolution", "-o", "--auth", "--env"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      parsed.rest = argv.slice(i + 1);
      break;
    }
    if (withValue.has(arg)) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      parsed.values.set(arg, [...(parsed.values.get(arg) ?? []), value]);
    } else if (arg.startsWith("--") || (arg.startsWith("-") && arg.length === 2 && !/^-\d/.test(arg))) {
      parsed.flags.add(arg);
    } else {
      parsed.positional.push(arg);
    }
  }
  const one = (key: string) => parsed.values.get(key)?.at(-1);
  parsed.name = one("--name");
  if (parsed.flags.has("--no-workspace")) parsed.up.workspace = false;
  else if (one("--workspace")) parsed.up.workspace = path.resolve(one("--workspace")!);
  parsed.up.gpu = parsed.flags.has("--gpu");
  parsed.up.cpus = one("--cpus");
  parsed.up.memory = one("--memory");
  parsed.up.resolution = one("--resolution");
  return parsed;
}

function printInfo(info: computer.ComputerInfo): void {
  console.log(`name:       ${info.name}`);
  console.log(`state:      ${info.running ? "running" : "stopped"}`);
  console.log(`workspace:  ${info.workspace} → /workspace`);
  if (info.desktopUrl) console.log(`desktop:    ${info.desktopUrl}`);
  if (info.cdpUrl) console.log(`devtools:   ${info.cdpUrl} (after Chromium is opened)`);
}

function openOnHost(url: string): void {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(opener, [url], { detached: true, stdio: "ignore" }).unref();
}

/** How agents should launch this CLI: the global command when installed, else node + this file. */
function selfCommand(): string[] {
  const onPath = spawnSync("sh", ["-c", "command -v agent-computer"], { encoding: "utf8" }).stdout.trim();
  return onPath ? ["agent-computer"] : [process.execPath, fileURLToPath(import.meta.url)];
}

/** Waits for a passthrough process and stops it inside the computer when we are told to stop. */
function supervise(handle: ReturnType<typeof computer.exec>, tty: boolean): void {
  const stop = async () => {
    await handle.kill();
    process.exit(143);
  };
  // In a TTY, Ctrl-C belongs to the program (docker forwards it); only stop on hangup/terminate.
  process.on("SIGINT", tty ? () => undefined : stop);
  process.on("SIGTERM", stop);
  process.on("SIGHUP", stop);
  handle.child.on("exit", (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
}

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2));
  const [command, ...positional] = args.positional;
  const name = computer.resolveName(args.name);
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const ensure = () => computer.up(name, args.up);
  const num = (index: number, label: string) => {
    const value = Number(positional[index]);
    if (!Number.isFinite(value)) throw new Error(`Expected ${label}`);
    return String(Math.round(value));
  };

  switch (command) {
    case undefined:
    case "help":
      console.log(HELP);
      return;

    case "up":
      printInfo(await ensure());
      return;

    case "status": {
      const info = await computer.status(name);
      if (!info) console.log(`No computer named ${name}. Start one with: agent-computer up`);
      else printInfo(info);
      return;
    }

    case "list": {
      const all = await computer.list();
      if (!all.length) console.log("No computers.");
      for (const info of all) {
        console.log(`${info.running ? "●" : "○"} ${info.name.padEnd(32)} ${info.workspace}${info.desktopUrl ? `  ${info.desktopUrl}` : ""}`);
      }
      return;
    }

    case "url":
      console.log((await ensure()).desktopUrl);
      return;

    case "view": {
      const url = (await ensure()).desktopUrl!;
      openOnHost(url);
      console.log(url);
      return;
    }

    case "down":
      await computer.down(name);
      console.log(`Stopped ${name}`);
      return;

    case "destroy":
      await computer.destroy(name);
      console.log(`Destroyed ${name}`);
      return;

    case "image": {
      if (positional[0] === "status") {
        const image = await computer.imageState();
        console.log(image.state === "ready" ? `ready (${computer.IMAGE})` : image.state === "missing" ? "not built" : `${image.state} — log: ${image.log}\n${image.tail}`);
        return;
      }
      if (positional[0] !== "build") throw new Error("Usage: agent-computer image build|status");
      const result = spawnSync("docker", computer.imageBuildArgs(), { stdio: "inherit" });
      process.exit(result.status ?? 1);
    }

    case "mcp":
      await serveMcp(name, args.up);
      return;

    case "browser-mcp": {
      await ensure();
      const opened = await computer.run(name, "ac-browser");
      if (opened.code !== 0) throw new Error(`Could not start Chromium: ${opened.stderr}`);
      // Playwright MCP runs inside the computer, so it reaches DevTools on the computer's own localhost.
      const handle = computer.exec(name, ["playwright-mcp", "--cdp-endpoint", "http://127.0.0.1:9222"], { cwd: "/workspace" });
      supervise(handle, false);
      return;
    }

    case "screenshot": {
      await ensure();
      const out = path.resolve(args.values.get("-o")?.at(-1) ?? "screenshot.png");
      fs.writeFileSync(out, await computer.screenshot(name));
      console.log(out);
      return;
    }

    case "click": {
      await ensure();
      const button = args.flags.has("--right") ? "3" : args.flags.has("--middle") ? "2" : "1";
      const repeat = args.flags.has("--double") ? "2" : "1";
      await computer.xdotool(name, ["mousemove", num(0, "X"), num(1, "Y"), "click", "--repeat", repeat, button]);
      return;
    }

    case "move":
      await ensure();
      await computer.xdotool(name, ["mousemove", num(0, "X"), num(1, "Y")]);
      return;

    case "drag":
      await ensure();
      await computer.xdotool(name, [
        "mousemove", num(0, "X1"), num(1, "Y1"), "mousedown", "1",
        "mousemove", "--sync", num(2, "X2"), num(3, "Y2"), "mouseup", "1",
      ]);
      return;

    case "type":
      await ensure();
      await computer.xdotool(name, ["type", "--delay", "12", "--", [...positional, ...args.rest].join(" ")]);
      return;

    case "key":
      await ensure();
      await computer.xdotool(name, ["key", "--delay", "60", ...positional]);
      return;

    case "scroll": {
      await ensure();
      const button = { up: "4", down: "5", left: "6", right: "7" }[positional[2] ?? "down"];
      if (!button) throw new Error("Direction must be up, down, left or right");
      await computer.xdotool(name, ["mousemove", num(0, "X"), num(1, "Y"), "click", "--repeat", positional[3] ?? "3", button]);
      return;
    }

    case "open": {
      await ensure();
      const target = [...positional, ...args.rest].join(" ");
      if (!target) throw new Error("Usage: agent-computer open URL|COMMAND");
      const quoted = `'${target.replace(/'/g, `'\\''`)}'`;
      const isUrl = /^(https?|file):\/\//.test(target);
      const result = await computer.run(name, isUrl ? `ac-browser ${quoted}` : `nohup setsid bash -lc ${quoted} >/tmp/ac-open.log 2>&1 &`);
      if (result.code !== 0) throw new Error(result.stderr || "open failed");
      return;
    }

    case "exec":
    case "shell": {
      await ensure();
      const cmd = command === "shell" ? ["bash", "-l"] : args.rest.length ? args.rest : positional;
      if (!cmd.length) throw new Error("Usage: agent-computer exec -- CMD...");
      supervise(computer.exec(name, cmd, { tty }), tty);
      return;
    }

    case "auth": {
      await ensure();
      const agents = (positional[0] ?? computer.AUTH_AGENTS.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
      const copied = await computer.copyAuth(name, agents);
      console.log(copied.length ? `Copied:\n  ${copied.join("\n  ")}` : "No matching login files found on this machine.");
      return;
    }

    case "run": {
      if (!args.rest.length) throw new Error("Usage: agent-computer run -- CMD...");
      await ensure();
      if (!args.flags.has("--no-auth")) {
        const requested = args.values.get("--auth")?.flatMap((value) => value.split(","));
        const inferred = computer.authForCommand(args.rest[0]);
        const agents = requested ?? (inferred ? [inferred] : []);
        // stdout may be an ACP/MCP stream, so report on stderr.
        const copied = await computer.copyAuth(name, agents);
        if (copied.length) process.stderr.write(`[agent-computer] copied logins: ${copied.join(", ")}\n`);
      }
      const env: Record<string, string> = {};
      const forward = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "CURSOR_API_KEY", ...(args.values.get("--env") ?? [])];
      for (const key of forward) if (process.env[key]) env[key] = process.env[key]!;
      supervise(computer.exec(name, args.rest, { tty, env }), tty);
      return;
    }

    case "cp": {
      const [from, to] = positional;
      if (!from || !to) throw new Error("Usage: agent-computer cp SRC DEST (prefix computer paths with computer:)");
      await ensure();
      const inComputer = (p: string) => p.startsWith("computer:");
      if (inComputer(from) === inComputer(to)) throw new Error("Exactly one side must start with computer:");
      if (inComputer(from)) await computer.copy(name, from.slice(9), path.resolve(to), "out");
      else await computer.copy(name, path.resolve(from), to.slice(9), "in");
      return;
    }

    case "setup": {
      const agent = positional[0];
      const self = selfCommand();
      const mcpCommand = [...self, "mcp"];
      const commands: Record<string, string[]> = {
        claude: ["claude", "mcp", "add", "--scope", "user", "agent-computer", "--", ...mcpCommand],
        codex: ["codex", "mcp", "add", "agent-computer", "--", ...mcpCommand],
        pi: ["pi", "mcp", "add", "agent-computer", "--", ...mcpCommand],
      };
      if (agent && commands[agent]) {
        const [bin, ...rest] = commands[agent];
        console.log(`$ ${[bin, ...rest].join(" ")}`);
        const result = spawnSync(bin, rest, { stdio: "inherit" });
        process.exit(result.status ?? 1);
      }
      const json = JSON.stringify(
        { mcpServers: { "agent-computer": { command: mcpCommand[0], args: mcpCommand.slice(1) } } },
        null,
        2,
      );
      console.log(
        agent === "cursor"
          ? `Add this to ~/.cursor/mcp.json:\n\n${json}`
          : `Usage: agent-computer setup claude|codex|pi|cursor\n\nAny other MCP client (T3 Code uses your Claude/Codex config):\n\n${json}`,
      );
      return;
    }

    case "install-skill": {
      const target = positional[0];
      const home = process.env.HOME ?? "";
      const known = Object.keys(SKILL_TARGETS);
      if (!target) throw new Error(`Usage: agent-computer install-skill ${known.join(" | ")} | all | DIR`);
      const dirs =
        target === "all"
          ? [...new Set(Object.values(SKILL_TARGETS))]
              .map((rel) => path.join(home, rel))
              .filter((dir) => fs.existsSync(path.dirname(dir)))
          : [SKILL_TARGETS[target] ? path.join(home, SKILL_TARGETS[target]) : path.resolve(target)];
      const source = computer.skillRoot();
      for (const dir of dirs) {
        const dest = path.join(dir, "agent-computer");
        if (path.resolve(dest) === path.resolve(source)) {
          console.log(`Already installed at ${dest}`);
          continue;
        }
        fs.rmSync(dest, { recursive: true, force: true });
        fs.cpSync(source, dest, { recursive: true });
        console.log(`Installed ${dest}`);
      }
      return;
    }

    default:
      throw new Error(`Unknown command: ${command}\n\n${HELP}`);
  }
}

main().catch((error: unknown) => {
  console.error(`agent-computer: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

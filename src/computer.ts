import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const IMAGE = process.env.AGENT_COMPUTER_IMAGE ?? "agent-computer:latest";
const LABEL = "agent-computer";
const CONTAINER_PREFIX = "ac-";
const HOME_IN_COMPUTER = "/home/agent";

export type UpOptions = {
  /** Host folder shared at /workspace. Omit to derive from cwd; `false` for a private volume. */
  workspace?: string | false;
  gpu?: boolean;
  cpus?: string;
  memory?: string;
  resolution?: string;
};

export type ComputerInfo = {
  name: string;
  container: string;
  running: boolean;
  workspace: string;
  desktopUrl?: string;
  cdpUrl?: string;
};

type DockerResult = { code: number; stdout: Buffer; stderr: string };

export function docker(args: string[], input?: Buffer | string): Promise<DockerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error: NodeJS.ErrnoException) =>
      reject(error.code === "ENOENT" ? new Error("Docker is not installed or not on PATH.") : error),
    );
    child.on("close", (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr }));
    child.stdin.end(input);
  });
}

async function dockerOk(args: string[], input?: Buffer | string): Promise<string> {
  const result = await docker(args, input);
  if (result.code !== 0) {
    throw new Error(`docker ${args[0]} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
  return result.stdout.toString();
}

/**
 * Name of the computer to use: explicit flag, then AGENT_COMPUTER, then one per project folder,
 * so agents working in different repos get different computers by default.
 */
export function resolveName(explicit?: string, cwd = process.cwd()): string {
  const raw = explicit || process.env.AGENT_COMPUTER;
  if (raw) return sanitize(raw);
  const hash = createHash("sha1").update(path.resolve(cwd)).digest("hex").slice(0, 6);
  return sanitize(`${path.basename(path.resolve(cwd)) || "root"}-${hash}`);
}

function sanitize(name: string): string {
  const clean = name.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^[^a-z0-9]+/, "");
  return (clean || "computer").slice(0, 48);
}

export const containerName = (name: string) => `${CONTAINER_PREFIX}${name}`;
const volumeName = (name: string) => `${CONTAINER_PREFIX}${name}-workspace`;

/** Sharing $HOME or / would hand the whole machine to the computer, so those get a private volume. */
function defaultWorkspace(cwd = process.cwd()): string | false {
  const resolved = path.resolve(cwd);
  if (resolved === path.parse(resolved).root || resolved === os.homedir()) return false;
  return resolved;
}

type Inspect = {
  State: { Running: boolean };
  Mounts: Array<{ Destination: string; Source: string; Type: string; Name?: string }>;
  NetworkSettings: { Ports: Record<string, Array<{ HostIp: string; HostPort: string }> | null> };
};

async function inspect(name: string): Promise<Inspect | null> {
  const result = await docker(["inspect", "--type", "container", containerName(name)]);
  if (result.code !== 0) return null;
  return (JSON.parse(result.stdout.toString()) as Inspect[])[0] ?? null;
}

function hostPort(info: Inspect, port: number): string | undefined {
  return info.NetworkSettings.Ports[`${port}/tcp`]?.[0]?.HostPort;
}

function toInfo(name: string, info: Inspect): ComputerInfo {
  const mount = info.Mounts.find((item) => item.Destination === "/workspace");
  const novnc = hostPort(info, 6080);
  const cdp = hostPort(info, 9223);
  return {
    name,
    container: containerName(name),
    running: info.State.Running,
    workspace: mount ? (mount.Type === "bind" ? mount.Source : `volume:${mount.Name}`) : "(none)",
    desktopUrl: novnc
      ? `http://127.0.0.1:${novnc}/vnc.html?autoconnect=1&resize=scale&reconnect=1`
      : undefined,
    cdpUrl: cdp ? `http://127.0.0.1:${cdp}` : undefined,
  };
}

export async function status(name: string): Promise<ComputerInfo | null> {
  const info = await inspect(name);
  return info ? toInfo(name, info) : null;
}

export async function list(): Promise<ComputerInfo[]> {
  const ids = (await dockerOk(["ps", "-a", "--filter", `label=${LABEL}`, "--format", "{{.Label \"agent-computer.name\"}}"]))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const infos = await Promise.all(ids.map((id) => status(id)));
  return infos.filter((info): info is ComputerInfo => info != null);
}

/**
 * The skill folder (SKILL.md, scripts/, docker/). This file runs either bundled as
 * `<skill>/scripts/agent-computer.mjs` or from the repo, so check both layouts.
 */
export function skillRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(here, ".."), path.resolve(here, "..", "skills", "agent-computer")];
  const found = candidates.find((dir) => fs.existsSync(path.join(dir, "SKILL.md")) && fs.existsSync(path.join(dir, "docker", "Dockerfile")));
  if (!found) throw new Error(`Could not find the agent-computer skill folder near ${here}`);
  return found;
}

export async function imageExists(): Promise<boolean> {
  return (await docker(["image", "inspect", IMAGE])).code === 0;
}

const CACHE_DIR = path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "agent-computer");
export const BUILD_LOG = path.join(CACHE_DIR, "build.log");
const BUILD_LOCK = path.join(CACHE_DIR, "build.pid");

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function logTail(lines = 15): string {
  try {
    return fs.readFileSync(BUILD_LOG, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

export type ImageState =
  | { state: "ready" }
  | { state: "building"; log: string; tail: string }
  | { state: "failed"; log: string; tail: string }
  | { state: "missing" };

/** Fails clearly when Docker is unreachable (not installed, daemon down, or blocked by an agent sandbox). */
export async function checkDaemon(): Promise<void> {
  const result = await docker(["version", "--format", "{{.Server.Version}}"]);
  if (result.code === 0) return;
  throw new Error(
    `Can't reach the Docker daemon: ${result.stderr.trim().split("\n").pop()}\n` +
      "If you are an agent running in a sandbox (e.g. Codex workspace-write), run agent-computer commands " +
      "with escalated / unsandboxed permissions, or ask the user to allow it.",
  );
}

export async function imageState(): Promise<ImageState> {
  await checkDaemon();
  if (await imageExists()) return { state: "ready" };
  const pid = Number(fs.existsSync(BUILD_LOCK) ? fs.readFileSync(BUILD_LOCK, "utf8") : NaN);
  if (pid && isAlive(pid)) return { state: "building", log: BUILD_LOG, tail: logTail(3) };
  if (fs.existsSync(BUILD_LOCK)) return { state: "failed", log: BUILD_LOG, tail: logTail() };
  return { state: "missing" };
}

/** Starts `docker build` detached, so it survives the CLI exiting and agent tool timeouts. */
export function imageBuildArgs(): string[] {
  const args = ["build", "-t", IMAGE];
  if (process.env.AGENT_COMPUTER_WITH_CURSOR === "1") args.push("--build-arg", "INSTALL_CURSOR=1");
  return [...args, path.join(skillRoot(), "docker")];
}

export function startImageBuild(): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const log = fs.openSync(BUILD_LOG, "w");
  const child = spawn("docker", imageBuildArgs(), {
    detached: true,
    stdio: ["ignore", log, log],
  });
  fs.writeFileSync(BUILD_LOCK, String(child.pid));
  child.unref();
}

/**
 * Makes sure the image exists. The first build takes ~10 minutes, longer than agents' tool timeouts,
 * so instead of blocking it starts the build in the background and asks the caller to retry.
 */
export async function ensureImage(): Promise<void> {
  const image = await imageState();
  if (image.state === "ready") return;
  if (image.state === "missing" || image.state === "failed") {
    const previous = image.state === "failed" ? `The previous build failed:\n${image.tail}\n\nRetrying. ` : "";
    startImageBuild();
    throw new Error(
      `${previous}Building the agent-computer image now (first run only: ~10 minutes, ~9 GB). ` +
        `Retry in a few minutes; check progress with \`agent-computer image status\` or ${BUILD_LOG}.`,
    );
  }
  throw new Error(
    `The agent-computer image is still building (first run only, ~10 minutes). Retry in a few minutes.\n` +
      `Latest output:\n${image.tail}`,
  );
}

/** Creates or starts the computer and waits until its desktop is ready. Idempotent. */
export async function up(name: string, options: UpOptions = {}): Promise<ComputerInfo> {
  const existing = await inspect(name);
  if (existing?.State.Running) return toInfo(name, existing);
  if (existing) {
    await dockerOk(["start", containerName(name)]);
  } else {
    await ensureImage();
    const workspace = options.workspace === undefined ? defaultWorkspace() : options.workspace;
    const args = [
      "run", "-d",
      "--name", containerName(name),
      "--hostname", name.slice(0, 63),
      "--label", LABEL,
      "--label", `agent-computer.name=${name}`,
      "-p", "127.0.0.1::6080",
      "-p", "127.0.0.1::9223",
      "--shm-size", "2g",
      "-e", `AC_RESOLUTION=${options.resolution ?? "1280x800"}`,
      "-v", workspace ? `${workspace}:/workspace` : `${volumeName(name)}:/workspace`,
    ];
    // e.g. AGENT_COMPUTER_RUNTIME=runsc (gVisor) or kata-runtime for stronger isolation than plain runc.
    if (process.env.AGENT_COMPUTER_RUNTIME) args.push("--runtime", process.env.AGENT_COMPUTER_RUNTIME);
    if (options.cpus) args.push("--cpus", options.cpus);
    if (options.memory) args.push("--memory", options.memory);
    if (options.gpu && fs.existsSync("/dev/dri")) {
      args.push("--device", "/dev/dri");
      for (const node of fs.readdirSync("/dev/dri")) {
        const gid = fs.statSync(path.join("/dev/dri", node)).gid;
        if (!args.includes(String(gid))) args.push("--group-add", String(gid));
      }
    }
    args.push(IMAGE);
    await dockerOk(args);
  }
  await waitReady(name);
  const info = await inspect(name);
  if (!info) throw new Error(`Computer ${name} disappeared while starting`);
  return toInfo(name, info);
}

async function waitReady(name: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = await docker(["exec", containerName(name), "test", "-f", "/tmp/ac-ready"]);
    if (result.code === 0) {
      // Give XFCE a moment to map its windows before the first screenshot.
      await new Promise((r) => setTimeout(r, 1500));
      return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Computer ${name} did not become ready within 60s (see: docker logs ${containerName(name)})`);
}

export async function down(name: string): Promise<void> {
  await dockerOk(["stop", "-t", "5", containerName(name)]);
}

export async function destroy(name: string): Promise<void> {
  await docker(["rm", "-f", containerName(name)]);
  await docker(["volume", "rm", volumeName(name)]);
}

export type ExecOptions = {
  tty?: boolean;
  interactive?: boolean;
  env?: Record<string, string>;
  cwd?: string;
  user?: string;
  stdio?: StdioOptions;
};

/**
 * Runs a command in the computer and returns the local `docker exec` process. The command runs in its own
 * process group whose id is written to a pid file, so `kill()` can stop it inside the container (killing
 * the `docker exec` client alone would leave it running).
 */
export function exec(name: string, command: string[], options: ExecOptions = {}) {
  const pidFile = `/tmp/ac-exec-${randomBytes(6).toString("hex")}.pid`;
  const args = ["exec"];
  if (options.interactive !== false) args.push("-i");
  if (options.tty) args.push("-t");
  args.push("-u", options.user ?? "agent", "-w", options.cwd ?? "/workspace");
  for (const [key, value] of Object.entries(options.env ?? {})) args.push("-e", `${key}=${value}`);
  args.push(containerName(name), "setsid", "--wait", "sh", "-c", `echo $$ > ${pidFile}; exec "$@"`, "sh", ...command);

  const child: ChildProcess = spawn("docker", args, { stdio: options.stdio ?? "inherit" });
  const kill = async (signal: "TERM" | "KILL" = "TERM") => {
    await docker(["exec", containerName(name), "bash", "-c", `[ -f ${pidFile} ] && kill -s ${signal} -- -$(cat ${pidFile}); rm -f ${pidFile}`]);
  };
  return { child, kill };
}

/** Runs a shell command to completion and captures its output. */
export async function run(
  name: string,
  script: string,
  options: { timeoutMs?: number; cwd?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  // No `-i`: with stdin attached but already closed, `docker exec` can return before the command
  // finishes and drop its output.
  const { child, kill } = exec(name, ["bash", "-lc", script], {
    cwd: options.cwd,
    interactive: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const timer = setTimeout(() => {
    timedOut = true;
    void kill("KILL");
  }, options.timeoutMs ?? 120_000);
  const code = await new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? 1)));
  clearTimeout(timer);
  return { code, stdout, stderr, timedOut };
}

/** Captures the screen as PNG. */
export async function screenshot(name: string): Promise<Buffer> {
  const result = await docker([
    "exec", "-u", "agent", containerName(name),
    "sh", "-c", "scrot -o -p /tmp/ac-shot.png >/dev/null 2>&1 && cat /tmp/ac-shot.png",
  ]);
  if (result.code !== 0 || result.stdout.length === 0) {
    throw new Error(`screenshot failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
  return result.stdout;
}

export async function xdotool(name: string, args: string[]): Promise<void> {
  const result = await docker(["exec", "-u", "agent", containerName(name), "xdotool", ...args]);
  if (result.code !== 0) throw new Error(`xdotool ${args[0]} failed: ${result.stderr.trim()}`);
}

export async function writeFile(name: string, filePath: string, content: string | Buffer): Promise<void> {
  const target = filePath.startsWith("/") ? filePath : `/workspace/${filePath}`;
  const result = await docker(
    ["exec", "-i", "-u", "agent", containerName(name), "sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", target],
    content,
  );
  if (result.code !== 0) throw new Error(`write failed: ${result.stderr.trim()}`);
}

export async function readFile(name: string, filePath: string): Promise<Buffer> {
  const target = filePath.startsWith("/") ? filePath : `/workspace/${filePath}`;
  const result = await docker(["exec", "-u", "agent", containerName(name), "cat", target]);
  if (result.code !== 0) throw new Error(`read failed: ${result.stderr.trim()}`);
  return result.stdout;
}

/** Copies a file or folder between host and computer (`docker cp` semantics). */
export async function copy(name: string, from: string, to: string, direction: "in" | "out"): Promise<void> {
  const container = containerName(name);
  if (direction === "in") {
    await dockerOk(["cp", from, `${container}:${to}`]);
    await docker(["exec", "-u", "root", container, "chown", "-R", "agent:agent", to]);
  } else {
    await dockerOk(["cp", `${container}:${from}`, to]);
  }
}

/** Host login files each agent needs, relative to the host and computer home folders. */
const AUTH_FILES: Record<string, Array<[host: string, computer: string]>> = {
  claude: [[".claude/.credentials.json", ".claude/.credentials.json"]],
  codex: [[".codex/auth.json", ".codex/auth.json"]],
  cursor: [
    [".config/cursor/auth.json", ".config/cursor/auth.json"],
    [".cursor/cli-config.json", ".cursor/cli-config.json"],
  ],
  gemini: [
    [".gemini/oauth_creds.json", ".gemini/oauth_creds.json"],
    [".gemini/settings.json", ".gemini/settings.json"],
  ],
};

export const AUTH_AGENTS = Object.keys(AUTH_FILES);

/** Guesses which login an agent command needs, e.g. `claude-agent-acp` → claude. */
export function authForCommand(command: string): string | undefined {
  const base = path.basename(command);
  if (base.startsWith("claude")) return "claude";
  if (base.startsWith("codex")) return "codex";
  if (base.startsWith("cursor") || base === "agent") return "cursor";
  if (base.startsWith("gemini")) return "gemini";
  return undefined;
}

/** Copies the host's login for each agent into the computer. Returns what was copied. */
export async function copyAuth(name: string, agents: string[]): Promise<string[]> {
  const copied: string[] = [];
  for (const agent of agents) {
    for (const [hostRel, computerRel] of AUTH_FILES[agent] ?? []) {
      const source = path.join(os.homedir(), hostRel);
      if (!fs.existsSync(source)) continue;
      const target = `${HOME_IN_COMPUTER}/${computerRel}`;
      await docker(["exec", "-u", "agent", containerName(name), "mkdir", "-p", path.posix.dirname(target)]);
      await copy(name, source, target, "in");
      copied.push(`${agent}: ~/${hostRel}`);
    }
    if (agent === "claude") {
      // Skip Claude Code's first-run onboarding without copying the host's whole ~/.claude.json.
      await run(name, `[ -f ~/.claude.json ] || echo '{"hasCompletedOnboarding":true}' > ~/.claude.json`);
    }
  }
  return copied;
}

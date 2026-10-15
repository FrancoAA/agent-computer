import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as computer from "./computer.js";
import type { UpOptions } from "./computer.js";

const MAX_OUTPUT = 30_000;

function clip(text: string): string {
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n… (${text.length - MAX_OUTPUT} more characters)` : text;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

/** MCP server exposing one agent computer: screen, mouse/keyboard, shell, files, apps and Blender. */
export async function serveMcp(name: string, upOptions: UpOptions): Promise<void> {
  let ready: Promise<computer.ComputerInfo> | undefined;
  // Start the computer lazily on first use, so adding the server to an agent costs nothing until needed.
  const ensure = () => {
    ready ??= computer.up(name, upOptions).catch((error) => {
      ready = undefined;
      throw error;
    });
    return ready;
  };

  const server = new McpServer(
    { name: "agent-computer", version: "0.1.0" },
    {
      instructions:
        "Tools for your own Linux desktop computer (Debian + XFCE) with Chromium, Blender, LibreOffice and GIMP. " +
        "Files live in /workspace. Take a screenshot before clicking; coordinates are screen pixels. " +
        "Prefer `shell` for anything scriptable (e.g. `blender -b ... --python`), and the GUI tools for visual work. " +
        "A person may be watching the screen live.",
    },
  );

  server.registerTool(
    "computer_info",
    {
      description: "Describe the computer: screen size, workspace folder, live desktop URL and installed apps.",
    },
    async () => {
      const info = await ensure();
      const size = await computer.run(name, "xdpyinfo | awk '/dimensions/{print $2}'");
      return text(
        [
          `Computer: ${info.name}`,
          `Screen: ${size.stdout.trim()}`,
          `Workspace: /workspace (host: ${info.workspace})`,
          `Live desktop for the user: ${info.desktopUrl ?? "n/a"}`,
          "Apps: chromium (open with the `open` tool or `ac-browser <url>`), blender, libreoffice, gimp, xfce4-terminal, thunar",
          "CLI: python3, node 22, git, xdotool, wmctrl, scrot, imagemagick; sudo apt-get install for more",
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "screenshot",
    { description: "Take a screenshot of the whole screen (PNG). Use it to find what to click." },
    async () => {
      await ensure();
      const png = await computer.screenshot(name);
      return { content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }] };
    },
  );

  server.registerTool(
    "click",
    {
      description: "Move the mouse to (x, y) and click.",
      inputSchema: {
        x: z.number().int(),
        y: z.number().int(),
        button: z.enum(["left", "middle", "right"]).default("left"),
        clicks: z.number().int().min(1).max(3).default(1).describe("2 for double-click"),
      },
    },
    async ({ x, y, button, clicks }) => {
      await ensure();
      const code = { left: "1", middle: "2", right: "3" }[button];
      await computer.xdotool(name, ["mousemove", String(x), String(y), "click", "--repeat", String(clicks), "--delay", "80", code]);
      return text(`Clicked ${button} ×${clicks} at (${x}, ${y})`);
    },
  );

  server.registerTool(
    "move_mouse",
    { description: "Move the mouse without clicking (e.g. to hover).", inputSchema: { x: z.number().int(), y: z.number().int() } },
    async ({ x, y }) => {
      await ensure();
      await computer.xdotool(name, ["mousemove", String(x), String(y)]);
      return text(`Mouse at (${x}, ${y})`);
    },
  );

  server.registerTool(
    "drag",
    {
      description: "Drag with the left button from one point to another.",
      inputSchema: { from_x: z.number().int(), from_y: z.number().int(), to_x: z.number().int(), to_y: z.number().int() },
    },
    async ({ from_x, from_y, to_x, to_y }) => {
      await ensure();
      await computer.xdotool(name, [
        "mousemove", String(from_x), String(from_y), "mousedown", "1",
        "mousemove", "--sync", String(to_x), String(to_y), "mouseup", "1",
      ]);
      return text(`Dragged (${from_x}, ${from_y}) → (${to_x}, ${to_y})`);
    },
  );

  server.registerTool(
    "type_text",
    { description: "Type text into the focused window.", inputSchema: { text: z.string() } },
    async ({ text: value }) => {
      await ensure();
      await computer.xdotool(name, ["type", "--delay", "12", "--", value]);
      return text(`Typed ${value.length} characters`);
    },
  );

  server.registerTool(
    "press_keys",
    {
      description: "Press a key or shortcut, xdotool syntax: Return, Escape, ctrl+s, ctrl+shift+t, alt+F4, super.",
      inputSchema: { keys: z.string(), repeat: z.number().int().min(1).max(50).default(1) },
    },
    async ({ keys, repeat }) => {
      await ensure();
      await computer.xdotool(name, ["key", "--repeat", String(repeat), "--delay", "60", ...keys.split(/\s+/)]);
      return text(`Pressed ${keys}${repeat > 1 ? ` ×${repeat}` : ""}`);
    },
  );

  server.registerTool(
    "scroll",
    {
      description: "Scroll at (x, y).",
      inputSchema: {
        x: z.number().int(),
        y: z.number().int(),
        direction: z.enum(["up", "down", "left", "right"]),
        amount: z.number().int().min(1).max(30).default(3),
      },
    },
    async ({ x, y, direction, amount }) => {
      await ensure();
      const button = { up: "4", down: "5", left: "6", right: "7" }[direction];
      await computer.xdotool(name, ["mousemove", String(x), String(y), "click", "--repeat", String(amount), "--delay", "30", button]);
      return text(`Scrolled ${direction} ×${amount} at (${x}, ${y})`);
    },
  );

  server.registerTool(
    "shell",
    {
      description:
        "Run a bash command on the computer (as user `agent` with sudo, DISPLAY=:1, cwd /workspace). " +
        "Returns exit code, stdout and stderr. For GUI apps that keep running, use `open` instead.",
      inputSchema: {
        command: z.string(),
        timeout_seconds: z.number().int().min(1).max(3600).default(120),
        cwd: z.string().optional(),
      },
    },
    async ({ command, timeout_seconds, cwd }) => {
      await ensure();
      const result = await computer.run(name, command, { timeoutMs: timeout_seconds * 1000, cwd });
      return text(
        clip(
          `exit code: ${result.timedOut ? `killed after ${timeout_seconds}s` : result.code}\n` +
            (result.stdout ? `--- stdout\n${result.stdout}` : "") +
            (result.stderr ? `--- stderr\n${result.stderr}` : ""),
        ),
      );
    },
  );

  server.registerTool(
    "open",
    {
      description:
        "Open a URL in Chromium, or start a GUI app in the background (e.g. `blender /workspace/scene.blend`, " +
        "`libreoffice --calc`, `gimp`, `xfce4-terminal`). Take a screenshot afterwards to see it.",
      inputSchema: { target: z.string().describe("URL or command line") },
    },
    async ({ target }) => {
      await ensure();
      const isUrl = /^(https?|file):\/\//.test(target) || /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(target);
      const command = isUrl
        ? `ac-browser ${shellQuote(target)}`
        : `nohup setsid bash -lc ${shellQuote(target)} >/tmp/ac-open.log 2>&1 &`;
      const result = await computer.run(name, `${command}\nsleep 2`, { timeoutMs: 30_000 });
      if (result.code !== 0) return text(`Failed to open: ${result.stderr || result.stdout}`);
      return text(`Opened ${target}`);
    },
  );

  server.registerTool(
    "list_windows",
    { description: "List open windows (id, desktop, title)." },
    async () => {
      await ensure();
      const result = await computer.run(name, "wmctrl -l");
      return text(result.stdout.trim() || "(no windows)");
    },
  );

  server.registerTool(
    "focus_window",
    { description: "Bring the first window whose title contains the text to the front.", inputSchema: { title: z.string() } },
    async ({ title }) => {
      await ensure();
      const result = await computer.run(name, `wmctrl -a ${shellQuote(title)}`);
      return text(result.code === 0 ? `Focused "${title}"` : `No window matching "${title}"`);
    },
  );

  server.registerTool(
    "read_file",
    { description: "Read a text file on the computer (relative paths are under /workspace).", inputSchema: { path: z.string() } },
    async ({ path }) => {
      await ensure();
      return text(clip((await computer.readFile(name, path)).toString("utf8")));
    },
  );

  server.registerTool(
    "write_file",
    {
      description: "Create or overwrite a text file on the computer (relative paths are under /workspace).",
      inputSchema: { path: z.string(), content: z.string() },
    },
    async ({ path, content }) => {
      await ensure();
      await computer.writeFile(name, path, content);
      return text(`Wrote ${content.length} characters to ${path}`);
    },
  );

  server.registerTool(
    "view_image",
    {
      description: "Return an image file from the computer (e.g. a Blender render) so you can look at it.",
      inputSchema: { path: z.string() },
    },
    async ({ path }) => {
      await ensure();
      const data = await computer.readFile(name, path);
      const lower = path.toLowerCase();
      const mimeType = lower.endsWith(".jpg") || lower.endsWith(".jpeg") ? "image/jpeg" : lower.endsWith(".webp") ? "image/webp" : "image/png";
      return { content: [{ type: "image", data: data.toString("base64"), mimeType }] };
    },
  );

  server.registerTool(
    "blender",
    {
      description:
        "Run a Blender Python (bpy) script headlessly, optionally on a .blend file. Use it to build scenes, " +
        "export models or render (e.g. set scene.render.filepath and call bpy.ops.render.render(write_still=True)). " +
        "Returns Blender's output. Use `view_image` to look at renders.",
      inputSchema: {
        script: z.string().describe("Python code using bpy"),
        blend_file: z.string().optional().describe("Path of a .blend file to open first"),
        timeout_seconds: z.number().int().min(1).max(3600).default(600),
      },
    },
    async ({ script, blend_file, timeout_seconds }) => {
      await ensure();
      const scriptPath = `/tmp/ac-blender-${Date.now()}.py`;
      await computer.writeFile(name, scriptPath, script);
      const file = blend_file ? `${shellQuote(blend_file)} ` : "";
      const result = await computer.run(
        name,
        // Drop per-tile progress lines ("Fra:...") so errors and prints stay visible.
        `set -o pipefail; blender -b ${file}--python-exit-code 1 --python ${scriptPath} 2>&1 | grep -v '^Fra:' | tail -n 200`,
        { timeoutMs: timeout_seconds * 1000 },
      );
      return text(clip(`exit code: ${result.timedOut ? "timeout" : result.code}\n${result.stdout}${result.stderr}`));
    },
  );

  await server.connect(new StdioServerTransport());
}

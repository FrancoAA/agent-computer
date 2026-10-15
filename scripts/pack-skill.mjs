// Zips the skill folder for manual installs (unzip into ~/.claude/skills, ~/.agents/skills or ~/.pi/agent/skills).
import { execFileSync } from "node:child_process";
import fs from "node:fs";

fs.mkdirSync("release", { recursive: true });
fs.rmSync("release/agent-computer-skill.zip", { force: true });
execFileSync("zip", ["-qr", "../release/agent-computer-skill.zip", "agent-computer"], { cwd: "skills", stdio: "inherit" });
console.log(`release/agent-computer-skill.zip (${(fs.statSync("release/agent-computer-skill.zip").size / 1024).toFixed(0)} KB)`);

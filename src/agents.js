// エージェントの実体は外の Claude Code。どのディレクトリで、どの定義を読んで起きるかだけが違う
import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DEFS = {
  manager: path.join(ROOT, "agents", "manager.md"),
  task: path.join(ROOT, "skills", "backroom", "SKILL.md"),
};

// 取り消せないことはしない。マネージャはボードだけ、控室は読むことと調べることだけ
const TOOLS = {
  manager: ["mcp__board"],
  task: ["mcp__board", "Read", "Grep", "Glob", "WebSearch", "WebFetch"],
};

export function readDef(file) {
  const text = fs.readFileSync(file, "utf8");
  return text.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
}

// models：役割ごとのモデル（{ manager, task }）。指定がなければ claude の既定
export function claudeArgs(job, boardUrl, models = {}) {
  const mcp = { mcpServers: { board: { type: "http", url: `${boardUrl}/mcp?as=${encodeURIComponent(job.name)}` } } };
  return [
    "-p", job.prompt,
    "--mcp-config", JSON.stringify(mcp),
    "--strict-mcp-config",
    "--append-system-prompt", readDef(DEFS[job.role]),
    ...(models[job.role] ? ["--model", models[job.role]] : []),
    "--allowedTools", ...TOOLS[job.role],
  ];
}

// job: { role, name, prompt } -> { done: Promise<{code, error?}>, kill() }
export function claudeSpawner({ cmd = "claude", room = process.cwd(), boardUrl, logDir = null, models = {} }) {
  return (job) => {
    const args = claudeArgs(job, boardUrl, models);
    const cwd = room;
    let out = null;
    if (logDir) {
      fs.mkdirSync(logDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      out = fs.createWriteStream(path.join(logDir, `${stamp}-${job.role}-${job.taskId || "board"}.log`));
      out.write(`$ ${cmd} (${job.role} ${job.name} ${models[job.role] || "既定"}) in ${cwd}\n${job.prompt}\n\n`);
    }
    let child;
    const done = new Promise((resolve) => {
      try {
        child = nodeSpawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        resolve({ code: -1, error: e.message });
        return;
      }
      let tail = "";
      const keep = (b) => {
        out?.write(b);
        tail = (tail + b).slice(-400);
      };
      child.stdout.on("data", keep);
      child.stderr.on("data", keep);
      child.on("error", (e) => resolve({ code: -1, error: e.message }));
      child.on("close", (code) => {
        out?.end();
        resolve(code === 0 ? { code } : { code, error: `終了コード ${code}${tail ? `：${tail.trim().split("\n").at(-1)}` : ""}` });
      });
    });
    return { done, kill: () => child?.kill("SIGTERM") };
  };
}

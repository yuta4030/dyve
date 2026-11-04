import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { readConfig, loadCrew, ensureCrew, namesOf, initialsOf, agentOf, NAMES } from "../src/crew.js";
import { claudeArgs, claudeSpawner, claudeSession, systemPrompt, workspace, integrate } from "../src/agents.js";

// 設定（config.json）と指示の置き場（agents/）を一時ディレクトリに作る
function home(conf, bodies = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dyve-crew-"));
  const agents = path.join(dir, "agents");
  fs.mkdirSync(agents);
  for (const [f, text] of Object.entries(bodies)) fs.writeFileSync(path.join(agents, f), text);
  const config = path.join(dir, "config.json");
  if (conf != null) fs.writeFileSync(config, typeof conf === "string" ? conf : JSON.stringify(conf));
  return { dir, agents, config, crew: () => loadCrew({ config, fallback: agents }) };
}
const sys = (args) => args[args.indexOf("--append-system-prompt") + 1];
const model = (args) => (args.includes("--model") ? args[args.indexOf("--model") + 1] : undefined);

test("設定も指示もなければ既定のまま。置き場には README だけ置き、指示としては読まない", () => {
  const h = home(null);
  ensureCrew(h.agents);
  assert.ok(fs.existsSync(path.join(h.agents, "README.md")));
  const crew = h.crew();
  assert.deepEqual([crew.scribe, crew.manager, crew.team], [null, null, []]);
  assert.deepEqual(namesOf(crew), NAMES);
  assert.equal(initialsOf(crew, NAMES)["ボブ"], "B");
  assert.equal(agentOf(crew, "アリス"), null);
});

test("設定：控室は team の順、名前・頭文字・モデル・部屋。パスは ~ と config.json からの相対。--names が勝つ", () => {
  const h = home({
    port: 4800,
    room: "./repo",
    scribe: { model: "sonnet", pause: 300, cwd: "s" },
    team: [{ name: "マイ", initial: "M", model: "opus", room: "~/code/x" }, { name: "ケン" }],
  });
  const crew = h.crew();
  assert.deepEqual(crew.settings, { port: 4800, room: path.join(h.dir, "repo") });
  assert.deepEqual(namesOf(crew), ["マイ", "ケン"]);
  assert.equal(agentOf(crew, "マイ").room, path.join(os.homedir(), "code", "x"));
  assert.deepEqual(initialsOf(crew, namesOf(crew)), { "マイ": "M", "ケン": "ケ" });
  assert.deepEqual(crew.scribe, { mode: "append", model: "sonnet", pause: 300, cwd: path.join(h.dir, "s"), body: "" });
  assert.deepEqual(namesOf(crew, ["ジョー"]), ["ジョー"]);
});

test("設定の書き間違いは、どこの何かを言って断る", () => {
  const bad = (conf) => () => readConfig(home(conf).config);
  assert.throws(bad("{ port: 1 }"), /JSON として読めない/);
  assert.throws(bad({ prot: 1 }), /知らない項目 prot/);
  assert.throws(bad({ scribe: { pase: 1 } }), /知らない項目 scribe\.pase/);
  assert.throws(bad({ manager: { pause: "soon" } }), /manager\.pause は 0 以上の数/);
  assert.throws(bad({ manager: { mode: "over" } }), /"append" か "replace"/);
  assert.throws(bad({ team: [{ initial: "A" }] }), /team\[0\] に name がない/);
  assert.throws(bad({ team: [{ name: "manager" }] }), /ボードの立場の名前/);
  assert.throws(bad({ team: [{ name: "x" }, { name: "x" }] }), /二人いる/);
  assert.throws(bad({ team: { name: "x" } }), /team は配列/);
  assert.throws(bad({ scribe: { prompt: "./nai.md" } }), /scribe\.prompt のファイルがない/);
});

test("指示：置き場の <名前>.md を既定に足す（append）か差し替える（replace）。{{names}} は控室の名前になる", () => {
  const h = home({ scribe: { mode: "replace" }, team: [{ name: "マイ" }] }, {
    "manager.md": "要点は 5 項目まで。{{names}} を呼ぶ",
    "scribe.md": "あなたは私専用の清書係。{{names}}",
    "マイ.md": "結論は一行目",
  });
  const crew = h.crew(), names = namesOf(crew);
  const m = systemPrompt("manager", "manager", { crew, names });
  assert.match(m, /あなたはボードマネージャです/);
  assert.match(m, /## 利用者からの指示\n要点は 5 項目まで。マイ を呼ぶ/);
  assert.match(m, /控室のエージェントの名前（マイ）/);
  assert.doesNotMatch(m, /\{\{names\}\}|アリス/);
  assert.equal(systemPrompt("scribe", "scribe", { crew, names }), "あなたは私専用の清書係。マイ");
  assert.match(systemPrompt("task", "マイ", { crew, names }), /控室のタスクエージェント[\s\S]*## 利用者からの指示\n結論は一行目/);
  assert.match(systemPrompt("dev", "マイ", { crew, names }), /結論は一行目/);
  // 置き場がなければ、いままでどおり既定の六人
  assert.match(systemPrompt("scribe", "scribe"), /アリス、ボブ、キャロル、デイブ、エレン、フランク/);
});

test("prompt：育てている CLAUDE.md などのファイルを指示として読ませる（task は控室の全員に）", () => {
  const h = home(null, { "アリス.md": "アリスだけ" });
  const notes = path.join(h.dir, "notes");
  fs.mkdirSync(notes);
  fs.writeFileSync(path.join(notes, "CLAUDE.md"), "# 私の流儀\n短く書く");
  fs.writeFileSync(path.join(notes, "words.md"), "ホゲ → hoge");
  fs.writeFileSync(path.join(notes, "research.md"), "一次資料から");
  fs.writeFileSync(h.config, JSON.stringify({ scribe: { prompt: ["notes/CLAUDE.md", "notes/words.md"] }, task: { prompt: "notes/research.md" } }));
  const crew = h.crew();
  assert.equal(crew.scribe.body, "# 私の流儀\n短く書く\n\nホゲ → hoge");
  assert.match(systemPrompt("scribe", "scribe", { crew }), /## 利用者からの指示\n# 私の流儀/);
  assert.equal(agentOf(crew, "アリス").body, "一次資料から\n\nアリスだけ");
  assert.equal(agentOf(crew, "ボブ").body, "一次資料から");
  assert.equal(crew.manager, null);
});

test("モデル：控室は --task-model、なければその人の model", () => {
  const crew = home({ team: [{ name: "マイ", model: "opus" }, { name: "ケン" }] }).crew();
  assert.equal(model(claudeArgs({ role: "task", name: "マイ", prompt: "x" }, "http://x", {}, { crew })), "opus");
  assert.equal(model(claudeArgs({ role: "dev", name: "マイ", prompt: "x" }, "http://x", {}, { crew })), "opus");
  assert.equal(model(claudeArgs({ role: "task", name: "ケン", prompt: "x" }, "http://x", {}, { crew })), undefined);
  assert.equal(model(claudeArgs({ role: "task", name: "マイ", prompt: "x" }, "http://x", { task: "haiku" }, { crew })), "haiku");
});

test("マネージャには、別の部屋で働く人とその場所を教える", () => {
  const crew = home({ team: [{ name: "マイ", room: "/repo/docs" }, { name: "ケン" }] }).crew();
  const m = sys(claudeArgs({ role: "manager", name: "manager", prompt: "x" }, "http://x", {}, { room: "/repo/x", crew, names: namesOf(crew) }));
  assert.match(m, /リポジトリ \/repo\/x で働きます/);
  assert.match(m, /- マイ：\/repo\/docs/);
  assert.doesNotMatch(m, /- ケン/);
});

test("起きる場所：控室はその人の room、清書係とマネージャは設定の cwd", async () => {
  const h = home(null);
  const own = path.join(h.dir, "own"), staffCwd = path.join(h.dir, "mine-staff"), logDir = path.join(h.dir, "logs");
  fs.writeFileSync(h.config, JSON.stringify({ team: [{ name: "マイ", room: own }], manager: { cwd: staffCwd } }));
  const crew = h.crew();
  const spawn = claudeSpawner({ cmd: "true", room: path.join(h.dir, "room"), staff: path.join(h.dir, "staff"), boardUrl: "http://x", logDir, crew });
  await spawn({ role: "task", name: "マイ", taskId: "p1", prompt: "x" }).done;
  await spawn({ role: "manager", name: "manager", prompt: "x" }).done;
  const logs = fs.readdirSync(logDir).map((f) => fs.readFileSync(path.join(logDir, f), "utf8")).join("\n");
  assert.match(logs, new RegExp(`\\(task マイ [^)]*\\) in ${own}\n`));
  assert.match(logs, new RegExp(`\\(manager manager [^)]*\\) in ${staffCwd}\n`));
  // 起こしっぱなしの会話も同じ場所で起きる
  fs.rmSync(staffCwd, { recursive: true });
  const s = claudeSession({ cmd: "true", room: path.join(h.dir, "room"), staff: path.join(h.dir, "staff"), boardUrl: "http://x", crew })({ role: "manager", name: "manager" });
  s.kill();
  assert.ok(fs.existsSync(staffCwd));
});

test("別の部屋で働く人の開発の仕事は、その部屋から切り出し、その部屋に取り込む", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dyve-crew-"));
  const mk = (name) => {
    const room = path.join(dir, name);
    fs.mkdirSync(room);
    const git = (...a) => execFileSync("git", ["-C", room, ...a], { encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    fs.writeFileSync(path.join(room, "a.txt"), "a\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    return { room, git };
  };
  const main = mk("main"), other = mk("other");
  const workDir = path.join(dir, "work");
  const ws = workspace({ room: other.room, workDir, taskId: "p3" });
  fs.writeFileSync(path.join(ws.dir, "b.txt"), "b\n");
  execFileSync("git", ["-C", ws.dir, "add", "."]);
  execFileSync("git", ["-C", ws.dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "b"]);
  const r = integrate({ room: main.room, rooms: [path.join(dir, "not-git"), other.room], workDir, taskId: "p3" });
  assert.equal(r.into, "main");
  assert.ok(fs.existsSync(path.join(other.room, "b.txt")));
  assert.ok(!fs.existsSync(path.join(main.room, "b.txt")));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { readConfig, loadCrew, ensureCrew, namesOf, initialsOf, agentOf, callsOf, teamsOf, NAMES } from "../src/crew.js";
import { Store } from "../src/store.js";
import { Waker } from "../src/waker.js";
import { claudeArgs, claudeSpawner, claudeSession, exitError, systemPrompt, workspace, integrate } from "../src/agents.js";

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
  assert.deepEqual([crew.scribe, crew.manager, crew.members, crew.teams, crew.warnings], [null, null, [], [], []]);
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
  assert.match(m, /- マイ → data.to: "マイ"（\/repo\/docs で働く）/);
  assert.match(m, /- ケン → data.to: "ケン"\n|- ケン → data.to: "ケン"$/);
  // 呼び名も場所もふつうなら、顔ぶれの一覧は出さない
  assert.doesNotMatch(sys(claudeArgs({ role: "manager", name: "manager", prompt: "x" }, "http://x", {}, { room: "/repo/x" })), /data\.to: "/);
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

// チームのリポジトリ（.dyve/config.json と指示のファイル）を作る
function teamRepo(base, dirName, conf, files = {}) {
  const root = path.join(base, dirName);
  fs.mkdirSync(path.join(root, ".dyve"), { recursive: true });
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(root, ".dyve", f), text);
  fs.writeFileSync(path.join(root, ".dyve", "config.json"), JSON.stringify(conf));
  return root;
}

test("チーム：顔ぶれを合わせ、ログの名前は「名前@チーム」。働く場所の既定はチームのリポジトリ", () => {
  const h = home(null);
  const algr = teamRepo(h.dir, "algr", { task: { model: "sonnet" }, team: [{ name: "マイ" }, { name: "ケン", model: "opus", room: "sub" }] });
  fs.mkdirSync(path.join(algr, ".dyve", "sub"));
  fs.writeFileSync(h.config, JSON.stringify({ team: [{ name: "アリス" }], teams: ["algr"] }));
  const crew = h.crew(), names = namesOf(crew);
  assert.deepEqual(names, ["アリス", "マイ@algr", "ケン@algr"]);
  assert.deepEqual(callsOf(crew, names), { "アリス": "アリス", "マイ@algr": "マイ", "ケン@algr": "ケン" });
  assert.deepEqual(teamsOf(crew, names), { "アリス": null, "マイ@algr": "algr", "ケン@algr": "algr" });
  assert.equal(agentOf(crew, "マイ@algr").room, algr);
  assert.equal(agentOf(crew, "ケン@algr").room, path.join(algr, ".dyve", "sub"));
  assert.equal(agentOf(crew, "マイ@algr").model, "sonnet");
  assert.equal(agentOf(crew, "ケン@algr").model, "opus");
  assert.deepEqual(crew.warnings, []);
});

test("チーム：名前がぶつかったら知らせ、チームの人を「チーム の 名前」と呼び分ける。rename で変えられる", () => {
  const h = home(null);
  teamRepo(h.dir, "algr", { team: [{ name: "アリス" }] });
  teamRepo(h.dir, "k2down", { team: [{ name: "アリス" }, { name: "ボブ" }] });
  fs.writeFileSync(h.config, JSON.stringify({ team: [{ name: "アリス" }], teams: ["algr", "k2down"] }));
  let crew = h.crew(), names = namesOf(crew);
  assert.deepEqual(callsOf(crew, names), { "アリス": "アリス", "アリス@algr": "algr の アリス", "アリス@k2down": "k2down の アリス", "ボブ@k2down": "ボブ" });
  assert.deepEqual(initialsOf(crew, names), { "アリス": "A", "アリス@algr": "aA", "アリス@k2down": "kA", "ボブ@k2down": "B" });
  assert.equal(crew.warnings.length, 1);
  assert.match(crew.warnings[0], /自分の控室 と algr と k2down の両方に アリス がいる/);
  // rename：呼び名だけ変わり、ログの名前（id）は変わらない
  fs.writeFileSync(h.config, JSON.stringify({ teams: ["algr", { path: "k2down", rename: { "アリス": "アリサ", "ゾーイ": "z" } }] }));
  crew = h.crew();
  names = namesOf(crew);
  assert.deepEqual(callsOf(crew, names), { "アリス@algr": "アリス", "アリス@k2down": "アリサ", "ボブ@k2down": "ボブ" });
  assert.deepEqual(crew.warnings, ["teams の k2down の rename：ゾーイ はそのチームにいない"]);
});

test("チーム：指示はチームのあとに個人。清書係はつなぎ、マネージャにはチームごとの節を渡す", () => {
  const h = home(null, { "scribe.md": "個人の言い換え", "マイ@algr.md": "個人からマイへ" });
  teamRepo(h.dir, "algr", { name: "algr", task: { prompt: "conv.md" }, scribe: { prompt: "words.md" }, manager: { prompt: "triage.md" }, team: [{ name: "マイ" }] },
    { "conv.md": "algr の決まり", "words.md": "アルゴ → algr", "triage.md": "algr はバグを先に" });
  teamRepo(h.dir, "k2", { name: "k2down", team: [] });
  fs.writeFileSync(h.config, JSON.stringify({ teams: ["algr", "k2"] }));
  const crew = h.crew(), names = namesOf(crew);
  assert.equal(crew.scribe.body, "アルゴ → algr\n\n個人の言い換え");
  assert.equal(agentOf(crew, "マイ@algr").body, "algr の決まり\n\n個人からマイへ");
  assert.match(crew.warnings.join("\n"), /チーム k2down には控室の人がいない/);
  const m = systemPrompt("manager", "manager", { room: "/r", crew, names });
  assert.match(m, new RegExp(`### チーム algr（リポジトリ ${path.join(h.dir, "algr")}）\nalgr はバグを先に\n\n- マイ → data.to: "マイ@algr"`));
  assert.match(m, /data\.team に "algr"/);
  assert.match(m, /### チーム k2down[^\n]*\n- （控室の人はいない）/);
  assert.match(m, /どちらの〇〇か決まっていません/);
  assert.match(systemPrompt("task", "マイ@algr", { crew, names }), /## 利用者からの指示\nalgr の決まり/);
});

test("チームの設定は、書ける項目とリポジトリの外を断る", () => {
  const bad = (conf, files) => () => {
    const h = home(null);
    teamRepo(h.dir, "t", conf, files);
    fs.writeFileSync(h.config, JSON.stringify({ teams: ["t"] }));
    h.crew();
  };
  assert.throws(bad({ claude: "rm -rf /" }), /知らない項目 claude/);
  assert.throws(bad({ data: "x" }), /知らない項目 data/);
  assert.throws(bad({ manager: { mode: "replace" } }), /知らない項目 manager\.mode/);
  assert.throws(bad({ scribe: { model: "opus" } }), /知らない項目 scribe\.model/);
  assert.throws(bad({ room: "../.." }), /リポジトリ（[^）]+）の中だけ/);
  assert.throws(bad({ task: { prompt: "~/.ssh/id_rsa" } }), /の中だけ/);
  assert.throws(bad({ team: [{ name: "a@b" }] }), /@ を含まない/);
  assert.throws(bad({ name: "日本語" }), /チームの名前/);
  const h = home(null);
  fs.writeFileSync(h.config, JSON.stringify({ teams: ["nai"] }));
  assert.throws(() => h.crew(), /チームの設定がない/);
  teamRepo(h.dir, "a", { name: "same", team: [] });
  teamRepo(h.dir, "b", { name: "same", team: [] });
  fs.writeFileSync(h.config, JSON.stringify({ teams: ["a", "b"] }));
  assert.throws(() => h.crew(), /チームの名前 same が二つある/);
});

test("取り次ぎ：data.team ならそのチームの空いている人、data.to は呼び名や @ を省いた名前でも一人に決まれば渡す", () => {
  const store = new Store(null);
  const jobs = [];
  const w = new Waker({
    store,
    spawn: (j) => { jobs.push(j); return { done: new Promise(() => {}), kill() {} }; },
    pause: 1e6,
    slots: 5,
    names: ["アリス", "マイ@algr", "アリス@k2down"],
    calls: { "アリス": "アリス", "マイ@algr": "マイ", "アリス@k2down": "k2down の アリス" },
    teams: { "アリス": null, "マイ@algr": "algr", "アリス@k2down": "k2down" },
  }).start();
  const task = (data) => store.apply({ by: "manager", type: "add", panel: { view: "task", state: "task", data }, reason: "t" });
  task({ text: "k2down のこと", team: "k2down" });
  task({ text: "マイへ", to: "マイ" });
  task({ text: "呼び名で", to: "k2down の アリス" });
  // 呼び名で呼ばれた k2down の アリス は働いているので、ほかの人に回さずに空くまで待つ
  assert.deepEqual(jobs.map((j) => j.name), ["アリス@k2down", "マイ@algr"]);
  assert.match(jobs[1].prompt, /「マイ」（ボードの上の名前は マイ@algr）/);
  w.stop();
  assert.equal(w.resolve("アリス"), "アリス");
  assert.equal(w.resolve("k2down の アリス"), "アリス@k2down");
  assert.equal(w.resolve("ゾーイ"), null);
});

test("落ちた理由は claude の文から取り、JSON の切れ端を出さない", () => {
  const json = JSON.stringify({ duration_api_ms: 0, usage: {} });
  assert.equal(exitError(1, { result: "You've hit your 5-hour limit" }, "", json), "終了コード 1：You've hit your 5-hour limit");
  assert.equal(exitError(1, { usage: {} }, "", json), "終了コード 1");
  assert.equal(exitError(1, { usage: {} }, "warn\nboom\n", json), "終了コード 1：boom");
  assert.equal(exitError(1, null, "", "not json"), "終了コード 1：not json");
});

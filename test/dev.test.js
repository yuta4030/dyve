import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { claudeArgs, claudeSpawner, updateApp, workspace } from "../src/agents.js";

// 外にはつながず、手元に作った git リポジトリで試す
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dyve-dev-"));
  const room = path.join(dir, "room");
  fs.mkdirSync(room);
  const git = (...a) => execFileSync("git", ["-C", room, ...a], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(room, "a.txt"), "a\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return { dir, room, git };
}

test("開発の道具：書けるが push はできない。控室はいまも読むだけ", () => {
  const d = claudeArgs({ role: "dev", name: "アリス", prompt: "直して" }, "http://x", { task: "opus" });
  const allowed = d.slice(d.indexOf("--allowedTools") + 1);
  assert.ok(allowed.includes("Edit") && allowed.includes("Bash(node --test:*)") && allowed.includes("Bash(git commit:*)"));
  assert.ok(!allowed.some((t) => /push|Bash\)$|^Bash$/.test(t)));
  assert.ok(d.slice(d.indexOf("--disallowedTools") + 1).includes("Bash(git push:*)"));
  assert.equal(d[d.indexOf("--model") + 1], "opus");
  const t = claudeArgs({ role: "task", name: "ボブ", prompt: "調べて" }, "http://x");
  assert.ok(!t.includes("Edit") && !t.includes("Write"));
});

test("開発の仕事は、仕事ごとの worktree とブランチで起こし、同じ仕事なら同じ作業場を使う", async () => {
  const { dir, room } = repo();
  const workDir = path.join(dir, "work");
  const ws = workspace({ room, workDir, taskId: "p7", now: new Date("2026-11-03T01:02:00Z") });
  assert.equal(ws.branch, "dyve/p7-20261103-0102");
  assert.equal(ws.base, "main");
  assert.ok(fs.existsSync(path.join(ws.dir, "a.txt")));
  assert.equal(workspace({ room, workDir, taskId: "p7" }).dir, ws.dir);
  assert.notEqual(workspace({ room, workDir, taskId: "p70" }).dir, ws.dir);
  // claude の代わりに true を起こし、作業場で起きたことと、指示に作業場が書かれたことを見る
  const logDir = path.join(dir, "logs");
  const spawn = claudeSpawner({ cmd: "true", room, staff: path.join(dir, "staff"), workDir, boardUrl: "http://x", logDir });
  const r = await spawn({ role: "dev", name: "アリス", taskId: "p7", prompt: "直して" }).done;
  assert.equal(r.code, 0);
  const log = fs.readFileSync(path.join(logDir, fs.readdirSync(logDir)[0]), "utf8");
  assert.match(log, new RegExp(`in ${ws.dir}`));
  assert.match(log, /ブランチ：dyve\/p7-/);
  // git でない部屋なら、作業場を作れなかったと返す（落ちたままにしない）
  const bad = claudeSpawner({ cmd: "true", room: dir, staff: path.join(dir, "staff"), workDir, boardUrl: "http://x" });
  const e = await bad({ role: "dev", name: "ボブ", taskId: "p9", prompt: "x" }).done;
  assert.match(e.error, /作業場を作れませんでした/);
});

test("使う dyve を別の置き場に切り出し、人が決めたときだけ更新する", () => {
  const { dir, room, git } = repo();
  const app = path.join(dir, "app");
  const first = updateApp({ room, app });
  assert.equal(first.created, true);
  assert.equal(fs.readFileSync(path.join(app, "a.txt"), "utf8"), "a\n");
  fs.writeFileSync(path.join(room, "a.txt"), "b\n");
  git("commit", "-qam", "b");
  // 作る側が進んでも、使う側は更新するまで変わらない
  assert.equal(fs.readFileSync(path.join(app, "a.txt"), "utf8"), "a\n");
  const next = updateApp({ room, app });
  assert.equal(next.created, false);
  assert.equal(fs.readFileSync(path.join(app, "a.txt"), "utf8"), "b\n");
  fs.writeFileSync(path.join(app, "a.txt"), "local\n");
  assert.throws(() => updateApp({ room, app }), /手を入れた跡/);
});

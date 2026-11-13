import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ensurePanels, listViews, readView } from "../src/panels.js";
import { Log } from "../src/log.js";
import { loadRoles, NEVER } from "../src/roles.js";
import { Sessions } from "../src/sessions.js";
import { saidPrompt, sessionPrompt, cardOf } from "../src/kakari.js";
import { createServer } from "../src/server.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dyve-next-panels-"));
const roles = loadRoles();

test("置き場がなければ作る：git の履歴・README・見本の view を一つ。あれば何も上書きしない", () => {
  const dir = path.join(tmp(), "panels");
  const r = ensurePanels(dir);
  assert.deepEqual([r.created, r.warn], [true, null]);
  assert.ok(fs.existsSync(path.join(dir, "README.md")));
  assert.deepEqual(fs.readdirSync(path.join(dir, "views")), ["bars.js"]);
  assert.match(execFileSync("git", ["-C", dir, "log", "--oneline"], { encoding: "utf8" }), /パネル置き場をつくる/);
  fs.writeFileSync(path.join(dir, "README.md"), "わたしの README");
  fs.rmSync(path.join(dir, "views", "bars.js"));
  assert.equal(ensurePanels(dir).created, false);
  assert.equal(fs.readFileSync(path.join(dir, "README.md"), "utf8"), "わたしの README");
  assert.deepEqual(fs.readdirSync(path.join(dir, "views")), [], "消した見本を戻さない");
});

test("view の一覧：名前・一行の説明（頭のコメントの一行目）・データの形（二行目から）。名前で絞る", () => {
  const dir = path.join(tmp(), "panels");
  ensurePanels(dir);
  fs.writeFileSync(path.join(dir, "views", "steps-done.js"), "// 段取りを点で\n// data: { \"done\": 数, \"all\": 数 }\n// ref はなくてよい\ndyve.view(() => {});\n");
  fs.writeFileSync(path.join(dir, "views", "Bad Name.js"), "// x\n");
  fs.writeFileSync(path.join(dir, "views", "notes.txt"), "x");
  const views = listViews(dir);
  assert.deepEqual(views.map((v) => v.name), ["bars", "steps-done"]);
  assert.equal(views[0].about, "数を横棒で比べる");
  assert.match(views[0].shape, /^data: \[\{ "label"/);
  assert.equal(views[1].shape, 'data: { "done": 数, "all": 数 }\nref はなくてよい');
  assert.match(readView(dir, "bars"), /dyve\.view/);
  for (const bad of ["../README", "..%2Fx", "Bad Name", "", "bars.js"]) assert.equal(readView(dir, bad), null, bad);
  assert.deepEqual(listViews(path.join(dir, "nowhere")), []);
});

test("サーバー：view の一覧と中身だけ。置き場の外は読ませない", async () => {
  const dir = path.join(tmp(), "panels");
  ensurePanels(dir);
  fs.writeFileSync(path.join(path.dirname(dir), "secret.js"), "秘密");
  const server = createServer({ log: new Log(), panels: dir });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepEqual((await (await fetch(`${base}/api/views`)).json()).map((v) => v.name), ["bars"]);
    const r = await fetch(`${base}/api/views/bars`);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /^\/\/ 数を横棒で比べる/);
    for (const bad of ["..%2Fsecret", "..%2F..%2Fsecret", "%2E%2E%2Fsecret", "nothing", "%E0%A4%A"]) {
      assert.notEqual((await fetch(`${base}/api/views/${bad}`)).status, 200, bad);
    }
    // 囲いの中（sandbox で origin が null）からは何も読めない
    const http = await import("node:http");
    const status = await new Promise((ok) => http.get({ host: "127.0.0.1", port: server.address().port, path: "/api/state", headers: { origin: "null" } }, (res) => ok(res.statusCode)));
    assert.equal(status, 403);
  } finally {
    server.closeAll();
  }
});

test("パネルの役割は置き場で起き、道具は 2 段目のまま（外に届くことは止める）。置き場がなければ選ばせない", () => {
  const dir = path.join(tmp(), "panels");
  ensurePanels(dir);
  const log = new Log();
  const jobs = [];
  const s = new Sessions({ log, roles, room: "/tmp/room", panels: dir, spawn: (job) => { jobs.push(job); return { done: new Promise(() => {}), kill() {} }; } }).start();
  const r = s.ask(log.add("say", { text: "かかった時間を棒で見たい" }).record.seq, { role: "パネル", name: "棒の view" });
  assert.equal(r.ok, true);
  assert.equal(jobs[0].cwd, dir);
  const a = jobs[0].args, allow = a.slice(a.indexOf("--allowedTools") + 1, a.indexOf("--disallowedTools")), deny = a.slice(a.indexOf("--disallowedTools") + 1);
  assert.ok(allow.includes("Edit") && allow.includes("Bash(git commit:*)"));
  for (const t of NEVER) assert.ok(deny.includes(t), t);
  assert.match(a[a.indexOf("--append-system-prompt") + 1], /README\.md を読み/);
  assert.equal(jobs[0].prompt, "かかった時間を棒で見たい", "セッションは素のまま");
  // 係に見せる役割：置き場があればパネルも、なければ出さない
  const st = log.state;
  const with_ = saidPrompt({ state: st, batch: [st.said[0]], roles, can: (x) => !!s.placeOf(x) });
  assert.match(with_, /- パネル：パネルの見せ方（view）そのものを作る・直す/);
  assert.doesNotMatch(with_, /- 開発：/);
  const none = new Sessions({ log: new Log(), roles, room: "/tmp", spawn: () => ({ done: new Promise(() => {}), kill() {} }) });
  assert.doesNotMatch(saidPrompt({ state: st, batch: [st.said[0]], roles, can: (x) => !!none.placeOf(x) }), /- パネル：/);
});

test("係に置き場の view を見せ、合うときだけ選べる。あるものだけ通し、ないものは本体の view に落とす", () => {
  const x = { id: 2, sym: "A", name: "時間", role: "調べもの", asked: [1], flow: [{ seq: 3, said: 1 }, { seq: 5, talk: "a 3 秒、b 5 秒" }], last: "a 3 秒、b 5 秒", card: null };
  const state = { said: [{ id: 1, text: "時間を比べて" }], sessions: [x] };
  const views = [{ name: "bars", about: "数を横棒で比べる", shape: 'data: [{ "label": "名前", "value": 数 }]' }];
  const p = sessionPrompt(state, x, views);
  assert.match(p, /置き場の view（[^）]*）：\n- bars：数を横棒で比べる\n  data: \[\{ "label": "名前", "value": 数 \}\]$/);
  assert.doesNotMatch(sessionPrompt(state, x, []), /置き場の view/);
  const json = { line: "b が遅い", back: "b が遅い", panels: [{ view: "bars", title: "秒", data: [{ label: "a", value: 3, ref: 5 }, { label: "b", value: 5 }] }, { view: "pie", data: [1, 2] }] };
  const c = cardOf(json, x, new Set(["bars"]));
  assert.deepEqual(c.panels[0], { view: "bars", title: "秒", data: [{ label: "a", value: 3, ref: 5 }, { label: "b", value: 5 }] });
  assert.equal(c.panels[1].view, "json", "置き場にない view は本体の view に落とす");
  assert.equal(cardOf(json, x).panels[0].view, "json", "置き場がなければ通さない");
});

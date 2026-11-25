import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withUser } from "../src/user.js";
import { Log } from "../src/log.js";
import { Sessions } from "../src/sessions.js";

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "dyve-user-"));

test("利用者の書き足し：用語は全員に、<名前>.md はその者だけに足す。なければ足さない", () => {
  const d = dir();
  assert.equal(withUser("基本", d, "係"), "基本");
  assert.equal(withUser("基本", null, "係"), "基本");
  fs.writeFileSync(path.join(d, "用語.md"), "- Toon（「問 2」と聞こえる）\n");
  fs.writeFileSync(path.join(d, "係.md"), "見積もりの話は D に届ける\n");
  const k = withUser("基本", d, "係");
  assert.match(k, /^基本\n\n## 用語（利用者が書いたもの）\n[\s\S]*- Toon（「問 2」と聞こえる）\n\n## 利用者からの指示\n\n見積もりの話は D に届ける$/);
  const m = withUser("基本", d, "まとめ");
  assert.match(m, /Toon/);
  assert.doesNotMatch(m, /見積もり/);
});

test("セッションは起きるたびに、用語とセッション.md を読み直す", () => {
  const d = dir(), jobs = [];
  const spawn = (job) => { jobs.push(job); return { done: new Promise(() => {}), write() {}, end() {}, kill() {} }; };
  const log = new Log();
  const sessions = new Sessions({ log, spawn, room: d, prompt: "P", user: d });
  fs.writeFileSync(path.join(d, "用語.md"), "PROJ は社内の課題管理");
  fs.writeFileSync(path.join(d, "セッション.md"), "日本語で答える");
  const id = sessions.open("a");
  const s = log.add("say", { text: "x" }).seq;
  log.add("route", { say: s, session: id });
  sessions.send(id, s);
  const p = jobs[0].args[jobs[0].args.indexOf("--append-system-prompt") + 1];
  assert.match(p, /^P\n\n## 用語/);
  assert.match(p, /PROJ は社内の課題管理/);
  assert.match(p, /日本語で答える/);
});

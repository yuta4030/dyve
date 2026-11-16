import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadRoles, NEVER } from "../src/roles.js";

// 利用者の置き場を一時に作る：config.json と roles/<名前>.md
function place(config, bodies = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dyve-next-roles-"));
  fs.mkdirSync(path.join(dir, "roles"));
  if (config) fs.writeFileSync(path.join(dir, "config.json"), typeof config === "string" ? config : JSON.stringify(config));
  for (const [n, t] of Object.entries(bodies)) fs.writeFileSync(path.join(dir, "roles", `${n}.md`), t);
  return path.join(dir, "config.json");
}

test("置き場がなければ dyve の役割のまま", () => {
  const r = loadRoles({ config: "/nowhere/config.json" });
  assert.deepEqual(Object.keys(r).sort(), ["パネル", "開発", "調べもの"].sort());
  assert.doesNotMatch(r.調べもの.prompt, /利用者からの指示/);
});

test("同じ名前の定義は後ろに足し、mode が replace なら差し替える", () => {
  const add = loadRoles({ config: place(null, { 調べもの: "出典は日本語のものを先に" }) });
  assert.match(add.調べもの.prompt, /^あなたは調べものを受け持ちます[\s\S]*## 利用者からの指示\n出典は日本語のものを先に$/);
  const rep = loadRoles({ config: place({ roles: { 調べもの: { mode: "replace" } } }, { 調べもの: "わたしの調べもの" }) });
  assert.equal(rep.調べもの.prompt, "わたしの調べもの");
  // 差し替えても、禁じる道具は残る
  for (const t of ["Edit", ...NEVER]) assert.ok(rep.調べもの.deny.includes(t));
});

test("新しい名前なら役割が増える。道具を書かなければ読むだけ", () => {
  const r = loadRoles({ config: place(null, { 書き手: "リリースノートを書く" }) });
  assert.equal(r.書き手.prompt, "リリースノートを書く");
  assert.equal(r.書き手.place, "room");
  assert.ok(!r.書き手.tools.includes("Edit"));
  assert.ok(r.書き手.deny.includes("Edit"));
});

test("利用者は道具とモデルを決められるが、外に届くことの禁止は外せない", () => {
  const r = loadRoles({ config: place({ roles: { 書き手: { model: "opus", tools: ["Read", "Edit", "Bash(git push:*)", "Bash"], deny: ["WebFetch"] } } }, { 書き手: "書く" }) });
  assert.equal(r.書き手.model, "opus");
  assert.deepEqual(r.書き手.tools, ["Read", "Edit", "Bash(git push:*)", "Bash"]);
  for (const t of [...NEVER, "WebFetch"]) assert.ok(r.書き手.deny.includes(t), t);
  assert.ok(!r.書き手.deny.includes("Edit"), "道具を書いたら、その道具は禁じない");
  const dev = loadRoles({ config: place({ roles: { 開発: { deny: [] } } }) });
  for (const t of NEVER) assert.ok(dev.開発.deny.includes(t));
});

test("設定の誤りは、どこが悪いかを言って断る", () => {
  assert.throws(() => loadRoles({ config: place("{") }), /JSON として読めない/);
  assert.throws(() => loadRoles({ config: place({ port: 1 }) }), /知らない項目 port/);
  assert.throws(() => loadRoles({ config: place({ roles: { 調べもの: { place: "x" } } }) }), /知らない項目 roles\.調べもの\.place/);
  assert.throws(() => loadRoles({ config: place({ roles: { 調べもの: { mode: "x" } } }) }), /"append" か "replace"/);
  assert.throws(() => loadRoles({ config: place({ roles: { 調べもの: { tools: "Read" } } }) }), /文字列の配列/);
  assert.throws(() => loadRoles({ config: place({ roles: { 幽霊: { model: "opus" } } }) }), /役割「幽霊」の定義がない/);
});

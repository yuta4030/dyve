// 利用者の設定（config.json）。依存を持たないので JSON。書ける項目と型を絞り、誤りはどこが悪いかを言って断る
//   roles.<名前>：model・mode・tools・deny（役割。roles.js）
//   kakari：model（係）
//   sessions：renew（会話がこの大きさ（トークン）を超えたら、次の続きはまっさらで起こし直す。0 なら起こし直さない）
import fs from "node:fs";

export const NAME = /^[^\s/\\.][^\s/\\]{0,39}$/u;
const ROLE = { model: "string", mode: "mode", tools: "list", deny: "list" };
const KAKARI = { model: "string" };
const SESSIONS = { renew: "count" };

function check(obj, fields, at, file) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error(`${file}：${at} はオブジェクトで書く`);
  for (const [k, v] of Object.entries(obj)) {
    const t = fields[k], key = `${at}.${k}`;
    if (!t) throw new Error(`${file}：知らない項目 ${key}（書けるのは ${Object.keys(fields).join("・")}）`);
    if (t === "string" && !(typeof v === "string" && v.trim())) throw new Error(`${file}：${key} は空でない文字列`);
    if (t === "mode" && v !== "append" && v !== "replace") throw new Error(`${file}：${key} は "append" か "replace"`);
    if (t === "count" && !(Number.isInteger(v) && v >= 0)) throw new Error(`${file}：${key} は 0 以上の整数`);
    if (t === "list" && !(Array.isArray(v) && v.every((x) => typeof x === "string" && x.trim()))) throw new Error(`${file}：${key} は文字列の配列`);
  }
}

// 返すもの：{ roles: { 名前: {...} }, kakari: {...}, sessions: {...} }。ファイルがなければ空
export function readConfig(file) {
  if (!file || !fs.existsSync(file)) return { roles: {}, kakari: {}, sessions: {} };
  let c;
  try {
    c = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file} が JSON として読めない（${e.message}）`);
  }
  if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error(`${file} はオブジェクト（{ … }）で書く`);
  for (const k of Object.keys(c)) if (!["roles", "kakari", "sessions"].includes(k)) throw new Error(`${file}：知らない項目 ${k}（書けるのは roles・kakari・sessions）`);
  const roles = c.roles ?? {};
  if (!roles || typeof roles !== "object" || Array.isArray(roles)) throw new Error(`${file}：roles はオブジェクトで書く`);
  for (const [name, r] of Object.entries(roles)) {
    if (!NAME.test(name)) throw new Error(`${file}：役割の名前「${name}」は空白・/・\\ を含まない 40 文字まで`);
    check(r, ROLE, `roles.${name}`, file);
  }
  const kakari = c.kakari ?? {};
  check(kakari, KAKARI, "kakari", file);
  const sessions = c.sessions ?? {};
  check(sessions, SESSIONS, "sessions", file);
  return { roles, kakari, sessions };
}

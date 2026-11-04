#!/usr/bin/env node
// リリース用の補助。CI（.github/workflows/release.yml）とテストから使う。
//   node scripts/release-notes.js --version   package.json の版を出す
//   node scripts/release-notes.js 0.1.0       CHANGELOG.md のその版の節を出す（なければ終了コード 1）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function version() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
}

// 「## [版] - 日付」の見出しから次の「## 」の手前までを返す
export function notes(ver, changelog) {
  const esc = ver.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = changelog.match(new RegExp(`^## \\[${esc}\\][^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m"));
  return m ? m[1].trim() + "\n" : null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  if (a.length === 1 && a[0] === "--version") {
    process.stdout.write(version() + "\n");
  } else if (a.length === 1) {
    const n = notes(a[0], fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8"));
    if (n == null) {
      process.stderr.write(`CHANGELOG.md に ${a[0]} の節がない\n`);
      process.exit(1);
    }
    process.stdout.write(n);
  } else {
    process.stderr.write("使い方: node scripts/release-notes.js --version | <版>\n");
    process.exit(1);
  }
}

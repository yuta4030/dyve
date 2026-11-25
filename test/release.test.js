import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { version, notes } from "../scripts/release-notes.js";

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

test("CHANGELOG にいまの版の節がある", () => {
  const v = version();
  assert.ok(notes(v, read("CHANGELOG.md")), `CHANGELOG.md に ${v} の節がない`);
});

test("CHANGELOG からその版の節だけを取り出す", () => {
  const md = "# C\n\n## [0.2.0] - x\n\n- b\n\n## [0.1.0] - y\n\n- a\n";
  assert.equal(notes("0.2.0", md), "- b\n");
  assert.equal(notes("0.1.0", md), "- a\n");
  assert.equal(notes("0.3.0", md), null);
  assert.equal(notes("0.1", md), null);
});

test("入れたときに要るものだけを配る", () => {
  const pkg = JSON.parse(read("package.json"));
  for (const f of ["bin", "src", "prompts"]) assert.ok(pkg.files.includes(f), f);
  assert.ok(!pkg.files.includes("test"));
  assert.equal(pkg.bin.dyve, "bin/dyve.js");
});

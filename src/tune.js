// 画面の調整：指したとみなす・知らせを見たことにするまでの時間など。人が dyve 設定で変え、立て直さずに効く。
// 読む速さは人によるので、ボードではなく人のものとして ~/.dyve/ui-settings.json に持つ（パネルの設定と同じところ）
import fs from "node:fs";

// 既定と、受け付ける幅（単位は名前のとおり）
export const TUNE = {
  pointHoldMs: { def: 250, min: 0, max: 3000 }, // マウスがこれだけ留まったら、そのパネルを指したことにする
  pointKeepSec: { def: 45, min: 5, max: 600 }, // 指した・動かして見たのがこれより前なら、発言に付けない
  readPerCharMs: { def: 25, min: 0, max: 300 }, // 知らせを見たことにするまで：一文字あたり
  readMinMs: { def: 1200, min: 0, max: 20000 }, // その下限
  readMaxMs: { def: 6000, min: 500, max: 60000 }, // その上限
  readZoomPct: { def: 50, min: 10, max: 100 }, // これより小さく縮めて映っているものは、見たことにしない
};

const defaults = () => Object.fromEntries(Object.entries(TUNE).map(([k, v]) => [k, v.def]));
const limits = () => Object.fromEntries(Object.entries(TUNE).map(([k, { min, max, def }]) => [k, { min, max, def }]));

// 変えたものだけを持つ。知らない項目と幅の外の値は読まない
function own(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw && typeof raw === "object" ? raw : {})) {
    if (TUNE[k] && Number.isFinite(v) && v >= TUNE[k].min && v <= TUNE[k].max) out[k] = v;
  }
  return out;
}

// file がなければメモリだけに持つ（テストや置き場のない起動）
export class Tune {
  constructor(file = null) {
    this.file = file;
    this.mem = {};
    try {
      if (file) this.mem = own(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch {}
  }

  view() {
    return { values: { ...defaults(), ...this.mem }, limits: limits() };
  }

  // { 名前: 値 | null }。null は既定に戻す。幅の外は断る
  set(patch = {}) {
    const next = { ...this.mem };
    for (const [k, v] of Object.entries(patch && typeof patch === "object" ? patch : {})) {
      const t = TUNE[k];
      if (!t) throw new Error(`知らない項目：${k}`);
      if (v === null) { delete next[k]; continue; }
      if (!Number.isFinite(v) || v < t.min || v > t.max) throw new Error(`${k} は ${t.min} から ${t.max} まで`);
      next[k] = v;
    }
    this.mem = next;
    if (this.file) fs.writeFileSync(this.file, JSON.stringify(next, null, 2) + "\n");
    return this.view();
  }
}

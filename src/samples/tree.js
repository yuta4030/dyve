// ファイルや場所の一覧と、それぞれの状態（残っている・消した・手を入れた）
// data は [項目] か { 群の名前: [項目] }。項目は文字列か { path, state?, tone?, gone?, children? }
//   state：右に出す短い札（「使用中」「未取り込みあり」）。tone：ok・warn・accent・mute（先頭の丸の色）。gone: true は消したもの（× と打ち消し線）
//   children：下の項目（字下げして木にする）。群の中が全部 / で区切った道（3 つ以上）なら、同じ場所の下にまとめて木にする
dyve.view((el, data) => {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const str = (v) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  const item = (x) => (x && typeof x === "object" && !Array.isArray(x) ? { ...x, path: str(x.path ?? x.name ?? x.title ?? x.text) } : { path: str(x) });
  const groups = Array.isArray(data) ? [["", data]]
    : data && typeof data === "object" ? Object.entries(data).map(([k, v]) => [k, Array.isArray(v) ? v : [v]])
    : [["", str(data).split("\n").filter((s) => s.trim())]];
  const TONES = ["ok", "warn", "accent", "mute"];
  // 道の並びを木に：同じ親の下にまとめ、子が一つだけの場所はつなげて一行に
  const fold = (items) => {
    const root = { dirs: new Map(), items: [] };
    for (const it of items) {
      const parts = it.path.split("/");
      let n = root;
      for (const p of parts.slice(0, -1)) {
        if (!n.dirs.has(p)) n.dirs.set(p, { dirs: new Map(), items: [] });
        n = n.dirs.get(p);
      }
      n.items.push({ ...it, path: parts.at(-1) || it.path });
    }
    const out = (n) => [...[...n.dirs].map(([name, d]) => {
      while (d.dirs.size === 1 && !d.items.length) { const [[k, v]] = [...d.dirs]; name = `${name}/${k}`; d = v; }
      return { path: `${name}/`, dir: true, children: out(d) };
    }), ...n.items];
    return out(root);
  };
  const row = (it, depth) => {
    const tone = TONES.includes(it.tone) ? it.tone : it.gone ? "mute" : "";
    const sym = it.dir ? "▾" : it.gone ? "×" : "●";
    const kids = Array.isArray(it.children) ? it.children.map(item) : [];
    return `<div class="r${it.gone ? " gone" : ""}${it.dir ? " dir" : ""}" style="padding-left:${depth * 14}px"><span class="d ${tone}">${sym}</span><span class="p" title="${esc(it.path)}">${esc(it.path)}</span>${it.state != null ? `<span class="t ${tone}">${esc(str(it.state))}</span>` : "<span></span>"}</div>` +
      kids.map((k) => row(k, depth + 1)).join("");
  };
  const body = (items) => {
    const list = items.map(item);
    const paths = list.length >= 3 && list.every((it) => !it.children && /\//.test(it.path));
    return (paths ? fold(list) : list).map((it) => row(it, 0)).join("");
  };
  el.innerHTML = `<style>
    .tree { display: grid; gap: 2px; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .r { display: grid; grid-template-columns: 1.2em minmax(0, 1fr) auto; gap: 6px; align-items: center; }
    .p { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .d { color: var(--mute); } .d.ok { color: var(--ok); } .d.warn { color: var(--warn); } .d.accent { color: var(--accent); }
    .dir .p { color: var(--mute); }
    .gone .p { text-decoration: line-through; color: var(--mute); }
    .t { font: 11px system-ui, sans-serif; padding: 0 7px; border-radius: 999px; border: 1px solid var(--line); color: var(--mute); white-space: nowrap; }
    .t.ok { border-color: var(--ok); color: var(--ok); } .t.warn { border-color: var(--warn); color: var(--warn); } .t.accent { border-color: var(--accent); color: var(--accent); }
    h4 { margin: 6px 0 2px; font: 600 11px system-ui, sans-serif; letter-spacing: .06em; color: var(--mute); }
    h4:first-child { margin-top: 0; } h4 em { font-style: normal; margin-left: 6px; }
  </style><div class="tree">${groups.map(([name, items]) => `${name ? `<h4>${esc(name)}<em>${items.length}</em></h4>` : ""}${body(items)}`).join("")}</div>`;
});

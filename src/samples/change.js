// 取り込み待ちの変更（ブランチ・差分・取り込みの依頼）を一枚で。題・どこからどこへ・チェックの成否・変わったファイルと量・注意
// data は { title, id?, from?, to?, state?, checks?, files?, add?, del?, steps?, notes? }
//   state：文字列か { text, tone }（tone は ok・warn）。checks：[{ name, ok }]（ok は true・false・null＝まだ）か { 名前: true|false }
//   files：[{ path, add?, del?, new?, gone? }]（文字列でもよい。多いものから 6 つまで出し、残りは「ほか n」）。add・del は全体の行数（なければ files から足す）
//   steps：このあと続くこと（["取り込む", "タグ", "公開"]。先頭が次の一手）。notes：注意の文の配列
// 文字列なら unified diff（git diff の出力）として読み、ファイルごとの行数を数える
dyve.view((el, data) => {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const str = (v) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const list = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);
  // 差分の文字列から、ファイルごとの行数
  const fromDiff = (src) => {
    const files = [];
    let cur = null;
    for (const l of src.replace(/\r\n?/g, "\n").split("\n")) {
      const m = l.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (m) { cur = { path: m[2], add: 0, del: 0 }; files.push(cur); continue; }
      if (!cur || /^(\+\+\+|---) /.test(l)) continue;
      if (/^new file/.test(l)) cur.new = true;
      else if (/^deleted file/.test(l)) cur.gone = true;
      else if (l.startsWith("+")) cur.add++;
      else if (l.startsWith("-")) cur.del++;
    }
    return files.length ? { files } : { title: src.split("\n")[0] };
  };
  const d = typeof data === "string" ? fromDiff(data) : data && typeof data === "object" && !Array.isArray(data) ? data : Array.isArray(data) ? { files: data } : { title: str(data) };
  const files = list(d.files).map((f) => (f && typeof f === "object" ? { ...f, path: str(f.path ?? f.name ?? f.file) } : { path: str(f) }));
  const size = (f) => num(f.add) + num(f.del);
  const top = [...files].sort((a, b) => size(b) - size(a)).slice(0, 6);
  const max = Math.max(1, ...top.map(size));
  const add = d.add != null ? num(d.add) : files.reduce((a, f) => a + num(f.add), 0);
  const del = d.del != null ? num(d.del) : files.reduce((a, f) => a + num(f.del), 0);
  const checks = Array.isArray(d.checks) ? d.checks.map((c) => (c && typeof c === "object" ? { name: str(c.name ?? c.title), ok: c.ok ?? c.pass ?? null } : { name: str(c), ok: null }))
    : d.checks && typeof d.checks === "object" ? Object.entries(d.checks).map(([name, ok]) => ({ name, ok })) : [];
  const passed = checks.filter((c) => c.ok === true).length;
  const st = d.state && typeof d.state === "object" ? d.state : d.state != null ? { text: str(d.state) } : null;
  const stTone = st && ["ok", "warn"].includes(st.tone) ? st.tone : checks.some((c) => c.ok === false) ? "warn" : "";
  const mark = (ok) => (ok === true ? "✓" : ok === false ? "✗" : "…");
  const steps = list(d.steps).map(str), notes = list(d.notes).map(str);
  const split = add + del ? Math.round((add / (add + del)) * 100) : 100;
  el.innerHTML = `<style>
    .hd { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
    .hd h3 { margin: 0; font-size: 16px; overflow-wrap: anywhere; } .hd .id { color: var(--mute); }
    .flow { display: flex; align-items: center; gap: 6px; margin-top: 6px; flex-wrap: wrap; font-size: 12px; }
    .pill { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; padding: 1px 7px; border-radius: 6px; background: var(--accent-soft); border: 1px solid var(--line); }
    .st { font-weight: 700; padding: 1px 9px; border-radius: 999px; border: 1px solid var(--line); }
    .st.ok { color: var(--ok); border-color: var(--ok); } .st.warn { color: var(--warn); border-color: var(--warn); background: var(--warn-soft); }
    .mute { color: var(--mute); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-top: 12px; }
    h4 { margin: 0 0 5px; font-size: 11px; letter-spacing: .06em; color: var(--mute); font-weight: 600; }
    .files { display: grid; gap: 3px; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .files div { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) 3em; gap: 8px; align-items: center; }
    .files span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .files .bar { height: 7px; border-radius: 4px; background: var(--ok); min-width: 3px; }
    .files .bar.gone { background: var(--warn); }
    .files .n { text-align: right; color: var(--mute); }
    .files .tag { color: var(--ok); font-family: system-ui, sans-serif; } .files .tag.gone { color: var(--warn); }
    .tot { margin-top: 6px; display: flex; gap: 8px; align-items: center; font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .tot .p { color: var(--ok); } .tot .m { color: var(--warn); }
    .tot .sp { flex: 1; height: 5px; border-radius: 3px; background: linear-gradient(90deg, var(--ok) 0 ${split}%, var(--warn) ${split}% 100%); }
    .checks { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 4px; }
    .checks div { display: flex; gap: 6px; padding: 3px 7px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); font-size: 12px; min-width: 0; }
    .checks div span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .checks i { font-style: normal; font-weight: 700; color: var(--mute); } .checks .y i { color: var(--ok); } .checks .n i { color: var(--warn); }
    .steps { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; font-size: 12px; margin-top: 4px; }
    .steps span { padding: 2px 8px; border: 1px dashed var(--line); border-radius: 6px; }
    .steps span:first-child { border: 1px solid var(--warn); color: var(--warn); }
    .steps i { font-style: normal; color: var(--mute); }
    .files em { font-style: normal; }
    .notes { margin-top: 10px; padding: 6px 9px; border: 1px solid var(--line); border-radius: 7px; background: var(--bg); font-size: 12px; color: var(--mute); display: flex; gap: 10px; }
    .notes b { flex: none; color: var(--warn); font-weight: 600; }
    .notes div { display: grid; gap: 1px; min-width: 0; overflow-wrap: anywhere; }
  </style>
  <div class="hd">${d.id != null ? `<span class="id">${esc(str(d.id))}</span>` : ""}<h3>${esc(str(d.title)) || '<span class="mute">変更</span>'}</h3></div>
  ${d.from != null || d.to != null || st ? `<div class="flow">${d.from != null ? `<span class="pill">${esc(str(d.from))}</span>` : ""}${d.from != null && d.to != null ? '<span class="mute">→</span>' : ""}${d.to != null ? `<span class="pill">${esc(str(d.to))}</span>` : ""}${st ? `<span class="st ${stTone}">${esc(str(st.text))}</span>` : ""}</div>` : ""}
  ${files.length || checks.length || steps.length ? `<div class="grid">
    ${files.length ? `<div><h4>変わったファイル　${files.length}</h4><div class="files">${top.map((f) => `<div><span title="${esc(f.path)}">${esc(f.path)}${f.new ? ' <em class="tag">新</em>' : f.gone ? ' <em class="tag gone">消</em>' : ""}</span><span class="bar${f.gone ? " gone" : ""}" style="width:${(size(f) / max) * 100}%"></span><span class="n">${size(f) || ""}</span></div>`).join("")}${files.length > top.length ? `<div><span class="mute">ほか ${files.length - top.length}</span><span></span><span></span></div>` : ""}</div>${add + del ? `<div class="tot"><span class="p">+${add}</span><span class="sp"></span><span class="m">−${del}</span></div>` : ""}</div>` : ""}
    ${checks.length || steps.length ? `<div>${checks.length ? `<h4>チェック　${passed} / ${checks.length}</h4><div class="checks">${checks.map((c) => `<div class="${c.ok === true ? "y" : c.ok === false ? "n" : ""}"><i>${mark(c.ok)}</i><span title="${esc(c.name)}">${esc(c.name)}</span></div>`).join("")}</div>` : ""}${steps.length ? `<h4 style="margin-top:${checks.length ? 10 : 0}px">このあと</h4><div class="steps">${steps.map((s) => `<span>${esc(s)}</span>`).join('<i>→</i>')}</div>` : ""}</div>` : ""}
  </div>` : ""}
  ${notes.length ? `<div class="notes"><b>注意</b><div>${notes.map((n) => `<span>${esc(n)}</span>`).join("")}</div></div>` : ""}`;
});

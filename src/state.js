// 状態：記録を頭から一件ずつ当てて作る。データに持つのは記録だけで、状態はいつも作り直せる
//   say   { id, text, peek }               人の発言
//   route { say, session | null, error }   係が決めた届け先（null はどこにも届けない）
//   open  { session, name }                新しいセッション
//   turn  { session, says }                セッションがターンを始めた（届いた発言）
//   step  { session, what, text }          ターンの中の出来事（what は text か tool）
//   end   { session, claude, result, error } ターンが終わった
//   reset {}                               画面をまっさらにする（チャットを空にし、動いていないセッションを一覧から外す）
//   undo  {}                               直前のリセットを戻す（リセットのあと、まだ何も話していないときだけ）

// 記号：A〜Z、そのあと AA, AB…
export function symOf(n) {
  let s = "";
  for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// since：最後にリセットした記録の番号（それより前の発言は、係にも見せない）。undo：リセットを戻すための控え
export const empty = () => ({ seq: 0, since: 0, said: [], sessions: [], chat: [], undo: null });

// 一覧に出ているセッション
export const shown = (state) => state.sessions.filter((x) => !x.hidden);
// 一覧に出ているセッションが使っていない、いちばん若い記号
const freeSym = (state) => {
  const used = new Set(shown(state).map((x) => x.sym));
  let n = 0;
  while (used.has(symOf(n))) n++;
  return symOf(n);
};

const need = (v, what) => {
  if (v == null || v === "") throw new Error(`${what}がない`);
  return v;
};

// 種類ごとの、記録に書く中身の作り方（足りなければ断る）
export const KINDS = {
  say: (b) => ({ text: need(String(b.text ?? "").trim(), "文"), peek: Number.isInteger(b.peek) ? b.peek : null }),
  route: (b) => ({ say: need(b.say, "発言"), session: b.session ?? null, ...(b.error ? { error: String(b.error) } : {}) }),
  open: (b) => ({ session: need(b.session, "セッション"), name: String(b.name ?? "").trim() || "頼まれたこと" }),
  turn: (b) => ({ session: need(b.session, "セッション"), says: b.says ?? [] }),
  step: (b) => ({ session: need(b.session, "セッション"), what: b.what === "tool" ? "tool" : "text", text: String(b.text ?? "") }),
  end: (b) => ({ session: need(b.session, "セッション"), claude: b.claude ?? null, result: b.result ?? null, ...(b.error ? { error: String(b.error) } : {}) }),
  reset: () => ({}),
  undo: () => ({}),
};

export function step(state, r) {
  state.seq = r.seq;
  const ses = (id) => state.sessions.find((x) => x.id === id);
  switch (r.kind) {
    case "say": {
      const s = { id: r.seq, at: r.at, text: r.text, peek: r.peek, session: undefined };
      state.said.push(s);
      state.chat.push({ say: s.id });
      state.undo = null;
      break;
    }
    case "route": {
      const s = state.said.find((p) => p.id === r.say);
      if (!s) break;
      s.session = r.error ? undefined : r.session;
      s.error = r.error ?? null;
      break;
    }
    case "open":
      state.sessions.push({ id: r.session, sym: freeSym(state), name: r.name, at: r.at, status: "idle", claude: null, flow: [], last: "" });
      break;
    case "turn": {
      const x = ses(r.session);
      if (!x) break;
      x.status = "run";
      for (const id of r.says) {
        const s = state.said.find((p) => p.id === id);
        if (s) x.flow.push({ who: "human", text: s.text, say: id });
      }
      break;
    }
    case "step": {
      const x = ses(r.session);
      if (!x) break;
      x.flow.push({ who: r.what === "tool" ? "tool" : "ai", text: r.text });
      x.last = r.text;
      break;
    }
    case "end": {
      const x = ses(r.session);
      if (!x) break;
      if (r.claude) x.claude = r.claude;
      x.status = r.error ? "fail" : "wait";
      x.last = r.error ? r.error : r.result ?? x.last;
      if (r.error) x.flow.push({ who: "error", text: r.error });
      x.endedAt = r.at;
      state.chat.push({ reply: x.id, text: x.last, error: !!r.error });
      break;
    }
    case "reset": {
      // 動いているもの・まだ始まっていないものは残す（仕事を落とさない）
      const hide = shown(state).filter((x) => x.status !== "run" && x.status !== "idle");
      state.undo = { since: state.since, chat: state.chat, hidden: hide.map((x) => x.id) };
      for (const x of hide) x.hidden = true;
      state.chat = [];
      state.since = r.seq;
      break;
    }
    case "undo": {
      const u = state.undo;
      if (!u) break;
      for (const x of state.sessions) if (u.hidden.includes(x.id)) x.hidden = false;
      state.chat = [...u.chat, ...state.chat];
      state.since = u.since;
      state.undo = null;
      break;
    }
  }
  return state;
}

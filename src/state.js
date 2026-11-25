// 状態：記録を頭から一件ずつ当てて作る。データに持つのは記録だけで、状態はいつも作り直せる
//   say   { id, text, peek, to }           人の発言（to は、人が選択肢を押して届け先を決めて言ったもの）
//   route { say, session | null, error }   届け先（null はどこにも届けない）。もう届け先がある発言なら、人が付け替えた
//   cancel { say }                         人が発言を取り消した
//   brief { session, summary, choices }    まとめが書いた、セッションの要約と、人が押すだけで答えられる選択肢
//   open  { session, name }                新しいセッション
//   turn  { session, says }                セッションがターンを始めた（届いた発言）
//   step  { session, what, text }          ターンの中の出来事（what は text か tool）
//   end   { session, claude, result, error, stopped } ターンが終わった（stopped は人が止めた）
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
  say: (b) => ({ text: need(String(b.text ?? "").trim(), "文"), peek: Number.isInteger(b.peek) ? b.peek : null, ...(Number.isInteger(b.to) ? { to: b.to } : {}) }),
  route: (b) => ({ say: need(b.say, "発言"), session: b.session ?? null, ...(b.error ? { error: String(b.error) } : {}) }),
  open: (b) => ({ session: need(b.session, "セッション"), name: String(b.name ?? "").trim() || "頼まれたこと" }),
  turn: (b) => ({ session: need(b.session, "セッション"), says: b.says ?? [] }),
  step: (b) => ({ session: need(b.session, "セッション"), what: b.what === "tool" ? "tool" : "text", text: String(b.text ?? "") }),
  end: (b) => ({ session: need(b.session, "セッション"), claude: b.claude ?? null, result: b.result ?? null, ...(b.error ? { error: String(b.error) } : {}), ...(b.stopped ? { stopped: true } : {}) }),
  cancel: (b) => ({ say: need(b.say, "発言") }),
  brief: (b) => ({
    session: need(b.session, "セッション"),
    summary: String(b.summary ?? "").trim(),
    choices: (Array.isArray(b.choices) ? b.choices : []).map((c) => ({ label: String(c?.label ?? "").trim(), say: String(c?.say ?? c?.label ?? "").trim() })).filter((c) => c.label && c.say).slice(0, 6),
  }),
  reset: () => ({}),
  undo: () => ({}),
};

// まだ取り消せる発言：届けていて（または届け先を決めているところで）、セッションがまだ答え終えていないもの
export const cancelable = (s) => !!s && !s.canceled && !s.done && s.session !== null;

export function step(state, r) {
  state.seq = r.seq;
  const ses = (id) => state.sessions.find((x) => x.id === id);
  // 発言が一つも届いていないセッションは、間違って起きたものとして一覧から外す
  const orphan = (id) => {
    const x = ses(id);
    if (x && !state.said.some((p) => p.session === id && !p.canceled)) x.hidden = true;
  };
  switch (r.kind) {
    case "say": {
      const s = { id: r.seq, at: r.at, text: r.text, peek: r.peek, session: r.to ?? undefined, done: false, canceled: false };
      state.said.push(s);
      state.chat.push({ say: s.id });
      state.undo = null;
      break;
    }
    case "route": {
      const s = state.said.find((p) => p.id === r.say);
      if (!s) break;
      const old = s.session;
      s.session = r.error ? undefined : r.session;
      s.error = r.error ?? null;
      s.done = false;
      if (old != null && old !== s.session) orphan(old);
      break;
    }
    case "brief": {
      const x = ses(r.session);
      if (x) x.brief = { summary: r.summary, choices: x.status === "wait" ? r.choices : [], at: r.at };
      break;
    }
    case "cancel": {
      const s = state.said.find((p) => p.id === r.say);
      if (!s) break;
      s.canceled = true;
      if (s.session != null) orphan(s.session);
      break;
    }
    case "open":
      state.sessions.push({ id: r.session, sym: freeSym(state), name: r.name, at: r.at, status: "idle", claude: null, flow: [], last: "" });
      break;
    case "turn": {
      const x = ses(r.session);
      if (!x) break;
      x.status = "run";
      x.turn = r.says;
      // 選択肢は、そのとき聞かれていたことへの答え。次のターンが始まったら古い
      if (x.brief) x.brief.choices = [];
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
      // 答え終えた発言（ほかへ付け替えたものは除く）。人が止めたときは、待たせていた発言も渡さないので同じく終える
      for (const s of state.said) if (s.session === x.id && ((x.turn ?? []).includes(s.id) || r.stopped)) s.done = true;
      x.turn = [];
      x.endedAt = r.at;
      if (r.stopped) {
        // 人が止めたものは、チャットに返さない（止めたのは人なので知っている）
        x.status = "stop";
        x.flow.push({ who: "note", text: "止めた" });
        break;
      }
      x.status = r.error ? "fail" : "wait";
      x.last = r.error ? r.error : r.result ?? x.last;
      if (r.error) x.flow.push({ who: "error", text: r.error });
      if (!x.hidden) state.chat.push({ reply: x.id, text: x.last, error: !!r.error });
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

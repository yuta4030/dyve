// 状態：記録を頭から一件ずつ当てて作る。データに持つのは記録だけで、状態はいつも作り直せる
//   say   { id, text, peek, to }           人の発言（to は、人が選択肢を押して届け先を決めて言ったもの）
//   route { say, session | null, error, fair, ref, from, quote } 届け先（null はどこにも届けない）。もう届け先がある発言なら、人が付け替えた
//                                          ref・from・quote は発言の「それ」が指すもの（前の発言の id、セッションとそのときの最後の答え）
//   fold  { session, on }                  人がカードを畳んだ（on）・広げた
//   cancel { say }                         人が発言を取り消した
//   rewind { session, say, files }         人がセッションを、その発言の手前まで巻き戻した（say はターンの最初の発言。files ならファイルも戻した）
//   prompt { session, say, uuid }          渡した発言の、Claude Code での ID（ファイルをその時点に戻すときの目印）
//   asks  { session, questions }           セッションが dyve の道具（ask）で人に聞いた。前の質問は置き換わる。空なら質問を下げる
//   tree  { session, groups }              セッションが dyve の道具（state）で書いた、決まったこと・まだのことの木
//   open  { session, name }                新しいセッション
//   turn  { session, says }                セッションに発言を渡した（答えている途中なら差し込み）。says が空なら、差し込まれた発言でまた動きだした
//   bind  { session, claude }              Claude Code の会話の ID が届いた（立て直しても続きを頼めるように、すぐ書く）
//   step  { session, what, text }          ターンの中の出来事（what は text か tool）
//   end   { session, claude, result, error, stopped, mark } ターンが終わった（stopped は人が止めた。mark はそのターンの最後の答えの ID）
//   quota { five, fiveAt, week, weekAt, status } Claude の利用枠（使った割合 0〜1 と、戻る時刻の秒）。変わったときだけ
//   links { rules }                        リンクの決まり（当てはまる言葉を押せるようにする）。まるごと置き換える
//   set   { key, value }                   設定を変えた（SETTINGS にあるものだけ）
//   reset {}                               画面をまっさらにする（チャットを空にし、動いていないセッションを一覧から外す）
//   undo  {}                               直前のリセットを戻す（リセットのあと、まだ何も話していないときだけ）

// 記号：A〜Z、そのあと AA, AB…
export function symOf(n) {
  let s = "";
  for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// 設定：名前 -> 取れる値（最初のものが既定）
//   send：声の送り方（pause は間があいたらまとめて、each は区切りごとにすぐ）。pause：間の秒数。fair：係が清書するか
//   opener：返事の中のファイルを押したときに開くもの（os は OS の既定のアプリ）
export const SETTINGS = { send: ["pause", "each"], pause: [2, 1, 3, 5], fair: [false, true], opener: ["os", "vscode"] };
const defaults = () => Object.fromEntries(Object.entries(SETTINGS).map(([k, v]) => [k, v[0]]));

// リンクの決まりを確かめる：pattern は正規表現（空の文字に当たらないもの）、url は http か https で、$0（当たった言葉全体）や $1… を差し込める
export function linkRules(rules) {
  if (!Array.isArray(rules) || rules.length > 20) throw new Error("リンクの決まりは 20 個まで");
  return rules.map((r) => {
    const pattern = String(r?.pattern ?? "").trim(), url = String(r?.url ?? "").trim();
    let re;
    try { re = new RegExp(pattern); } catch (e) { throw new Error(`正規表現として読めない：${pattern}`); }
    if (!pattern || re.test("")) throw new Error(`空の文字に当たる決まりは使えない：${pattern}`);
    if (!/^https?:\/\/[^\s"<>]+$/.test(url)) throw new Error(`URL は http か https で、空白や " < > を含まない：${url}`);
    return { pattern, url };
  });
}

// since：最後にリセットした記録の番号（それより前の発言は、係にも見せない）。undo：リセットを戻すための控え
export const empty = () => ({ seq: 0, since: 0, said: [], sessions: [], chat: [], undo: null, settings: defaults(), quota: null, links: [] });

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
  route: (b) => ({ say: need(b.say, "発言"), session: b.session ?? null, ...(b.error ? { error: String(b.error) } : {}), ...(b.fair ? { fair: String(b.fair).trim() } : {}),
    ...(Array.isArray(b.ref) && b.ref.length ? { ref: b.ref.filter(Number.isInteger) } : {}),
    ...(Number.isInteger(b.from) && b.quote ? { from: b.from, quote: String(b.quote) } : {}) }),
  quota: (b) => {
    const n = (v) => (Number.isFinite(v) ? v : null);
    return { five: n(b.five), fiveAt: n(b.fiveAt), week: n(b.week), weekAt: n(b.weekAt), status: String(b.status ?? "allowed") };
  },
  links: (b) => ({ rules: linkRules(b.rules) }),
  set: (b) => {
    if (!Object.hasOwn(SETTINGS, b.key) || !SETTINGS[b.key].includes(b.value)) throw new Error(`変えられない設定：${b.key}=${b.value}`);
    return { key: b.key, value: b.value };
  },
  open: (b) => ({ session: need(b.session, "セッション"), name: String(b.name ?? "").trim() || "頼まれたこと" }),
  turn: (b) => ({ session: need(b.session, "セッション"), says: b.says ?? [] }),
  bind: (b) => ({ session: need(b.session, "セッション"), claude: need(b.claude, "会話") }),
  step: (b) => ({ session: need(b.session, "セッション"), what: b.what === "tool" ? "tool" : "text", text: String(b.text ?? "") }),
  end: (b) => ({ session: need(b.session, "セッション"), claude: b.claude ?? null, result: b.result ?? null, ...(b.error ? { error: String(b.error) } : {}), ...(b.stopped ? { stopped: true } : {}), ...(b.mark ? { mark: String(b.mark) } : {}) }),
  rewind: (b) => ({ session: need(b.session, "セッション"), say: need(b.say, "発言"), ...(b.files ? { files: true } : {}) }),
  prompt: (b) => ({ session: need(b.session, "セッション"), say: need(b.say, "発言"), uuid: String(need(b.uuid, "ID")) }),
  cancel: (b) => ({ say: need(b.say, "発言") }),
  fold: (b) => ({ session: need(b.session, "セッション"), on: !!b.on }),
  asks: (b) => ({ session: need(b.session, "セッション"), questions: Array.isArray(b.questions) ? b.questions : [] }),
  tree: (b) => ({ session: need(b.session, "セッション"), groups: Array.isArray(b.groups) ? b.groups : [] }),
  reset: () => ({}),
  undo: () => ({}),
};

// 右上の情報：道具の一行から、見たページと書いたファイルを拾う（新しいものを後ろに、同じものは一つに、12 まで）
const PAGE = /^(WebFetch) (https?:\/\/\S+)/;
const FILE = /^(Edit|Write|MultiEdit|NotebookEdit) (\S.*)$/;
function noteInfo(x, line) {
  const m = line.match(PAGE) ?? line.match(FILE);
  if (!m) return;
  const it = { kind: PAGE.test(line) ? "page" : "file", ref: m[2].trim() };
  x.info = [...(x.info ?? []).filter((i) => i.ref !== it.ref), it].slice(-12);
}

// まだ取り消せる発言：届けていて（または届け先を決めているところで）、セッションがまだ答え終えていないもの
export const cancelable = (s) => !!s && !s.canceled && !s.done && s.session !== null;

// 巻き戻せるか：止まっていて、その発言がターンの最初で、一つ前のターンの終わりがわかっている（最初のターンなら新しく始める）
export const rewindable = (x, say) => {
  if (!x || x.status === "run" || x.status === "idle") return false;
  const i = x.turns?.findIndex((t) => t.say === say) ?? -1;
  return i === 0 || (i > 0 && !!x.turns[i - 1].mark);
};

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
      // 清書した文（元の文は text に残す）。元と同じなら持たない
      if (r.fair && r.fair !== s.text) s.fair = r.fair;
      // 「それ」が指すもの。人が付け替えたとき（ref も from もない route）は、前のものを残す
      if (r.ref) s.ref = r.ref;
      if (r.from != null) Object.assign(s, { from: r.from, quote: r.quote });
      if (old != null && old !== s.session) orphan(old);
      break;
    }
    case "asks": {
      const x = ses(r.session);
      if (x) x.asks = r.questions.length ? { questions: r.questions, at: r.at, seq: r.seq } : null;
      break;
    }
    case "tree": {
      const x = ses(r.session);
      if (x) { x.tree = r.groups; (x.trees ??= []).push({ seq: r.seq, groups: r.groups }); }
      break;
    }
    case "fold": {
      const x = ses(r.session);
      // 畳めるのは止まっているものだけ
      if (x) x.folded = r.on && x.status !== "run" && x.status !== "idle";
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
      // 答えている途中に届いた発言（差し込み）は、いまのターンに足す
      // 止まっているところから発言で始まったターンは、巻き戻せる区切りとして覚える
      if (x.status !== "run" && r.says.length) (x.turns ??= []).push({ say: r.says[0], seq: r.seq, flowAt: x.flow.length, mark: null });
      x.turn = x.status === "run" ? [...(x.turn ?? []), ...r.says] : r.says;
      // 畳んでいたものも、また動きだしたら広げる（もう終わっていないので）
      x.folded = false;
      x.status = "run";
      for (const id of r.says) {
        const s = state.said.find((p) => p.id === id);
        if (s) x.flow.push({ who: "human", text: s.fair ?? s.text, say: id });
      }
      break;
    }
    case "bind": {
      const x = ses(r.session);
      if (x) { x.claude = r.claude; x.resumeAt = null; }
      break;
    }
    case "step": {
      const x = ses(r.session);
      if (!x) break;
      x.flow.push({ who: r.what === "tool" ? "tool" : "ai", text: r.text });
      x.last = r.text;
      if (r.what === "tool") noteInfo(x, r.text);
      break;
    }
    case "end": {
      const x = ses(r.session);
      if (!x) break;
      if (r.claude) x.claude = r.claude;
      if (r.mark && x.turns?.length) x.turns.at(-1).mark = r.mark;
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
      // 返事が空のターン（裏でサブエージェントを待ったときなど）は、最後の本文を返事にする
      const said = x.flow.filter((f) => f.who === "ai").at(-1)?.text;
      x.last = r.error ? r.error : r.result?.trim() ? r.result : said ?? x.last;
      if (r.error) x.flow.push({ who: "error", text: r.error });
      if (!x.hidden) state.chat.push({ reply: x.id, text: x.last, error: !!r.error });
      break;
    }
    case "prompt": {
      const t = ses(r.session)?.turns?.find((u) => u.say === r.say);
      if (t) t.prompt = r.uuid;
      break;
    }
    case "rewind": {
      const x = ses(r.session);
      const i = x?.turns?.findIndex((t) => t.say === r.say) ?? -1;
      if (!x || i < 0 || !rewindable(x, r.say)) break;
      const t = x.turns[i];
      // その発言から後の発言は、答え終えたことにする（取り消しや付け替えの的にしない）
      const gone = new Set(x.flow.slice(t.flowAt).filter((f) => f.say != null).map((f) => f.say));
      for (const s of state.said) if (gone.has(s.id) && s.session === x.id) Object.assign(s, { done: true, rewound: true });
      x.flow = [...x.flow.slice(0, t.flowAt), { who: "note", text: r.files ? "ここまで戻した（ファイルも）" : "ここまで戻した" }];
      // 最初の発言まで戻したら、会話を新しく始める。そうでなければ、一つ前のターンの最後の答えから枝分かれさせる
      x.resumeAt = i ? x.turns[i - 1].mark : null;
      if (!i) x.claude = null;
      x.turns = x.turns.slice(0, i);
      x.last = x.flow.filter((f) => f.who === "ai").at(-1)?.text ?? "";
      if (x.asks && x.asks.seq > t.seq) x.asks = null;
      x.trees = (x.trees ?? []).filter((u) => u.seq < t.seq);
      x.tree = x.trees.at(-1)?.groups ?? null;
      x.info = [];
      break;
    }
    case "quota":
      state.quota = { five: r.five, fiveAt: r.fiveAt, week: r.week, weekAt: r.weekAt, status: r.status, at: r.at };
      break;
    case "links":
      state.links = r.rules;
      break;
    case "set":
      // 今はもうない値（前の版で選んだもの）は、既定に戻す
      state.settings[r.key] = SETTINGS[r.key]?.includes(r.value) ? r.value : SETTINGS[r.key]?.[0];
      break;
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

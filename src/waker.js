// 起こし係：発言が来たら清書係に渡し、間があいたらマネージャを起こし、仕事（行）が置かれたらその行のタスクエージェントを起こす。
// 同じ仕事を同時に二つ走らせない。同時に動く行の数は slots だけで決まり、役割はいくつの行を受け持ってもよい。清書係は一度に一人。マネージャは、前の整理が済むのを待たずに次の発言を読めるよう、
// 読む発言を分けて二本（lanes）まで並べる。同じ発言を二本で読むことはない
import path from "node:path";
import { isPerson, hasAiAnswer, STAFF, turnOf, layoutOf, fixedTile, isRecord, RECORD } from "./board.js";
import { changeLayout, layoutPanel } from "./view.js";
import { NAMES, callOf } from "./crew.js";
import { wordLine } from "./words.js";
import { Focus, GONE } from "./focus.js";

// 起こしっぱなしの会話を起こし直す目安：流し込んだ数と、あいた時間（キャッシュの持ちは 1 時間）。
// 毎回起こし直すと前置きの一部（約 7 千トークン）が毎回キャッシュに書き直しになるので、清書係もマネージャも会話を続ける。
// 会話は伸びるので、目安を超えたら起こし直す。マネージャの引き継ぎは話題の表（行・帰った一行・話題の note）が持つ
const TURNS = { scribe: 50, manager: 20 };
const IDLE = 55 * 60 * 1000;
const CONTEXT = 5;
const NEAR = 3;

export { NAMES };

export class Waker {
  // session：清書係の会話を開く関数（なければ清書係を置かない）
  // integrate：開発の提案を人が受け入れたら呼ぶ（{ board, taskId } -> { branch, into, commit, cleaned }）
  constructor({ store, spawn, session = null, integrate = null, pause = 4000, scribePause = 1000, slots = 3, lanes = 2, names = NAMES, initials = {}, calls = {}, teams = {}, words = null, now = () => Date.now() }) {
    this.store = store;
    this.words = words; // 辞書（全部のボードで共通）
    this.focus = new Focus(); // 人のいま（画面が知らせてくる。これで誰かを起こすことはしない）
    this.wordsSeen = 0;
    this.integrate = integrate;
    this.board = store.file ? path.basename(store.file, ".jsonl") : "board";
    this.spawn = spawn;
    this.session = session;
    this.pause = pause;
    this.scribePause = scribePause;
    this.convs = {}; // role -> { s, turns, lastAt }
    this.scribeBusy = false;
    this.scribeAgain = false;
    this.scribeTimer = null;
    this.afterScribe = false;
    this.quota = null; // 利用枠の残り（起こしっぱなしの会話が拾ったもの）
    this.usage = { runs: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, costUsd: 0 };
    this.slots = slots;
    this.names = names.length ? names : NAMES; // 役割の名前（id）。最初のものが既定
    this.initials = initials; // 役割 -> 画面のアイコンの頭文字
    this.calls = calls; // 役割（ログに残る id）-> 呼び名（画面と声）。なければ既定の呼び名か名前のまま
    this.teams = teams; // 役割 -> チーム（個人の役割は null）
    this.lanes = Math.max(1, lanes);
    this.managers = []; // 走っているマネージャ：{ lane, since, upto, startedAt, handle }
    this.now = now;
    this.waitTimer = null;
    this.again = false;
    this.timer = null;
    // taskId -> { name（役割）, startedAt, handle, inside }。inside は行の中の動き（流れてくる記録から導く。操作ログには持たない）
    this.running = new Map();
    this.tried = new Map(); // taskId -> 起こしたときの rev（同じ形の仕事で二度起こさない）
    // taskId -> { upto }：最後に起こしたときの seq。そのあとに届いた行への言葉が、まだ渡していないもの
    this.started = new Map();
    // その行のセッション自身が自分の行に置いた言葉の id（それでは起こし続けない）。置かれたときに導く
    this.own = new Set();
    // 動いている行のセッションに押し込んで渡した行への言葉の id（それでは起こし直さない）
    this.delivered = new Set();
    // taskId -> { name, role, session, cwd, upto }：その行を前に受け持ったセッション。頼み直しで引き継ぐ。
    // 操作ログには持たない（dyve を立て直したら忘れ、まっさらで起こす）
    this.sessions = new Map();
    this.listeners = new Set();
    this.foldTimer = null; // 人がいる面を畳むのを待っているあいだ、画面の便りが途絶えたときに見直す
    const last = (by) => store.board.log.filter((op) => op.by === by).at(-1)?.seq ?? 0;
    this.cutoff = last("manager");
    this.scribeCutoff = Math.max(last("scribe"), this.cutoff);
  }

  start() {
    this.off = this.store.onOp((op, meta) => this._onOp(op, meta));
    if (this.session && this._says(this.scribeCutoff).length) this._scheduleScribe();
    if (this._unreadSays()) this._schedule();
    this.offFocus = this.focus.onChange(() => this._closeDecided());
    this._recover();
    this._fill();
    this._waits();
    return this;
  }

  stop() {
    this.off?.();
    this.offFocus?.();
    clearTimeout(this.foldTimer);
    clearTimeout(this.timer);
    clearTimeout(this.scribeTimer);
    clearTimeout(this.waitTimer);
    for (const c of Object.values(this.convs)) c.s.kill();
    for (const m of this.managers) m.handle.kill();
    for (const r of this.running.values()) r.handle.kill();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // いちばん前から走っているマネージャ（なければ null）
  get manager() {
    return this.managers[0] ?? null;
  }

  status() {
    const m = this.manager;
    return {
      scribe: this.scribeBusy,
      manager: m ? { since: m.since, startedAt: m.startedAt } : null,
      managers: this.managers.map((x) => ({ lane: x.lane, since: x.since, upto: x.upto, startedAt: x.startedAt })),
      waitingManager: !!this.timer || this.afterScribe,
      // マネージャが読み終えたところ（走っているあいだは、読みはじめる前の位置）。画面は、これより後の発言を「まだ」と見せる
      read: m ? m.since : this.cutoff,
      usage: { ...this.usage },
      quota: this.quota,
      agents: [...this.running].map(([task, r]) => ({ name: r.name, task, startedAt: r.startedAt, inside: r.inside })),
    };
  }

  runningTasks() {
    return [...this.running.keys()];
  }

  _changed() {
    const s = this.status();
    for (const fn of this.listeners) fn(s);
  }

  _count(res) {
    const u = res?.usage;
    if (!u) return;
    this.usage.runs++;
    for (const k of ["input", "output", "cacheWrite", "cacheRead", "costUsd"]) this.usage[k] += u[k] || 0;
  }

  // meta.row：その操作が MCP のどの行のセッションから来たか（?row=。操作ログには持たない）
  _onOp(op, meta = {}) {
    // 受け入れ：人が押したか、人が声で受け入れたのをマネージャが書いたか（from）
    if ((isPerson(op.by) || (op.by === "manager" && op.from)) && op.type === "edit" && op.panel.state === "done") this._accepted(op.panel.id);
    if (op.type === "add" && op.panel.view === "say" && isPerson(op.by)) {
      if (this.session) this._scheduleScribe();
      this._schedule();
    }
    if (op.type === "add" && op.panel.view === "text" && op.panel.about) {
      this._markOwn(op, meta);
      this._deliver(op.panel.id);
      this._relay(op.panel.about);
    }
    // 人かマネージャか、ほかの行のセッションが仕事を取り下げた。止めないのは、その行のセッション自身が自分の行を終えるときだけ。
    // どの行から来たかがわからない口（?row= なし）では、同じ役割からの取り下げでは止めない（by で見分けられない）
    const r = this.running.get(op.panel.id);
    const self = meta.row != null ? meta.row === op.panel.id : op.by === r?.name;
    if (r && !self && (op.type === "drop" || (op.type === "edit" && "state" in op.panel && op.panel.state !== "task"))) {
      r.handle.kill();
    }
    this._fill();
    if (op.panel.id !== layoutPanel(this.store.board)?.id) {
      this._closeDecided();
      this._waits();
    }
  }

  // 決まった行・待ちになった行の面は、行に畳む（閉じた面は行からいつでも開き直せる）。
  // 畳むのは、面を開いたあとに行が動いて決まった・待ちになったものだけ（決まった行を開き直したものは畳まない）。
  // 人がいまその行にいるあいだは待ち、離れたら（人のいま・次の発言・次の操作のどれかで）畳む。待っているものはデータに持たず、毎回導く
  _closeDecided() {
    try {
      const board = this.store.board, lp = layoutPanel(board);
      if (!lp) return;
      const data = layoutOf(lp.data, board.panels);
      const opened = openedAt(board, lp.id), close = [];
      let held = false;
      for (const id of data.out || []) {
        const p = board.get(id);
        if (p?.view !== "task" || !["ok", "wait"].includes(turnOf(board, p)) || fixedTile(board.panels, data, id)) continue;
        const kin = subtree(board, id);
        if (Math.max(...[...kin].map((k) => board.get(k).rev)) <= (opened.get(id) ?? 0)) continue;
        if (hereAt(board, this.focus, id, kin)) held = true;
        else close.push(id);
      }
      clearTimeout(this.foldTimer);
      this.foldTimer = held ? setTimeout(() => this._closeDecided(), GONE + 1000) : null;
      if (close.length) changeLayout(this.store, "board", { out: Object.fromEntries(close.map((id) => [id, false])) }, "決まった行の面を、人が離れたので行に畳む");
    } catch (e) {
      console.error(`面を畳めませんでした：${e.message}`);
    }
  }

  // 条件つきの待ち：日時が来たか、先に済ませる行が済んだら、人の番で帰す
  _waits() {
    clearTimeout(this.waitTimer);
    this.waitTimer = null;
    const board = this.store.board, now = this.now();
    let next = Infinity;
    for (const p of board.list()) {
      if (p.view !== "task" || !p.wait) continue;
      const w = p.wait, after = w.after ? board.get(w.after) : null;
      const until = w.until ? Date.parse(w.until) : null;
      const met = (until != null && until <= now) || (w.after && (!after || after.state === "done" || turnOf(board, after) === "ok"));
      if (met) {
        this.store.apply({ by: "board", type: "edit", panel: { id: p.id, wait: null, state: "done", line: `待ちが明けた：${w.text}` }, reason: "条件つきの待ちの条件が満たされたので、人の番で帰す" });
        return; // 書いた操作でまた呼ばれる
      }
      if (until != null) next = Math.min(next, until);
    }
    if (next < Infinity) this.waitTimer = setTimeout(() => this._waits(), Math.min(Math.max(next - now, 1000), 3600_000));
  }

  // 人が提案を受け入れた。開発の仕事の提案なら、ブランチを取り込む。それ以外は、提案を置いた人に、提案のとおりに進めてもらう
  _accepted(id) {
    const board = this.store.board;
    const prev = board.history(id).slice(0, -1).reverse().find((o) => "state" in o.panel)?.panel.state;
    if (prev !== "proposal") return;
    let t = board.get(id);
    while (t && !(t.view === "task" && t.data?.write === true)) t = t.about ? board.get(t.about) : null;
    if (!t) return this._act(id);
    if (!this.integrate) return;
    const note = (data) => this.store.apply({ by: "board", type: "add", panel: { view: "text", about: id, data }, reason: "受け入れられた開発の提案を取り込んだ結果" });
    Promise.resolve()
      .then(() => this.integrate({ board: this.board, taskId: t.id }))
      .then((r) => note(`取り込みました：${r.branch} → ${r.into}（${r.commit}）。使っている dyve に反映するには、dyve 設定の「更新して再起動」${r.cleaned ? "" : "。作業場は片付けられなかったので残っています"}`))
      .catch((e) => note(`取り込めませんでした：${e.message}`));
  }

  _says(since) {
    return this.store.board.list().filter((p) => p.view === "say" && isPerson(p.by) && p.seq > since);
  }

  // ── 清書係：発言が来て短い間があいたら、起こしっぱなしの会話に流し込む ──
  _scheduleScribe() {
    if (this.scribeBusy) {
      this.scribeAgain = true;
      return;
    }
    clearTimeout(this.scribeTimer);
    this.scribeTimer = setTimeout(() => this._wakeScribe(), this.scribePause);
  }

  async _wakeScribe() {
    this.scribeTimer = null;
    const since = this.scribeCutoff;
    this.scribeCutoff = this.store.board.seq;
    // 人が手を入れた発言は直さない。「これにする」を押して置かれた発言は、画面が書いた文なので直すところがない
    const fresh = this._says(since).filter((p) => p.rev === p.seq && !p.pinned && !p.into && p.point?.how !== "pick").slice(-10);
    if (!fresh.length) return this._scribeDone();
    const { c, first } = this._conv("scribe");
    // 直前の発言はいつも渡す（一つの考えならつなげるので、いまの文と rev が要る）
    const before = this.store.board.list().filter((p) => p.view === "say" && isPerson(p.by) && p.seq <= since && !p.into).slice(first ? -CONTEXT : -NEAR);
    const words = this._wordsFor(first);
    const screen = this._screenFor(c, first);
    this.scribeBusy = true;
    this._changed();
    const res = await c.s.send(scribePrompt(fresh, before, words, { screen, board: this.store.board }));
    this._count(res);
    if (c.s.quota) this.quota = c.s.quota;
    c.turns += fresh.length;
    c.lastAt = Date.now();
    this.scribeBusy = false;
    this._scribeDone();
  }

  // 辞書：会話の頭では全部、あとは変わった分だけ（前置きに入れるとキャッシュが外れる）
  _wordsFor(first) {
    if (!this.words) return [];
    const from = first ? 0 : this.wordsSeen;
    this.wordsSeen = this.words.seq;
    if (first) return this.words.list().map(wordLine);
    return this.words.log.slice(from).map((o) => (o.type === "add" ? wordLine(o) : `- ${o.heard} は直さなくなった`));
  }

  // 画面の言葉：人がいま見ている表の行・面の見出し。辞書と同じく、会話の頭では全部、あとは前に送っていない行だけ
  _screenFor(c, first) {
    if (first || !c.screen) c.screen = new Set();
    const out = screenWords(this.store.board).filter((l) => !c.screen.has(l));
    for (const l of out) c.screen.add(l);
    return out;
  }

  // 役ごとの会話。死んでいたり、伸びすぎたり、あきすぎたりしたら起こし直す
  _conv(role, key = role) {
    const now = Date.now();
    const c = this.convs[key];
    if (c && c.s.alive && c.turns < TURNS[role] && now - c.lastAt <= IDLE) return { c, first: false };
    c?.s.kill();
    this.convs[key] = { s: this.session({ role, name: role }), turns: 0, lastAt: now };
    return { c: this.convs[key], first: true };
  }

  _scribeDone() {
    if (this.scribeAgain) {
      this.scribeAgain = false;
      this._scheduleScribe();
    }
    if (this.afterScribe && !this.scribeBusy && !this.scribeTimer) {
      this.afterScribe = false;
      if (this.managers.length < this.lanes) this._wakeManager();
    }
    this._changed();
  }

  _unreadSays() {
    return this.store.board.list().some((p) => p.view === "say" && isPerson(p.by) && p.seq > this.cutoff);
  }

  // 間があいたら起こす。空いている本がなければ、どれかが終わったあとにまとめて読ませる
  _schedule() {
    if (this.managers.length >= this.lanes) {
      this.again = true;
      return;
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._wakeManager(), this.pause);
    this._changed();
  }

  _wakeManager() {
    this.timer = null;
    // 清書が済んでから整理する
    if (this.scribeBusy || this.scribeTimer) {
      this.afterScribe = true;
      this._changed();
      return;
    }
    if (this.managers.length >= this.lanes || !this._unreadSays()) return;
    const since = this.cutoff;
    this.cutoff = this.store.board.seq;
    const busy = new Set(this.managers.map((m) => m.lane));
    let lane = 0;
    while (busy.has(lane)) lane++;
    // ほかの本がいま読んでいる発言（取り次ぎを二重にしない）
    const others = this.managers.flatMap((m) => this._says(m.since).filter((p) => p.seq <= m.upto && !p.into).map((p) => p.id));
    const prompt = managerPrompt(since, this.store.board, this.runningTasks(), this.focus, others);
    let handle;
    if (this.session) {
      const { c } = this._conv("manager", lane ? `manager#${lane + 1}` : "manager");
      c.turns++;
      handle = { done: c.s.send(prompt).finally(() => { c.lastAt = Date.now(); if (c.s.quota) this.quota = c.s.quota; }), kill: () => c.s.kill() };
    } else {
      handle = this.spawn({ role: "manager", name: "manager", prompt });
    }
    const m = { lane, since, upto: this.cutoff, startedAt: new Date().toISOString(), handle };
    this.managers.push(m);
    this._changed();
    handle.done.then((res) => this._count(res)).finally(() => {
      this.managers = this.managers.filter((x) => x !== m);
      if (this.again || this._unreadSays()) {
        this.again = false;
        this._schedule();
      }
      this._changed();
    });
  }

  // 立て直し：dyve が止まったあいだに、答えはあるのに task のまま残った仕事は、宙づりにせず行に帰す（待っている行への言葉があれば、_fill が起こす）
  _recover() {
    const board = this.store.board;
    for (const t of board.list()) {
      if (t.view !== "task" || t.state !== "task" || this.running.has(t.id)) continue;
      if (!hasAiAnswer(board, t.id) || this._relayPending(t.id)) continue;
      this._settle(t.id, t.line ? null : "dyve を立て直したとき、途中で終わっていました", "dyve を立て直したとき、走り終えていた仕事を行に帰す");
    }
  }

  // 走り終えた（または立て直した）仕事を、task のまま残さない。line を変えるときは text を行に、なければ行はそのまま
  _settle(id, line, reason) {
    const panel = { id, state: "done", ...(line ? { line: line.slice(0, 200) } : {}) };
    return this.store.apply({ by: "board", type: "edit", panel, reason });
  }

  // 行への言葉が置かれたとき、その行のセッション自身が置いたものかを導く：その行のセッションの口（?row=）から来たとき。
  // どの行から来たかがわからない口では、その行がその役割で動いていて、同じ役割で動いているほかの行がないとき。
  // ほかにもあれば見分けられないので、落とさない方に倒す（行への言葉として数える）
  _markOwn(op, meta = {}) {
    if (typeof op.panel.data?.to !== "string") return;
    if (meta.row != null) {
      if (meta.row === op.panel.about) this.own.add(op.panel.id);
      return;
    }
    const r = this.running.get(op.panel.about);
    if (!r || r.name !== op.by) return;
    if ([...this.running].some(([id, x]) => id !== op.panel.about && x.name === op.by)) return;
    this.own.add(op.panel.id);
  }

  // 動いている行への言葉は、その行のセッションに押し込む。渡せたら覚えて、終わったあとにそれで起こし直さない。
  // 渡せなければ（標準入力がもう閉じた、書けない）まだ渡していないものとして残し、終わったあとに起こし直す
  _deliver(id) {
    const board = this.store.board, p = board.get(id);
    const r = p?.about ? this.running.get(p.about) : null;
    if (!r?.handle.say || !isRelay(p) || this.own.has(id)) return;
    const t = board.get(p.about);
    if (t && r.handle.say(wordPrompt(t, p))) this.delivered.add(id);
  }

  // 行への言葉（own と、動いているセッションに渡したものを除く）。since より後のもの
  _relays(id, since) {
    return relaysOf(this.store.board, id, since).filter((p) => !this.own.has(p.id) && !this.delivered.has(p.id));
  }

  // 担当の一覧：行の中で呼ばれたものが一つでもあれば、誰が・何を頼まれ・何と返したか・どれだけかかったかを、行に一枚だけ置く。
  // 同じ行の次の回は、その一枚に書き足す（data.record で見分けるので、dyve を立て直しても見つかる）。書き足せなければ（ピン留めなど）新しく置く
  _record(id, inside) {
    if (!Array.isArray(inside) || !inside.length) return;
    const board = this.store.board;
    if (!board.get(id)) return;
    const rows = inside.map(recordRow);
    const data = (old) => ({ columns: RECORD_COLUMNS, rows: [...old, ...rows], record: RECORD });
    const cur = board.list().filter((p) => p.about === id && isRecord(p)).at(-1);
    if (cur && this.store.apply({ by: "board", type: "edit", panel: { id: cur.id, data: data(Array.isArray(cur.data.rows) ? cur.data.rows : []) }, reason: "行の中で呼ばれたものの記録に、この回の分を書き足す" }).ok) return;
    this.store.apply({ by: "board", type: "add", panel: { view: "table", about: id, data: data([]) }, reason: "行の中で呼ばれたものが、誰で、何を頼まれ、何と返したかを行に残す" });
  }

  // 起こしたあとに届いた行への言葉（まだ渡していないもの）。その行のセッション自身が置いたものは数えない（自分の言葉で起こし続けない）
  _relayPending(id) {
    const board = this.store.board;
    const since = this.started.get(id)?.upto ?? (board.history(id).filter((o) => "state" in o.panel).at(-1)?.seq ?? 0);
    return this._relays(id, since).length > 0;
  }

  // 起こす行：AI の番で、走っていない、まだ起こしていない形か、届いた言葉があるもの。
  // 枠が足りないときは、人・マネージャ・ボードが置いた行を、タスクエージェントが置いた行より先に起こす（それぞれの中は今までの順）
  _fill() {
    const board = this.store.board;
    let changed = false;
    const ready = board.list().filter((t) => t.state === "task" && !this.running.has(t.id)
      // 走り終えたあとに言葉が届いていれば、答えがあっても起こす（答えのある行を、言葉で拾い直せるように）
      && (this._relayPending(t.id) || (this.tried.get(t.id) !== t.rev && !hasAiAnswer(board, t.id))));
    const staff = (t) => isPerson(t.by) || STAFF.has(t.by);
    for (const t of [...ready.filter(staff), ...ready.filter((t) => !staff(t))]) {
      if (this.running.size >= this.slots) break;
      // data.write が付いた仕事：true は開発（仕事ごとの worktree の中で）、"panels" はパネルの仕事（利用者のパネル置き場で）
      // data.accepted が付いた仕事は、人が受け入れた提案（部屋で、提案の範囲なら外に届くこともする）
      const role = t.data?.accepted ? "act" : t.data?.write === true ? "dev" : t.data?.write === "panels" ? "panels" : "task";
      const prev = this.sessions.get(t.id);
      const name = this.pick(t, role);
      this.tried.set(t.id, t.rev);
      // 引き継ぐのは、前の回と同じ役割・同じ仕事の種類で、前の回のセッション id がわかっているとき（起きる場所が同じかはスポーナーが確かめる）
      const again = prev && prev.session && prev.name === name && prev.role === role ? prev : null;
      // 渡す行への言葉：前の回を起こしたあとに届いて、まだ渡していないもの（はじめての回は、行がいちど帰したあとのもの）
      const before = this.started.get(t.id)?.upto;
      const words = before != null ? this._relays(t.id, before) : null;
      const job = { role, name, taskId: t.id, board: this.board, prompt: taskPrompt(board, t, name, this.call(name), this.focus, words) };
      if (again) job.resume = { session: again.session, cwd: again.cwd, prompt: reaskPrompt(board, t, name, this.call(name), this.focus, again.upto, words ?? []) };
      const upto = board.seq;
      this.started.set(t.id, { upto });
      const entry = { name, startedAt: new Date().toISOString(), handle: null, inside: [] };
      // 行の中の動き：スポーナーが流れてくる記録から導いて知らせてくる（まとめて、一秒に二度まで）
      job.onInside = (inside) => {
        entry.inside = inside;
        if (this.running.get(t.id) === entry) this._changed();
      };
      const handle = (entry.handle = this.spawn(job));
      this.running.set(t.id, entry);
      changed = true;
      handle.done.then((res) => {
        this._count(res);
        this.running.delete(t.id);
        this._record(t.id, res?.inside ?? entry.inside);
        // セッション id が取れた回だけ覚える（取れなければ、次はまっさらで起こす）
        if (res?.session) this.sessions.set(t.id, { name, role, session: res.session, cwd: res.cwd ?? null, upto });
        else this.sessions.delete(t.id);
        const cur = this.store.board.get(t.id);
        // 走り終えて行がまだ task なら、宙づりにしない。走っているあいだに言葉が届いていれば、帰さずに _fill で続けて起こす
        if (cur && cur.state === "task" && !this._relayPending(t.id)) {
          // 途中経過を置いたあとで落ちた仕事も、待っているように見えたままにしない。止まったことは行に帰す（人の番：止まったのを知る）
          const answered = hasAiAnswer(this.store.board, t.id);
          const stopped = res?.error || !answered;
          const text = `${answered ? "途中で止まりました" : "結果を置かずに終わりました"}${res?.error ? `（${res.error}）` : ""}`;
          const back = this._settle(t.id, stopped ? text : null, stopped ? "仕事が落ちたままにならないように、止まったことを行に帰す" : "走り終えた仕事を task のまま残さないように、行を帰す");
          if (!back.ok && stopped) this.store.apply({ by: "board", type: "add", panel: { view: "text", about: t.id, data: text }, reason: "仕事が落ちたままにならないように" });
        }
        // 走っているあいだに置かれて渡せなかった言葉と、帰したあとに置かれた言葉
        this._relay(t.id, upto);
        this._fill();
        this._changed();
      });
    }
    if (changed) this._changed();
  }

  // 受け入れた提案を仕事にする（data.accepted）。役割は提案を置いた役割（役割でなければ既定の役割）。
  // 頼むのは受け入れたときの提案の文そのもの。元の仕事（after）を付けて、そこに置かれたものを読めるようにする
  _act(id) {
    const board = this.store.board, p = board.get(id);
    if (!p) return;
    let task = p.about ? board.get(p.about) : null;
    while (task && task.view !== "task") task = task.about ? board.get(task.about) : null;
    const name = this.resolve(p.by);
    const from = Array.isArray(task?.data?.from) ? task.data.from : null;
    this.store.apply({
      by: "board",
      type: "add",
      panel: { view: "task", state: "task", about: id, data: { title: titleOf(p.data), text: plainOf(p.data), accepted: id, ...(name ? { to: name } : {}), ...(task ? { after: task.id } : {}), ...(from ? { from } : {}) } },
      reason: `人が提案 ${id} を受け入れたので、${this.call(name ?? this.names[0])}で提案のとおり進めてもらう`,
    });
  }

  // 終わった行に置かれた行への言葉（data.to 付きの text）：行を AI の番に戻して起こし直す。答えは同じ行に帰る。
  // 行の役割は変えない（to は行を起こす合図で、宛先ではない）。
  // 動いている行はセッションに押し込むので戻さない（渡せなかったものは、終わったときにもう一度見る）。提案は人が決めるので戻さない
  // since：これより後の言葉を見る（走り終えたときは起こしたときの seq。ふだんは行が最後に番を変えたとき）
  _relay(id, since = null) {
    const board = this.store.board, t = board.get(id);
    if (!t || t.view !== "task" || t.state === "task" || t.state === "proposal" || this.running.has(id)) return;
    since ??= board.history(id).filter((o) => "state" in o.panel).at(-1)?.seq ?? 0;
    const m = this._relays(id, since).at(-1);
    if (!m) return;
    this.store.apply({
      by: "board",
      type: "edit",
      panel: { id, state: "task" },
      reason: `行への言葉（${m.id}）が終わった行に置かれたので、行を AI の番に戻して渡す`,
    });
  }

  call(name) {
    return this.calls[name] ?? callOf(null, name);
  }

  // data.to はふつう役割の名前（id）。呼び名や「@チーム」を省いた名前で書かれても、一つに決まればその役割にする
  resolve(to) {
    if (!to || typeof to !== "string") return null;
    if (this.names.includes(to)) return to;
    const hit = this.names.filter((n) => this.call(n) === to);
    if (hit.length === 1) return hit[0];
    const bare = this.names.filter((n) => n.split("@")[0] === to);
    return bare.length === 1 ? bare[0] : null;
  }

  // 行の役割：data.to が役割に決まればそれ、data.team ならそのチームの最初の役割、
  // 前にこの行を同じ仕事の種類で受け持った役割、どれでもなければ既定の役割。空いているかは見ない（並べる数は slots だけで決まる）
  pick(t, role) {
    const who = this.resolve(t.data?.to);
    if (who) return who;
    const team = t.data?.team;
    const mate = team ? this.names.find((n) => this.teams[n] === team) : null;
    if (mate) return mate;
    const prev = this.sessions.get(t.id);
    if (prev && prev.role === role && this.names.includes(prev.name)) return prev.name;
    return this.names[0];
  }
}

const textOf = (d) => (typeof d === "string" ? d : d?.text ?? JSON.stringify(d));
// 提案の中身を、頼む文に：箇条書きは一行ずつ、ほかは文のまま（JSON の文字列にしない）
function plainOf(d) {
  if (typeof d === "string") return d;
  if (Array.isArray(d)) return d.map((x) => `- ${typeof x === "string" ? x : textOf(x)}`).join("\n");
  return typeof d?.text === "string" ? d.text : JSON.stringify(d);
}
// 行に出す短い名前：提案の一行目の頭
const titleOf = (d) => clip(plainOf(d).split("\n").map((x) => x.replace(/^\s*[-・*]\s*/, "").trim()).find(Boolean) ?? "", 20);
const clip = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);

// パネルの中身の頭の一行
function headOf(p) {
  const d = p?.data;
  const t = typeof d === "string" ? d : Array.isArray(d) ? d.map((x) => textOf(x)).find((x) => typeof x === "string") : d?.title ?? d?.text;
  return typeof t === "string" ? t.split("\n").map((x) => x.trim()).find(Boolean) ?? "" : "";
}
// パネルを一行で呼ぶ（行なら記号、id と中身の頭）
function label(board, id) {
  const p = board.get(id);
  const line = headOf(p);
  const name = p?.key ? `${p.key}（${id}）` : id;
  return line ? `${name}「${clip(line, 30)}」` : p ? `${name}（${p.view}）` : `${id}（もうない）`;
}
// 人がその発言をしたときに指していたパネル（合流した発言のぶんも）。押して選んだものは決定なので言い切り、
// マウスの下（hover）と見ていたまん中（view）は手がかりなので、人の意図ではなく画面のありさまとして言う
const PICKED = "を押して選んだ";
const HOW = { pick: (l) => `${l}${PICKED}`, hover: (l) => `マウスは ${l}の上`, view: (l) => `画面のまん中は ${l}` };
function pointNotes(board, says) {
  const out = [];
  for (const p of says) {
    const note = p?.point && Object.hasOwn(HOW, p.point.how) ? HOW[p.point.how](label(board, p.point.id)) : "";
    if (note && !out.includes(note)) out.push(note);
  }
  return out;
}

// 行への言葉：仕事に about して置かれた、data.to 付きの text（清書係・ボード・人の置いたものは数えない）。since より後のもの
const isRelay = (p) => p?.view === "text" && !!p.about && typeof p.data?.to === "string" && !!p.data.to && !isPerson(p.by) && p.by !== "scribe" && p.by !== "board";
function relaysOf(board, id, since = 0) {
  return board.list().filter((p) => p.about === id && p.seq > since && isRelay(p));
}

// 動いている行のセッションに押し込む一通：この行への言葉であること、誰が置いたか、その文、答えはこの行に帰すこと
export function wordPrompt(task, p) {
  return [
    `この行（仕事 ${task.id}${task.key ? `、表の行 ${task.key}` : ""}）への言葉が届きました。${p.by} が置いたもの（${p.id}）です：`,
    textOf(p.data),
    `いまの仕事と合わせて応え、答えはこの行に帰します（panel_edit で仕事 ${task.id} の line。新しいパネルは足しません）。`,
  ].join("\n");
}

// 担当の一覧の列と一行：誰（行の中の行は ↳ を付ける）・頼まれたこと・返したこと（200 字ほど）・かかった時間
const RECORD_COLUMNS = ["誰", "頼まれたこと", "返したこと", "かかった"];
const took = (ms) => (!ms ? "—" : ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}秒` : `${Math.round(ms / 60_000)}分`);
function recordRow(t) {
  const said = t.report ? clip(t.report.replace(/\s+/g, " ").trim(), 200) : t.state === "done" ? "（報告なし）" : "（途中で終わった）";
  return [`${t.depth > 1 ? "↳ " : ""}${t.type}`, clip(String(t.what ?? ""), 80), said, took(t.ms)];
}

// 画面の言葉：人がいま目の前にしている表（話題・行の記号・行の名前・帰った一行）と、開いている面の見出し。
// 人は画面を見ながら喋るので、聞き違いはここにある言葉に寄せられる（「プリクラ」→ 行の「PR #16 マージ」）
export function screenWords(board) {
  const all = board.list();
  const lp = all.find((p) => p.view === "layout");
  const open = new Set(lp ? layoutOf(lp.data, board.panels).out || [] : []);
  const rowName = (r) => clip(String(r.data?.title ?? headOf(r) ?? ""), 40);
  const out = [];
  const rows = (parent, depth) => {
    for (const r of all.filter((q) => q.about === parent.id && q.view === "task")) {
      out.push(`${"  ".repeat(depth)}- ${r.key ?? r.id} ${rowName(r)}${r.line ? ` → ${clip(r.line, 60)}` : ""}${r.decided ? `（決まった：${clip(r.decided, 30)}）` : ""}`);
      if (!open.has(r.id)) continue;
      // 開いている面：中の行と、置かれたものの見出し（表なら列と一列目）
      for (const q of all.filter((x) => x.about === r.id && x.view !== "task")) {
        const d = q.data;
        const head = q.view === "table" && d && Array.isArray(d.columns)
          ? [d.columns.join("・"), ...(Array.isArray(d.rows) ? d.rows.map((row) => (Array.isArray(row) ? row[0] : null)).filter((x) => typeof x === "string") : [])].map((x) => clip(String(x), 30)).join("／")
          : clip(headOf(q), 60);
        if (head) out.push(`${"  ".repeat(depth + 1)}- ${r.key ?? r.id} の面：${head}`);
      }
      rows(r, depth + 1);
    }
  };
  for (const t of all.filter((p) => p.view === "topic" && p.state !== "done")) {
    out.push(`- 話題「${clip(String(t.data?.title ?? headOf(t)), 40)}」`);
    rows(t, 1);
  }
  return out;
}

// 人が手で直した発言か（清書係は触らない）
const byHand = (board, p) => board.history(p.id).some((o) => o.type === "edit" && isPerson(o.by) && "data" in o.panel);

// 清書係への一通。新しい発言を直させ、直前の発言は文脈として渡す（新しい発言で言葉の正体がわかれば、文脈の発言も直せる）。
// screen：画面の言葉（前に送っていない行だけ）。board があれば、発言のとき指していたものの名前を添える
export function scribePrompt(fresh, before = [], words = [], { screen = [], board = null } = {}) {
  const pointed = (p) => (board ? pointNotes(board, [p]) : []).map((n) => `、${n}`).join("");
  const ctx = (p) => (p.pinned ? `- ${p.id}（ピン留め。触らない）：` : board && byHand(board, p) ? `- ${p.id}（人が直した。触らない）：` : `- ${p.id}（rev ${p.rev}${pointed(p)}）：`) + textOf(p.data);
  return [
    words.length ? "辞書（よく聞き違える言葉。左のように聞こえたら右の書き方に）：" : "",
    ...words,
    screen.length ? "画面の言葉（人がいま見ている表の行と面。音が近ければここに寄せる。前に送ったものに足す分）：" : "",
    ...screen,
    before.length ? "文脈（前の発言。一つの考えならここへつなげる。新しい発言で言葉の正体がわかれば、ここも直す）：" : "",
    ...before.map(ctx),
    "新しい発言（直すものだけ panel_edit。rev を付ける）：",
    ...fresh.map((p) => `- ${p.id}（rev ${p.rev}${pointed(p)}）：${textOf(p.data)}`),
  ].filter(Boolean).join("\n");
}

// マネージャへの指示。読むものをはじめから渡して、board_read の往復を減らす
const TURN_WORD = { ai: "AI の番", you: "人の番", back: "帰った（読むだけ）", ok: "決まった", wait: "待ち" };
// 行を一行で：記号・番・頼んだこと → 帰った一行（決まったこと・待ち）
export function rowLine(board, t, busy = new Set()) {
  const turn = turnOf(board, t);
  const tail = [t.line ? `→ ${t.line}` : "", t.decided ? `決まった：${t.decided}` : "", t.wait ? `待ち：${t.wait.text}` : ""].filter(Boolean).join("　");
  return `- ${t.key ? `${t.key}（${t.id}）` : t.id}［${TURN_WORD[turn] ?? t.state ?? "—"}${busy.has(t.id) ? "・動いている" : ""}${t.state === "proposal" ? "・提案" : ""}］${t.data?.to ? `${t.data.to}：` : ""}${clip(textOf(t.data), 80)}${tail ? `　${tail}` : ""}`;
}
// 届いたばかりのもの：AI かボードが行に一行を帰した・提案を置いた、新しい順。「それ」はまずここを指す
export function arrivals(board, n = 4) {
  const out = [];
  for (let i = board.log.length - 1; i >= 0 && out.length < n; i--) {
    const op = board.log[i];
    if (isPerson(op.by) || op.by === "scribe") continue;
    const id = op.type === "edit" && op.panel.line != null ? op.panel.id : op.type === "add" && op.panel.state === "proposal" ? op.panel.about ?? op.panel.id : null;
    const p = id && board.get(id);
    if (p && !out.some((x) => x.p.id === p.id)) out.push({ p, seq: op.seq, at: op.at });
  }
  return out;
}

// 面が開いた seq：並びの書き換えを順にたどり、いま開いている面ごとに、開いたときの seq
function openedAt(board, layoutId) {
  const at = new Map();
  for (const op of board.history(layoutId)) {
    if (!("data" in op.panel)) continue;
    const out = new Set(Array.isArray(op.panel.data?.out) ? op.panel.data.out : []);
    for (const id of [...at.keys()]) if (!out.has(id)) at.delete(id);
    for (const id of out) if (!at.has(id)) at.set(id, op.seq);
  }
  return at;
}

// 行と、その中のもの（about をたどって行に着くもの。面に出るもの）
function subtree(board, id) {
  const kin = new Set([id]);
  for (let more = true; more; ) {
    more = false;
    for (const p of board.list()) if (p.about && kin.has(p.about) && !kin.has(p.id)) { kin.add(p.id); more = true; }
  }
  return kin;
}

// 人がいまその行にいるか：画面がつながっていて、人がいて、いちばん新しい人の発言がその行か面の中を指している
// （point か、その発言から出た行の中の仕事）。画面に面も表も見えていなければ、離れた
function hereAt(board, focus, id, kin) {
  const c = focus?.current();
  if (!c || c.data.presence !== "here") return false;
  const say = board.list().filter((p) => p.view === "say" && isPerson(p.by) && !p.into).at(-1);
  if (!say) return false;
  const about = (say.point?.id && kin.has(say.point.id)) || [...kin].some((k) => { const p = board.get(k); return Array.isArray(p.data?.from) && p.data.from.includes(say.id); });
  if (!about) return false;
  const shown = [...c.data.viewing, ...c.data.inside];
  if (!shown.length) return true;
  const up = new Set(kin);
  for (let p = board.get(id); p?.about && !up.has(p.about); p = board.get(p.about)) up.add(p.about);
  return shown.some((k) => up.has(k));
}

export function managerPrompt(since, board = null, running = [], focus = null, others = []) {
  const head = `ボードに新しい動きがあります（since: ${since}、seq ${since} より後）。読むものは下にそろえてあります。足りないときだけ board_read を使ってください。`;
  const tail = "終わったら何も言わずに終えてください。人への返事はボードに置くものだけです。";
  if (!board) return [head, tail].join("\n");
  const all = board.list();
  const summary = all.filter((p) => p.by === "manager" && p.view === "summary").at(-1);
  const busy = new Set(running);
  // 話題の表にない仕事（話題の外のもの）だけを、ここに並べる。表の行は「表」に出す
  const inTable = (p) => p.view === "task" && p.key;
  const tasks = all.filter((p) => !inTable(p) && (p.state === "task" || (p.view === "task" && p.rev > since)));
  // 合流した発言は先頭だけ読む。先頭が古くても、新しい発言が合流していれば読み直す
  const says = all.filter((p) => p.view === "say" && isPerson(p.by) && !p.into && (p.seq > since || all.some((q) => q.into === p.id && q.seq > since)));
  const placed = all.filter((p) => p.rev > since && p.view !== "layout" && !isPerson(p.by) && !STAFF.has(p.by) && p.by !== "scribe");
  const lines = [head, ""];
  // 前の版のマネージャが要点に置いた、まだ決まっていない問い。行になっていなければ行にする（落とさない）
  const open = Array.isArray(summary?.data?.open) ? summary.data.open.map((x) => (typeof x === "string" ? x : x?.text)).filter((x) => typeof x === "string" && x.trim()) : [];
  if (open.length) lines.push(`## いまの要点に残っている問い（${summary.id}。要点はもう書き換えない。まだ行になっていないものは、合う話題の行にする）`, ...open.map((x) => `- ${clip(x, 100)}`), "");
  const topics = all.filter((p) => p.view === "topic");
  lines.push("", "## 話題");
  if (!topics.length) lines.push("（まだない）");
  for (const t of topics) {
    const rows = all.filter((p) => p.about === t.id && p.view === "task");
    lines.push(`- ${t.id}（rev ${t.rev}）${t.state === "done" ? "［済み］" : ""}${t.pinned ? "［ピン留め］" : ""}：${clip(typeof t.data === "string" ? t.data : t.data?.title ?? textOf(t.data), 60)}（行 ${rows.length}）${t.data?.note ? `　いまどこまで：${clip(String(t.data.note), 80)}` : "　いまどこまで：（まだない）"}`);
    // 済んだ話題の表は、決まっていない行だけ
    const shown = t.state === "done" ? rows.filter((r) => !["ok", null].includes(turnOf(board, r))) : rows;
    const tree = (r, depth) => [`${"  ".repeat(depth + 1)}${rowLine(board, r, busy)}`, ...all.filter((q) => q.about === r.id && q.view === "task").flatMap((q) => tree(q, depth + 1))];
    for (const r of shown) lines.push(...tree(r, 0));
  }
  const back = arrivals(board).filter((a) => a.p.view === "task" || a.p.state === "proposal");
  if (back.length) {
    lines.push("", "## 届いたばかり（新しい順。「それ」「それでいい」は、指したものがなければまずいちばん上を指す）");
    for (const a of back) lines.push(`- ${a.p.key ? `${a.p.key}（${a.p.id}）` : a.p.id}${a.seq > since ? "［前に起きてから］" : ""}：${clip(a.p.line ?? textOf(a.p.data), 80)}`);
  }
  const lp = all.find((p) => p.view === "layout");
  const faces = lp ? (layoutOf(lp.data, board.panels).out || []).filter((id) => board.get(id)?.view === "task") : [];
  if (faces.length) lines.push("", "## 開いている面", ...faces.map((id) => `- ${board.get(id).key || id}（${id}）`));
  lines.push("", "## 仕事");
  if (!tasks.length) lines.push("（なし）");
  for (const t of tasks) lines.push(`- ${t.id}［${t.state}${busy.has(t.id) ? "・動いている" : ""}${board.get(t.about)?.view === "topic" ? `・話題 ${t.about}` : ""}］${t.data?.to ? `${t.data.to}：` : ""}${clip(textOf(t.data), 120)}`);
  lines.push("", "## 新しい発言（清書済み）");
  const skip = new Set(others);
  if (!says.length) lines.push("（なし）");
  if (others.length) lines.push(`（${others.join(" ")} は、もう一本のマネージャがいま読んでいます。取り次ぎや受け入れを二重にしないでください。要点の書き換えで conflict が返ったら、board_read で読み直してから足してください）`);
  for (const p of says.filter((x) => !skip.has(x.id))) {
    const notes = [p.to ? `役割 ${p.to} を指している` : "", ...pointNotes(board, [p, ...all.filter((q) => q.into === p.id)])].filter(Boolean);
    lines.push(`- ${p.id}${notes.length ? `（${notes.join("、")}）` : ""}：${textOf(p.data)}`);
  }
  if (placed.length) {
    lines.push("", "## 新しく置かれたもの");
    for (const p of placed) lines.push(`- ${p.id}（${p.by}${p.about ? `、${p.about} について` : ""}${p.state ? `、${p.state}` : ""}）：${clip(textOf(p.data), 300)}`);
  }
  if (focus) lines.push("", "## 人のいま", ...focus.lines(board));
  lines.push("", tail);
  return lines.join("\n");
}

// name：行の役割（id）、call：その呼び名
// words：渡す行への言葉（なければ、行がいちど帰したあとに置かれたもの）
export function taskPrompt(board, task, name, call = name, focus = null, words = null) {
  // 元の発言：data.from があればそれ、なければ about の先が発言のとき
  const from = Array.isArray(task.data?.from) ? task.data.from.map((id) => board.get(id)).filter(Boolean) : [];
  const above = task.about ? board.get(task.about) : null;
  const srcs = from.length ? from : above?.view === "say" ? [above] : [];
  const topic = above?.view === "topic" ? above : null;
  const text = typeof task.data === "string" ? task.data : task.data?.text ?? JSON.stringify(task.data);
  const prev = task.data?.after ? board.get(task.data.after) : null;
  const parent = above?.view === "task" ? above : null;
  const agent = (p) => !isPerson(p.by) && !STAFF.has(p.by);
  // 前の仕事にタスクエージェントが置いたもの（受け入れた提案の仕事が読む）
  const prevOut = prev ? board.list().filter((p) => p.about === prev.id && agent(p)).slice(-5) : [];
  // この行についてタスクエージェントが前に置いた結果（面の中身）。同じ仕事の結果は書き換えて、古いものと新しいものを並べない
  const mine = board.list().filter((p) => p.about === task.id && p.view !== "task" && agent(p) && p.state !== "proposal").slice(-5);
  // 行がいちど帰ったあとに置かれた言葉（ボードが行を戻して起こし直したとき）
  const returned = board.history(task.id).filter((o) => "state" in o.panel && o.panel.state !== "task").at(-1)?.seq ?? 0;
  const relays = words ?? relaysOf(board, task.id, returned);
  return [
    `あなたはタスクエージェントで、ボードの仕事 ${task.id} を受け持ちました。この行の役割は「${call}」${call === name ? "" : `（ボードの上の名前は ${name}）`}です。`,
    task.data?.accepted ? `これは人が受け入れた提案（${task.data.accepted}）です。提案に書いたことを、そのとおりに進めてください。提案の範囲なら、外に届くこと（push・送信・起票など）もしてかまいません。提案にないことはしません。危ない操作は止められることがあります。止められたら別の手で済ませるか、そのことを結果に書きます。` : "",
    task.data?.accepted ? `受け入れた提案：${text}` : `仕事：${text}`,
    prev ? `前の仕事（${prev.id}）：${clip(textOf(prev.data), 300)}` : "",
    ...prevOut.map((p) => `- そこに置かれたもの（${p.id}、${p.by}）：${clip(textOf(p.data), 300)}`),
    topic ? `話題（${topic.id}）：${typeof topic.data === "string" ? topic.data : topic.data?.title ?? textOf(topic.data)}` : "",
    ...srcs.map((p) => `元の発言（${p.id}）：${textOf(p.data)}`),
    ...pointNotes(board, srcs.flatMap((p) => [p, ...board.list().filter((q) => q.into === p.id)])).map((n) => (n.endsWith(PICKED) ? `人はそのとき ${n}` : `発言のとき、${n}（手がかり。話が合わなければ無視する）`)),
    ...(relays.length ? [`${returned ? `この行はいちど帰したあと、言葉が届いたので戻ってきました。` : ""}この行への言葉です。応えて、答えをこの行に帰します：`, ...relays.map((p) => `- ${p.id}（${p.by}）：${clip(textOf(p.data), 500)}`)] : []),
    task.key ? `この仕事は表の行 ${task.key} です。${parent?.view === "task" ? `行 ${parent.key || parent.id} の面の中から呼ばれました。` : ""}` : "",
    `結果は行に帰します：終わったら panel_edit で仕事 ${task.id} に line（答えの一行。60 字くらいまで）と state done を一度に渡してください。一行に収まるなら、それだけです。新しいパネルは足しません。`,
    `一行に収まらないとき（比べる案がある、人が先に決めることがある、出典を並べる）だけ、詳しいものを about: "${task.id}" で置き、line はその結論の一行にします。行から開ける面になります。人に決めてもらう問いも、そこに短く置きます。`,
    `時間がかかるときは、途中で line を「いまどこまで来たか」の一行に書き換えます（state は task のまま）。`,
    `行の中では、仕事を分けて、合う相手（サブエージェント）を並べて呼んでかまいません。誰も見なくてよい下調べは行の中で済ませ、ボードに置きません。人が決めること・提案は、今までどおりこの行に about して置きます。`,
    `ほかの行の答えを待つことになったら、ここで止まらず、line に待っていることを書いて state done で終えます。答えが届くと、この行への言葉で起こし直されます（task のまま終えると、誰も起こしません）。`,
    `面に置くものは数行まで（表なら列は 3〜4、セルは短く）。依頼に返す形が書いてあっても、読む人が一瞥で読める量に絞ります。`,
    ...(mine.length ? [`この行には前に置かれた結果があります。同じことの新しい結果なら、足さずに panel_edit でそれを書き換えます（view も変えてよい）。並べて残しません：`, ...mine.map((p) => `- ${p.id}（${p.view}、${p.by}、rev ${p.rev}）：${clip(textOf(p.data).split("\n")[0], 60)}`)] : []),
    ...(focus ? ["人のいま（受け持ったときのもの）：", ...focus.lines(board)] : []),
  ].filter(Boolean).join("\n");
}

// 頼み直し（前の回のセッションを引き継いだ相手）への短い文。前の回の調べは会話に残っているので、何が足されたかと、同じ行に帰すことだけ
// upto：前の回を起こしたときの seq。これより後に人が言ったこと・置いたものを「足されたこと」として渡す
// words：前の回のあとに届いて、まだ渡していない行への言葉
export function reaskPrompt(board, task, name, call = name, focus = null, upto = 0, words = []) {
  const text = typeof task.data === "string" ? task.data : task.data?.text ?? JSON.stringify(task.data);
  const from = Array.isArray(task.data?.from) ? task.data.from.map((id) => board.get(id)).filter(Boolean) : [];
  const near = board.list().filter((p) => p.about === task.id && isPerson(p.by) && p.view !== "task");
  const added = [...new Map([...from, ...near].filter((p) => p.seq > upto).map((p) => [p.id, p])).values()].sort((a, b) => a.seq - b.seq);
  return [
    `同じ仕事 ${task.id}${task.key ? `（表の行 ${task.key}）` : ""}を頼み直されました。前の回の続きです。前に読んだこと・調べたことはこの会話に残っているので、読み直さずに続きから進めてください。`,
    `いまの頼み：${text}`,
    added.length ? "前の回のあとに人が足したこと：" : "前の回のあとに人が足した発言はありません。いまの頼みと、ボードの行（board_read）を見て続けてください。",
    ...added.map((p) => `- ${p.id}：${textOf(p.data)}`),
    ...(words.length ? ["この行への言葉です。応えて、答えをこの行に帰します：", ...words.map((p) => `- ${p.id}（${p.by}）：${clip(textOf(p.data), 500)}`)] : []),
    ...pointNotes(board, added.flatMap((p) => [p, ...board.list().filter((q) => q.into === p.id)])).map((n) => (n.endsWith(PICKED) ? `人はそのとき ${n}` : `発言のとき、${n}（手がかり。話が合わなければ無視する）`)),
    `結果は同じ行に帰します：終わったら panel_edit で仕事 ${task.id} に line と state done を一度に渡します。新しいパネルは足しません。前の回に置いたものを直すなら、足さずに panel_edit で書き換えます。`,
    ...(focus ? ["人のいま（受け持ったときのもの）：", ...focus.lines(board)] : []),
  ].filter(Boolean).join("\n");
}

// 人のいま：画面が知らせてくる、人がいまどこを見ているか・何の話をしているか・何を見たか。
// 操作ログには積まない（ボードを変える操作ではない）。最新だけをメモリに持ち、これで誰かを起こすことはしない。
// 読むのは、別の理由で起きたエージェントだけ（マネージャを起こす文・控室の最初の文・board_read）
import { isPerson } from "./board.js";

const GONE = 2 * 60 * 1000; // 画面からこれだけ便りがなければ、人はいない
const ids = (v, n) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.length <= 40).slice(0, n) : []);
const int = (v) => (Number.isInteger(v) ? v : null);

// 画面が並べた結果（枠ごとの置き場所）。AI が絵や対応表で見るのはこれ
function tilesOf(v) {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 300).flatMap((t) => {
    if (!t || typeof t.key !== "string" || t.key.length > 40) return [];
    const [x, y, w, h] = [t.x, t.y, t.w, t.h].map(int);
    if ([x, y, w, h].includes(null)) return [];
    return [{ key: t.key, x, y, w, h, ...(t.auto ? { auto: true } : {}), ...(t.folded ? { folded: true } : {}), ...(int(t.need) ? { need: t.need } : {}) }];
  });
}

export class Focus {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.clients = new Map(); // 画面（タブ）ごと：id -> { at, data }
    this.seen = {}; // パネルの id -> 人が見たときの aiSeq（端末をまたいで一つにまとめる）
  }

  // 画面から来たものを確かめて持つ。返すのはまとめた seen（ほかの端末で見たものも含む）
  set(client, body = {}) {
    if (typeof client !== "string" || !client || client.length > 64) throw new Error("client がない");
    const data = {
      presence: body.presence === "away" ? "away" : "here",
      listening: !!body.listening,
      followingTalk: !!body.followingTalk,
      viewing: ids(body.viewing, 60),
      inside: ids(body.inside, 120),
      talking: ids(body.talking, 5),
      tiles: tilesOf(body.tiles),
    };
    this.clients.set(client, { at: this.now(), data });
    if (body.seen && typeof body.seen === "object") {
      for (const [id, n] of Object.entries(body.seen).slice(0, 5000)) if (Number.isInteger(n) && n > (this.seen[id] || 0)) this.seen[id] = n;
    }
    return this.seen;
  }

  // いちばん最近の画面。人が見ている画面（here）を先に
  current() {
    const live = [...this.clients.values()].filter((c) => this.now() - c.at < GONE);
    if (!live.length) return null;
    live.sort((a, b) => (b.data.presence === "here") - (a.data.presence === "here") || b.at - a.at);
    return live[0];
  }

  // 人がまだ見ていない、AI が置いた・変えたもの（画面の「知らせ」と同じ決まり）
  unseen(board) {
    return board.list().filter((p) => p.view !== "layout" && !isPerson(p.by) && p.aiSeq && p.aiSeq > (this.seen[p.id] || 0)).map((p) => p.id);
  }

  // board_read に付けるもの
  view(board) {
    const c = this.current();
    if (!c) return { presence: "gone" };
    const { tiles, ...d } = c.data;
    const unseen = this.unseen(board);
    return { ...d, unseen: unseen.slice(-20), ...(unseen.length > 20 ? { unseenMore: unseen.length - 20 } : {}) };
  }

  // 画面が並べた結果（なければ null）
  tiles() {
    return this.current()?.data.tiles ?? null;
  }

  // 起こすときの文に混ぜる数行
  lines(board) {
    const c = this.current();
    if (!c) return ["- いない（画面が開いていない）"];
    const d = c.data;
    const title = (id) => {
      const p = board.get(id);
      const t = typeof p?.data === "string" ? p.data : p?.data?.title ?? p?.data?.text;
      return t ? `${id}「${String(t).slice(0, 30)}」` : id;
    };
    const out = [`- ${d.presence === "here" ? "いる" : "離れている"}${d.listening ? "・聞いています" : ""}`];
    const look = [...d.viewing.map(title), ...(d.followingTalk ? ["トークの末尾"] : [])];
    if (look.length) out.push(`- 見ている：${look.join("、")}${d.inside.length ? `（中の ${d.inside.slice(0, 12).join(" ")}）` : ""}`);
    if (d.talking.length) out.push(`- 話している話題：${d.talking.map(title).join("、")}`);
    const un = this.unseen(board);
    if (un.length) out.push(`- まだ見ていない：${un.slice(-12).join(" ")}${un.length > 12 ? `（ほか ${un.length - 12}）` : ""}`);
    return out;
  }
}

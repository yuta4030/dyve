# CLAUDE.md — dyve

潜ったまま働ける道具。入力欄は一つで、喋ると係が届け先を決め、セッションが裏で動き、オーバービューのカードが変わる。
企画（なぜ・何を・どこまで・未決）の正本は `PLAN.md`、形（コンセプト・原則・構成・画面）と仮の決めは `REBUILD.md`。このファイルは実装時に守ることをまとめたもの。

## 守ること
- コードは `REBUILD.md` と `PLAN.md` の原則に従う
- 0.10.0 までの形（ボード・パネルの操作・MCP の口・マネージャ・控室）は捨てた。参考に読むときは `v0.10.0` のタグを見る。前の版の言葉をコードに持ち込まない（`test/ui.test.js` が確かめる）
- 画面はダイアログを出さない・フォーカスを奪わない・音を鳴らさない（`test/ui.test.js` が確かめる）

## 構成
- `bin/dyve.js`：CLI（`serve`）
- `src/`：記録（`log.js`）・状態（`state.js`）・係（`kakari.js`）・セッション（`sessions.js`）・役割（`roles.js`）・設定（`config.js`）・辞書（`words.js`）・パネル置き場（`panels.js`）・開発の作業場（`work.js`）・サーバー（`server.js`）・画面（`ui.html`）
- `kakari/`：係の定義（発言を読む口・セッションを読む口）
- `roles/`：dyve が配る役割の定義（調べもの・開発・パネル）
- `test/`：テスト。`test/fake-claude.js` が Claude Code のふりをする

## 技術スタック
- サーバーは依存ゼロの Node（http・fs・child_process だけ）。Node 20+
- 画面は `src/ui.html` の 1 枚とブラウザ標準の Web Components。ビルド工程なし。外部の CDN やフォントを読まない
- 画面の言葉は `ui.html` の `L` にまとめる
- CLI は `node:util` の parseArgs。エラーは終了コード 1 と stderr
- テストは `node --test`（`npm test`）。外には一切つながず、偽の spawn で回す
- 前作（bansho・humm）のコードは使わない。考え方だけ流用する

## リリース
- 版は `package.json` の `version` だけ。手順は README の「リリース」

## 文書を直すとき
- 正本は一つずつ。企画は `PLAN.md`、形と仮の決め・未決は `REBUILD.md`、実装で守ることはこのファイル、入れ方・立て方・置き場・設定は README、係と役割の決まりは `kakari/`・`roles/` の定義、版ごとの変更は CHANGELOG。同じことを二か所に書かず、ほかからは指すだけにする
- 結論だけを書く。決め直したら書き換え、前の形や経緯（済みの一覧、「〜から〜に変えた」）は残さない。経緯は CHANGELOG と git の履歴にある
- どこまで来たか・いまやること・未決は `PLAN.md` と `REBUILD.md` に持つ。決まったら未決から外し、決まった形を合う正本に書く

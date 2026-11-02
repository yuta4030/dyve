# dyve

仕事が思考になった人のための、潜ったまま働けるボード。
思考を声で流し込むと、AI が整理して見える化する。人は見て決め、決めたことはそのまま実行に流れていく。

企画書：https://claude.ai/artifact/1K7uGG7NUQVTWx8FHFjxpb

## 使い方

```sh
node bin/dyve.js serve --room ~/code/myrepo   # ボードを立てる（一つだけ）
open http://127.0.0.1:4740/                    # 画面
```

- 下の欄に話すか書く。「しゃべり流し」が入っていれば、間があいたら発言として置かれる。OS の音声入力（Mac の音声入力、Windows の Win+H）でも、ブラウザが対応していれば「マイク」でも話せる
- 発言が来て間があくと、マネージャが起きて清書・整理し、仕事を見つけたら控室に取り次ぐ
- 取り次がれた仕事は、名前のあるタスクエージェント（アリス、ボブ…）が `--room` のディレクトリで片付け、結果を元の発言の横に置く
- 特定の相手に言いたいときは名前を呼ぶ（「アリス、それもういい」）

| オプション | 既定 | 意味 |
|---|---|---|
| `--port` | 4740 | ボードのポート |
| `--data` | `~/.dyve/board.jsonl` | 操作ログ。エージェントのログは同じ場所の `logs/` |
| `--room` | いまのディレクトリ | 控室のエージェントが働くディレクトリ |
| `--pause` | 4000 | 最後の発言からマネージャを起こすまでの間（ミリ秒） |
| `--slots` | 3 | 同時に働くタスクエージェントの数 |
| `--claude` | `claude` | Claude Code のコマンド |
| `--no-agents` | | エージェントを起こさない（画面だけ） |

`node bin/dyve.js export` で、ボードをそのまま Markdown に書き出す（AI は使わない）。画面の「Markdown に書き出す」も同じ。

## Claude Code のプラグインとして入れる

このリポジトリはそのままマーケットプレイスになっている。

```
/plugin marketplace add yuta4030/dyve
/plugin install dyve@dyve
```

中身は、ボードへの接続設定（`.mcp.json`）、マネージャの定義（`agents/manager.md`）、控室で使うスキル（`skills/backroom`）。
ユーザーの好みは、自分の CLAUDE.md に書けば重なる。

## しくみ

```
Panel { id, by, view, data, about?, state?, pinned }
Op    { seq, at, by, type: add | edit | drop, panel, reason? }
```

- **ボード**（`src/board.js`）：操作ログを頭から当てた結果のパネルの並び。操作は add・edit・drop だけ
- **印**はデータに持たず導く。未着手＝結果の付いていない仕事、受け入れ待ち＝提案、知らせ＝人が最後に見たあとに AI が置いた・変えたパネル
- **MCP の口**（`POST /mcp?as=<名前>`）：エージェントが人と同じ操作でボードを読み書きする。道具は `board_read`・`panel_add`・`panel_edit`・`panel_drop`・`panel_history`
- **起こし係**（`src/waker.js`）：間があいたらマネージャを一人だけ起こし、仕事が置かれたら名前のあるエージェントを起こす。同じ仕事を同時に二つ走らせない
- **画面**（`src/ui.html`）：パネルの JSON を view（Web Components）に流し込んで描く。view は `say`・`text`・`list`・`table`・`task`

### 立場ごとにできること

| 操作 | 人（画面） | AI（MCP） |
|---|---|---|
| パネルを置く・書き換える | できる | できる（reason が要る） |
| ピン留めされたパネルを書き換える・外す | できる | 断られる（pinned） |
| ピン留めする・外す | できる | 断られる（forbidden） |
| 提案を受け入れる（proposal → done） | できる | 断られる（forbidden） |
| 人が置いたパネルを外す | できる | 断られる（forbidden） |

拒否コードは pinned・forbidden・not_found・conflict・invalid。

### 控室のエージェントに許す道具

取り消せないことはしない。マネージャはボードだけ、タスクエージェントはボードと、読むこと・調べること（Read・Grep・Glob・WebSearch・WebFetch）だけ。
外に届くことは提案（state `proposal`）として置き、人が受け入れる。

## 開発

```sh
npm test
```

依存ゼロ（Node 20+ の標準だけ）。テストは外につながず、偽の起こし方で回す。

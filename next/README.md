# dyve（作り直し）

潜ったまま働ける道具。入力欄は一つで、喋ると係が届け先を決め、セッションが裏で動き、オーバービューのカードが変わる。
なぜ・何を・どこまでは `../PLAN.md`、作り直す先の形と仮の決め・未決は `../REBUILD.md`。このファイルは立て方と置き場だけを持つ。

## 立てる

Node 20 以上と、ログインした Claude Code（`claude`）が要る。依存はない。

```sh
node next/bin/dyve.js serve --room <セッションが働くリポジトリ>
```

出てきた URL（既定は http://127.0.0.1:4750/）を開く。引数の一覧は `node next/bin/dyve.js --help`。

- 声は OS の音声入力を使う。間があくと置かれ、キーボードで打ったものは Enter で置かれる（改行は Shift+Enter）
- `claude` が動かなくても画面は立つ。セッションは結果を出さずに終わり、発言は残る

## 置き場

既定は `~/.dyve/next/`。`--config` を変えると、その隣が置き場になる。

| もの | 場所 | 中身 |
|---|---|---|
| 記録 | `record.jsonl`（`--data`） | 追記だけのログ。画面と状態は、これを頭から当て直して作る |
| 設定 | `config.json`（`--config`） | 下の「設定」 |
| 役割の定義 | `roles/<名前>.md` | 役割の指示。dyve と同じ名前なら後ろに足し、新しい名前なら役割が増える |
| 辞書 | `words.jsonl` | 聞き違える言葉と書き方。一行に `{"by":"人","heard":"聞こえた言葉","write":"書き方"}`。係も足す（人が書いた言葉は書き換えない） |
| パネル置き場 | `panels/`（`--panels`） | 利用者の view。git で履歴を持つ。書き方は、作られた置き場の `README.md` |
| 開発の作業場 | `work/`（`--work`） | 開発のセッションごとの git worktree |

## 設定

`config.json` は JSON。書ける項目はこれだけで、知らない項目は立てるときに断る。

```json
{
  "kakari": { "model": "haiku" },
  "roles": {
    "調べもの": { "model": "sonnet" },
    "校正": { "tools": ["Read", "Grep", "Glob"], "deny": ["WebFetch"] }
  }
}
```

- `kakari.model`：係のモデル（既定は速いもの）
- `roles.<名前>`：`model`、`mode`（`"append"` か `"replace"`。定義を後ろに足すか差し替えるか）、`tools`（許す道具）、`deny`（禁じる道具。足すだけ）
- 新しい役割は `roles/<名前>.md` を置くと増える。定義の頭の一行が、係が役割を選ぶときの説明になる。`tools` を書かなければ読むだけ
- 外に届くこと（`git push`・`git remote`・`git reset`・`rm`）は、どの役割でも止まり、設定では外せない

## 役割

| 役割 | 起きる場所 | できること |
|---|---|---|
| 調べもの | `--room` | 読む・Web で調べる。ファイルは書き換えない |
| 開発 | セッションごとの作業場（`--room` が git のリポジトリのとき） | 作業場のブランチで書いてコミットする。取り込むのは、人がカードの「取り込む」を押したとき |
| パネル | パネル置き場 | view を書いてコミットする |

## テスト

```sh
npm run test:next
```

外にはつながない。`test/fake-claude.js` が Claude Code のふりをするので、`serve --claude next/test/fake-claude.js` で費用をかけずに通しで動かせる。

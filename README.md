# dyve

潜ったまま働ける道具。入力欄は一つで、喋ると係が届け先を決め、セッションが裏で動き、オーバービューのカードが変わる。
なぜ・何を・どこまでは [PLAN.md](PLAN.md)、形と仮の決め・未決は [REBUILD.md](REBUILD.md)。このファイルは入れ方・立て方・置き場・設定を持つ。

## 入れる

Node 20 以上と、入れてログインした [Claude Code](https://docs.claude.com/en/docs/claude-code/setup)（`claude`）が要る。依存はない。

```sh
npm i -g github:yuta4030/dyve#v0.11.0     # dyve コマンドを入れる。版はタグで固定する
```

入れずに試すだけなら `npx github:yuta4030/dyve#v0.11.0 serve`。更新は版を変えて `npm i -g` し直す（版ごとの変更は [CHANGELOG](CHANGELOG.md)）。

## 立てる

```sh
dyve serve --room <セッションが働くリポジトリ>
```

出てきた URL（既定は http://127.0.0.1:4750/）を開く。引数の一覧は `dyve --help`。

- 声は OS の音声入力を使う。間があくと置かれ、キーボードで打ったものは Enter で置かれる（改行は Shift+Enter）
- `claude` が動かなくても画面は立つ。セッションは結果を出さずに終わり、発言は残る

## 置き場

既定は `~/.dyve/next/`。`--config` を変えると、その隣が置き場になる。0.10.0 までの版が `~/.dyve/` の直下に置いたもの（`board.jsonl`・`config.json` など）は読まない

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
npm test
```

依存ゼロ（Node 20+ の標準だけ）。外にはつながない。`test/fake-claude.js` が Claude Code のふりをするので、`node bin/dyve.js serve --claude test/fake-claude.js` で費用をかけずに通しで動かせる。
CI は Linux と macOS、Node 20 と 22 で回す。

## リリース

1. `package.json` の `version` を上げる
2. `CHANGELOG.md` に `## [<版>] - <日付>` の節を書く（テストが、いまの版の節があるかを確かめる）
3. PR をマージする。main の版にまだタグがなければ、CI（`.github/workflows/release.yml`）が `v<版>` のタグと GitHub Release を作る。Release の本文は CHANGELOG のその版の節
4. README の「入れる」の版を新しいタグに直す

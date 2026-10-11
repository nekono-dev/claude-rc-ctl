# 開発ガイド

- 言語は日本語（コメント・ドキュメント・エラーメッセージ）。README は利用者向けで、「だ・である」調。
- 仕様駆動開発: 機能の追加・修正の前に `specs/claude-rc-ctl/` の要件・設計・タスクを更新し、`npm run lint:spec` を通す。ルールは `.claude/skills/spec-driven-development/references/rules.md`。
- 受け入れ条件 `AC-n` には、テスト名に `claude-rc-ctl/AC-n` を含むテストを `tests/*.test.mjs` に置く（lint が検査する）。
- テストは `npm test`（`node --test`）。systemctl・tmux 等は `tests/helpers.mjs` の擬似コマンドで置き換えるため、実機の systemd は変更されない。
- シェルは `shellcheck -S warning` を通す。

# 構成

| パス                   | 内容                                                                    |
| ---------------------- | ----------------------------------------------------------------------- |
| `src/`                 | 配布物（コマンド・起動ラッパー・systemd テンプレートユニット）          |
| `installer/`           | 頒布用インストーラ（`main.sh` の `app_*` フックが固有処理）             |
| `.github/workflows/`   | CI（ブランチ push で Pre-release、`v*` タグで Release に `install.sh`） |
| `specs/claude-rc-ctl/` | 要件・設計・タスク                                                      |

# 実機検証

- 実 systemd での確認は検証サーバへ資材を scp して行う。インストーラは `sh installer/build-bootstrap.sh main <コミット> file://<リポジトリ>` で生成し、`sh install.sh install` で導入する。
- `claude` の代わりに、引数を表示して `sleep` する擬似コマンドを `PATH` 上に置けば、`claude` 本体なしで常駐の動作を確認できる。

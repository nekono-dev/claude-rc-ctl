# 開発ガイド

- 言語は日本語（コメント・ドキュメント・エラーメッセージ）。README は利用者向けで、「だ・である」調。
- 仕様駆動開発: 機能の追加・修正の前に `specs/<コンポーネント>/`（claude-rc-ctl・claude-rc-archive）の要件・設計・タスクを更新し、`npm run lint:spec` を通す（実体は `spec-lint`）。ルールは `spec-lint --rules`。
- `spec-lint`（`@nekono-dev/spec-lint`）と skill は環境側に導入し、このリポジトリには同梱しない。導入は `npm install -g @nekono-dev/spec-lint`（GitHub Packages の認証が必要）、skill は `~/.claude/skills/spec-driven-development`。手順は skill の `references/setup.md`。未導入だと lint は導入手順を表示して終了コード 1 で止まる。
- 設計済みの spec が3件以上になったら `docs/architecture.md` を必須とする（現在は2件で任意）。手順は skill の `references/workflow.md`。
- 受け入れ条件 `AC-n` には、テスト名に `claude-rc-ctl/AC-n` を含むテストを `tests/*.test.mjs` に置く（lint が検査する）。
- テストは `npm test`（`node --test`）。systemctl・tmux 等は `tests/helpers.mjs` の擬似コマンドで置き換えるため、実機の systemd は変更されない。
- シェルは `shellcheck -S warning` を通す。

# 構成

| パス                 | 内容                                                                        |
| -------------------- | --------------------------------------------------------------------------- |
| `src/`               | 配布物（コマンド・起動ラッパー・systemd テンプレートユニット）              |
| `installer/`         | 頒布用インストーラ（`main.sh` の `app_*` フックが固有処理）                 |
| `.github/workflows/` | CI（ブランチ push でアーティファクト、`v*` タグで Release に `install.sh`） |
| `.claude/skills/`    | 開発用 skill（インストーラ・CI の整備 `bootstrap-ci-builder`）              |
| `specs/`             | 要件・設計・タスク（コンポーネントごと）                                    |

# 実機検証

- 実 systemd での確認は検証サーバへ資材を scp して行う。インストーラは `sh installer/build-bootstrap.sh refs/heads/main <コミット> file://<リポジトリ>` で生成し、`sh install.sh install` で導入する。
- `claude` の代わりに、引数を表示して `sleep` する擬似コマンドを `PATH` 上に置けば、`claude` 本体なしで常駐の動作を確認できる。

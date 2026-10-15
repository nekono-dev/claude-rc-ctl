# claude-rc-archive タスク一覧

## Phase 1: 起動方式

- 対応: D-1
- [x] T-1.1: 起動ラッパーに、セッションを事前に作らない指定を追加する。
- [x] T-1.2: 指定が渡されることを受け入れ条件タグ付きでテストする。
- 検証: `node --test tests/service.test.mjs`

## Phase 2: 判定と再起動

- 対応: D-2, D-3
- [x] T-2.1: 擬似コマンドに tmux の display-message と systemctl の停止状態を追加する。
- [x] T-2.2: アイドル・実行中・リマインダーを判定し、再起動する archive サブコマンドを実装する。
- [x] T-2.3: 一括判定と確認のみの指定を実装する。
- [x] T-2.4: 受け入れ条件タグ付きで archive のテストを追加する。
- 検証: `node --test tests/archive.test.mjs`

## Phase 3: 定期実行

- 対応: D-4
- [x] T-3.1: 定期実行のサービスとタイマーのユニットを追加する。
- [x] T-3.2: インストーラに配置・有効化・無効化・撤去と旧ユニットの撤去を追加する。
- [x] T-3.3: 定期実行の配置と撤去をテストする。
- 検証: `node --test tests/archive.test.mjs tests/installer.test.mjs`

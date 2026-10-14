# claude-rc-reap タスク一覧

## Phase 1: 回収コマンド

- 対応: D-1, D-2
- [x] T-1.1: 擬似コマンドに tmux の display-message と systemctl の停止状態を追加する。
- [x] T-1.2: 判定と終了を行う reap サブコマンドを実装する。
- [x] T-1.3: 一括回収と確認のみの指定を実装する。
- [x] T-1.4: 受け入れ条件タグ付きで reap のテストを追加する。
- 検証: `node --test tests/reap.test.mjs`

## Phase 2: 定期実行

- 対応: D-3
- [x] T-2.1: 定期実行のサービスとタイマーのユニットを追加する。
- [x] T-2.2: インストーラに配置・有効化・無効化・撤去を追加する。
- [x] T-2.3: 定期実行の配置と撤去をテストする。
- 検証: `node --test tests/reap.test.mjs tests/installer.test.mjs`

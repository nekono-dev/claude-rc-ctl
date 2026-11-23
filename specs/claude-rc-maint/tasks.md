# claude-rc-maint タスク一覧

## Phase 1: 判定と再起動

- 対応: D-1, D-2, D-4, D-5
- [x] T-1.1: archive サブコマンドを maintain に改め、アイドル判定と2つの設定（閾値・猶予時間）を削除する。
- [x] T-1.2: 本体が更新されたサーバーを、実行中・リマインダーのセッションがなければ猶予なしで再起動する。
- [x] T-1.3: 使い方の表示から廃止した設定を除き、受け入れ条件タグ付きで判定のテストを改める。
- 検証: `node --test tests/maint.test.mjs`

## Phase 2: 定期実行

- 対応: D-3
- [x] T-2.1: 定期実行のユニットを claude-rc-maint に改名し、maintain --all を実行させる。
- [x] T-2.2: インストーラの導入・更新で旧名（claude-rc-archive）のタイマーを無効化してユニットを撤去する。
- [x] T-2.3: 配置・旧名の撤去・削除を受け入れ条件タグ付きでテストする。
- 検証: `node --test tests/maint.test.mjs tests/installer.test.mjs`

## Phase 3: 版の削除と警告

- 対応: D-6, D-7, D-8
- [x] T-3.1: 版の削除と起動失敗・認証失敗の警告を maintain の処理として残し、再起動の案内を改める。
- [x] T-3.2: 受け入れ条件タグ付きでテストを改め、README のアーカイブの説明を削除して定期実行の説明に改める。
- 検証: `node --test --test-name-pattern '版|起動失敗|認証失敗' tests/maint.test.mjs`

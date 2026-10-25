# shellcheck shell=sh disable=SC2154

UNIT_DIR="$HOME/.config/systemd/user"

app_install() {
  for _c in tmux python3 systemctl; do
    command -v "$_c" >/dev/null 2>&1 || die "$_c が必要です。先に導入してください"
  done
  systemctl --user show-environment >/dev/null 2>&1 || die "systemctl --user が使えません（ユーザーのsystemdセッションがありません）"
  mkdir -p "$UNIT_DIR" "$DATA_DIR"
  chmod 755 "$DIR/src/claude-rc-ctl" "$DIR/src/claude-rc-run"
  ln -sf "$DIR/src/claude-rc-ctl" "$BIN_DIR/claude-rc-ctl"
  ln -sf "$DIR/src/claude-rc-run" "$BIN_DIR/claude-rc-run"
  if [ -f "$UNIT_DIR/claude-rc-reap.timer" ]; then
    systemctl --user disable --now claude-rc-reap.timer 2>/dev/null || true
  fi
  rm -f "$UNIT_DIR/claude-rc-reap.service" "$UNIT_DIR/claude-rc-reap.timer" "$UNIT_DIR/timers.target.wants/claude-rc-reap.timer"
  cp "$DIR/src/claude-rc@.service" "$DIR/src/claude-rc-archive.service" "$DIR/src/claude-rc-archive.timer" "$UNIT_DIR/"
  systemctl --user daemon-reload
  systemctl --user enable --now claude-rc-archive.timer
  [ -s "$HOME/.nvm/nvm.sh" ] || log "警告: $HOME/.nvm/nvm.sh がありません。claude-rc-run は nvm 経由で claude を起動します"
  [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" = "yes" ] || log "警告: linger が無効です。ログアウトやOS再起動後も常駐させるには loginctl enable-linger $(id -un) を実行してください"
}

app_uninstall() {
  for _f in "$DATA_DIR"/*.env; do
    [ -f "$_f" ] || continue
    systemctl --user stop "claude-rc@$(basename "$_f" .env).service" 2>/dev/null || true
  done
  systemctl --user disable --now claude-rc-archive.timer 2>/dev/null || true
  rm -f "$UNIT_DIR/claude-rc@.service" "$UNIT_DIR/claude-rc-archive.service" "$UNIT_DIR/claude-rc-archive.timer" "$BIN_DIR/claude-rc-ctl" "$BIN_DIR/claude-rc-run"
  systemctl --user daemon-reload 2>/dev/null || true
}

app_purge() {
  rm -f "$UNIT_DIR"/default.target.wants/claude-rc@*.service "$UNIT_DIR/timers.target.wants/claude-rc-archive.timer"
  systemctl --user daemon-reload 2>/dev/null || true
}

import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { CTL, makeEnv } from "./helpers.mjs"

const proj = (e, name) => {
  const d = join(e.home, name)
  mkdirSync(d, { recursive: true })
  return d
}

test("claude-rc-ctl/AC-1: 登録すると作業ディレクトリが保存され、サービスが有効化と同時に起動される", () => {
  const e = makeEnv()
  const d = proj(e, "alpha")
  const r = e.run(CTL, ["add", d, "a1"])
  assert.equal(r.status, 0, r.err)
  assert.match(
    readFileSync(join(e.confDir, "a1.env"), "utf8"),
    new RegExp(`^CLAUDE_RC_DIR=${d}$`, "m"),
  )
  assert.ok(
    e.calls().includes("systemctl --user enable --now claude-rc@a1.service"),
  )
})

test("claude-rc-ctl/AC-2: 名前を省略するとディレクトリ名が登録名になる", () => {
  const e = makeEnv()
  const r = e.run(CTL, ["add", proj(e, "beta")])
  assert.equal(r.status, 0, r.err)
  assert.ok(existsSync(join(e.confDir, "beta.env")))
})

test("claude-rc-ctl/AC-3: 登録解除するとサービスが無効化と同時に停止され、登録情報が削除される", () => {
  const e = makeEnv()
  e.run(CTL, ["add", proj(e, "gamma"), "g"])
  const r = e.run(CTL, ["remove", "g"])
  assert.equal(r.status, 0, r.err)
  assert.ok(
    e.calls().includes("systemctl --user disable --now claude-rc@g.service"),
  )
  assert.ok(!existsSync(join(e.confDir, "g.env")))
})

test("claude-rc-ctl/AC-4: 一覧に名前・状態・作業ディレクトリが1行ずつ表示される", () => {
  const e = makeEnv()
  e.register("one", "/work/one")
  e.register("two", "/work/two")
  const r = e.run(CTL, ["list"])
  assert.equal(r.status, 0, r.err)
  const lines = r.out.trim().split("\n")
  assert.match(lines[0], /^NAME\s+STATE\s+DIR$/)
  assert.match(
    lines.find((l) => l.startsWith("one")),
    /^one\s+active\s+\/work\/one$/,
  )
  assert.match(
    lines.find((l) => l.startsWith("two")),
    /^two\s+active\s+\/work\/two$/,
  )
})

test("claude-rc-ctl/AC-5: 起動・停止・再起動・状態表示が対象のサービスへ渡される", () => {
  const e = makeEnv()
  e.register("svc", "/work/svc")
  for (const c of ["start", "stop", "restart", "status"]) {
    const r = e.run(CTL, [c, "svc"])
    assert.equal(r.status, 0, r.err)
    assert.ok(
      e.calls().includes(`systemctl --user ${c} claude-rc@svc.service`),
      c,
    )
  }
})

test("claude-rc-ctl/AC-6: 接続を指示すると対象専用の tmux ソケットへ接続する", () => {
  const e = makeEnv()
  e.register("svc", "/work/svc")
  e.run(CTL, ["attach", "svc"])
  assert.ok(e.calls().includes("tmux -L claude-rc-svc attach -t svc"))
})

test("claude-rc-ctl/AC-7: ログ表示で画面出力とジャーナルの両方が表示される", () => {
  const e = makeEnv()
  e.register("svc", "/work/svc")
  const r = e.run(CTL, ["logs", "svc"])
  assert.equal(r.status, 0, r.err)
  assert.match(r.out, /PANE_OUTPUT/)
  assert.match(r.out, /JOURNAL_OUTPUT/)
  assert.ok(
    e
      .calls()
      .includes("journalctl --user -u claude-rc@svc.service -n 30 --no-pager"),
  )
})

test("claude-rc-ctl/AC-11: 不正な名前・存在しないディレクトリ・登録済みの名前は登録情報を作らずに失敗する", () => {
  const e = makeEnv()
  const d = proj(e, "delta")
  let r = e.run(CTL, ["add", d, "bad name"])
  assert.notEqual(r.status, 0)
  assert.ok(!existsSync(join(e.confDir, "bad name.env")))

  r = e.run(CTL, ["add", join(e.home, "missing"), "m"])
  assert.notEqual(r.status, 0)
  assert.ok(!existsSync(join(e.confDir, "m.env")))

  assert.equal(e.run(CTL, ["add", d, "dup"]).status, 0)
  const before = readFileSync(join(e.confDir, "dup.env"), "utf8")
  const enables = e.calls().filter((c) => c.includes("enable --now")).length
  r = e.run(CTL, ["add", proj(e, "other"), "dup"])
  assert.notEqual(r.status, 0)
  assert.equal(readFileSync(join(e.confDir, "dup.env"), "utf8"), before)
  assert.equal(
    e.calls().filter((c) => c.includes("enable --now")).length,
    enables,
  )
})

test("claude-rc-ctl/AC-12: git でないディレクトリと未信頼のディレクトリに警告が表示される", () => {
  const e = makeEnv()
  const plain = proj(e, "plain")
  let r = e.run(CTL, ["add", "--spawn", "worktree", plain, "p"])
  assert.match(r.err, /git リポジトリではない/)
  assert.match(r.err, /未信頼/)

  r = e.run(CTL, ["add", proj(e, "plain2"), "p2"])
  assert.doesNotMatch(r.err, /git リポジトリではない/)

  const repo = proj(e, "repo")
  e.run("git", ["-C", repo, "init", "-q"])
  writeFileSync(
    join(e.home, ".claude.json"),
    JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } }),
  )
  r = e.run(CTL, ["add", repo, "r"])
  assert.equal(r.status, 0, r.err)
  assert.doesNotMatch(r.err, /git リポジトリではない/)
  assert.doesNotMatch(r.err, /未信頼/)
})

test("claude-rc-ctl/AC-20: 登録済みが10件のとき一覧表示が3秒以内に終わる", () => {
  const e = makeEnv()
  for (let i = 0; i < 10; i++) e.register(`inst${i}`, `/work/${i}`)
  const r = e.run(CTL, ["list"])
  assert.equal(r.status, 0, r.err)
  assert.equal(r.out.trim().split("\n").length, 11)
  assert.ok(r.ms < 3000, `${r.ms}ms`)
})

test("claude-rc-ctl/AC-22: 起動方式を省略すると保存されず、指定するとその値が保存される", () => {
  const e = makeEnv()
  assert.equal(e.run(CTL, ["add", proj(e, "s1"), "s1"]).status, 0)
  assert.doesNotMatch(
    readFileSync(join(e.confDir, "s1.env"), "utf8"),
    /CLAUDE_RC_SPAWN/,
  )

  const repo = proj(e, "s2")
  e.run("git", ["-C", repo, "init", "-q"])
  assert.equal(e.run(CTL, ["add", "--spawn", "worktree", repo, "s2"]).status, 0)
  assert.match(
    readFileSync(join(e.confDir, "s2.env"), "utf8"),
    /^CLAUDE_RC_SPAWN=worktree$/m,
  )

  assert.equal(
    e.run(CTL, ["add", "--spawn=same-dir", proj(e, "s3"), "s3"]).status,
    0,
  )
  assert.match(
    readFileSync(join(e.confDir, "s3.env"), "utf8"),
    /^CLAUDE_RC_SPAWN=same-dir$/m,
  )
})

test("claude-rc-ctl/AC-23: 不正な起動方式では登録情報を作らずに失敗する", () => {
  const e = makeEnv()
  const r = e.run(CTL, ["add", "--spawn", "session", proj(e, "bad"), "bad"])
  assert.notEqual(r.status, 0)
  assert.match(r.err, /same-dir か worktree/)
  assert.ok(!existsSync(join(e.confDir, "bad.env")))
  assert.ok(!e.calls().some((c) => c.includes("enable --now")))
})

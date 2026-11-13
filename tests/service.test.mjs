import assert from "node:assert/strict"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { hostname } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { ROOT, RUN, makeEnv } from "./helpers.mjs"

const unit = readFileSync(join(ROOT, "src", "claude-rc@.service"), "utf8")

const setup = (extraEnvLines) => {
  const e = makeEnv()
  const dir = join(e.home, "work")
  mkdirSync(dir)
  mkdirSync(e.confDir, { recursive: true })
  writeFileSync(
    join(e.confDir, "w.env"),
    `CLAUDE_RC_DIR=${dir}\n${extraEnvLines}`,
  )
  return { e, dir, r: e.run(RUN, ["w"]) }
}

const runWith = (extraEnvLines) => {
  const { e, dir, r } = setup(extraEnvLines)
  assert.equal(r.status, 0, r.err)
  return {
    effort: readFileSync(join(e.home, "claude.effort"), "utf8").trim(),
    args: readFileSync(join(e.home, "claude.args"), "utf8").trim().split("\n"),
    dir,
  }
}

test("claude-rc-ctl/AC-8: 登録情報に値がないとき same-dir と auto で remote-control が起動される", () => {
  const { args, dir } = runWith("")
  assert.equal(args[0], dir)
  assert.deepEqual(args.slice(1), [
    "remote-control",
    "--no-create-session-in-dir",
    "--spawn",
    "same-dir",
    "--permission-mode",
    "auto",
    "--remote-control-session-name-prefix",
    `${hostname()}-w`,
  ])
})

test("claude-rc-ctl/AC-9: 登録情報の起動方式と権限モードで remote-control が起動される", () => {
  const { args } = runWith(
    "CLAUDE_RC_SPAWN=same-dir\nCLAUDE_RC_PERMISSION_MODE=plan\n",
  )
  assert.deepEqual(args.slice(3, 7), [
    "--spawn",
    "same-dir",
    "--permission-mode",
    "plan",
  ])
})

test("claude-rc-ctl/AC-24: 登録情報に effort がないとき medium で claude が起動される", () => {
  assert.equal(runWith("").effort, "medium")
})

test("claude-rc-ctl/AC-25: 登録情報の effort で claude が起動される", () => {
  for (const v of ["low", "medium", "high", "xhigh", "max"])
    assert.equal(runWith(`CLAUDE_RC_EFFORT=${v}\n`).effort, v)
})

test("claude-rc-ctl/AC-26: 許可値以外の effort では claude を起動せずに失敗する", () => {
  for (const v of ["middle", "HIGH", "0"]) {
    const { e, r } = setup(`CLAUDE_RC_EFFORT=${v}\n`)
    assert.equal(r.status, 1)
    assert.match(r.err, /CLAUDE_RC_EFFORT/)
    assert.equal(existsSync(join(e.home, "claude.args")), false)
  }
})

test("claude-rc-ctl/AC-10: サービス定義は tmux の専用ソケット内でセッションを作成して起動する", () => {
  assert.match(
    unit,
    /^ExecStart=\/usr\/bin\/tmux -L claude-rc-%i new-session -d -s %i %h\/\.local\/bin\/claude-rc-run %i$/m,
  )
  assert.match(unit, /^ExecStop=\/usr\/bin\/tmux -L claude-rc-%i kill-server$/m)
})

test("claude-rc-ctl/AC-19: サービス定義は常に再起動し、待ち時間が10秒である", () => {
  assert.match(unit, /^Restart=always$/m)
  assert.match(unit, /^RestartSec=10$/m)
})

test("claude-rc-archive/AC-14: 起動ラッパーはセッションを事前に作らない指定を付けて remote-control を起動する", () => {
  const { args } = runWith("")
  assert.equal(args[1], "remote-control")
  assert.ok(args.includes("--no-create-session-in-dir"))
})

const VERSIONS = (e) => join(e.home, ".local", "share", "claude-rc", "versions")
const launched = (e) => readFileSync(join(e.home, "claude.path"), "utf8").trim()

test("claude-rc-ctl/AC-32: 起動ラッパーは claude を版ごとの置き場所へ固定し、その複製から起動し、元の場所を記録する", () => {
  const { e, r } = setup("")
  assert.equal(r.status, 0, r.err)
  const pinned = join(VERSIONS(e), "9.9.9", "claude")
  assert.equal(launched(e), pinned)
  // 同じファイルシステムではハードリンクで固定する（容量を使わない）
  assert.equal(statSync(pinned).ino, statSync(join(e.bin, "claude")).ino)
  assert.equal(
    readFileSync(join(VERSIONS(e), "9.9.9", "source"), "utf8").trim(),
    join(e.bin, "claude"),
  )
  // 引数はそのまま remote-control へ渡る
  const args = readFileSync(join(e.home, "claude.args"), "utf8").split("\n")
  assert.equal(args[1], "remote-control")
})

test("claude-rc-ctl/AC-33: npm の claude は node_modules からの相対配置のまま固定され、同じ版の再起動では既存の複製を使う", () => {
  const e = makeEnv()
  const dir = join(e.home, "work")
  mkdirSync(dir)
  mkdirSync(e.confDir, { recursive: true })
  writeFileSync(join(e.confDir, "w.env"), `CLAUDE_RC_DIR=${dir}\n`)
  // nvm と同じ配置: bin/claude -> ../lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe
  const rel = join(
    "node_modules",
    "@anthropic-ai",
    "claude-code",
    "bin",
    "claude.exe",
  )
  const npm = join(e.home, "npm")
  mkdirSync(join(npm, "lib", dirname(rel)), { recursive: true })
  mkdirSync(join(npm, "bin"))
  copyFileSync(join(e.bin, "claude"), join(npm, "lib", rel))
  symlinkSync(join("..", "lib", rel), join(npm, "bin", "claude"))
  const PATH = `${join(npm, "bin")}:${e.env.PATH}`
  const r1 = e.run(RUN, ["w"], { PATH })
  assert.equal(r1.status, 0, r1.err)
  const pinned = join(VERSIONS(e), "9.9.9", rel)
  assert.equal(launched(e), pinned)
  const ino = statSync(pinned).ino
  // 同じ版での再起動は既存の複製を使い、作業用のディレクトリを残さない
  assert.equal(e.run(RUN, ["w"], { PATH }).status, 0)
  assert.equal(statSync(pinned).ino, ino)
  assert.deepEqual(readdirSync(VERSIONS(e)), ["9.9.9"])
  // 版が変わると別の置き場所へ固定し、古い版は残す
  assert.equal(
    e.run(RUN, ["w"], { PATH, STUB_CLAUDE_VERSION: "9.9.10" }).status,
    0,
  )
  assert.equal(launched(e), join(VERSIONS(e), "9.9.10", rel))
  assert.deepEqual(readdirSync(VERSIONS(e)).sort(), ["9.9.10", "9.9.9"])
})

test("claude-rc-ctl/AC-34: claude が見つからないときは、remote-control を起動せずに失敗する", () => {
  const e = makeEnv()
  unlinkSync(join(e.bin, "claude"))
  const dir = join(e.home, "work")
  mkdirSync(dir)
  mkdirSync(e.confDir, { recursive: true })
  writeFileSync(join(e.confDir, "w.env"), `CLAUDE_RC_DIR=${dir}\n`)
  const r = e.run(RUN, ["w"])
  assert.equal(r.status, 1)
  assert.match(r.err, /claude が見つかりません/)
  assert.equal(existsSync(join(e.home, "claude.args")), false)
  assert.equal(existsSync(VERSIONS(e)), false)
})

import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { CTL, ROOT, installFixture, makeEnv } from "./helpers.mjs"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 擬似サーバー（sh）と、指定ディレクトリを cwd とする子プロセス（セッション）を起動する。セッションが0件のサーバーは子を持たない。
 * busy が真の子は、実行中状態の孫プロセスを持つ。
 * stale が真のサーバーは、起動後に実行ファイルを削除する（版を固定する前の方式で、claude 本体の更新で入れ替わった状態）。
 * exe を指定したサーバーは、そのパスに置いた sh の複製で動く（版を固定した状態）。remove が真なら起動後にそれを削除する。
 * onStarted は、サーバーの起動後、実行ファイルを削除する前に呼ぶ。
 */
async function makeServer(e, sessions, { stale, exe, remove, onStarted } = {}) {
  // 削除してよい sh の複製をサーバー本体にする（擬似コマンドではなく実物を複製する）
  let shell = "sh"
  // セッションなしで本体を保つための待ち受け口（sleep へ置き換わると実行ファイルが変わってしまう）
  const fifo = join(e.home, `fifo-${Date.now()}`)
  const own = stale || exe
  if (own) {
    shell = exe ?? join(e.home, `sh-copy-${Date.now()}`)
    copySh(e, shell)
    e.run("mkfifo", [fifo])
  }
  const files = sessions.map((_, i) => join(e.home, `pid${i}-${Date.now()}`))
  const body = sessions
    .map(({ dir, busy }, i) => {
      const tail = busy
        ? `sh -c "while :; do :; done" & wait`
        : "exec sleep 300"
      return `(cd '${dir}' && exec sh -c 'echo $$ > ${files[i]}; ${tail}') &`
    })
    .join("\n")
  // 読み書き両用で開くと開く時点では止まらず、読み取りで待ち続ける（子プロセスを作らない）
  const idleScript = own ? `exec 3<>'${fifo}'; read x <&3` : "exec sleep 300"
  const script = sessions.length ? `${body}\nwait` : idleScript
  const server = spawn(shell, ["-c", script], {
    detached: true,
    stdio: "ignore",
  })
  for (let n = 0; n < 100 && !files.every((f) => existsSync(f)); n++)
    await sleep(50)
  await sleep(own ? 300 : 100)
  onStarted?.()
  if (stale || remove) unlinkSync(shell)
  const pids = files.map((f) => Number(readFileSync(f, "utf8").trim()))
  const stop = () => {
    try {
      process.kill(-server.pid, "SIGKILL")
    } catch {}
  }
  return { pid: server.pid, pids, stop }
}

/** 実物の sh を dest へ複製する（ディレクトリも作る） */
function copySh(e, dest) {
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(
    realpathSync(
      e.run("sh", ["-c", "PATH=/usr/bin:/bin command -v sh"]).out.trim(),
    ),
    dest,
  )
  chmodSync(dest, 0o755)
}

const versionsOf = (e) =>
  join(e.home, ".local", "share", "claude-rc", "versions")

/**
 * 版を固定したサーバーの実行ファイルと、元の場所（source）を用意する。
 * host が "same" なら元の場所は複製と同じファイル（ハードリンク）、"updated" なら別のファイル（本体が更新された状態）、
 * "absent" なら存在しないパス（更新の途中）にする。
 */
function pinServer(e, host) {
  const v = join(versionsOf(e), "1.0.0")
  const exe = join(v, "claude")
  const src = join(e.home, "host", "claude")
  mkdirSync(dirname(src), { recursive: true })
  return {
    exe,
    // サーバーの起動後、削除の前に呼ぶ（複製は makeServer が作る）
    prepare() {
      if (host === "same") linkSync(exe, src)
      if (host === "updated") {
        copySh(e, src)
        const t = new Date(Date.now() - 86_400_000)
        utimesSync(src, t, t)
      }
      writeFileSync(join(v, "source"), `${src}\n`)
    },
  }
}

/** プロジェクトディレクトリと、更新時刻を minutes 分前にした transcript を作る */
function makeProject(e, name, minutes = 1, { reminder } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `rcproj-${name}-`)))
  const proj = join(
    e.home,
    ".claude",
    "projects",
    dir.replace(/[^A-Za-z0-9]/g, "-"),
  )
  mkdirSync(proj, { recursive: true })
  const f = join(proj, "00000000-0000-0000-0000-000000000000.jsonl")
  writeFileSync(f, "{}\n")
  const t = new Date(Date.now() - minutes * 60_000)
  utimesSync(f, t, t)
  if (reminder !== undefined) {
    mkdirSync(join(dir, ".claude"))
    writeFileSync(join(dir, ".claude", "scheduled_tasks.json"), reminder)
  }
  return dir
}

const RESTART = (n) => `systemctl --user restart claude-rc@${n}.service`

/** 1インスタンスに対して maintain を実行し、再起動されたかを返す */
async function scenario(
  sessions,
  { stale, pin, remove, conf = "", args = ["maintain", "inst"] } = {},
) {
  const e = makeEnv()
  e.register("inst", "/x")
  if (conf)
    writeFileSync(join(e.confDir, "inst.env"), `CLAUDE_RC_DIR=/x\n${conf}`)
  const dirs = sessions.map((s) =>
    makeProject(e, "s", s.minutes, { reminder: s.reminder }),
  )
  const pinned = pin ? pinServer(e, pin) : undefined
  const srv = await makeServer(
    e,
    sessions.map((s, i) => ({ dir: dirs[i], busy: s.busy })),
    { stale, exe: pinned?.exe, remove, onStarted: pinned?.prepare },
  )
  try {
    const r = e.run(CTL, args, { STUB_PANE_PID_inst: String(srv.pid) })
    return { e, r, srv, restarted: e.calls().includes(RESTART("inst")) }
  } finally {
    srv.stop()
  }
}

test("claude-rc-maint/AC-1: 本体が更新されたサーバーは、セッションがないときも、実行中でないセッションだけがあるときも再起動される", async () => {
  const none = await scenario([], { stale: true })
  assert.equal(none.r.status, 0, none.r.err)
  assert.ok(none.restarted)
  assert.match(none.r.out, /\[inst\] 本体更新: サーバーを再起動する/)
  // 更新された直後（数分前に使われた）のセッションでも、猶予を待たずに再起動する
  const idle = await scenario([{ minutes: 1 }, { minutes: 3 }], { stale: true })
  assert.equal(idle.r.status, 0, idle.r.err)
  assert.ok(idle.restarted)
  assert.match(idle.r.out, /\[inst\] セッション=- 判定=本体更新/)
  // 廃止した設定は読まない（不正な値が残っていても失敗しない）
  const legacy = await scenario([{ minutes: 1 }], {
    stale: true,
    conf: "CLAUDE_RC_ARCHIVE_MINUTES=0\nCLAUDE_RC_STALE_MINUTES=abc\n",
  })
  assert.equal(legacy.r.status, 0, legacy.r.err)
  assert.ok(legacy.restarted)
})

test("claude-rc-maint/AC-2: 未登録の名前を指定すると、何も再起動せずに失敗する", () => {
  const e = makeEnv()
  const r = e.run(CTL, ["maintain", "nothing"])
  assert.equal(r.status, 1)
  assert.match(r.err, /未登録です: nothing/)
  assert.ok(!e.calls().some((c) => c.includes("restart")))
  // 廃止したサブコマンドは受け付けない
  assert.equal(e.run(CTL, ["archive", "--all"]).status, 1)
})

test("claude-rc-maint/AC-3: 本体が更新されたサーバーでも、実行中の子プロセスかリマインダーを持つセッションがあれば、警告が表示され再起動されない", async () => {
  const busy = await scenario([{ busy: true }, {}], { stale: true })
  assert.equal(busy.r.status, 0, busy.r.err)
  assert.ok(!busy.restarted)
  assert.match(busy.r.out, /判定=保持\(実行中\)/)
  assert.match(
    busy.r.err,
    /\[inst\] 警告: claude 本体が更新されているが、利用中のセッションがあるため再起動を見送る/,
  )
  const withTask = JSON.stringify({
    tasks: [{ id: "a", cron: "0 9 * * *", prompt: "x", createdAt: 1 }],
  })
  const kept = await scenario([{ reminder: withTask }], { stale: true })
  assert.ok(!kept.restarted)
  assert.match(kept.r.out, /判定=保持\(リマインダー\)/)
  const broken = await scenario([{ reminder: "{" }], { stale: true })
  assert.ok(!broken.restarted, "壊れた定義は保持側に倒す")
  const empty = await scenario([{ reminder: JSON.stringify({ tasks: [] }) }], {
    stale: true,
  })
  assert.ok(empty.restarted, "タスクが0件なら再起動される")
})

test("claude-rc-maint/AC-4: 停止中のインスタンスと、本体が更新されていないサーバーは、セッションの有無によらず再起動されない", async () => {
  for (const sessions of [[], [{ minutes: 90000 }]]) {
    const { r, restarted } = await scenario(sessions)
    assert.equal(r.status, 0, r.err)
    assert.ok(!restarted)
    assert.equal(r.out, "", "更新がなければ判定を表示しない")
  }
  const e = makeEnv()
  e.register("down", "/x")
  const srv = await makeServer(e, [], { stale: true })
  try {
    const r = e.run(CTL, ["maintain", "--all"], {
      STUB_INACTIVE: "down",
      STUB_PANE_PID_down: String(srv.pid),
    })
    assert.equal(r.status, 0, r.err)
    assert.ok(!e.calls().some((c) => c.includes("restart")))
  } finally {
    srv.stop()
  }
})

test("claude-rc-maint/AC-5: 固定した実行ファイルと元の場所の claude が異なるサーバーは再起動され、同じか元の場所が開けなければ再起動されない", async () => {
  const upd = await scenario([], { pin: "updated" })
  assert.equal(upd.r.status, 0, upd.r.err)
  assert.ok(upd.restarted)
  assert.match(upd.r.out, /\[inst\] 本体更新: サーバーを再起動する/)
  assert.ok((await scenario([{ minutes: 1 }], { pin: "updated" })).restarted)
  const same = await scenario([{ minutes: 1 }], { pin: "same" })
  assert.equal(same.r.status, 0, same.r.err)
  assert.ok(!same.restarted)
  assert.ok(!(await scenario([], { pin: "absent" })).restarted)
})

test("claude-rc-maint/AC-6: 固定した実行ファイルが削除されたサーバーは、警告され、実行中のセッションがなければ再起動され、あれば再起動されない", async () => {
  const none = await scenario([], { pin: "same", remove: true })
  assert.equal(none.r.status, 0, none.r.err)
  assert.ok(none.restarted)
  assert.match(
    none.r.err,
    /\[inst\] 警告: サーバーの実行ファイルが削除されている/,
  )
  assert.match(none.r.out, /\[inst\] 実行ファイル消失: サーバーを再起動する/)
  // リマインダーがあっても再起動する（待っても回復しない）
  const withTask = JSON.stringify({ tasks: [{ id: "a" }] })
  const idle = await scenario([{ reminder: withTask }], {
    pin: "same",
    remove: true,
  })
  assert.ok(idle.restarted)
  assert.match(idle.r.out, /判定=実行ファイル消失/)
  const busy = await scenario([{ busy: true }], { pin: "same", remove: true })
  assert.ok(!busy.restarted)
  assert.match(
    busy.r.err,
    /\[inst\] 警告: 実行中のセッションがあるため再起動を見送る/,
  )
})

test("claude-rc-maint/AC-8: 一括判定を指示すると、条件を満たす複数のインスタンスが再起動され、満たさないものは飛ばされる", async () => {
  const e = makeEnv()
  const names = ["aa", "bb", "cc", "dd", "ee"]
  const srvs = []
  const extra = { STUB_INACTIVE: "cc" }
  // aa・bb は本体更新、cc は停止中、dd は実行中、ee は更新なし
  const opt = {
    aa: [[{}], true],
    bb: [[], true],
    cc: [[{}], true],
    dd: [[{ busy: true }], true],
    ee: [[{}], false],
  }
  try {
    for (const n of names) {
      e.register(n, "/x")
      const [sessions, stale] = opt[n]
      const s = await makeServer(
        e,
        sessions.map((x) => ({ dir: makeProject(e, n), busy: x.busy })),
        { stale },
      )
      srvs.push(s)
      extra[`STUB_PANE_PID_${n}`] = String(s.pid)
    }
    const r = e.run(CTL, ["maintain", "--all"], extra)
    assert.equal(r.status, 0, r.err)
    assert.deepEqual(
      names.filter((n) => e.calls().includes(RESTART(n))),
      ["aa", "bb"],
    )
  } finally {
    srvs.forEach((s) => s.stop())
  }
})

const UNITS = ["claude-rc-maint.service", "claude-rc-maint.timer"]

test("claude-rc-maint/AC-9: インストーラを実行すると、定期実行のユニットが配置されて有効化され、旧名のユニットは無効化されて撤去される", () => {
  const e = makeEnv()
  const unitDir = join(e.home, ".config/systemd/user")
  // 旧名のユニットが残っている環境からの導入でも、旧ユニットは撤去される
  mkdirSync(join(unitDir, "timers.target.wants"), { recursive: true })
  const old = ["claude-rc-reap", "claude-rc-archive"]
  for (const o of old) {
    writeFileSync(join(unitDir, `${o}.service`), "old\n")
    writeFileSync(join(unitDir, `${o}.timer`), "old\n")
    writeFileSync(join(unitDir, "timers.target.wants", `${o}.timer`), "old\n")
  }
  const { res } = installFixture(e)
  assert.equal(res.status, 0, res.err)
  for (const u of UNITS)
    assert.equal(
      readFileSync(join(unitDir, u), "utf8"),
      readFileSync(join(ROOT, "src", u), "utf8"),
    )
  assert.ok(
    e.calls().includes("systemctl --user enable --now claude-rc-maint.timer"),
  )
  for (const o of old) {
    assert.ok(e.calls().includes(`systemctl --user disable --now ${o}.timer`))
    for (const f of [
      `${o}.service`,
      `${o}.timer`,
      `timers.target.wants/${o}.timer`,
    ])
      assert.ok(!existsSync(join(unitDir, f)), f)
  }
  assert.match(
    readFileSync(join(unitDir, "claude-rc-maint.timer"), "utf8"),
    /OnUnitActiveSec=10min/,
  )
  assert.match(
    readFileSync(join(unitDir, "claude-rc-maint.service"), "utf8"),
    /ExecStart=%h\/\.local\/bin\/claude-rc-ctl maintain --all/,
  )
})

test("claude-rc-maint/AC-10: 削除を指示すると、定期実行のユニットが無効化されて撤去される", () => {
  const e = makeEnv()
  const { res } = installFixture(e)
  assert.equal(res.status, 0, res.err)
  // 導入先のコマンドで実行する（リポジトリ内のコマンドは取得先として自身を削除してしまう）
  const ctl = join(e.home, ".local", "bin", "claude-rc-ctl")
  const r = e.run(ctl, ["self", "uninstall"])
  assert.equal(r.status, 0, r.err)
  assert.ok(
    e.calls().includes("systemctl --user disable --now claude-rc-maint.timer"),
  )
  const unitDir = join(e.home, ".config/systemd/user")
  for (const u of UNITS) assert.ok(!existsSync(join(unitDir, u)))
})

test("claude-rc-maint/AC-11: 確認のみを指定すると、対象と理由が表示され、サーバーは再起動されない", async () => {
  const upd = await scenario([{}], {
    stale: true,
    args: ["maintain", "--dry-run", "inst"],
  })
  assert.equal(upd.r.status, 0, upd.r.err)
  assert.ok(!upd.restarted)
  assert.match(upd.r.out, /判定=本体更新/)
  assert.match(
    upd.r.out,
    /\[inst\] 対象: claude 本体が更新されたためサーバーを再起動する/,
  )
  const gone = await scenario([], {
    pin: "same",
    remove: true,
    args: ["maintain", "--dry-run", "inst"],
  })
  assert.ok(!gone.restarted)
  assert.match(
    gone.r.out,
    /\[inst\] 対象: 実行ファイルが削除されたためサーバーを再起動する/,
  )
})

test("claude-rc-maint/AC-16: 登録済みインスタンスが10件のとき、一括判定が5秒以内に終わる", () => {
  const e = makeEnv()
  for (let i = 0; i < 10; i++) e.register(`n${i}`, "/x")
  const r = e.run(CTL, ["maintain", "--all"])
  assert.equal(r.status, 0, r.err)
  assert.ok(r.ms < 5000, `${r.ms}ms`)
})

const FAILED =
  "[08:26:18] Session failed: spawn error: ENOENT: no such file or directory, posix_spawn '/x/claude.exe' cse_01"

test("claude-rc-maint/AC-12: サーバーの画面出力にセッションの起動失敗の記録があると、警告と対処が表示され、サーバーは再起動されない", async () => {
  const e = makeEnv()
  e.register("inst", "/x")
  const srv = await makeServer(e, [])
  try {
    const r = e.run(CTL, ["maintain", "inst"], {
      STUB_PANE_PID_inst: String(srv.pid),
      STUB_PANE_inst: `Connected\n${FAILED}\nCapacity: 0/32`,
    })
    assert.equal(r.status, 0, r.err)
    assert.match(
      r.err,
      /\[inst\] 警告: セッションの起動に失敗した記録が 1 件ある（最新: \[08:26:18\] Session failed: spawn error: ENOENT/,
    )
    assert.match(r.err, /\[inst\] 対処: .*メッセージを送り直す/)
    assert.ok(!e.calls().includes(RESTART("inst")))
    // 記録がなければ警告しない
    const e2 = makeEnv()
    e2.register("inst", "/x")
    const quiet = e2.run(CTL, ["maintain", "inst"], {
      STUB_PANE_PID_inst: String(srv.pid),
    })
    assert.equal(quiet.err, "")
  } finally {
    srv.stop()
  }
})

test("claude-rc-maint/AC-13: 警告済みの起動失敗は次回の判定で繰り返し警告されず、新しい失敗とサーバーの再起動後の失敗は警告される", async () => {
  const e = makeEnv()
  e.register("inst", "/x")
  const srv = await makeServer(e, [])
  const srv2 = await makeServer(e, [])
  const run = (pane, pid = srv.pid, args = ["maintain", "inst"]) =>
    e.run(CTL, args, {
      STUB_PANE_PID_inst: String(pid),
      STUB_PANE_inst: pane,
    })
  try {
    // 確認のみでは記録しないので、次の判定でも警告される
    assert.match(
      run(FAILED, srv.pid, ["maintain", "--dry-run", "inst"]).err,
      /1 件ある/,
    )
    assert.match(run(FAILED).err, /1 件ある/)
    assert.equal(run(FAILED).err, "")
    assert.match(run(`${FAILED}\n${FAILED}`).err, /1 件ある/)
    assert.equal(run(`${FAILED}\n${FAILED}`).err, "")
    // サーバーが再起動されてプロセスが替わると、件数を数え直す
    assert.match(run(FAILED, srv2.pid).err, /1 件ある/)
    // 登録解除で記録が消える
    e.run(CTL, ["remove", "inst"])
    assert.ok(!existsSync(join(e.home, ".local/state/claude-rc/inst.failed")))
  } finally {
    srv.stop()
    srv2.stop()
  }
})

/** 認証失敗の記録（セッションの記録ファイル）を置く */
function putTranscript(e, dir, sid, records) {
  const enc = dir.replace(/[^A-Za-z0-9]/g, "-")
  const base = join(e.home, ".claude/projects", enc)
  mkdirSync(base, { recursive: true })
  const file = join(base, `${sid}.jsonl`)
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n")
  return file
}
const AUTH_FAIL = (uuid) => ({
  type: "assistant",
  uuid,
  timestamp: "2026-11-13T10:19:15.173Z",
  isApiErrorMessage: true,
  message: {
    role: "assistant",
    content: [
      {
        type: "text",
        text: "Failed to authenticate. API Error: 403 Attention Required! | Cloudflare",
      },
    ],
  },
})
const OK = {
  type: "assistant",
  uuid: "ok",
  message: { role: "assistant", content: [{ type: "text", text: "done" }] },
}

test("claude-rc-maint/AC-14: セッションの記録の最後が認証失敗だと、警告と対処が表示され、サーバーは再起動されない。回復したセッションや、サーバーの起動前の記録、別のディレクトリの記録は警告されない", async () => {
  const e = makeEnv()
  e.register("inst", "/x")
  const srv = await makeServer(e, [])
  const run = () =>
    e.run(CTL, ["maintain", "inst"], { STUB_PANE_PID_inst: String(srv.pid) })
  try {
    // 回復済み（最後が通常の応答）、別のディレクトリ、サーバーの起動前の記録は警告されない
    putTranscript(e, "/x", "s-ok", [AUTH_FAIL("u0"), OK])
    putTranscript(e, "/y", "s-other", [AUTH_FAIL("u1")])
    const old = putTranscript(e, "/x", "s-old", [AUTH_FAIL("u2")])
    utimesSync(old, 1, 1)
    assert.equal(run().err, "")
    // 認証失敗で止まったセッションは警告される
    putTranscript(e, "/x", "s-stuck", [OK, AUTH_FAIL("u3")])
    const r = run()
    assert.equal(r.status, 0, r.err)
    assert.match(
      r.err,
      /\[inst\] 警告: 認証に失敗して止まったセッションの記録が 1 件ある（最新: 2026-11-13T10:19:15.173Z s-stuck Failed to authenticate\. API Error: 403/,
    )
    assert.match(
      r.err,
      /\[inst\] 対処: .*メッセージを送り直す.*claude auth status/,
    )
    assert.ok(!e.calls().includes(RESTART("inst")))
  } finally {
    srv.stop()
  }
})

test("claude-rc-maint/AC-15: 警告済みの認証失敗は次回の判定で繰り返し警告されず、新しい失敗は警告され、確認のみでは記録されない", async () => {
  const e = makeEnv()
  e.register("inst", "/x")
  const srv = await makeServer(e, [])
  const run = (args = ["maintain", "inst"]) =>
    e.run(CTL, args, { STUB_PANE_PID_inst: String(srv.pid) })
  try {
    putTranscript(e, "/x", "s1", [AUTH_FAIL("u1")])
    assert.match(run(["maintain", "--dry-run", "inst"]).err, /1 件ある/)
    assert.match(run().err, /1 件ある/)
    assert.equal(run().err, "")
    // 別のセッションの新しい失敗だけが警告される
    putTranscript(e, "/x", "s2", [AUTH_FAIL("u2")])
    assert.match(run().err, /1 件ある（最新: .* s2 /)
    assert.equal(run().err, "")
    // 回復したあとに同じセッションが再び失敗すると、新しい記録として警告される
    putTranscript(e, "/x", "s2", [AUTH_FAIL("u2"), OK])
    assert.equal(run().err, "")
    putTranscript(e, "/x", "s2", [AUTH_FAIL("u2"), OK, AUTH_FAIL("u4")])
    assert.match(run().err, /1 件ある/)
    // 登録解除で記録が消える
    e.run(CTL, ["remove", "inst"])
    assert.ok(!existsSync(join(e.home, ".local/state/claude-rc/inst.authfail")))
  } finally {
    srv.stop()
  }
})

test("claude-rc-maint/AC-7: 一括判定で使われていない古い版は削除され、使われている版と作られたばかりの版は残り、確認のみでは削除されない", async () => {
  const e = makeEnv()
  const root = versionsOf(e)
  const old = new Date(Date.now() - 3_600_000)
  for (const v of ["old", "fresh", ".tmp-1"]) {
    mkdirSync(join(root, v), { recursive: true })
    writeFileSync(join(root, v, "claude"), "x")
  }
  utimesSync(join(root, "old"), old, old)
  utimesSync(join(root, ".tmp-1"), old, old)
  // 使われている版（古くても残す）
  const srv = await makeServer(e, [], { exe: join(root, "used", "claude") })
  utimesSync(join(root, "used"), old, old)
  try {
    const dry = e.run(CTL, ["maintain", "--dry-run", "--all"])
    assert.equal(dry.status, 0, dry.err)
    assert.match(dry.out, /\[版\] 対象: 使われていない版 old を削除する/)
    assert.ok(existsSync(join(root, "old")))
    const r = e.run(CTL, ["maintain", "--all"])
    assert.equal(r.status, 0, r.err)
    assert.match(r.out, /\[版\] 削除: old/)
    assert.ok(!existsSync(join(root, "old")))
    assert.ok(!existsSync(join(root, ".tmp-1")))
    assert.ok(existsSync(join(root, "used", "claude")))
    assert.ok(existsSync(join(root, "fresh")))
    // 名前を指定した判定では削除しない
    utimesSync(join(root, "fresh"), old, old)
    e.register("inst", "/x")
    assert.equal(e.run(CTL, ["maintain", "inst"]).status, 0)
    assert.ok(existsSync(join(root, "fresh")))
  } finally {
    srv.stop()
  }
})

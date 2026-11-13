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
function makeProject(e, name, minutes, { reminder } = {}) {
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

/** 1インスタンスに対して archive を実行し、再起動されたかを返す */
async function scenario(
  sessions,
  { idle, grace, stale, pin, remove, args = ["archive", "inst"] } = {},
) {
  const e = makeEnv()
  e.register("inst", "/x")
  if (idle !== undefined || grace !== undefined)
    writeFileSync(
      join(e.confDir, "inst.env"),
      "CLAUDE_RC_DIR=/x\n" +
        (idle !== undefined ? `CLAUDE_RC_ARCHIVE_MINUTES=${idle}\n` : "") +
        (grace !== undefined ? `CLAUDE_RC_STALE_MINUTES=${grace}\n` : ""),
    )
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

test("claude-rc-archive/AC-1: 全セッションが閾値を超えて更新されていないとき、サーバーが再起動される", async () => {
  const { r, restarted } = await scenario([
    { minutes: 20000 },
    { minutes: 15000 },
  ])
  assert.equal(r.status, 0, r.err)
  assert.ok(restarted)
  assert.match(r.out, /\[inst\] セッション=- アイドル=20000分 判定=アーカイブ/)
  assert.match(r.out, /\[inst\] アーカイブ: サーバーを再起動する/)
})

test("claude-rc-archive/AC-2: 未登録の名前を指定すると、何も再起動せずに失敗する", () => {
  const e = makeEnv()
  const r = e.run(CTL, ["archive", "nothing"])
  assert.equal(r.status, 1)
  assert.match(r.err, /未登録です: nothing/)
  assert.ok(!e.calls().some((c) => c.includes("restart")))
})

test("claude-rc-archive/AC-3: 閾値内に更新のあるセッションが1つでもあれば、サーバーは再起動されない", async () => {
  const { r, restarted } = await scenario([{ minutes: 5 }, { minutes: 20000 }])
  assert.equal(r.status, 0, r.err)
  assert.ok(!restarted)
  assert.match(r.out, /判定=保持\(アイドル不足\)/)
})

test("claude-rc-archive/AC-4: 更新が古くても、実行中の子プロセスを持つセッションがあれば、サーバーは再起動されない", async () => {
  const { r, restarted } = await scenario([
    { minutes: 20000, busy: true },
    { minutes: 20000 },
  ])
  assert.ok(!restarted)
  assert.match(r.out, /判定=保持\(実行中\)/)
})

test("claude-rc-archive/AC-5: 更新が古くても、作業ディレクトリにリマインダーが1件以上あれば、サーバーは再起動されない", async () => {
  const withTask = JSON.stringify({
    tasks: [{ id: "a", cron: "0 9 * * *", prompt: "x", createdAt: 1 }],
  })
  const kept = await scenario([{ minutes: 20000, reminder: withTask }])
  assert.ok(!kept.restarted)
  assert.match(kept.r.out, /判定=保持\(リマインダー\)/)
  const broken = await scenario([{ minutes: 20000, reminder: "{" }])
  assert.ok(!broken.restarted, "壊れた定義は保持側に倒す")
  const empty = await scenario([
    { minutes: 20000, reminder: JSON.stringify({ tasks: [] }) },
  ])
  assert.ok(empty.restarted, "タスクが0件なら再起動される")
})

test("claude-rc-archive/AC-6: 閾値が未指定のとき、10079分前の更新は残り、10081分前の更新は再起動される", async () => {
  assert.ok(!(await scenario([{ minutes: 10079 }])).restarted)
  assert.ok((await scenario([{ minutes: 10081 }])).restarted)
})

test("claude-rc-archive/AC-7: 閾値を指定すると、その分数で判定される", async () => {
  assert.ok(!(await scenario([{ minutes: 5 }], { idle: 10 })).restarted)
  assert.ok((await scenario([{ minutes: 20 }], { idle: 10 })).restarted)
})

test("claude-rc-archive/AC-8: 閾値が0のとき、古いセッションがあっても再起動されない", async () => {
  const { r, restarted } = await scenario([{ minutes: 90000 }], { idle: 0 })
  assert.equal(r.status, 0, r.err)
  assert.ok(!restarted)
})

test("claude-rc-archive/AC-9: 停止中のインスタンスと、セッションがないインスタンスは、再起動されない", async () => {
  const e = makeEnv()
  e.register("down", "/x")
  e.register("empty", "/x")
  const srv = await makeServer(e, [])
  try {
    const r = e.run(CTL, ["archive", "--all"], {
      STUB_INACTIVE: "down",
      STUB_PANE_PID_down: String(srv.pid),
      STUB_PANE_PID_empty: String(srv.pid),
    })
    assert.equal(r.status, 0, r.err)
    assert.ok(!e.calls().some((c) => c.includes("restart")))
  } finally {
    srv.stop()
  }
})

test("claude-rc-archive/AC-10: 一括判定を指示すると、条件を満たす複数のインスタンスが再起動され、満たさないものは飛ばされる", async () => {
  const e = makeEnv()
  const names = ["aa", "bb", "cc", "dd"]
  const srvs = []
  const extra = { STUB_INACTIVE: "cc" }
  const minutes = { aa: 20000, bb: 20000, cc: 20000, dd: 5 }
  try {
    for (const n of names) {
      e.register(n, "/x")
      const s = await makeServer(e, [{ dir: makeProject(e, n, minutes[n]) }])
      srvs.push(s)
      extra[`STUB_PANE_PID_${n}`] = String(s.pid)
    }
    const r = e.run(CTL, ["archive", "--all"], extra)
    assert.equal(r.status, 0, r.err)
    assert.deepEqual(
      names.filter((n) => e.calls().includes(RESTART(n))),
      ["aa", "bb"],
    )
  } finally {
    srvs.forEach((s) => s.stop())
  }
})

const UNITS = ["claude-rc-archive.service", "claude-rc-archive.timer"]

test("claude-rc-archive/AC-11: インストーラを実行すると、定期実行のユニットが配置されて有効化される", () => {
  const e = makeEnv()
  const unitDir = join(e.home, ".config/systemd/user")
  // 旧名のユニットが残っている環境からの導入でも、旧ユニットは撤去される
  mkdirSync(unitDir, { recursive: true })
  for (const u of ["claude-rc-reap.service", "claude-rc-reap.timer"])
    writeFileSync(join(unitDir, u), "old\n")
  const { res } = installFixture(e)
  assert.equal(res.status, 0, res.err)
  for (const u of UNITS)
    assert.equal(
      readFileSync(join(unitDir, u), "utf8"),
      readFileSync(join(ROOT, "src", u), "utf8"),
    )
  assert.ok(
    e.calls().includes("systemctl --user enable --now claude-rc-archive.timer"),
  )
  assert.ok(
    e.calls().includes("systemctl --user disable --now claude-rc-reap.timer"),
  )
  assert.ok(!existsSync(join(unitDir, "claude-rc-reap.timer")))
  assert.match(
    readFileSync(join(unitDir, "claude-rc-archive.timer"), "utf8"),
    /OnUnitActiveSec=10min/,
  )
  assert.match(
    readFileSync(join(unitDir, "claude-rc-archive.service"), "utf8"),
    /ExecStart=%h\/\.local\/bin\/claude-rc-ctl archive --all/,
  )
})

test("claude-rc-archive/AC-12: 削除を指示すると、定期実行のユニットが無効化されて撤去される", () => {
  const e = makeEnv()
  const { res } = installFixture(e)
  assert.equal(res.status, 0, res.err)
  // 導入先のコマンドで実行する（リポジトリ内のコマンドは取得先として自身を削除してしまう）
  const ctl = join(e.home, ".local", "bin", "claude-rc-ctl")
  const r = e.run(ctl, ["self", "uninstall"])
  assert.equal(r.status, 0, r.err)
  assert.ok(
    e
      .calls()
      .includes("systemctl --user disable --now claude-rc-archive.timer"),
  )
  const unitDir = join(e.home, ".config/systemd/user")
  for (const u of UNITS) assert.ok(!existsSync(join(unitDir, u)))
})

test("claude-rc-archive/AC-13: 確認のみを指定すると、対象と理由が表示され、サーバーは再起動されない", async () => {
  const { r, restarted } = await scenario([{ minutes: 20000 }], {
    args: ["archive", "--dry-run", "inst"],
  })
  assert.equal(r.status, 0, r.err)
  assert.match(r.out, /判定=アーカイブ/)
  assert.match(r.out, /\[inst\] 対象: サーバーを再起動して/)
  assert.ok(!restarted)
})

test("claude-rc-archive/AC-15: 登録済みインスタンスが10件のとき、一括判定が5秒以内に終わる", () => {
  const e = makeEnv()
  for (let i = 0; i < 10; i++) e.register(`n${i}`, "/x")
  const r = e.run(CTL, ["archive", "--all"])
  assert.equal(r.status, 0, r.err)
  assert.ok(r.ms < 5000, `${r.ms}ms`)
})

test("claude-rc-archive/AC-16: 本体が更新されたサーバーにセッションがないとき、サーバーが再起動される", async () => {
  const { r, restarted } = await scenario([], { stale: true })
  assert.equal(r.status, 0, r.err)
  assert.ok(restarted)
  assert.match(r.out, /\[inst\] 本体更新: サーバーを再起動する/)
  // アーカイブの閾値が 0 でも、本体の更新による再起動は行う
  assert.ok((await scenario([], { stale: true, idle: 0 })).restarted)
})

test("claude-rc-archive/AC-17: 本体が更新されたサーバーで、全セッションの更新が猶予時間より古いとき、アーカイブの閾値に届いていなくてもサーバーが再起動される", async () => {
  const { r, restarted } = await scenario([{ minutes: 31 }, { minutes: 90 }], {
    stale: true,
    grace: 30,
  })
  assert.equal(r.status, 0, r.err)
  assert.ok(restarted)
  assert.match(r.out, /\[inst\] セッション=- アイドル=31分 判定=本体更新/)
  // 本体が更新されていなければ、同じセッションでも再起動されない
  assert.ok(!(await scenario([{ minutes: 31 }, { minutes: 90 }])).restarted)
})

test("claude-rc-archive/AC-18: 本体が更新されたサーバーでも、猶予時間内の更新・実行中・リマインダーのセッションがあれば、再起動されない", async () => {
  const recent = await scenario([{ minutes: 90 }, { minutes: 5 }], {
    stale: true,
    grace: 30,
  })
  assert.ok(!recent.restarted)
  assert.match(recent.r.err, /\[inst\] 警告: claude 本体が更新されているが/)
  assert.ok(
    !(await scenario([{ minutes: 90, busy: true }], { stale: true, grace: 30 }))
      .restarted,
  )
  assert.ok(
    !(
      await scenario([{ minutes: 90, reminder: '{"tasks":[{"id":"a"}]}' }], {
        stale: true,
        grace: 30,
      })
    ).restarted,
  )
})

test("claude-rc-archive/AC-19: 本体が更新されていないサーバーにセッションがないとき、サーバーは再起動されない", async () => {
  const { r, restarted } = await scenario([])
  assert.equal(r.status, 0, r.err)
  assert.ok(!restarted)
})

test("claude-rc-archive/AC-20: 猶予時間を指定するとその分数で判定され、0 のときは本体が更新されていても再起動されない", async () => {
  assert.ok(
    !(await scenario([{ minutes: 31 }], { stale: true, grace: 60 })).restarted,
  )
  assert.ok(
    (await scenario([{ minutes: 61 }], { stale: true, grace: 60 })).restarted,
  )
  assert.ok(!(await scenario([], { stale: true, grace: 0 })).restarted)
  assert.ok(
    !(await scenario([{ minutes: 90 }], { stale: true, grace: 0 })).restarted,
  )
  const bad = await scenario([], { stale: true, grace: "abc" })
  assert.equal(bad.r.status, 1)
  assert.match(bad.r.err, /CLAUDE_RC_STALE_MINUTES は整数で指定してください/)
})

test("claude-rc-archive/AC-21: 確認のみを指定すると、本体の更新が理由であることが表示され、サーバーは再起動されない", async () => {
  const { r, restarted } = await scenario([{ minutes: 90 }], {
    stale: true,
    grace: 30,
    args: ["archive", "--dry-run", "inst"],
  })
  assert.equal(r.status, 0, r.err)
  assert.ok(!restarted)
  assert.match(
    r.out,
    /\[inst\] 対象: claude 本体が更新されたためサーバーを再起動する/,
  )
})

test("claude-rc-archive/AC-22: 猶予時間が未指定のとき、本体が更新されたサーバーでも、10079分前の更新は残り、10081分前の更新は再起動される", async () => {
  // アーカイブの閾値を無効にして、猶予時間の既定だけで判定させる
  const kept = await scenario([{ minutes: 10079 }], { stale: true, idle: 0 })
  assert.equal(kept.r.status, 0, kept.r.err)
  assert.ok(!kept.restarted)
  assert.match(kept.r.err, /\[inst\] 警告: claude 本体が更新されているが/)
  const gone = await scenario([{ minutes: 10081 }], { stale: true, idle: 0 })
  assert.ok(gone.restarted)
  assert.match(gone.r.out, /アイドル=10081分 判定=本体更新/)
  // 閾値も未指定なら、30分を超えた程度のセッションは残る
  assert.ok(!(await scenario([{ minutes: 90 }], { stale: true })).restarted)
})

const FAILED =
  "[08:26:18] Session failed: spawn error: ENOENT: no such file or directory, posix_spawn '/x/claude.exe' cse_01"

test("claude-rc-archive/AC-23: サーバーの画面出力にセッションの起動失敗の記録があると、警告と対処が表示され、サーバーは再起動されない", async () => {
  const e = makeEnv()
  e.register("inst", "/x")
  const srv = await makeServer(e, [])
  try {
    const r = e.run(CTL, ["archive", "inst"], {
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
    const quiet = e2.run(CTL, ["archive", "inst"], {
      STUB_PANE_PID_inst: String(srv.pid),
    })
    assert.equal(quiet.err, "")
  } finally {
    srv.stop()
  }
})

test("claude-rc-archive/AC-24: 警告済みの起動失敗は次回の判定で繰り返し警告されず、新しい失敗とサーバーの再起動後の失敗は警告される", async () => {
  const e = makeEnv()
  e.register("inst", "/x")
  const srv = await makeServer(e, [])
  const srv2 = await makeServer(e, [])
  const run = (pane, pid = srv.pid, args = ["archive", "inst"]) =>
    e.run(CTL, args, {
      STUB_PANE_PID_inst: String(pid),
      STUB_PANE_inst: pane,
    })
  try {
    // 確認のみでは記録しないので、次の判定でも警告される
    assert.match(
      run(FAILED, srv.pid, ["archive", "--dry-run", "inst"]).err,
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

test("claude-rc-archive/AC-25: セッションの記録の最後が認証失敗だと、警告と対処が表示され、サーバーは再起動されない。回復したセッションや、サーバーの起動前の記録、別のディレクトリの記録は警告されない", async () => {
  const e = makeEnv()
  e.register("inst", "/x")
  const srv = await makeServer(e, [])
  const run = () =>
    e.run(CTL, ["archive", "inst"], { STUB_PANE_PID_inst: String(srv.pid) })
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

test("claude-rc-archive/AC-26: 警告済みの認証失敗は次回の判定で繰り返し警告されず、新しい失敗は警告され、確認のみでは記録されない", async () => {
  const e = makeEnv()
  e.register("inst", "/x")
  const srv = await makeServer(e, [])
  const run = (args = ["archive", "inst"]) =>
    e.run(CTL, args, { STUB_PANE_PID_inst: String(srv.pid) })
  try {
    putTranscript(e, "/x", "s1", [AUTH_FAIL("u1")])
    assert.match(run(["archive", "--dry-run", "inst"]).err, /1 件ある/)
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

test("claude-rc-archive/AC-27: 固定した実行ファイルと元の場所の claude が異なるサーバーはセッションがなければ再起動され、同じなら再起動されない", async () => {
  const upd = await scenario([], { pin: "updated" })
  assert.equal(upd.r.status, 0, upd.r.err)
  assert.ok(upd.restarted)
  assert.match(upd.r.out, /\[inst\] 本体更新: サーバーを再起動する/)
  // 猶予時間の条件はこれまでと同じ（猶予時間内のセッションがあれば見送る）
  const kept = await scenario([{ minutes: 5 }], { pin: "updated", grace: 30 })
  assert.ok(!kept.restarted)
  assert.match(kept.r.err, /\[inst\] 警告: claude 本体が更新されているが/)
  assert.ok(
    (await scenario([{ minutes: 31 }], { pin: "updated", grace: 30 }))
      .restarted,
  )
  // 元の場所が同じファイルのまま、または開けない（更新の途中）なら再起動しない
  const same = await scenario([], { pin: "same" })
  assert.equal(same.r.status, 0, same.r.err)
  assert.ok(!same.restarted)
  assert.ok(!(await scenario([], { pin: "absent" })).restarted)
  // 猶予時間が 0 なら、本体が更新されていても再起動しない
  assert.ok(!(await scenario([], { pin: "updated", grace: 0 })).restarted)
})

test("claude-rc-archive/AC-28: 固定した実行ファイルが削除されたサーバーは、警告され、実行中のセッションがなければ再起動され、あれば再起動されない", async () => {
  const none = await scenario([], { pin: "same", remove: true })
  assert.equal(none.r.status, 0, none.r.err)
  assert.ok(none.restarted)
  assert.match(
    none.r.err,
    /\[inst\] 警告: サーバーの実行ファイルが削除されている/,
  )
  assert.match(none.r.out, /\[inst\] 実行ファイル消失: サーバーを再起動する/)
  // 閾値・猶予時間を待たない（0 でも判定する）
  const idle = await scenario([{ minutes: 1 }], {
    pin: "same",
    remove: true,
    idle: 0,
    grace: 0,
  })
  assert.ok(idle.restarted)
  assert.match(idle.r.out, /判定=実行ファイル消失/)
  const busy = await scenario([{ minutes: 1, busy: true }], {
    pin: "same",
    remove: true,
  })
  assert.ok(!busy.restarted)
  assert.match(
    busy.r.err,
    /\[inst\] 警告: 実行中のセッションがあるため再起動を見送る/,
  )
  const dry = await scenario([], {
    pin: "same",
    remove: true,
    args: ["archive", "--dry-run", "inst"],
  })
  assert.ok(!dry.restarted)
  assert.match(
    dry.r.out,
    /\[inst\] 対象: 実行ファイルが削除されたためサーバーを再起動する/,
  )
})

test("claude-rc-archive/AC-29: 一括判定で使われていない古い版は削除され、使われている版と作られたばかりの版は残り、確認のみでは削除されない", async () => {
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
    const dry = e.run(CTL, ["archive", "--dry-run", "--all"])
    assert.equal(dry.status, 0, dry.err)
    assert.match(dry.out, /\[版\] 対象: 使われていない版 old を削除する/)
    assert.ok(existsSync(join(root, "old")))
    const r = e.run(CTL, ["archive", "--all"])
    assert.equal(r.status, 0, r.err)
    assert.match(r.out, /\[版\] 削除: old/)
    assert.ok(!existsSync(join(root, "old")))
    assert.ok(!existsSync(join(root, ".tmp-1")))
    assert.ok(existsSync(join(root, "used", "claude")))
    assert.ok(existsSync(join(root, "fresh")))
    // 名前を指定した判定では削除しない
    utimesSync(join(root, "fresh"), old, old)
    e.register("inst", "/x")
    assert.equal(e.run(CTL, ["archive", "inst"]).status, 0)
    assert.ok(existsSync(join(root, "fresh")))
  } finally {
    srv.stop()
  }
})

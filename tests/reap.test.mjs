import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
 * 擬似サーバー（sh。子を失っても終了しないよう、起動直後の番兵の子を1つ持つ）と、指定ディレクトリを cwd とする子プロセス（セッション）を起動する。
 * busy が真の子は、実行中状態の孫プロセスを持つ。
 */
async function makeServer(e, sessions) {
  const files = sessions.map((_, i) => join(e.home, `pid${i}-${Date.now()}`))
  const body = sessions
    .map(({ dir, busy }, i) => {
      const tail = busy
        ? `sh -c "while :; do :; done" & wait`
        : "exec sleep 300"
      return `(cd '${dir}' && exec sh -c 'echo $$ > ${files[i]}; ${tail}') &`
    })
    .join("\n")
  const server = spawn("sh", ["-c", `${body}\nsleep 300 &\nwait`], {
    detached: true,
    stdio: "ignore",
  })
  for (let n = 0; n < 100 && !files.every((f) => existsSync(f)); n++)
    await sleep(50)
  await sleep(100)
  const pids = files.map((f) => Number(readFileSync(f, "utf8").trim()))
  const stop = () => {
    try {
      process.kill(-server.pid, "SIGKILL")
    } catch {}
  }
  return { pid: server.pid, pids, stop }
}

/** プロジェクトディレクトリと、更新時刻を minutes 分前にした transcript を作る */
function makeProject(e, name, minutes) {
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
  return dir
}

/** 1インスタンスに対して reap を実行し、各セッションが終了したかを返す */
async function scenario(sessions, { idle, args = ["reap", "inst"] } = {}) {
  const e = makeEnv()
  e.register("inst", "/x")
  if (idle !== undefined)
    writeFileSync(
      join(e.confDir, "inst.env"),
      `CLAUDE_RC_DIR=/x\nCLAUDE_RC_IDLE_MINUTES=${idle}\n`,
    )
  const dirs = sessions.map((s) => makeProject(e, "s", s.minutes))
  const srv = await makeServer(
    e,
    sessions.map((s, i) => ({ dir: dirs[i], busy: s.busy })),
  )
  try {
    const r = e.run(CTL, args, { STUB_PANE_PID_inst: String(srv.pid) })
    await sleep(300)
    return { e, r, srv, killed: srv.pids.map((p) => !alive(p)) }
  } finally {
    srv.stop()
  }
}

test("claude-rc-reap/AC-1: 閾値を超えて更新のないセッションが終了し、サーバー本体は終了せずに残る", async () => {
  const e = makeEnv()
  e.register("inst", "/x")
  const srv = await makeServer(e, [{ dir: makeProject(e, "a", 120) }])
  try {
    const r = e.run(CTL, ["reap", "inst"], {
      STUB_PANE_PID_inst: String(srv.pid),
    })
    assert.equal(r.status, 0, r.err)
    await sleep(300)
    assert.ok(!alive(srv.pids[0]), "セッションが残っている")
    assert.ok(alive(srv.pid), "サーバーが終了した")
    assert.match(
      r.out,
      /\[inst\] 回収: pid=\d+ セッション=- アイドル=1[0-9][0-9]分/,
    )
  } finally {
    srv.stop()
  }
})

test("claude-rc-reap/AC-2: 未登録の名前を指定すると、何も終了せずに失敗する", () => {
  const e = makeEnv()
  const r = e.run(CTL, ["reap", "nothing"])
  assert.equal(r.status, 1)
  assert.match(r.err, /未登録です: nothing/)
})

test("claude-rc-reap/AC-3: 閾値内に更新のあるセッションは終了しない", async () => {
  const { killed } = await scenario([{ minutes: 5 }])
  assert.deepEqual(killed, [false])
})

test("claude-rc-reap/AC-4: 更新が古くても、実行中の子プロセスを持つセッションは終了しない", async () => {
  const { killed } = await scenario([
    { minutes: 500, busy: true },
    { minutes: 500 },
  ])
  assert.deepEqual(killed, [false, true])
})

test("claude-rc-reap/AC-5: 閾値が未指定のとき、59分前の更新は残り、61分前の更新は終了する", async () => {
  const { killed } = await scenario([{ minutes: 59 }, { minutes: 61 }])
  assert.deepEqual(killed, [false, true])
})

test("claude-rc-reap/AC-6: 閾値を指定すると、その分数で判定される", async () => {
  const { killed } = await scenario([{ minutes: 5 }, { minutes: 20 }], {
    idle: 10,
  })
  assert.deepEqual(killed, [false, true])
})

test("claude-rc-reap/AC-7: 閾値が0のとき、古いセッションも終了しない", async () => {
  const { killed, r } = await scenario([{ minutes: 5000 }], { idle: 0 })
  assert.equal(r.status, 0, r.err)
  assert.deepEqual(killed, [false])
})

test("claude-rc-reap/AC-8: 一括回収を指示すると、複数のインスタンスが回収され、停止中のインスタンスは飛ばされる", async () => {
  const e = makeEnv()
  const names = ["aa", "bb", "cc"]
  const srvs = []
  const extra = { STUB_INACTIVE: "cc" }
  try {
    for (const n of names) {
      e.register(n, "/x")
      const s = await makeServer(e, [{ dir: makeProject(e, n, 300) }])
      srvs.push(s)
      extra[`STUB_PANE_PID_${n}`] = String(s.pid)
    }
    const r = e.run(CTL, ["reap", "--all"], extra)
    assert.equal(r.status, 0, r.err)
    await sleep(300)
    assert.deepEqual(
      srvs.map((s) => !alive(s.pids[0])),
      [true, true, false],
    )
  } finally {
    srvs.forEach((s) => s.stop())
  }
})

test("claude-rc-reap/AC-9: インストーラを実行すると、定期実行のユニットが配置されて有効化される", () => {
  const e = makeEnv()
  const { res } = installFixture(e)
  assert.equal(res.status, 0, res.err)
  const unitDir = join(e.home, ".config/systemd/user")
  for (const u of ["claude-rc-reap.service", "claude-rc-reap.timer"])
    assert.equal(
      readFileSync(join(unitDir, u), "utf8"),
      readFileSync(join(ROOT, "src", u), "utf8"),
    )
  assert.ok(
    e.calls().includes("systemctl --user enable --now claude-rc-reap.timer"),
  )
  assert.match(
    readFileSync(join(unitDir, "claude-rc-reap.timer"), "utf8"),
    /OnUnitActiveSec=10min/,
  )
  assert.match(
    readFileSync(join(unitDir, "claude-rc-reap.service"), "utf8"),
    /ExecStart=%h\/\.local\/bin\/claude-rc-ctl reap --all/,
  )
})

test("claude-rc-reap/AC-10: 削除を指示すると、定期実行のユニットが無効化されて撤去される", () => {
  const e = makeEnv()
  const { res } = installFixture(e)
  assert.equal(res.status, 0, res.err)
  // 導入先のコマンドで実行する（リポジトリ内のコマンドは取得先として自身を削除してしまう）
  const ctl = join(e.home, ".local", "bin", "claude-rc-ctl")
  const r = e.run(ctl, ["self", "uninstall"])
  assert.equal(r.status, 0, r.err)
  assert.ok(
    e.calls().includes("systemctl --user disable --now claude-rc-reap.timer"),
  )
  const unitDir = join(e.home, ".config/systemd/user")
  for (const u of ["claude-rc-reap.service", "claude-rc-reap.timer"])
    assert.ok(!existsSync(join(unitDir, u)))
})

test("claude-rc-reap/AC-11: 確認のみを指定すると、対象が表示され、どのセッションも終了しない", async () => {
  const { r, killed } = await scenario([{ minutes: 500 }], {
    args: ["reap", "--dry-run", "inst"],
  })
  assert.equal(r.status, 0, r.err)
  assert.match(r.out, /\[inst\] 回収対象: pid=\d+/)
  assert.deepEqual(killed, [false])
})

test("claude-rc-reap/AC-12: 登録済みインスタンスが10件のとき、一括回収の判定が5秒以内に終わる", () => {
  const e = makeEnv()
  for (let i = 0; i < 10; i++) e.register(`n${i}`, "/x")
  const r = e.run(CTL, ["reap", "--all"])
  assert.equal(r.status, 0, r.err)
  assert.ok(r.ms < 5000, `${r.ms}ms`)
})

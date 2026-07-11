import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, open, rm, symlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createA2AState } from "../a2a/state.js";
import * as realFs from "node:fs/promises";

const job = (n) => `0x${n.toString(16).padStart(64, "0")}`;
const identity = { agentId: "agent-7", serviceId: "service-9" };

function cleanup(t, stateDir) {
  t.after(async () => { await rm(stateDir, { recursive: true, force: true }); });
}

async function fixture(t, options = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), "a2a-spool-"));
  cleanup(t, stateDir);
  return createA2AState({ stateDir, ...options });
}

async function accept(state, jobId) {
  return state.accept({ jobId, request: { jobId }, accepted: { event: "job_accepted" }, ...identity });
}

function syncFaultIo(stateDir, phase) {
  const io = Object.create(realFs);
  let armed = true;
  io.open = async (path, flags, mode) => {
    const handle = await realFs.open(path, flags, mode);
    const original = handle.sync.bind(handle);
    handle.sync = async () => {
      const text = String(path);
      const accepted = await realFs.lstat(join(stateDir, "a2a", "jobs", job(251), "accepted.json")).then(() => true, () => false);
      const ready = await realFs.lstat(join(stateDir, "a2a", "jobs", job(251), "ready")).then(() => true, () => false);
      const working = await realFs.lstat(join(stateDir, "a2a", "jobs", job(251), "working.json")).then(() => true, () => false);
      const hit = phase === "file" ? text.includes(".accepted.json.")
        : phase === "accepted-parent" ? text.endsWith(job(251)) && accepted && !ready
          : phase === "ready" ? text.endsWith(job(251)) && ready
            : text.endsWith(job(251)) && working;
      if (armed && hit) {
        armed = false;
        const error = new Error(`EIO-${phase}`);
        error.code = "EIO";
        throw error;
      }
      return original();
    };
    return handle;
  };
  return io;
}

test("Given 一个 ready job When 两个 worker 并发 claim Then 只有一个成功", async (t) => {
  const state = await fixture(t);
  await accept(state, job(1));

  const results = await Promise.allSettled([state.claimNext("worker-a"), state.claimNext("worker-b")]);

  assert.equal(results.filter(({ status, value }) => status === "fulfilled" && value).length, 1);
  assert.equal(results.filter(({ status }) => status === "rejected").length, 0);
});

test("Given 两个 ready job When 两个 worker 并发 claim Then 全局仍只有一个 worker", async (t) => {
  const state = await fixture(t);
  await accept(state, job(1));
  await accept(state, job(2));

  const results = await Promise.all([state.claimNext("worker-a"), state.claimNext("worker-b")]);

  assert.equal(results.filter(Boolean).length, 1);
});

test("Given 两个实例使用相同 workerId When 并发 claim Then token 所有权仍只允许一个", async (t) => {
  const state = await fixture(t);
  await accept(state, job(1));
  await accept(state, job(2));
  const peer = createA2AState({ stateDir: state.stateDir });

  const results = await Promise.all([state.claimNext("stable-worker"), peer.claimNext("stable-worker")]);

  assert.equal(results.filter(Boolean).length, 1);
});

test("Given worker 正在处理 job When 无关 job 写 terminal Then 不释放当前 claim", async (t) => {
  const state = await fixture(t);
  await accept(state, job(1));
  await accept(state, job(2));
  await state.claimNext("worker-a");
  await state.record(job(2), "completed", { event: "completed" }, identity);

  assert.equal(await createA2AState({ stateDir: state.stateDir }).claimNext("worker-b"), null);
});

test("Given worker 完成当前 job When 再次 claim Then 推进到下一个 ready job", async (t) => {
  const state = await fixture(t);
  await accept(state, job(1));
  await accept(state, job(2));
  const first = await state.claimNext("stable-worker");
  await state.record(first.jobId, "completed", { event: "completed" }, identity);

  const second = await state.claimNext("stable-worker");

  assert.notEqual(second.jobId, first.jobId);
});

test("Given terminal durable 后清理 working 前崩溃 When 重启 Then 跳过已终态 job", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "a2a-terminal-kill-"));
  cleanup(t, stateDir);
  const state = createA2AState({ stateDir });
  await accept(state, job(1));
  await accept(state, job(2));
  const code = `
    import * as fs from "node:fs/promises";
    import {createA2AState} from ${JSON.stringify(new URL("../a2a/state.js", import.meta.url).href)};
    setInterval(()=>{},1000);
    const state=createA2AState({stateDir:process.env.STATE_DIR}); const claimed=await state.claimNext("stable-worker");
    const io=Object.create(fs); io.rmdir=async()=>{console.log("terminal-durable");await new Promise(()=>{});};
    await createA2AState({stateDir:process.env.STATE_DIR,io}).record(claimed.jobId,"completed",{event:"completed"},{agentId:"agent-7",serviceId:"service-9"});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...process.env, STATE_DIR: stateDir }, stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve) => child.stdout.once("data", resolve));
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));

  assert.equal((await createA2AState({ stateDir }).claimNext("stable-worker")).jobId, job(2));
});

test("Given 100 个 pending job When 再接收一个 Then 容量门拒绝", async (t) => {
  const state = await fixture(t);
  await Promise.all(Array.from({ length: 100 }, (_, index) => accept(state, job(index + 1))));

  await assert.rejects(accept(state, job(101)), /pending capacity/);
});

test("Given 101 个并发发布 When 容量竞争 Then 最多 100 个被接受", async (t) => {
  const state = await fixture(t);

  const results = await Promise.allSettled(Array.from({ length: 101 }, (_, index) => accept(state, job(index + 1))));

  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 100);
  assert.match(results.find(({ status }) => status === "rejected").reason.message, /pending capacity/);
});

test("Given 99 pending When 两个 state 实例并发接收 Then 跨实例仍不超过 100", async (t) => {
  const state = await fixture(t);
  for (let index = 1; index <= 99; index += 1) await accept(state, job(index));
  const peer = createA2AState({ stateDir: state.stateDir });

  const results = await Promise.allSettled([accept(state, job(100)), accept(peer, job(101))]);

  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  assert.match(results.find(({ status }) => status === "rejected").reason.message, /pending capacity/);
});

test("Given spool 已达 100MiB When 接收 Then 总容量门拒绝", async (t) => {
  const state = await fixture(t);
  await mkdir(state.root, { recursive: true });
  const handle = await open(join(state.root, "full.bin"), "w");
  await handle.truncate(100 * 1024 * 1024);
  await handle.close();

  await assert.rejects(accept(state, job(150)), /spool capacity/);
});

test("Given rename 或 link 故障 When 重试发布 Then ENOSPC/EACCES fail closed 且可恢复", async (t) => {
  for (const [method, code] of [["rename", "ENOSPC"], ["link", "EACCES"]]) {
    const stateDir = await mkdtemp(join(tmpdir(), `a2a-fault-${method}-`));
    cleanup(t, stateDir);
    let armed = true;
    const io = Object.create(realFs);
    io[method] = async (...args) => {
      if (armed) {
        armed = false;
        const error = new Error(code);
        error.code = code;
        throw error;
      }
      return realFs[method](...args);
    };
    const broken = createA2AState({ stateDir, io });

    await assert.rejects(accept(broken, job(method === "rename" ? 201 : 202)), new RegExp(code));
    const restarted = createA2AState({ stateDir });
    await accept(restarted, job(method === "rename" ? 201 : 202));
    assert.equal((await restarted.read(job(method === "rename" ? 201 : 202), "accepted")).payload.event, "job_accepted");
  }
});

test("Given ready 已 rename 后 working 写入 EIO When 重启 Then job 可再次领取", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "a2a-claim-eio-"));
  cleanup(t, stateDir);
  const healthy = createA2AState({ stateDir });
  await accept(healthy, job(250));
  const io = Object.create(realFs);
  io.rename = async (source, target) => {
    if (String(source).includes(".working.json.")) {
      const error = new Error("EIO");
      error.code = "EIO";
      throw error;
    }
    return realFs.rename(source, target);
  };
  const broken = createA2AState({ stateDir, io });

  await assert.rejects(broken.claimNext("broken-worker"), /EIO/);
  const restarted = createA2AState({ stateDir });
  assert.equal((await restarted.claimNext("restart-worker")).jobId, job(250));
});

test("Given publish 与 claim 各 sync 阶段 EIO When 重启 Then accepted 不丢且可恢复", async (t) => {
  for (const phase of ["file", "accepted-parent", "ready", "working"]) {
    const stateDir = await mkdtemp(join(tmpdir(), `a2a-sync-${phase}-`));
    cleanup(t, stateDir);
    const broken = createA2AState({ stateDir, io: syncFaultIo(stateDir, phase) });
    if (phase === "working") await accept(createA2AState({ stateDir }), job(251));

    if (phase === "working") await assert.rejects(broken.claimNext("stable-worker"), /EIO-working/);
    else await assert.rejects(accept(broken, job(251)), new RegExp(`EIO-${phase}`));
    const restarted = createA2AState({ stateDir });
    if (phase !== "working") await accept(restarted, job(251));
    assert.equal((await restarted.read(job(251), "accepted")).payload.event, "job_accepted");
    assert.equal((await restarted.claimNext("stable-worker")).jobId, job(251));
  }
});

test("Given 持容量门进程被 SIGKILL When 新进程接收 Then 死 owner 锁可恢复", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "a2a-gate-crash-"));
  cleanup(t, stateDir);
  const holderCode = `
    import * as fs from "node:fs/promises";
    import {createA2AState} from ${JSON.stringify(new URL("../a2a/state.js", import.meta.url).href)};
    setInterval(()=>{},1000);
    const io=Object.create(fs); let held=false;
    io.readdir=async (path, options) => {
      if (!held && String(path).endsWith("/a2a")) { held=true; console.log("gate-held"); await new Promise(()=>{}); }
      return fs.readdir(path, options);
    };
    await createA2AState({stateDir:process.env.STATE_DIR,io}).accept({jobId:${JSON.stringify(job(252))},request:{},accepted:{event:"job_accepted"},agentId:"agent-7",serviceId:"service-9"});`;
  const holder = spawn(process.execPath, ["--input-type=module", "-e", holderCode], {
    env: { ...process.env, STATE_DIR: stateDir }, stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve) => holder.stdout.once("data", resolve));
  holder.kill("SIGKILL");
  await new Promise((resolve) => holder.once("exit", resolve));
  const recoveryCode = `
    import {createA2AState} from ${JSON.stringify(new URL("../a2a/state.js", import.meta.url).href)};
    await createA2AState({stateDir:process.env.STATE_DIR}).accept({jobId:${JSON.stringify(job(253))},request:{},accepted:{event:"job_accepted"},agentId:"agent-7",serviceId:"service-9"});
    console.log("gate-recovered");`;
  const recovery = spawn(process.execPath, ["--input-type=module", "-e", recoveryCode], {
    env: { ...process.env, STATE_DIR: stateDir }, stdio: ["ignore", "pipe", "inherit"],
  });
  let output = "";
  recovery.stdout.on("data", (chunk) => { output += chunk; });
  const timer = setTimeout(() => recovery.kill("SIGKILL"), 1_000);
  const status = await new Promise((resolve) => recovery.once("exit", resolve));
  clearTimeout(timer);

  assert.equal(status, 0);
  assert.match(output, /gate-recovered/);
});

test("Given dead gate 有两个恢复进程 When 并发接收 Then 不发生 ABA 且容量仍串行", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "a2a-gate-aba-"));
  cleanup(t, stateDir);
  await mkdir(join(stateDir, "a2a", ".accepting"), { recursive: true });
  await writeFile(join(stateDir, "a2a", ".accepting", "owner"), "99999999");
  const left = createA2AState({ stateDir });
  const right = createA2AState({ stateDir });

  await Promise.all([accept(left, job(254)), accept(right, job(255))]);

  assert.equal((await left.read(job(254), "accepted")).payload.event, "job_accepted");
  assert.equal((await right.read(job(255), "accepted")).payload.event, "job_accepted");
});

test("Given 前一恢复者留下 dead candidate When 新实例接收 Then recovery 选举可接管", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "a2a-recovery-crash-"));
  cleanup(t, stateDir);
  const gate = join(stateDir, "a2a", ".accepting");
  await mkdir(join(gate, "recover.99999999.dead-token"), { recursive: true });
  await writeFile(join(gate, "owner"), "99999999");

  await accept(createA2AState({ stateDir }), job(258));

  assert.equal((await createA2AState({ stateDir }).read(job(258), "accepted")).payload.event, "job_accepted");
});

test("Given SIGKILL 落在 ready rename 后 When 重启 Then 无 working.json 的 claim 可恢复", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "a2a-claim-kill-"));
  cleanup(t, stateDir);
  await accept(createA2AState({ stateDir }), job(256));
  const code = `
    import * as fs from "node:fs/promises";
    import {createA2AState} from ${JSON.stringify(new URL("../a2a/state.js", import.meta.url).href)};
    setInterval(()=>{},1000);
    const io=Object.create(fs);
    io.rename=async (source,target) => { await fs.rename(source,target); if(String(target).endsWith("/working")){console.log("renamed");await new Promise(()=>{});} };
    await createA2AState({stateDir:process.env.STATE_DIR,io}).claimNext("stable-worker");`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...process.env, STATE_DIR: stateDir }, stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve) => child.stdout.once("data", resolve));
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  await new Promise((resolve) => setTimeout(resolve, 1_050));

  assert.equal((await createA2AState({ stateDir }).claimNext("stable-worker")).jobId, job(256));
});

test("Given SIGKILL 落在 committed rename 后 When 重启 Then publish 自动收口", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "a2a-committed-kill-"));
  cleanup(t, stateDir);
  const code = `
    import * as fs from "node:fs/promises";
    import {createA2AState} from ${JSON.stringify(new URL("../a2a/state.js", import.meta.url).href)};
    setInterval(()=>{},1000);
    const io=Object.create(fs); io.link=async()=>{console.log("committed");await new Promise(()=>{});};
    await createA2AState({stateDir:process.env.STATE_DIR,io}).accept({jobId:${JSON.stringify(job(257))},request:{},accepted:{event:"job_accepted"},agentId:"agent-7",serviceId:"service-9"});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...process.env, STATE_DIR: stateDir }, stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve) => child.stdout.once("data", resolve));
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  const restarted = createA2AState({ stateDir });

  await restarted.accept({ jobId: job(257), request: {}, accepted: { event: "job_accepted" }, ...identity });
  assert.equal((await restarted.read(job(257), "accepted")).payload.event, "job_accepted");
});

test("Given stale working When readiness Then 返回 503 blocker", async (t) => {
  let now = Date.parse("2026-07-11T00:00:00Z");
  const state = await fixture(t, { now: () => now });
  await accept(state, job(1));
  await state.claimNext("worker-a");
  now += 15 * 60 * 1000;

  const readiness = await state.readiness();

  assert.equal(readiness.status, 503);
  assert(readiness.blockers.includes("stale-working"));
});

test("Given 截断 JSON 或未知 schema When readiness Then fail closed", async (t) => {
  const state = await fixture(t);
  await accept(state, job(1));
  await writeFile(join(state.root, "jobs", job(1), "accepted.json"), "{\"schemaVersion\":");

  assert.equal((await state.readiness()).status, 503);

  await writeFile(join(state.root, "jobs", job(1), "accepted.json"), JSON.stringify({ schemaVersion: 99 }));
  assert.equal((await state.readiness()).status, 503);
});

test("Given delivery-attempt 无确定结果 When readiness Then 不自动 ready", async (t) => {
  const state = await fixture(t);
  await accept(state, job(1));
  await state.record(job(1), "delivery-attempt", { command: "deliver" }, identity);

  const readiness = await state.readiness();

  assert.equal(readiness.status, 503);
  assert(readiness.blockers.includes("delivery-unknown"));
});

test("Given symlink 混入 spool When readiness Then fail closed", async (t) => {
  const state = await fixture(t);
  await accept(state, job(1));
  const outside = join(state.stateDir, "outside");
  await mkdir(outside);
  await symlink(outside, join(state.root, "jobs", job(1), "trap"));

  assert.equal((await state.readiness()).status, 503);
});

test("Given 文件系统返回 EACCES When readiness Then fail closed", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "a2a-permission-"));
  cleanup(t, stateDir);
  const io = Object.create(realFs);
  io.readdir = async () => {
    const error = new Error("EACCES");
    error.code = "EACCES";
    throw error;
  };
  const state = createA2AState({ stateDir, io });

  assert.equal((await state.readiness()).status, 503);
});

test("Given 24 小时旧任务 When readiness Then 返回 job-expired", async (t) => {
  let now = Date.parse("2026-07-11T00:00:00Z");
  const state = await fixture(t, { now: () => now });
  await accept(state, job(1));
  now += 24 * 60 * 60 * 1000;

  const readiness = await state.readiness();

  assert.equal(readiness.status, 503);
  assert(readiness.blockers.includes("job-expired"));
});

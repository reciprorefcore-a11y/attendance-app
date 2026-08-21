import assert from "node:assert/strict";
import test from "node:test";
import {
  createPunchId,
  createSubmissionGuard,
  getAllowedActions,
  getCurrentPosition,
  PunchError,
  retryTransient,
  validateAccuracy,
} from "../lib/clock-punch.ts";

test("打刻成功: 状態遷移と短時間重複防止IDが安定する", () => {
  assert.deepEqual(getAllowedActions(null), ["clock_in"]);
  assert.deepEqual(getAllowedActions("clock_in"), ["break_start", "clock_out"]);
  assert.equal(
    createPunchId("employee-1", "clock_in", 60_001),
    createPunchId("employee-1", "clock_in", 89_999),
  );
});

test("GPS失敗: 権限拒否を権限エラーとして返す", async () => {
  const geolocation = {
    getCurrentPosition: (_success: PositionCallback, failure: PositionErrorCallback) =>
      failure({ code: 1, message: "denied", PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }),
  } as Geolocation;
  await assert.rejects(getCurrentPosition(geolocation), (error: unknown) => {
    assert.ok(error instanceof PunchError);
    assert.equal(error.kind, "permission");
    return true;
  });
  assert.throws(() => validateAccuracy(250, 50), /精度が不足/);
});

test("通信失敗: 一時エラーは安全な回数だけ再試行する", async () => {
  let calls = 0;
  const result = await retryTransient(async () => {
    calls += 1;
    if (calls === 1) throw { code: "unavailable" };
    return "saved";
  }, 1);
  assert.equal(result, "saved");
  assert.equal(calls, 2);
});

test("二重タップ: 実行中の二つ目の送信を拒否する", async () => {
  const guard = createSubmissionGuard();
  let release!: () => void;
  const first = guard(() => new Promise<void>((resolve) => { release = resolve; }));
  await assert.rejects(guard(async () => undefined), (error: unknown) => {
    assert.ok(error instanceof PunchError);
    assert.equal(error.kind, "duplicate");
    return true;
  });
  release();
  await first;
});

test("再試行: 失敗後はロックが解除され再送できる", async () => {
  const guard = createSubmissionGuard();
  await assert.rejects(guard(async () => { throw new Error("failed"); }));
  assert.equal(await guard(async () => "retried"), "retried");
});

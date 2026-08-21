import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCorrectionAudit,
  buildCorrectionWorkSets,
  commitCorrection,
  createCorrectionSaveGuard,
  openCorrectionEditor,
  validateCorrection,
} from "../lib/attendance-correction.ts";
import { buildAttendanceRows, type CalculationClockLog } from "../lib/attendance-calculation.ts";

const at = (value: string) => new Date(`${value}+09:00`);
const log = (id: string, type: "clock_in" | "clock_out", value: string, storeId = "a"): CalculationClockLog => ({
  id, type, timestamp: at(value), storeId, workStoreName: `店舗${storeId.toUpperCase()}`,
  employeeId: "employee-1", employeeCode: "001", employeeName: "テスト従業員",
});

test("17:00-23:00勤務を23:10退勤へ編集でき、クリック用editorが開く", () => {
  const [set] = buildCorrectionWorkSets([
    log("in", "clock_in", "2026-08-13T17:00:00"),
    log("out", "clock_out", "2026-08-13T23:00:00"),
  ]);
  const editor = openCorrectionEditor(set);
  assert.equal(editor.clockIn, "2026-08-13T17:00");
  assert.equal(editor.clockOut, "2026-08-13T23:00");
  editor.clockOut = "2026-08-13T23:10";
  editor.reason = "退勤時刻訂正";
  assert.deepEqual(validateCorrection(editor, set.key, [set]), []);
});

test("未退勤セットは退勤が空欄で開き23:10を追加できる", () => {
  const [set] = buildCorrectionWorkSets([log("in", "clock_in", "2026-08-13T17:00:00")]);
  assert.equal(set.status, "missing_clock_out");
  const editor = openCorrectionEditor(set);
  assert.equal(editor.clockOut, "");
  editor.clockOut = "2026-08-13T23:10";
  editor.reason = "退勤漏れ";
  assert.deepEqual(validateCorrection(editor, set.key, [set]), []);
});

test("孤立退勤セットは出勤が空欄で開き出勤を追加できる", () => {
  const [set] = buildCorrectionWorkSets([log("out", "clock_out", "2026-08-13T23:10:00")]);
  assert.equal(set.status, "orphan_clock_out");
  const editor = openCorrectionEditor(set);
  assert.equal(editor.clockIn, "");
  editor.clockIn = "2026-08-13T17:00";
  editor.reason = "出勤漏れ";
  assert.deepEqual(validateCorrection(editor, set.key, [set]), []);
});

test("監査履歴に前後値・対象ID・作成更新区分・管理者・理由が残る", () => {
  const [set] = buildCorrectionWorkSets([log("in", "clock_in", "2026-08-13T17:00:00")]);
  const editor = { ...openCorrectionEditor(set), clockOut: "2026-08-13T23:10", reason: "退勤漏れ" };
  const audit = buildCorrectionAudit(set, editor, ["in", "new-out"], "admin-uid");
  assert.equal(audit.before.clockOut, null);
  assert.equal(audit.after.clockOut, "2026-08-13T14:10:00.000Z");
  assert.equal(audit.actions[0].action, "update");
  assert.equal(audit.actions[1].action, "create");
  assert.equal(audit.correctedBy, "admin-uid");
  assert.equal(audit.correctionReason, "退勤漏れ");
});

test("修正後に労働時間と深夜時間が再計算される", () => {
  const [row] = buildAttendanceRows([
    log("in", "clock_in", "2026-08-13T17:00:00"),
    log("out", "clock_out", "2026-08-13T23:10:00"),
  ]);
  assert.equal(row.workMinutes, 370);
  assert.equal(row.nightMinutes, 70);
});

test("複数店舗の出退勤は別の勤務セットになり誤結合しない", () => {
  const sets = buildCorrectionWorkSets([
    log("a-in", "clock_in", "2026-08-13T16:00:00", "a"),
    log("b-in", "clock_in", "2026-08-13T17:00:00", "b"),
    log("a-out", "clock_out", "2026-08-13T18:00:00", "a"),
    log("b-out", "clock_out", "2026-08-13T19:00:00", "b"),
  ]);
  assert.deepEqual(sets.map((set) => [set.storeId, set.workMinutes]).sort(), [["a", 120], ["b", 120]]);
});

test("同じ保存操作の連打は二つ目を拒否する", async () => {
  const guard = createCorrectionSaveGuard();
  let release!: () => void;
  const first = guard(() => new Promise<void>((resolve) => { release = resolve; }));
  await assert.rejects(guard(async () => undefined), /correction_already_saving/);
  release();
  await first;
});

test("Firestore保存失敗時は成功処理を実行しない", async () => {
  let success = false;
  await assert.rejects(commitCorrection(async () => { throw new Error("firestore failed"); }, () => { success = true; }));
  assert.equal(success, false);
});

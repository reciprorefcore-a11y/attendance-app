import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCorrectionAudit,
  buildCorrectionWorkSets,
  calculateCorrectionPreview,
  commitCorrection,
  createCorrectionSaveGuard,
  openCorrectionEditor,
  validateCorrection,
} from "../lib/attendance-correction.ts";
import { buildAttendanceRows, type CalculationClockLog } from "../lib/attendance-calculation.ts";

const at = (value: string) => new Date(`${value}+09:00`);
const log = (id: string, type: "clock_in" | "clock_out" | "break_start" | "break_end", value: string, storeId = "a"): CalculationClockLog => ({
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

test("休憩開始・終了時刻を変更できる", () => {
  const [set] = buildCorrectionWorkSets([
    log("in", "clock_in", "2026-08-15T17:00:00"), log("bs", "break_start", "2026-08-15T19:00:00"),
    log("be", "break_end", "2026-08-15T19:30:00"), log("out", "clock_out", "2026-08-15T23:10:00"),
  ]);
  const editor = openCorrectionEditor(set);
  editor.breaks[0].start = "2026-08-15T19:05";
  editor.breaks[0].end = "2026-08-15T19:35";
  editor.reason = "休憩時刻訂正";
  assert.deepEqual(validateCorrection(editor, set.key, [set]), []);
  assert.equal(calculateCorrectionPreview(editor).breakMinutes, 30);
});

test("休憩を後日追加できる", () => {
  const [set] = buildCorrectionWorkSets([log("in", "clock_in", "2026-08-15T17:00:00"), log("out", "clock_out", "2026-08-15T23:10:00")]);
  const editor = openCorrectionEditor(set);
  editor.breaks.push({ key: "new-1", startLogId: null, endLogId: null, start: "2026-08-15T19:00", end: "2026-08-15T19:30", isDeleted: false });
  editor.reason = "休憩追加";
  assert.deepEqual(validateCorrection(editor, set.key, [set]), []);
  assert.equal(calculateCorrectionPreview(editor).workMinutes, 340);
});

test("休憩を論理削除対象にできる", () => {
  const [set] = buildCorrectionWorkSets([
    log("in", "clock_in", "2026-08-15T17:00:00"), log("bs", "break_start", "2026-08-15T19:00:00"),
    log("be", "break_end", "2026-08-15T19:30:00"), log("out", "clock_out", "2026-08-15T23:10:00"),
  ]);
  const editor = openCorrectionEditor(set);
  editor.breaks[0].isDeleted = true;
  assert.equal(calculateCorrectionPreview(editor).breakMinutes, 0);
});

test("2回以上の休憩を合計する", () => {
  const [set] = buildCorrectionWorkSets([
    log("in", "clock_in", "2026-08-15T17:00:00"),
    log("bs1", "break_start", "2026-08-15T19:00:00"), log("be1", "break_end", "2026-08-15T19:30:00"),
    log("bs2", "break_start", "2026-08-15T21:00:00"), log("be2", "break_end", "2026-08-15T21:15:00"),
    log("out", "clock_out", "2026-08-15T23:10:00"),
  ]);
  assert.equal(set.breakMinutes, 45);
  assert.equal(set.workMinutes, 325);
  assert.equal(openCorrectionEditor(set).breaks.length, 2);
});

test("休憩終了漏れは空欄と未完了警告になる", () => {
  const [set] = buildCorrectionWorkSets([
    log("in", "clock_in", "2026-08-15T17:00:00"), log("bs", "break_start", "2026-08-15T19:00:00"),
    log("out", "clock_out", "2026-08-15T23:10:00"),
  ]);
  assert.equal(openCorrectionEditor(set).breaks[0].end, "");
  assert.ok(set.warnings.includes("休憩打刻が未完了です"));
});

test("孤立した休憩終了は開始空欄で勤務セットに残る", () => {
  const [set] = buildCorrectionWorkSets([
    log("in", "clock_in", "2026-08-15T17:00:00"), log("be", "break_end", "2026-08-15T19:30:00"),
    log("out", "clock_out", "2026-08-15T23:10:00"),
  ]);
  assert.equal(openCorrectionEditor(set).breaks[0].start, "");
  assert.ok(set.warnings.includes("休憩打刻が未完了です"));
});

test("重複休憩を検出して保存不可にする", () => {
  const [set] = buildCorrectionWorkSets([log("in", "clock_in", "2026-08-15T17:00:00"), log("out", "clock_out", "2026-08-15T23:10:00")]);
  const editor = openCorrectionEditor(set);
  editor.breaks = [
    { key: "1", startLogId: null, endLogId: null, start: "2026-08-15T19:00", end: "2026-08-15T19:30", isDeleted: false },
    { key: "2", startLogId: null, endLogId: null, start: "2026-08-15T19:20", end: "2026-08-15T19:40", isDeleted: false },
  ];
  editor.reason = "休憩追加";
  assert.ok(validateCorrection(editor, set.key, [set]).includes("休憩時間が重複しています"));
});

test("日跨ぎ勤務中の休憩を正しく計算する", () => {
  const [set] = buildCorrectionWorkSets([
    log("in", "clock_in", "2026-08-15T22:00:00"), log("bs", "break_start", "2026-08-16T00:00:00"),
    log("be", "break_end", "2026-08-16T00:30:00"), log("out", "clock_out", "2026-08-16T02:00:00"),
  ]);
  const preview = calculateCorrectionPreview({ ...openCorrectionEditor(set), reason: "確認" });
  assert.equal(preview.breakMinutes, 30);
  assert.equal(preview.workMinutes, 210);
  assert.equal(preview.nightMinutes, 210);
});

test("休憩修正後に労働・深夜時間を再計算する", () => {
  const [set] = buildCorrectionWorkSets([log("in", "clock_in", "2026-08-15T21:00:00"), log("out", "clock_out", "2026-08-16T01:00:00")]);
  const editor = openCorrectionEditor(set);
  editor.breaks = [{ key: "new", startLogId: null, endLogId: null, start: "2026-08-15T23:00", end: "2026-08-15T23:30", isDeleted: false }];
  const preview = calculateCorrectionPreview(editor);
  assert.equal(preview.workMinutes, 210);
  assert.equal(preview.nightMinutes, 150);
});

test("休憩の追加・変更・削除を監査履歴へ保存する", () => {
  const [set] = buildCorrectionWorkSets([log("in", "clock_in", "2026-08-15T17:00:00"), log("out", "clock_out", "2026-08-15T23:10:00")]);
  const editor = { ...openCorrectionEditor(set), reason: "休憩訂正" };
  const audit = buildCorrectionAudit(set, editor, ["in", "out", "bs", "be"], "admin", [
    { targetLogId: "bs", action: "create", type: "break_start" },
    { targetLogId: "be", action: "delete", type: "break_end" },
  ]);
  assert.deepEqual(audit.actions.slice(-2).map((item) => item.action), ["create", "delete"]);
  assert.ok(Array.isArray(audit.before.breaks));
  assert.ok(Array.isArray(audit.after.breaks));
});

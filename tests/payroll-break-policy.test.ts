import assert from "node:assert/strict";
import test from "node:test";
import XLSX from "xlsx";
import { applyPayrollBreakPolicy, calculatePayrollEmployee, getPayrollBlockingIssues, type PayrollAttendanceDay, type PayrollBreakPolicy, type PayrollEmployee } from "../lib/payroll.ts";
import { createPayrollWorkbook, createPayslipPdf } from "../lib/payroll-export.ts";
import { isValidDate, isValidMonth } from "../lib/payroll-api-validation.ts";
import { buildAttendanceRows, type CalculationClockLog } from "../lib/attendance-calculation.ts";
import { shouldIncludePayrollClockLog } from "../lib/payroll-server.ts";

const policy: PayrollBreakPolicy = { enabled: true, thresholdMinutes: 180, deductionMinutes: 15, effectiveFrom: "2026-11-01" };
const day = (minutes: number, date = "2026-11-01", recordedBreakMinutes = 0): PayrollAttendanceDay => ({ employeeId: "e1", date, workMinutes: minutes, overtimeMinutes: 0, nightMinutes: 0, helpMinutes: 0, breakMinutes: recordedBreakMinutes, recordedBreakMinutes, confirmed: true });
const employee: PayrollEmployee = { id: "e1", employeeCode: "1001", name: "休憩テスト", storeId: "s1", storeName: "店舗A", payrollType: "hourly", employeeType: "partTime", hourlyWage: 1200, payrollEnabled: true };

test("break_policy_not_configuredを含むerrorだけをExcel・確定共通のblocking対象にする", () => {
  assert.deepEqual(getPayrollBlockingIssues([
    { severity: "warning", code: "month_not_closed", message: "締め前" },
    { severity: "error", code: "break_policy_not_configured", message: "設定未保存" },
  ]).map((issue) => issue.code), ["break_policy_not_configured"]);
});

test("一律休憩の境界は179分=0、180分=15、181分=15", () => {
  assert.equal(applyPayrollBreakPolicy(day(179), policy).automaticBreakMinutes, 0);
  assert.deepEqual([180, 181].map((value) => applyPayrollBreakPolicy(day(value), policy).automaticBreakMinutes), [15, 15]);
});

test("拘束3時間15分・記録休憩30分で実働2時間45分なら追加控除なし", () => {
  const applied = applyPayrollBreakPolicy(day(165, "2026-11-01", 30), policy);
  assert.equal(applied.recordedBreakMinutes, 30);
  assert.equal(applied.automaticBreakMinutes, 0);
  assert.equal(applied.workMinutes, 165);
});

test("応援勤務2時間+1時間30分は日次合算後に15分を1回だけ控除", () => {
  const applied = applyPayrollBreakPolicy(day(210), policy);
  assert.equal(applied.automaticBreakMinutes, 15);
  assert.equal(applied.workMinutes, 195);
});

test("適用開始日前は控除せず設定は固定値でなく検証可能な設定オブジェクト", () => {
  assert.equal(applyPayrollBreakPolicy(day(240, "2026-10-31"), policy).automaticBreakMinutes, 0);
  assert.equal(applyPayrollBreakPolicy(day(240), { ...policy, enabled: false }).automaticBreakMinutes, 0);
});

test("削除済み打刻を除外した後の実働で一律休憩を判定する", () => {
  const makeLog = (id: string, type: string, timestamp: string, isDeleted = false): CalculationClockLog & { isDeleted?: boolean } => ({ id, type, timestamp: new Date(timestamp), employeeId: "e1", employeeCode: "1001", employeeName: "休憩テスト", storeId: "s1", storeName: "店舗A", isDeleted });
  const all = [
    makeLog("active-in", "clock_in", "2026-11-01T00:00:00Z"),
    makeLog("active-out", "clock_out", "2026-11-01T02:59:00Z"),
    makeLog("deleted-in", "clock_in", "2026-11-01T03:00:00Z", true),
    makeLog("deleted-out", "clock_out", "2026-11-01T07:00:00Z", true),
  ];
  const active = all.filter((log) => shouldIncludePayrollClockLog(log as unknown as Record<string, unknown>, new Set(["e1"])));
  const [row] = buildAttendanceRows(active);
  const applied = applyPayrollBreakPolicy(day(row.workMinutes, row.date, row.breakMinutes), policy);
  assert.equal(row.workMinutes, 179);
  assert.equal(applied.automaticBreakMinutes, 0);
});

test("給与結果・給与Excel・給与明細PDFに記録休憩、一律控除、実働を保持", async () => {
  const result = calculatePayrollEmployee(employee, [applyPayrollBreakPolicy(day(180, "2026-11-01", 30), policy)]);
  assert.deepEqual({ recorded: result.attendance.recordedBreakMinutes, automatic: result.attendance.automaticBreakMinutes, work: result.attendance.workMinutes }, { recorded: 30, automatic: 15, work: 165 });
  const workbook = XLSX.read(createPayrollWorkbook([result], "2026-12", true, "2026-11", "2026-12-25"));
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  assert.equal(sheet.A40.v, "記録休憩（時間）");
  assert.equal(sheet.A41.v, "一律休憩控除（時間）");
  assert.equal(sheet.A42.v, "実働（時間）");
  assert.equal(sheet.C40.v, 0.5);
  assert.equal(sheet.C41.v, 0.25);
  assert.equal(sheet.C42.v, 2.75);
  const pdf = await createPayslipPdf(result, "2026-11", "2026-12-25", true);
  assert.ok(pdf.length > 5000);
});

test("年月日を実在値として検証しうるう年だけ2月29日を許可", () => {
  assert.equal(isValidMonth("2026-12"), true);
  assert.equal(isValidMonth("2026-13"), false);
  assert.equal(isValidDate("2028-02-29"), true);
  assert.equal(isValidDate("2026-02-29"), false);
});

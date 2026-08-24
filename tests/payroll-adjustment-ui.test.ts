import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { adjustmentDisabledReason, holidayAllowancePreview, reimbursementPending, resolveHolidayAllowanceBasis } from "../lib/payroll-adjustment-ui.ts";
import { applyFixedPayrollAdjustment, calculatePayrollEmployee, type PayrollEmployee } from "../lib/payroll.ts";

const employee = (patch: Partial<PayrollEmployee>): PayrollEmployee => ({
  id: "employee", employeeCode: "0002", name: "社員", payrollEnabled: true, payrollType: "fixed", fixedBaseSalary: 0,
  storeId: "", storeName: "所属なし", paymentMethod: "cash", transportationType: "none", bankAccountRegistered: false,
  taxTableType: "kou", dependentCount: 0, healthInsurance: 0, childSupportContribution: 0, careInsurance: 0,
  employeePension: 0, employmentInsurance: 0, residentTax: 0, ...patch,
});

test("青山・休日0回・立替30,000円は再試算可能", () => {
  assert.equal(adjustmentDisabledReason({ selected: true, adjustment: { temporaryAttendanceCount: 0, expenseReimbursement: 30000 }, holidayBasis: null, manualHolidayOverride: false, busy: false }), null);
});

test("立替30,000円は給与差引額を変えず最終支給額だけ30,000円増やす", () => {
  const base = calculatePayrollEmployee(employee({ directorCompensation: 150000, healthInsurance: 7440, childSupportContribution: 172, careInsurance: 1215, employeePension: 13725, residentTax: 12600 }), []);
  const adjusted = applyFixedPayrollAdjustment(base, { temporaryAttendanceCount: 0, expenseReimbursement: 30000 });
  assert.equal(adjusted.payrollNetPay, base.payrollNetPay);
  assert.equal(adjusted.netPay - base.netPay, 30000);
  assert.equal(reimbursementPending(30000, 0), true);
  assert.equal(reimbursementPending(30000, 30000), false);
});

test("休日出勤回数だけなら修正理由不要、手動修正時だけ理由必須", () => {
  const ordinary = adjustmentDisabledReason({ selected: true, adjustment: { temporaryAttendanceCount: 1 }, holidayBasis: 190000, manualHolidayOverride: false, busy: false });
  assert.equal(ordinary, null);
  const manual = adjustmentDisabledReason({ selected: true, adjustment: { temporaryAttendanceCount: 1, holidayAllowanceOverride: 12000 }, holidayBasis: 190000, manualHolidayOverride: true, busy: false });
  assert.equal(manual, "休日出勤手当を手動修正する場合は、修正理由を入力してください");
  assert.equal(adjustmentDisabledReason({ selected: true, adjustment: { temporaryAttendanceCount: 1, holidayAllowanceOverride: 12000, overrideReason: "当月調整" }, holidayBasis: 190000, manualHolidayOverride: true, busy: false }), null);
});

test("休日算定基礎は根拠のないoverrideではなく月給を使う", () => {
  assert.deepEqual(holidayAllowancePreview({ holidayAllowanceBaseSalary: 190000, fixedBaseSalary: 185000 }, 1), { basis: 185000, unitPay: 10413, automaticAllowance: 10413 });
});

test("算定基礎未設定では役員報酬を使わず休日1回以上を拒否する", () => {
  assert.equal(resolveHolidayAllowanceBasis({ fixedBaseSalary: 0 }), null);
  assert.deepEqual(holidayAllowancePreview({ fixedBaseSalary: 0 }, 1), { basis: null, unitPay: null, automaticAllowance: null });
  assert.equal(adjustmentDisabledReason({ selected: true, adjustment: { temporaryAttendanceCount: 1 }, holidayBasis: null, manualHolidayOverride: false, busy: false }), "正社員マスターで休日手当算定基礎を設定してください");
});

test("休日算定基礎0円は未設定として正の固定基本給へfallbackする", () => {
  assert.equal(resolveHolidayAllowanceBasis({ holidayAllowanceBaseSalary: 0, fixedBaseSalary: 200000 }), 200000);
  const base = calculatePayrollEmployee(employee({ fixedBaseSalary: 200000, holidayAllowanceBaseSalary: 0 }), []);
  assert.equal(base.holidayAllowanceBaseSalarySnapshot, 200000);
});

test("社員別入力はemployeeIdをキーに保持できる", () => {
  const adjustments = { aoyama: { expenseReimbursement: 30000 }, nakamura: { temporaryAttendanceCount: 1 } };
  const selected = "nakamura";
  assert.equal(adjustments.aoyama.expenseReimbursement, 30000);
  assert.equal(adjustments[selected].temporaryAttendanceCount, 1);
});

test("理由不足・未反映・選択ボタンを画面へ明示する", () => {
  const source = readFileSync(new URL("../app/hq/payroll/page.tsx", import.meta.url), "utf8");
  assert.match(source, /休日出勤手当を手動修正する場合は、修正理由を入力してください|selectedAdjustmentDisabledReason/);
  assert.match(source, /変更内容はまだ再試算されていません/);
  assert.match(source, /employeeButtonActive/);
  assert.doesNotMatch(source, /臨時出勤回数/);
});

/**
 * POST /api/payroll/calculate の adjustments バリデーション境界テスト。
 * validateAdjustments は route.ts から直接呼ばれる pure function のため、
 * Firebase・Next.js 依存なしでルートの API 契約を検証できる。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isValidDate, isValidMonth, validateAdjustments } from "../lib/payroll-api-validation.ts";
import { normalizePayrollResult } from "../lib/payroll-server.ts";
import XLSX from "xlsx";
import { createPayrollWorkbook, createPayslipPdf } from "../lib/payroll-export.ts";

// ── validateAdjustments: 400 になるケース ──────────────────────────────

test("POST adjustments: expenseReimbursement が -1 なら 400 を返す", () => {
  const err = validateAdjustments({ emp1: { expenseReimbursement: -1 } });
  assert.ok(err !== null, "エラーを返す");
  assert.equal(err!.status, 400);
  assert.match(err!.error, /0以上の整数/);
});

test("POST adjustments: expenseReimbursement が NaN相当（文字列 'NaN'）なら 400 を返す", () => {
  const err = validateAdjustments({ emp1: { expenseReimbursement: NaN } });
  assert.ok(err !== null);
  assert.equal(err!.status, 400);
});

test("POST adjustments: expenseReimbursement が小数（100.5）なら 400 を返す", () => {
  const err = validateAdjustments({ emp1: { expenseReimbursement: 100.5 } });
  assert.ok(err !== null);
  assert.equal(err!.status, 400);
});

test("POST adjustments: expenseReimbursement が文字列 '800000' なら 400 を返す", () => {
  // JSON.parse で数値にならず string のまま来た場合
  const err = validateAdjustments({ emp1: { expenseReimbursement: "800000" } });
  assert.ok(err !== null, "'800000'（文字列）は整数ではないため拒否");
  assert.equal(err!.status, 400);
});

test("POST adjustments: expenseReimbursement が Infinity相当（Number.POSITIVE_INFINITY）なら 400 を返す", () => {
  const err = validateAdjustments({ emp1: { expenseReimbursement: Infinity } });
  assert.ok(err !== null);
  assert.equal(err!.status, 400);
});

test("POST adjustments: 個別値がオブジェクト以外（配列）なら 400 を返す", () => {
  const err = validateAdjustments({ emp1: [800000] });
  assert.ok(err !== null, "配列は拒否");
  assert.equal(err!.status, 400);
});

test("POST adjustments 全体がオブジェクト以外（配列）なら 400 を返す", () => {
  const err = validateAdjustments([{ expenseReimbursement: 800000 }]);
  assert.ok(err !== null, "配列は拒否");
  assert.equal(err!.status, 400);
});

// ── validateAdjustments: 成功（null を返す）ケース ────────────────────

test("POST adjustments: expenseReimbursement が 0 なら成功", () => {
  assert.equal(validateAdjustments({ emp1: { expenseReimbursement: 0 } }), null);
});

test("POST adjustments: expenseReimbursement が 1 なら成功", () => {
  assert.equal(validateAdjustments({ emp1: { expenseReimbursement: 1 } }), null);
});

test("POST adjustments: expenseReimbursement が 7599 なら成功", () => {
  assert.equal(validateAdjustments({ emp1: { expenseReimbursement: 7599 } }), null);
});

test("POST adjustments: expenseReimbursement が 800000 なら成功", () => {
  assert.equal(validateAdjustments({ emp1: { expenseReimbursement: 800000 } }), null);
});

test("POST adjustments: expenseReimbursement が undefined（未指定）なら成功", () => {
  assert.equal(validateAdjustments({ emp1: { overtimeMinutes: 60 } }), null);
});

test("POST adjustments: adjustments 自体が undefined なら成功", () => {
  assert.equal(validateAdjustments(undefined), null);
});

test("POST adjustments: 複数社員で一人だけ不正なら 400 を返す", () => {
  const err = validateAdjustments({ emp1: { expenseReimbursement: 800000 }, emp2: { expenseReimbursement: -1 } });
  assert.ok(err !== null);
  assert.equal(err!.status, 400);
  assert.match(err!.error, /emp2/);
});

test("API年月日は正規表現だけでなく実在年月日を要求する", () => {
  assert.equal(isValidMonth("2026-00"), false);
  assert.equal(isValidMonth("2026-12"), true);
  assert.equal(isValidDate("2026-11-31"), false);
  assert.equal(isValidDate("2026-11-30"), true);
});

test("POST adjustments: 休日手当修正額の負数・小数・文字列を400にする", () => {
  for (const value of [-1, 100.5, "30891"]) {
    const result = validateAdjustments({ employee: { holidayAllowanceOverride: value } });
    assert.equal(result?.status, 400);
  }
  assert.equal(validateAdjustments({ employee: { holidayAllowanceOverride: 30891, overrideReason: "公休調整" } }), null);
});

test("POST adjustments: 休日出勤回数は0以上の整数だけ許可する", () => {
  assert.equal(validateAdjustments({ employee: { temporaryAttendanceCount: 0 } }), null);
  assert.equal(validateAdjustments({ employee: { temporaryAttendanceCount: 1 } }), null);
  for (const value of [-1, 1.5, "1", Number.NaN]) assert.equal(validateAdjustments({ employee: { temporaryAttendanceCount: value } })?.status, 400);
});

// ── 確定済みrunの旧フォーマット互換 ─────────────────────────────────

test("確定済み旧フォーマットPayrollResultは reimbursements=0・netPay保持で正規化される", async () => {
  // 旧 Firestore データ（reimbursements・payrollNetPay フィールドなし）
  const oldRaw: Record<string, unknown> = {
    employeeId: "aoyama", employeeCode: "0002", employeeName: "青山佳史",
    payrollType: "fixed", employeeType: "fullTime",
    paymentMethod: "cash", payrollTransferOrder: null,
    taxTableTypeSnapshot: "kou", dependentCountSnapshot: 0, hourlyWageSnapshot: null,
    issues: [], attendanceDaysDetail: [],
    attendance: { workingDays: 0, attendanceDays: 0, absenceDays: 0, paidLeaveDays: 0, workMinutes: 0, overtimeMinutes: 0, nightMinutes: 0, holidayMinutes: 0, breakMinutes: 0, helpMinutes: 0 },
    earnings: { baseSalary: 0, directorCompensation: 150000, positionAllowance: 0, fixedOvertimeAllowance: 0, holidayAllowance: 0, businessAllowance: 0, overtimePremium: 0, nightPremium: 0, otherTaxable: 0, absenceDeduction: 0, lateEarlyDeduction: 0, taxableTotal: 150000, transportation: 0, otherNonTaxable: 0, nonTaxableTotal: 0, grossTotal: 150000 },
    deductions: { healthInsurance: 7440, childSupportContribution: 172, careInsurance: 1215, employeePension: 13725, employmentInsurance: 0, socialInsuranceTotal: 22552, taxableIncome: 127448, incomeTax: 1300, residentTax: 12600, yearEndAdjustment: 0, otherDeduction: 0, total: 36452 },
    netPay: 113548, bankTransfer: 0, cashPayment: 113548,
    // 旧フォーマット: reimbursements・payrollNetPay なし、deductions に旧advanceExpense あり
  };

  const normalized = normalizePayrollResult(oldRaw);

  // 保存済み netPay は変更されない
  assert.equal(normalized.netPay, 113548, "確定済みnetPayは変更されない");
  // 旧フォーマットには精算なし → 0
  assert.equal(normalized.reimbursements.expenseReimbursement, 0, "旧形式は精算なし(0)として正規化");
  assert.equal(normalized.reimbursements.total, 0);
  // payrollNetPay はnetPayと同値（精算なし）
  assert.equal(normalized.payrollNetPay, 113548, "payrollNetPay = 保存済みnetPay");

  // Excel出力でエラーにならず、保存済み値を使う
  const book = XLSX.read(createPayrollWorkbook([normalized], "2026-08"));
  const sheet = book.Sheets[book.SheetNames[0]];
  assert.equal(sheet[XLSX.utils.encode_cell({ r: 32, c: 2 })].v, 113548, "Excel row32は確定済みnetPay");
  assert.equal(sheet[XLSX.utils.encode_cell({ r: 29, c: 2 })].v, 0, "Excel row29は旧形式では0");
  assert.equal(sheet[XLSX.utils.encode_cell({ r: 30, c: 2 })].v, 36452, "Excel row30は確定済み控除合計");

  // PDF出力でエラーにならない
  const pdf = await createPayslipPdf(normalized, "2026-07", "2026-08-25");
  assert.ok(pdf.length > 5000, "旧形式でもPDFが生成される");
  assert.match(pdf.toString("latin1"), /PDF-/);
});

test("確定済みrunは applyFixedPayrollAdjustment を経由しない（コード構造確認）", () => {
  const src = readFileSync("lib/payroll-server.ts", "utf8");
  const loadFnStart = src.indexOf("export async function loadPayrollRun");
  const loadFnEnd = src.indexOf("\nexport ", loadFnStart + 1);
  const loadFnBody = src.slice(loadFnStart, loadFnEnd > 0 ? loadFnEnd : undefined);
  assert.doesNotMatch(loadFnBody, /applyFixedPayrollAdjustment/, "loadPayrollRun内でapplyFixedPayrollAdjustmentを呼ばない");
});

test("給与確定はサーバー再計算と勤怠バージョン一致後だけ保存する", () => {
  const source = readFileSync("lib/payroll-server.ts", "utf8");
  const start = source.indexOf("export async function confirmPayrollRun");
  const end = source.indexOf("\n/**", start);
  const fn = source.slice(start, end);
  assert.match(fn, /createPayrollDraft\(db, input\)/);
  assert.match(fn, /sourceAttendanceVersion !== input\.sourceAttendanceVersion/);
  assert.match(fn, /source_changed/);
  assert.match(fn, /runTransaction/);
  assert.match(fn, /collection\("payrollPeriodLocks"\)\.doc\(input\.targetMonth\)/);
  assert.doesNotMatch(fn, /input\.results|draft\.results/);
});

test("未確定給与Excelはクライアントresultsを使わずサーバーで再計算する", () => {
  const route = readFileSync("app/api/payroll/export/[kind]/route.ts", "utf8");
  const post = route.slice(route.indexOf("export async function POST"), route.indexOf("export async function GET"));
  assert.match(post, /createPayrollDraft/);
  assert.match(post, /sourceAttendanceVersion/);
  assert.match(post, /getPayrollBlockingIssues\(run\.issues\)/);
  assert.match(post, /PAYROLL_BLOCKING_ERRORS/);
  assert.match(post, /blockingIssues\.map\(\(issue\) => issue\.message\)/);
  assert.doesNotMatch(post, /input\.results/);
});

test("確定と未確定Excelは同じblocking error抽出関数を使う", () => {
  const server = readFileSync("lib/payroll-server.ts", "utf8");
  const route = readFileSync("app/api/payroll/export/[kind]/route.ts", "utf8");
  assert.match(server, /getPayrollBlockingIssues\(recalculated\.issues\)/);
  assert.match(route, /getPayrollBlockingIssues\(run\.issues\)/);
});

test("確定取消はtransaction内でconfirmed状態を再確認する", () => {
  const source = readFileSync("lib/payroll-server.ts", "utf8");
  const start = source.indexOf("export async function cancelPayrollRun");
  const end = source.indexOf("\nexport async function", start + 1);
  const fn = source.slice(start, end);
  assert.match(fn, /runTransaction/);
  assert.match(fn, /snap\.data\(\)\.status !== "confirmed"/);
  assert.match(fn, /not_confirmed/);
  assert.match(fn, /collection\("payrollPeriodLocks"\)\.doc\(targetMonth\)/);
});

test("一律休憩設定保存時に既存確定月の非機密索引を初期化する", () => {
  const source = readFileSync("lib/payroll-server.ts", "utf8");
  const start = source.indexOf("export async function savePayrollBreakPolicy");
  const fn = source.slice(start);
  assert.match(fn, /where\("status", "==", "confirmed"\)/);
  assert.match(fn, /payrollPeriodLocks/);
  assert.match(fn, /payrollPeriodLocksInitialized: true/);
  const lockWrites = [...source.matchAll(/collection\("payrollPeriodLocks"\)[^\n]+/g)].map((match) => match[0]).join("\n");
  assert.doesNotMatch(lockWrites, /earnings|deductions|results|employeeId|runId|updatedBy/);
});

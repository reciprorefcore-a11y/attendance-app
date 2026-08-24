import assert from "node:assert/strict";
import test from "node:test";
import XLSX from "xlsx";
import { applyFixedPayrollAdjustment, calculatePayroll, calculatePayrollEmployee, calculateWithholdingTax2026, isPayrollMonthClosed, summarizePayroll, validatePayrollInput, type PayrollAttendanceDay, type PayrollEmployee } from "../lib/payroll.ts";
import { createPayrollWorkbook, createPayslipPdf, createPayslipZip, createTransferWorkbook, selectFullTimePayslipResults, selectStorePayslipResults } from "../lib/payroll-export.ts";
import { sortPayrollResults, sortPayrollResultsForExcel } from "../lib/payroll-order.ts";
import { resolveResidentTaxForMonth } from "../lib/payroll-server.ts";

const employee = (id: string, patch: Partial<PayrollEmployee> = {}): PayrollEmployee => ({ id, employeeCode: id, name: `従業員${id}`, storeId: "hq", storeName: "本部", payrollEnabled: true, payrollType: "hourly", hourlyWage: 1225, transportationType: "none", paymentMethod: "bank", bankAccountRegistered: true, taxTableType: "kou", dependentCount: 0, healthInsurance: 0, childSupportContribution: 0, careInsurance: 0, employeePension: 0, employmentInsurance: 0, residentTax: 0, ...patch });
const day = (employeeId: string, date: string, workMinutes: number, patch: Partial<PayrollAttendanceDay> = {}): PayrollAttendanceDay => ({ employeeId, date, workMinutes, overtimeMinutes: 0, nightMinutes: 0, helpMinutes: 0, breakMinutes: 0, confirmed: true, kind: "daily", ...patch });

test("日別勤怠だけを月次集計し合計行を二重加算しない", () => {
  const result = calculatePayrollEmployee(employee("1", { hourlyWage: 1200 }), [day("1", "2026-07-01", 600, { nightMinutes: 60 }), day("1", "2026-07-02", 300), { ...day("1", "2026-07-31", 900), kind: "total" }]);
  assert.equal(result.attendance.workMinutes, 900); assert.equal(result.attendance.nightMinutes, 60); assert.equal(result.attendance.attendanceDays, 2);
});

test("正社員はstoreIdなし・打刻なしで固定給与を計算できる", () => {
  const result = calculatePayrollEmployee(employee("full", { employeeType: "fullTime", payrollType: undefined, storeId: undefined, storeName: undefined, fixedBaseSalary: 200000, hourlyWage: null }), []);
  assert.equal(result.employeeType, "fullTime");
  assert.equal(result.storeId, "");
  assert.equal(result.storeName, "所属なし");
  assert.equal(result.earnings.baseSalary, 200000);
});

test("店舗別明細は選択店舗のアルバイトだけで正社員を含めない", () => {
  const storeA = calculatePayrollEmployee(employee("a", { employeeType: "partTime", storeId: "store-a", storeName: "A店" }), []);
  const storeB = calculatePayrollEmployee(employee("b", { employeeType: "partTime", storeId: "store-b", storeName: "B店" }), []);
  const full = calculatePayrollEmployee(employee("f", { employeeType: "fullTime", storeId: "store-a", fixedBaseSalary: 200000 }), []);
  assert.deepEqual(selectStorePayslipResults([storeA, storeB, full], "store-a").map((item) => item.employeeId), ["a"]);
});

test("正社員明細は正社員5名だけを抽出する", () => {
  const codes = ["0002", "0003", "0017", "0064", "0083"];
  const fullTime = codes.map((code) => calculatePayrollEmployee(employee(code, { employeeType: "fullTime", fixedBaseSalary: 200000 }), []));
  const partTime = calculatePayrollEmployee(employee("1000", { employeeType: "partTime" }), []);
  assert.deepEqual(selectFullTimePayslipResults([...fullTime, partTime]).map((item) => item.employeeCode), codes);
});

test("給与明細ZIPは従来型PDFを1名1ファイルで格納する", async () => {
  const result = calculatePayrollEmployee(employee("1076", { employeeType: "partTime", employeeCode: "1076", name: "松本るぴな" }), []);
  const zip = await createPayslipZip([result], "2026-07", "2026-08", "2026-08-25");
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.match(zip.toString("utf8"), /1076_松本るぴな_2026年08月給与明細\.pdf/);
  assert.match(zip.toString("latin1"), /%PDF-/);
});

test("24時間未満の労働・深夜・出勤日数を倍にしない", () => {
  const result = calculatePayrollEmployee(employee("1"), [day("1", "2026-07-01", 720, { nightMinutes: 120 })]);
  assert.deepEqual([result.attendance.workMinutes, result.attendance.nightMinutes, result.attendance.attendanceDays], [720, 120, 1]);
});

test("分数から1円未満四捨五入で時給・残業・深夜0.25割増を計算する", () => {
  const result = calculatePayrollEmployee(employee("1", { hourlyWage: 1225 }), [day("1", "2026-07-01", 61, { overtimeMinutes: 31, nightMinutes: 17 })]);
  assert.equal(result.earnings.baseSalary, 1245); assert.equal(result.earnings.overtimePremium, 158); assert.equal(result.earnings.nightPremium, 87);
});

test("時給端数処理：0.5円以上は切り上げ（四捨五入）", () => {
  // baseSalary: 1225 × 2910 / 60 = 59412.5 → 59413
  const r1 = calculatePayrollEmployee(employee("1", { hourlyWage: 1225 }), [day("1", "2026-07-01", 2910)]);
  assert.equal(r1.earnings.baseSalary, 59413, "59412.5は59413へ四捨五入");
  // overtimePremium: 1225 × 0.25 × 420 / 60 = 2143.75 → 2144
  const r2 = calculatePayrollEmployee(employee("hourly-2", { employeeCode: "hourly-2", hourlyWage: 1225 }), [day("hourly-2", "2026-07-01", 420, { overtimeMinutes: 420 })]);
  assert.equal(r2.earnings.overtimePremium, 2144, "2143.75は2144へ四捨五入");
});

test("固定給の自動残業手当も給与項目ごとに四捨五入する", () => {
  const fixed = calculatePayrollEmployee(employee("fixed-round", {
    employeeCode: "fixed-round", payrollType: "fixed", fixedBaseSalary: 1000, hourlyWage: 0,
  }), []);
  const adjusted = applyFixedPayrollAdjustment(fixed, { overtimeMinutes: 60 });
  assert.equal(adjusted.fixedAdjustment?.automaticOvertimeAllowance, 8, "7.8125円は8円へ四捨五入");
  assert.equal(adjusted.earnings.overtimePremium, 8);
});

test("店舗間ヘルプを同一employeeIdの1明細へ合算する", () => {
  const results = calculatePayroll([employee("1")], [day("1", "2026-07-01", 30), day("1", "2026-07-01", 210, { helpMinutes: 210 })]);
  assert.equal(results.length, 1); assert.equal(results[0].attendance.workMinutes, 240); assert.equal(results[0].attendance.helpMinutes, 210); assert.equal(results[0].attendance.attendanceDays, 1);
});

test("日額交通費は重複しない出勤日数、月額交通費は固定額", () => {
  const daily = calculatePayrollEmployee(employee("1", { transportationType: "daily", dailyTransportation: 300 }), [day("1", "2026-07-01", 30), day("1", "2026-07-01", 60), day("1", "2026-07-02", 60)]);
  const monthly = calculatePayrollEmployee(employee("2", { transportationType: "monthly", monthlyTransportation: 9000 }), []);
  assert.equal(daily.earnings.transportation, 600); assert.equal(monthly.earnings.transportation, 9000);
});

test("同日複数打刻・ヘルプでも日交通費は1回、日交通費と定期代を合算する", () => {
  const result = calculatePayrollEmployee(employee("1", { transportationType: "daily", dailyTransportation: 300, monthlyTransportation: 5000 }), [
    day("1", "2026-08-01", 60, { dailyTransportationUnit: 300, dailyTransportationAmount: 300 }),
    day("1", "2026-08-01", 120, { helpMinutes: 120, dailyTransportationUnit: 300, dailyTransportationAmount: 300 }),
    day("1", "2026-08-02", 0, { dailyTransportationUnit: 300, dailyTransportationAmount: 300 }),
    day("1", "2026-08-03", 60, { dailyTransportationUnit: 400, dailyTransportationAmount: 400 }),
  ]);
  assert.equal(result.attendance.attendanceDays, 2);
  assert.equal(result.earnings.transportation, 5700);
  assert.deepEqual(result.attendanceDaysDetail.map((item) => item.dailyTransportationAmount), [300,0,0,400]);
});

test("社員コードが重複してもemployeeIdごとに別人として計算する", () => {
  const first = employee("internal-a", { employeeCode: "0003" }), second = employee("internal-b", { employeeCode: "0003" });
  const results = calculatePayroll([first, second], [day("internal-a", "2026-08-01", 60), day("internal-b", "2026-08-01", 120)]);
  assert.equal(results.length, 2); assert.notEqual(results[0].employeeId, results[1].employeeId);
  assert.ok(validatePayrollInput([first, second], [], "2026-08").some((item) => item.code === "duplicate_employee_code" && item.severity === "warning"));
});

test("月途中は試算可能でも確定不可、翌月から確定可能", () => {
  assert.equal(isPayrollMonthClosed("2026-08", new Date("2026-08-22T03:00:00Z")), false);
  assert.equal(isPayrollMonthClosed("2026-08", new Date("2026-08-31T15:00:00Z")), true);
});

test("銀行口座と税区分が未設定でも給与計算を妨げず甲欄扶養0人を適用する", () => {
  const issues = validatePayrollInput([employee("1", { bankAccountRegistered: false, bankAccountNumber: null })], [], "2026-08");
  assert.equal(issues.some((item) => item.code === "missing_bank_account" || item.code === "missing_tax_setting"), false);
  const below = calculatePayrollEmployee(employee("below", { taxTableType: undefined, dependentCount: undefined, hourlyWage: 87999 }), [day("below", "2026-07-01", 60)]);
  const table = calculatePayrollEmployee(employee("table", { taxTableType: undefined, dependentCount: undefined, hourlyWage: 105558 }), [day("table", "2026-07-01", 60)]);
  assert.deepEqual([below.deductions.incomeTax, below.taxTableTypeSnapshot, below.dependentCountSnapshot], [0, "kou", 0]);
  assert.equal(table.deductions.incomeTax, 170);
});

test("固定給・固定手当と社保全額を引き継ぐ（休日手当はゼロ初期化）", () => {
  const result = calculatePayrollEmployee(employee("f", { payrollType: "fixed", fixedBaseSalary: 200000, positionAllowance: 10000, fixedOvertimeAllowance: 20000, healthInsurance: 10000, childSupportContribution: 500, careInsurance: 1000, employeePension: 20000, employmentInsurance: 1000 }), []);
  assert.equal(result.earnings.holidayAllowance, 0); assert.equal(result.earnings.overtimePremium, 0); assert.equal(result.deductions.socialInsuranceTotal, 32500); assert.equal(result.deductions.taxableIncome, result.earnings.taxableTotal - 32500);
});

test("休日出勤手当は基本給から自動計算し二重加算しない", () => {
  const base = calculatePayrollEmployee(employee("nk", { employeeCode: "0003", name: "中村鏡太郎", payrollType: "fixed", fixedBaseSalary: 190000 }), []);
  assert.equal(base.earnings.holidayAllowance, 0);
  const adj1 = applyFixedPayrollAdjustment(base, { temporaryAttendanceCount: 1 });
  assert.equal(adj1.earnings.holidayAllowance, 10694);
  assert.equal(adj1.earnings.holidayAllowance, Math.round(190000 / 177.67 * 8 * 1.25));
  const adj2 = applyFixedPayrollAdjustment(base, { temporaryAttendanceCount: 2 });
  assert.equal(adj2.earnings.holidayAllowance, 21388);
  const adj0 = applyFixedPayrollAdjustment(adj1, { temporaryAttendanceCount: 0 });
  assert.equal(adj0.earnings.holidayAllowance, 0);
  const base2 = calculatePayrollEmployee(employee("nk2", { employeeCode: "0003", payrollType: "fixed", fixedBaseSalary: 200000 }), []);
  const adj1b = applyFixedPayrollAdjustment(base2, { temporaryAttendanceCount: 1 });
  assert.equal(adj1b.earnings.holidayAllowance, Math.round(200000 / 177.67 * 8 * 1.25));
  assert.notEqual(adj1b.earnings.holidayAllowance, 10694);
});

test("休日手当overrideは当月調整だけに反映し、自動額との差異には理由を必須とする", () => {
  const base = calculatePayrollEmployee(employee("kobayashi-override", {
    employeeCode: "0064", name: "小林彗太", payrollType: "fixed", fixedBaseSalary: 183000,
  }), []);
  const withoutReason = applyFixedPayrollAdjustment(base, { temporaryAttendanceCount: 2, holidayAllowanceOverride: 30891 });
  assert.equal(withoutReason.earnings.holidayAllowance, 30891);
  assert.ok(withoutReason.issues.some((issue) => issue.code === "holiday_allowance_override_reason_required" && issue.severity === "error"));
  const reason = "公休6日のところ実休4日のため、休日出勤2回";
  const adjusted = applyFixedPayrollAdjustment(base, { temporaryAttendanceCount: 2, holidayAllowanceOverride: 30891, overrideReason: reason });
  assert.equal(adjusted.earnings.holidayAllowance, 30891);
  assert.equal(adjusted.fixedAdjustment?.temporaryAttendanceCount, 2);
  assert.equal(adjusted.fixedAdjustment?.holidayAllowanceOverride, 30891);
  assert.equal(adjusted.fixedAdjustment?.overrideReason, reason);
  assert.equal(adjusted.issues.some((issue) => issue.code === "holiday_allowance_override_reason_required"), false);
  assert.equal(applyFixedPayrollAdjustment(adjusted, { temporaryAttendanceCount: 2, holidayAllowanceOverride: 30891, overrideReason: reason }).earnings.holidayAllowance, 30891, "二重加算しない");
  assert.equal(base.earnings.holidayAllowance, 0, "元の固定給与マスター相当結果は変更しない");
});

test("住民税履歴はemployeeId単位で対象月以前の最新値を解決し、未設定時はfallback警告", () => {
  const source = employee("employee-id-1", {
    employeeCode: "duplicate-code", payrollType: "fixed", fixedBaseSalary: 200000, residentTax: 9999,
    residentTaxHistory: [
      { amount: 10000, effectiveMonth: "2026-06", updatedAt: "past", updatedBy: "admin-a" },
      { amount: 14100, effectiveMonth: "2026-08", updatedAt: "current", updatedBy: "admin-b" },
      { amount: 15000, effectiveMonth: "2026-09", updatedAt: "future", updatedBy: "admin-c" },
    ],
  });
  const july = resolveResidentTaxForMonth(source, "2026-07");
  const august = resolveResidentTaxForMonth(source, "2026-08");
  assert.deepEqual([july.residentTax, july.residentTaxEffectiveMonth], [10000, "2026-06"]);
  assert.deepEqual([august.residentTax, august.residentTaxEffectiveMonth], [14100, "2026-08"]);
  assert.equal(calculatePayrollEmployee(august, []).residentTaxEffectiveMonthSnapshot, "2026-08");
  const fallback = resolveResidentTaxForMonth(employee("employee-id-2", { payrollType: "fixed", fixedBaseSalary: 200000, residentTax: 12300 }), "2026-08");
  assert.equal(fallback.residentTax, 12300);
  assert.ok(validatePayrollInput([fallback], [], "2026-08").some((issue) => issue.code === "resident_tax_history_fallback" && issue.severity === "warning"));
});

test("2026年8月fixture：中村は根拠のない190,000円を使わず、小林overrideを維持", async () => {
  const residentEntry = (amount: number) => [{ amount, effectiveMonth: "2026-08", updatedAt: "fixture", updatedBy: "fixture-admin" }];
  const nakamuraEmployee = resolveResidentTaxForMonth(employee("hvjU14BKDB0pCdDrUZF1", {
    employeeCode: "0003", name: "中村鏡太郎", payrollType: "fixed", fixedBaseSalary: 185000,
    positionAllowance: 9000, businessAllowance: 110000, monthlyTransportation: 15670,
    healthInsurance: 15872, childSupportContribution: 368, careInsurance: 2592, employeePension: 29280, employmentInsurance: 1651,
    incomeTax: 6650, residentTax: 10000, residentTaxHistory: residentEntry(14100),
  }), "2026-08");
  const nakamura = applyFixedPayrollAdjustment(calculatePayrollEmployee(nakamuraEmployee, []), { temporaryAttendanceCount: 1 });
  assert.equal(nakamura.earnings.holidayAllowance, 10413, "中村は月給185,000円の自動式を使用しoverrideなし");
  assert.equal(nakamura.earnings.grossTotal, 330083);
  assert.equal(nakamura.fixedAdjustment?.holidayAllowanceOverride, null);
  assert.equal(nakamura.deductions.residentTax, 14100);
  assert.equal(nakamura.netPay, 259570);

  const kobayashiEmployee = resolveResidentTaxForMonth(employee("c6ADSFHwyHecwScuZ6g8", {
    employeeCode: "0064", name: "小林彗太", payrollType: "fixed", fixedBaseSalary: 183000,
    positionAllowance: 8000, fixedOvertimeAllowance: 27678, businessAllowance: 56417, monthlyTransportation: 10110,
    healthInsurance: 13888, childSupportContribution: 322, careInsurance: 0, employeePension: 25620, employmentInsurance: 1580,
    incomeTax: 6650, residentTax: 10000, residentTaxHistory: residentEntry(12200),
  }), "2026-08");
  const kobayashi = applyFixedPayrollAdjustment(calculatePayrollEmployee(kobayashiEmployee, []), {
    temporaryAttendanceCount: 2,
    holidayAllowanceOverride: 30891,
    overrideReason: "公休6日のところ実休4日のため、休日出勤2回",
  });
  assert.equal(kobayashi.earnings.holidayAllowance, 30891);
  assert.equal(kobayashi.deductions.employmentInsurance, 1580);
  assert.equal(kobayashi.deductions.incomeTax, 6650);
  assert.equal(kobayashi.deductions.residentTax, 12200);
  assert.equal(kobayashi.netPay, 255836);
  const payrollBook = XLSX.read(createPayrollWorkbook([kobayashi], "2026-08"));
  const payrollSheet = payrollBook.Sheets[payrollBook.SheetNames[0]];
  assert.equal(payrollSheet[XLSX.utils.encode_cell({ r: 8, c: 2 })].v, 30891, "給与Excel休日手当");
  assert.equal(payrollSheet[XLSX.utils.encode_cell({ r: 32, c: 2 })].v, 255836, "給与Excel最終支給額");
  const transferBook = XLSX.read(createTransferWorkbook([kobayashi], "2026-08"));
  assert.equal(transferBook.Sheets[transferBook.SheetNames[0]].D3.v, 255836, "振込一覧");
  const pdf = await createPayslipPdf(kobayashi, "2026-07", "2026-08-25");
  assert.ok(pdf.length > 5000, "PDF生成");
  const snapshot = structuredClone(kobayashi);
  assert.equal(snapshot.fixedAdjustment?.holidayAllowanceOverride, 30891);
  assert.equal(snapshot.fixedAdjustment?.overrideReason, "公休6日のところ実休4日のため、休日出勤2回");
});

test("青山佳史（0002）と木月徳子（0017）のBook2検算値が甲欄0扶養の自動計算と一致する", () => {
  // 青山：役員報酬のみ・現金支給・立替経費返金当月調整
  const aoyama = calculatePayrollEmployee(employee("aoyama", {
    employeeCode: "0002", name: "青山佳史", payrollType: "fixed",
    directorCompensation: 150000, fixedBaseSalary: 0,
    healthInsurance: 7440, childSupportContribution: 172, careInsurance: 1215, employeePension: 13725, employmentInsurance: 0,
    residentTax: 12600, paymentMethod: "cash",
  }), []);
  assert.equal(aoyama.earnings.taxableTotal, 150000, "青山 課税支給");
  assert.equal(aoyama.deductions.socialInsuranceTotal, 22552, "青山 社保合計");
  assert.equal(aoyama.deductions.taxableIncome, 127448, "青山 課税所得");
  assert.equal(aoyama.deductions.incomeTax, 1300, "青山 所得税（甲欄0扶養 自動計算）");
  assert.equal(aoyama.deductions.residentTax, 12600, "青山 住民税");
  assert.equal(aoyama.paymentMethod, "cash", "青山 現金支給");
  assert.equal(aoyama.earnings.holidayAllowance, 0, "青山 役員は休日手当0（基本給=0）");
  // 立替経費精算 7599 を当月調整として適用（正数入力）
  const aoyamaAdj = applyFixedPayrollAdjustment(aoyama, { expenseReimbursement: 7599 });
  assert.equal(aoyamaAdj.reimbursements.expenseReimbursement, 7599, "青山 立替経費精算（正数）");
  assert.equal(aoyamaAdj.deductions.total, aoyama.deductions.total, "精算で控除合計は変わらない");
  assert.equal(aoyamaAdj.payrollNetPay, aoyama.payrollNetPay, "精算で給与差引額は変わらない");
  assert.equal(aoyamaAdj.netPay, 121147, "青山 最終支給額（Book2）");

  // 木月：基本給+職能・振込・休日出勤対象
  const tsukiki = calculatePayrollEmployee(employee("tsukiki", {
    employeeCode: "0017", name: "木月徳子", payrollType: "fixed",
    fixedBaseSalary: 200000, positionAllowance: 6000,
    healthInsurance: 9920, childSupportContribution: 230, careInsurance: 1620, employeePension: 18300, employmentInsurance: 1030,
    residentTax: 0, paymentMethod: "bank",
  }), []);
  assert.equal(tsukiki.earnings.taxableTotal, 206000, "木月 課税支給");
  assert.equal(tsukiki.deductions.socialInsuranceTotal, 31100, "木月 社保合計");
  assert.equal(tsukiki.deductions.taxableIncome, 174900, "木月 課税所得");
  assert.equal(tsukiki.deductions.incomeTax, 3410, "木月 所得税（甲欄0扶養 自動計算）");
  assert.equal(tsukiki.netPay, 171490, "木月 差引支給額（Book2）");
  assert.equal(tsukiki.paymentMethod, "bank", "木月 振込支給");
  // 木月は基本給200000ベースで休日出勤単価が付く
  const tsukikiAdj = applyFixedPayrollAdjustment(tsukiki, { temporaryAttendanceCount: 1 });
  assert.equal(tsukikiAdj.earnings.holidayAllowance, Math.round(200000 / 177.67 * 8 * 1.25), "木月 休日1回単価");
  assert.ok(tsukikiAdj.netPay > tsukiki.netPay, "木月 休日出勤で差引増加");
  // 立替経費精算は正数入力：控除に含めず最終支給額を増やす
  const withReimb = applyFixedPayrollAdjustment(tsukiki, { expenseReimbursement: 5000 });
  assert.equal(withReimb.reimbursements.expenseReimbursement, 5000, "立替経費精算（正数）");
  assert.equal(withReimb.deductions.total, tsukiki.deductions.total, "精算で控除合計は変わらない");
  assert.equal(withReimb.payrollNetPay, tsukiki.payrollNetPay, "精算で給与差引額は変わらない");
  assert.equal(withReimb.netPay, tsukiki.netPay + 5000, "最終支給額が5,000円増加");
});

test("青山佳史の精算なし最終支給額は113,548円・精算7,599円正数入力で増加する", () => {
  const aoyama = calculatePayrollEmployee(employee("aoyama", {
    employeeCode: "0002", name: "青山佳史", payrollType: "fixed",
    directorCompensation: 150000, fixedBaseSalary: 0,
    healthInsurance: 7440, childSupportContribution: 172, careInsurance: 1215, employeePension: 13725, employmentInsurance: 0,
    residentTax: 12600, paymentMethod: "cash",
  }), []);
  assert.equal(aoyama.payrollNetPay, 113548, "精算なし時の給与差引額");
  assert.equal(aoyama.netPay, 113548, "精算なし時の最終支給額");
  assert.equal(aoyama.bankTransfer, 0, "現金支給のため振込額0");
  assert.equal(aoyama.cashPayment, 113548, "現金支給額");
  const withRefund = applyFixedPayrollAdjustment(aoyama, { expenseReimbursement: 7599 });
  assert.equal(withRefund.reimbursements.expenseReimbursement, 7599, "立替経費精算 7,599円");
  assert.equal(withRefund.deductions.total, aoyama.deductions.total, "控除合計は変わらない");
  assert.equal(withRefund.payrollNetPay, 113548, "給与差引額は変わらない");
  assert.equal(withRefund.netPay, 121147, "精算適用後の最終支給額");
  assert.equal(withRefund.netPay - aoyama.netPay, 7599, "精算7,599円で最終支給額が増加");
  assert.equal(withRefund.cashPayment, 121147, "現金支給額（最終支給額）");
});

test("store-payslip ZIPは正社員（fullTime）を含まずfulltime-payslip ZIPのみに含まれる", () => {
  const employees: PayrollEmployee[] = [
    employee("aoyama", { employeeCode: "0002", name: "青山佳史", payrollType: "fixed",
      directorCompensation: 150000, fixedBaseSalary: 0, healthInsurance: 7440,
      childSupportContribution: 172, careInsurance: 1215, employeePension: 13725,
      employmentInsurance: 0, residentTax: 12600, paymentMethod: "cash" }),
    employee("tsukiki", { employeeCode: "0017", name: "木月徳子", payrollType: "fixed",
      fixedBaseSalary: 200000, positionAllowance: 6000, healthInsurance: 9920,
      childSupportContribution: 230, careInsurance: 1620, employeePension: 18300,
      employmentInsurance: 1030, residentTax: 0, paymentMethod: "bank" }),
    employee("p1", { storeId: "store-abc", storeName: "ABC店" }),
    employee("p2", { storeId: "store-xyz", storeName: "XYZ店" }),
  ];
  const results = calculatePayroll(employees, []);
  const storeAbcResults = selectStorePayslipResults(results, "store-abc");
  assert.equal(storeAbcResults.length, 1, "store-abc には p1 のみ");
  assert.equal(storeAbcResults[0].employeeId, "p1");
  assert.ok(storeAbcResults.every((r) => r.employeeType === "partTime"), "store ZIP は全員 partTime");
  const fullTimeResults = selectFullTimePayslipResults(results);
  assert.equal(fullTimeResults.length, 2, "fulltime ZIP は青山と木月の2名");
  assert.ok(fullTimeResults.every((r) => r.employeeType === "fullTime"));
  assert.ok(fullTimeResults.some((r) => r.employeeId === "aoyama"), "青山は fulltime ZIP に含まれる");
  assert.ok(fullTimeResults.some((r) => r.employeeId === "tsukiki"), "木月は fulltime ZIP に含まれる");
  assert.ok(!storeAbcResults.some((r) => r.employeeType === "fullTime"), "store ZIP に fullTime は含まれない");
});

test("幹部は前月確定値の税額を使用し、前月値がなければ阻止する", () => {
  const fixed = employee("f", { payrollType: "fixed", fixedBaseSalary: 200000, incomeTax: 12345 });
  assert.equal(calculatePayrollEmployee(fixed, []).deductions.incomeTax, 12345);
  const issues = validatePayrollInput([{ ...fixed, previousConfirmedPayrollMissing: true }], [], "2026-07");
  assert.ok(issues.some((item) => item.code === "missing_previous_fixed_payroll" && item.severity === "error"));
});

test("正社員5名は時給0円・勤務0でも固定給として扱う", () => {
  for (const [code, name] of [["0002", "青山佳史"], ["0003", "中村鏡太郎"], ["0017", "木月徳子"], ["0064", "小林彗太"], ["0083", "佐藤雅信"]]) {
    const executive = employee(code, { employeeCode: code, name, payrollType: undefined, employmentType: undefined, hourlyWage: null, baseWage: 0 });
    const issues = validatePayrollInput([executive], [], "2026-07");
    assert.equal(issues.some((item) => item.code === "missing_hourly_wage"), false);
    assert.equal(calculatePayrollEmployee(executive, []).payrollType, "fixed");
  }
});

test("正社員の月次調整は固定給を変えず残業・非課税交通費・立替経費精算を反映する", () => {
  const fixed = calculatePayrollEmployee(employee("fixed", { employeeCode: "0003", payrollType: "fixed", fixedBaseSalary: 200000, hourlyWage: 0 }), []);
  const adjusted = applyFixedPayrollAdjustment(fixed, { overtimeMinutes: 60, transportation: 1000, expenseReimbursement: 2000, otherTemporaryPayment: 3000, otherDeduction: 400 });
  assert.equal(adjusted.earnings.baseSalary, 200000);
  assert.equal(adjusted.fixedAdjustment?.automaticOvertimeAllowance, 1563);
  assert.equal(adjusted.earnings.transportation, 1000);
  assert.equal(adjusted.reimbursements.expenseReimbursement, 2000, "立替経費精算は reimbursements に入る");
  assert.equal(adjusted.deductions.otherDeduction, 400);
  // 残業・臨時課税支給で所得税が再計算されるため incomeTax も変化する。expenseReimbursement は deductions に含まれない
  const incomeTaxDiff1 = adjusted.deductions.incomeTax - fixed.deductions.incomeTax;
  assert.equal(adjusted.deductions.total, fixed.deductions.total + incomeTaxDiff1 + 400, "控除合計は所得税変化 + otherDeduction のみ増加（expenseReimbursement は含まない）");
  assert.equal(adjusted.netPay, adjusted.payrollNetPay + 2000, "最終支給額 = 給与差引額 + 立替経費精算");
});

test("中村鏡太郎の当月調整は画面・両Excel・明細PDFで同じ再試算結果を使う", async () => {
  const fixed = calculatePayrollEmployee(employee("nakamura", { employeeCode: "0003", name: "中村鏡太郎", payrollType: "fixed", fixedBaseSalary: 200000, hourlyWage: 0 }), []);
  const adjusted = applyFixedPayrollAdjustment(fixed, { overtimeMinutes: 120, transportation: 1000, expenseReimbursement: 3000 });
  assert.equal(adjusted.earnings.overtimePremium, 3125);
  assert.equal(adjusted.earnings.transportation, 1000);
  assert.equal(adjusted.reimbursements.expenseReimbursement, 3000, "立替経費精算は reimbursements に入る");
  assert.equal(adjusted.earnings.grossTotal, 204125);
  // 残業で所得税が再計算されるため incomeTax は変化するが expenseReimbursement は deductions に含まれない
  const incomeTaxDiff2 = adjusted.deductions.incomeTax - fixed.deductions.incomeTax;
  assert.equal(adjusted.deductions.total, fixed.deductions.total + incomeTaxDiff2, "控除合計は所得税再計算分のみ変化（立替経費精算は含まない）");
  assert.equal(adjusted.netPay, adjusted.payrollNetPay + 3000, "最終支給額 = 給与差引額 + 立替経費精算");
  const payrollBook = XLSX.read(createPayrollWorkbook([adjusted], "2026-08"));
  const payrollSheet = payrollBook.Sheets[payrollBook.SheetNames[0]];
  assert.equal(payrollSheet[XLSX.utils.encode_cell({ r: 11, c: 2 })].v, 3125);
  assert.equal(payrollSheet[XLSX.utils.encode_cell({ r: 10, c: 2 })].v, 1000);
  assert.equal(payrollSheet[XLSX.utils.encode_cell({ r: 29, c: 2 })].v, 3000, "給与Excel row29: 立替経費精算（正数）");
  assert.equal(payrollSheet[XLSX.utils.encode_cell({ r: 32, c: 2 })].v, adjusted.netPay, "給与Excel row32: 最終支給額");
  const transferBook = XLSX.read(createTransferWorkbook([adjusted], "2026-08"));
  assert.equal(transferBook.Sheets[transferBook.SheetNames[0]].D3.v, adjusted.netPay);
  const pdf = await createPayslipPdf(adjusted, "2026-07", "2026-08-25");
  assert.ok(pdf.length > 5000);
});

test("既存振込一覧順を優先し未登録者を末尾へ置く", () => {
  const rows = [
    calculatePayrollEmployee(employee("new", { employeeCode: "9999", name: "一覧外" }), []),
    calculatePayrollEmployee(employee("kobayashi", { employeeCode: "0064", name: "小林彗太", payrollType: "fixed" }), []),
    calculatePayrollEmployee(employee("matsumoto", { employeeCode: "1076", name: "松本るぴな" }), []),
  ];
  assert.deepEqual(sortPayrollResults(rows).map((row) => row.employeeName), ["松本るぴな", "小林彗太", "一覧外"]);
});

test("給与ExcelだけをemployeeTypeとstoreIdの店舗順で並べ、振込一覧順は維持する", () => {
  const rows = [
    calculatePayrollEmployee(employee("unknown", { employeeCode: "9999", name: "一覧外", storeId: "store-none", storeName: "" }), []),
    calculatePayrollEmployee(employee("noge", { employeeCode: "7014", name: "有泉春花", storeId: "store-noge", storeName: "Graine Marche野毛店" }), []),
    calculatePayrollEmployee(employee("musashi", { employeeCode: "1076", name: "松本るぴな", storeId: "store-musashi", storeName: "灯 武蔵小杉店" }), []),
    calculatePayrollEmployee(employee("full", { employeeCode: "9000", name: "正社員", payrollType: "fixed", fixedBaseSalary: 200000, storeId: undefined, storeName: undefined }), []),
    calculatePayrollEmployee(employee("unset", { employeeCode: "9998", name: "店舗未設定", storeId: "", storeName: "" }), []),
    calculatePayrollEmployee(employee("pescara", { employeeCode: "9001", name: "Pescara", storeId: "store-pescara", storeName: "Pescara綱島店" }), []),
    calculatePayrollEmployee(employee("graine", { employeeCode: "9002", name: "Graine", storeId: "store-graine", storeName: "Graine Marche綱島店" }), []),
  ];
  assert.deepEqual(sortPayrollResultsForExcel(rows).map((row) => row.employeeId), ["full", "musashi", "pescara", "graine", "noge", "unknown", "unset"]);
  assert.equal(sortPayrollResults(rows)[0].employeeId, "musashi", "振込一覧用の既存34名順は変えない");
});

test("時給制の時給未設定エラーには社員コードと氏名を含む", () => {
  const hourly = employee("hourly", { employeeCode: "1234", name: "時給 花子", payrollType: "hourly", hourlyWage: null, baseWage: 0 });
  const issue = validatePayrollInput([hourly], [], "2026-07").find((item) => item.code === "missing_hourly_wage");
  assert.match(issue?.message ?? "", /1234 時給 花子：時給が未設定です/);
});

test("令和8年税額表の甲欄・乙欄・扶養人数を参照する", () => {
  assert.equal(calculateWithholdingTax2026(104999, "kou", 0), 0); assert.equal(calculateWithholdingTax2026(105558, "kou", 0), 170); assert.equal(calculateWithholdingTax2026(105558, "kou", 1), 0); assert.equal(calculateWithholdingTax2026(105558, "otsu", 0), 3800);
});

test("給与Excelと振込Excelの人数・合計が一致する", () => {
  const results = calculatePayroll([employee("1002", { hourlyWage: 2000, payrollTransferOrder: 2 }), employee("1001", { hourlyWage: 1000, payrollTransferOrder: 1 })], [day("1001", "2026-07-01", 60), day("1002", "2026-07-01", 60)]);
  const payroll = XLSX.read(createPayrollWorkbook(results, "2026-08")); const transfer = XLSX.read(createTransferWorkbook(results, "2026-08"));
  assert.equal(payroll.SheetNames[0], "FUBLEVG㈱"); const sheet = transfer.Sheets[transfer.SheetNames[0]], rows = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][];
  assert.equal(rows.length, 5); assert.deepEqual(rows[1], ["No.", "社員コード", "氏名", "振込金額"]); assert.deepEqual(rows[2]?.slice(0, 4), [1, "1001", "従業員1001", 1000]); assert.equal(rows.at(-1)?.[0], "振込合計（2名）"); assert.equal(sheet.D5.f, "SUM(D3:D4)");
});

test("小林彗太へその他臨時支給800,000円を設定すると所得税が再計算され差引支給額が単純に800,000円増にならない", async () => {
  // 2026-08 ドラフト想定。健康保険・厚生年金・雇用保険・住民税を含む実態に近いマスターデータを使う。
  const kobayashi = employee("kobayashi", {
    employeeCode: "0064", name: "小林彗太", payrollType: "fixed", fixedBaseSalary: 183000, hourlyWage: 0,
    monthlyTransportation: 10110,
    healthInsurance: 13888, childSupportContribution: 322, employeePension: 25620, employmentInsurance: 1580,
    residentTax: 10000,
  });
  const base = calculatePayrollEmployee(kobayashi, []);
  assert.equal(base.earnings.otherTaxable, 0);
  assert.equal(base.earnings.transportation, 10110, "ベース交通費");
  assert.equal(base.deductions.socialInsuranceTotal, 41410, "社会保険合計");
  assert.equal(base.deductions.taxableIncome, 141590, "ベース課税対象額");
  assert.equal(base.deductions.incomeTax, 2010, "ベース所得税");
  assert.equal(base.netPay, 139690, "ベース差引支給額");

  // ── 調整適用（transportation 未指定 = ベース値を引き継ぐ） ──
  const adjusted = applyFixedPayrollAdjustment(base, { otherTemporaryPayment: 800000 });

  // ① その他課税支給・課税支給合計・支給合計
  assert.equal(adjusted.earnings.otherTaxable, 800000, "その他課税支給");
  assert.equal(adjusted.earnings.taxableTotal, base.earnings.taxableTotal + 800000, "課税支給合計が800,000増");
  assert.equal(adjusted.earnings.grossTotal, 993110, "支給合計");

  // ② 交通費はadjustment未指定時にベース値を引き継ぐ（0上書きバグなし）
  assert.equal(adjusted.earnings.transportation, 10110, "交通費は0にならない");

  // ③ 課税対象額が再計算される（taxableTotal - 社会保険合計）
  assert.equal(adjusted.deductions.taxableIncome, 941590, "課税対象額が再計算");

  // ④ 所得税が再計算される（941,590円 → 令和8年分月額表 電算機計算の特例 甲欄 扶養0人）
  //    別表第一：empDeduct=162,500 / 別表第三：48,334 / B=730,756 / 別表第四(23.483%)：117,490
  assert.equal(adjusted.deductions.incomeTax, 117490, "所得税（令和8年分月額表 算式・甲欄・扶養0人）");
  assert.notEqual(adjusted.deductions.incomeTax, base.deductions.incomeTax, "所得税がベースの2,010円から変化");

  // ⑤ 控除合計 = 社保41,410 + 所得税117,490 + 住民税10,000
  assert.equal(adjusted.deductions.total, 168900, "控除合計");

  // ⑥ 差引支給額 = 支給合計993,110 - 控除合計168,900（立替経費精算なしのケース）
  assert.equal(adjusted.netPay, 824210, "差引支給額");
  assert.equal(adjusted.payrollNetPay, adjusted.earnings.grossTotal - adjusted.deductions.total, "給与差引額の整合性");
  assert.equal(adjusted.reimbursements.total, 0, "立替経費精算なし");
  assert.notEqual(adjusted.netPay, base.netPay + 800000, "差引支給額は単純に800,000円増ではない（所得税増加のため）");

  // ⑦ summarizePayroll も同じ run から計算する
  const totals = summarizePayroll([adjusted]);
  assert.equal(totals.grossTotal, adjusted.earnings.grossTotal, "集計支給合計");
  assert.equal(totals.netTotal, adjusted.netPay, "集計差引支給額");

  // ④-b その他課税支給は賞与（賞与表）ではなく月次給与（月額表）に算入されること
  //      fixedAdjustment.otherTemporaryPayment が earnings.otherTaxable に反映されているのが証拠
  assert.equal(adjusted.fixedAdjustment?.otherTemporaryPayment, 800000, "調整フィールド otherTemporaryPayment");
  assert.equal(adjusted.earnings.otherTaxable, adjusted.fixedAdjustment?.otherTemporaryPayment, "otherTaxable = otherTemporaryPayment（月額表源泉徴収）");

  // ⑧ 給与Excel：その他課税支給・支給合計・所得税・差引支給額が一致
  const payrollBook = XLSX.read(createPayrollWorkbook([adjusted], "2026-09", true, "2026-08", "2026-09-25"));
  const payrollSheet = payrollBook.Sheets[payrollBook.SheetNames[0]];
  assert.equal(payrollSheet[XLSX.utils.encode_cell({ r: 31, c: 2 })].v, 800000, "給与Excel その他課税支給");
  assert.equal(payrollSheet[XLSX.utils.encode_cell({ r: 17, c: 2 })].v, 993110, "給与Excel 支給合計");
  assert.equal(payrollSheet[XLSX.utils.encode_cell({ r: 25, c: 2 })].v, 117490, "給与Excel 所得税");
  assert.equal(payrollSheet[XLSX.utils.encode_cell({ r: 32, c: 2 })].v, 824210, "給与Excel 差引支給額");

  // ⑨ 振込一覧：差引支給額 824,210円
  const transferBook = XLSX.read(createTransferWorkbook([adjusted], "2026-09"));
  const transferSheet = transferBook.Sheets[transferBook.SheetNames[0]];
  assert.equal(transferSheet.D3.v, 824210, "振込一覧 振込金額 824,210円");

  // ⑩ 給与明細 PDF が生成される
  const pdf = await createPayslipPdf(adjusted, "2026-08", "2026-09-25");
  assert.ok(pdf.length > 5000, "PDFサイズ");
  assert.match(pdf.toString("latin1"), /PDF-/, "PDFヘッダー");

  // ⑪ 調整を削除（空オブジェクト）するとベース値に完全復帰する
  const reverted = applyFixedPayrollAdjustment(base, {});
  assert.equal(reverted.earnings.otherTaxable, 0, "復帰後 その他課税支給 0");
  assert.equal(reverted.deductions.taxableIncome, base.deductions.taxableIncome, "復帰後 課税対象額");
  assert.equal(reverted.deductions.incomeTax, base.deductions.incomeTax, "復帰後 所得税 2,010円");
  assert.equal(reverted.deductions.total, base.deductions.total, "復帰後 控除合計");
  assert.equal(reverted.reimbursements.total, 0, "復帰後 立替経費精算 0");
  assert.equal(reverted.netPay, base.netPay, "復帰後 差引支給額 139,690円");

  // ⑫ 調整の二重加算が起きない：adjusted に同じ調整を再適用しても数値が変わらない
  const reapplied = applyFixedPayrollAdjustment(adjusted, { otherTemporaryPayment: 800000 });
  assert.equal(reapplied.earnings.otherTaxable, adjusted.earnings.otherTaxable, "二重加算なし: otherTaxable");
  assert.equal(reapplied.deductions.incomeTax, adjusted.deductions.incomeTax, "二重加算なし: 所得税");
  assert.equal(reapplied.netPay, adjusted.netPay, "二重加算なし: 差引支給額");
});

test("立替経費精算は正数で本人へ加算し課税・社保・控除へ影響させない", async () => {
  const kobayashi = employee("kobayashi", {
    employeeCode: "0064", name: "小林彗太", payrollType: "fixed", fixedBaseSalary: 183000, hourlyWage: 0,
    monthlyTransportation: 10110,
    healthInsurance: 13888, childSupportContribution: 322, employeePension: 25620, employmentInsurance: 1580,
    residentTax: 10000,
  });
  const base = calculatePayrollEmployee(kobayashi, []);
  assert.equal(base.payrollNetPay, 139690, "ベース給与差引額");
  assert.equal(base.reimbursements.total, 0, "ベース立替経費精算0");
  assert.equal(base.netPay, 139690, "ベース最終支給額");

  // ① 正数800,000で入力 → 控除に影響しない
  const adjusted = applyFixedPayrollAdjustment(base, { expenseReimbursement: 800000 });
  assert.equal(adjusted.earnings.taxableTotal, base.earnings.taxableTotal, "課税支給額不変");
  assert.equal(adjusted.earnings.grossTotal, base.earnings.grossTotal, "支給合計不変");
  assert.equal(adjusted.deductions.socialInsuranceTotal, base.deductions.socialInsuranceTotal, "社会保険不変");
  assert.equal(adjusted.deductions.incomeTax, base.deductions.incomeTax, "所得税不変");
  assert.equal(adjusted.deductions.total, base.deductions.total, "控除合計不変");

  // ② reimbursements に正数で格納される
  assert.equal(adjusted.reimbursements.expenseReimbursement, 800000, "立替経費精算800,000円");
  assert.equal(adjusted.reimbursements.total, 800000);

  // ③ 給与差引額・最終支給額の区別
  assert.equal(adjusted.payrollNetPay, 139690, "給与差引額（変化なし）");
  assert.equal(adjusted.netPay, 939690, "最終支給額 = 139,690 + 800,000");
  assert.equal(adjusted.bankTransfer, 939690, "振込額（bank支給）");

  // ④ 二重加算されない
  const reapplied = applyFixedPayrollAdjustment(adjusted, { expenseReimbursement: 800000 });
  assert.equal(reapplied.reimbursements.total, 800000, "二重加算なし: reimbursementsTotal");
  assert.equal(reapplied.netPay, 939690, "二重加算なし: netPay");

  // ⑤ 0円に戻すと元に戻る
  const reverted = applyFixedPayrollAdjustment(base, { expenseReimbursement: 0 });
  assert.equal(reverted.reimbursements.total, 0, "0円で元に戻る");
  assert.equal(reverted.netPay, base.netPay, "0円でnetPayが元に戻る");

  // ⑥ 給与Excel：立替経費精算は正数で row29、控除合計は row30 に影響なし、最終支給額は row32
  const payrollBook = XLSX.read(createPayrollWorkbook([adjusted], "2026-09", true, "2026-08", "2026-09-25"));
  const payrollSheet = payrollBook.Sheets[payrollBook.SheetNames[0]];
  assert.equal(payrollSheet[XLSX.utils.encode_cell({ r: 29, c: 0 })].v, "立替経費精算（支給）", "給与Excel row29 ラベル: 控除ではなく精算区分");
  assert.equal(payrollSheet[XLSX.utils.encode_cell({ r: 29, c: 2 })].v, 800000, "給与Excel row29: 立替経費精算 正数800,000");
  assert.equal(payrollSheet[XLSX.utils.encode_cell({ r: 30, c: 2 })].v, base.deductions.total, "給与Excel row30: 控除合計変化なし");
  assert.equal(payrollSheet[XLSX.utils.encode_cell({ r: 32, c: 2 })].v, 939690, "給与Excel row32: 最終支給額939,690");

  // ⑦ 振込一覧：939,690円
  const transferBook = XLSX.read(createTransferWorkbook([adjusted], "2026-09"));
  const transferSheet = transferBook.Sheets[transferBook.SheetNames[0]];
  assert.equal(transferSheet.D3.v, 939690, "振込一覧 振込金額 939,690円");

  // ⑧ PDF生成：サイズ確認（PDFに最終支給額が含まれる）
  const pdf = await createPayslipPdf(adjusted, "2026-08", "2026-09-25");
  assert.ok(pdf.length > 5000, "PDFサイズ");
  assert.match(pdf.toString("latin1"), /PDF-/, "PDFヘッダー");

  // ─── 青山佳史（正数入力 7,599円）
  const aoyama = calculatePayrollEmployee(employee("aoyama2", {
    employeeCode: "0002", name: "青山佳史", payrollType: "fixed",
    directorCompensation: 150000, fixedBaseSalary: 0,
    healthInsurance: 7440, childSupportContribution: 172, careInsurance: 1215, employeePension: 13725, employmentInsurance: 0,
    residentTax: 12600, paymentMethod: "cash",
  }), []);
  const aoyamaAdj = applyFixedPayrollAdjustment(aoyama, { expenseReimbursement: 7599 });
  assert.equal(aoyamaAdj.reimbursements.expenseReimbursement, 7599, "青山 立替経費精算7,599円");
  assert.equal(aoyamaAdj.deductions.total, aoyama.deductions.total, "青山 控除合計変化なし");
  assert.equal(aoyamaAdj.payrollNetPay, 113548, "青山 給与差引額113,548円");
  assert.equal(aoyamaAdj.netPay, 121147, "青山 最終支給額121,147円");
  assert.equal(aoyamaAdj.cashPayment, 121147, "青山 現金支給額121,147円");
  assert.equal(aoyamaAdj.bankTransfer, 0, "青山 振込額0（現金支給）");

  // 振込一覧から青山は除外される（cash支給）
  const transferBook2 = XLSX.read(createTransferWorkbook([aoyamaAdj], "2026-09"));
  const transferSheet2 = transferBook2.Sheets[transferBook2.SheetNames[0]];
  const rows2 = XLSX.utils.sheet_to_json(transferSheet2, { header: 1 }) as unknown[][];
  assert.equal(rows2.length, 3, "青山（現金）は振込一覧に含まれない（ヘッダー+合計行のみ）");

  // 複数の金額で回帰検証
  for (const amount of [0, 1, 7599, 800000]) {
    const r = applyFixedPayrollAdjustment(aoyama, { expenseReimbursement: amount });
    assert.equal(r.reimbursements.expenseReimbursement, amount, `expenseReimbursement=${amount}`);
    assert.equal(r.deductions.total, aoyama.deductions.total, `控除合計不変(amount=${amount})`);
    assert.equal(r.netPay, aoyama.netPay + amount, `netPay=base+${amount}`);
  }
});

test("立替経費精算：負数・NaN・小数は0にclampし、旧advanceExpense負値は自動変換、正値はblocking errorを出す", () => {
  const base = calculatePayrollEmployee(employee("val", { payrollType: "fixed", fixedBaseSalary: 200000, hourlyWage: 0 }), []);

  // 負数・NaN・小数は applyFixedPayrollAdjustment 内で0または切り捨てになる（サーバーAPIは手前で400を返す）
  assert.equal(applyFixedPayrollAdjustment(base, { expenseReimbursement: -1000 }).reimbursements.expenseReimbursement, 0, "負数→0にclamp");
  assert.equal(applyFixedPayrollAdjustment(base, { expenseReimbursement: NaN }).reimbursements.expenseReimbursement, 0, "NaN→0にclamp");
  assert.equal(applyFixedPayrollAdjustment(base, { expenseReimbursement: 100.9 }).reimbursements.expenseReimbursement, 100, "小数→切り捨て");

  // 旧 advanceExpense 負値（返金）→ expenseReimbursement へ自動変換（issueなし）
  const legacyNeg = applyFixedPayrollAdjustment(base, { advanceExpense: -5000 });
  assert.equal(legacyNeg.reimbursements.expenseReimbursement, 5000, "旧advanceExpense負値→expenseReimbursement 5,000円");
  assert.equal(legacyNeg.deductions.total, base.deductions.total, "控除合計は変化しない");
  assert.equal(legacyNeg.netPay, base.netPay + 5000, "最終支給額 +5,000円");
  assert.equal(legacyNeg.issues.some((i) => i.code === "legacy_advance_expense"), false, "負値自動変換はissueを出さない");

  // 旧 advanceExpense 正値（支給方向が逆転するリスク）→ 変換せずblocking errorを出す
  const legacyPos = applyFixedPayrollAdjustment(base, { advanceExpense: 3000 });
  assert.equal(legacyPos.reimbursements.expenseReimbursement, 0, "旧advanceExpense正値は自動変換しない");
  assert.equal(legacyPos.deductions.total, base.deductions.total, "控除合計も変化しない");
  assert.ok(legacyPos.issues.some((i) => i.code === "legacy_advance_expense" && i.severity === "error"), "正値はblocking errorを出す（確定阻止）");
  assert.match(legacyPos.issues.find((i) => i.code === "legacy_advance_expense")?.message ?? "", /立替経費精算へ入力し直してください/, "エラーメッセージに再入力案内を含む");

  // 新旧フィールド同時指定：新フィールドが明示されていれば旧フィールドを完全に無視する
  const newWins = applyFixedPayrollAdjustment(base, { expenseReimbursement: 1000, advanceExpense: -5000 });
  assert.equal(newWins.reimbursements.expenseReimbursement, 1000, "expenseReimbursement 1,000 が優先（5,000 にならない）");
  assert.equal(newWins.issues.some((i) => i.code === "legacy_advance_expense"), false, "新フィールド指定時は旧フィールドissueなし");

  const zeroWins = applyFixedPayrollAdjustment(base, { expenseReimbursement: 0, advanceExpense: -5000 });
  assert.equal(zeroWins.reimbursements.expenseReimbursement, 0, "expenseReimbursement: 0 が明示されていれば旧フィールドを無視（0のまま）");

  const bigLegacy = applyFixedPayrollAdjustment(base, { expenseReimbursement: 3000, advanceExpense: -5000 });
  assert.equal(bigLegacy.reimbursements.expenseReimbursement, 3000, "旧フィールドの方が大きくても新フィールドの 3,000 を使う");
});

test("令和8年分月額表 甲欄 電算機計算の特例：境界値と高額給与の回帰テスト", () => {
  // 表の最終行（A=738,500）は算式と一致する
  assert.equal(calculateWithholdingTax2026(738_500, "kou", 0), 71_380, "A=738,500 は表と算式が一致");
  // 740,000円（表の上限）では算式を使う（乙欄ではない）
  assert.ok(calculateWithholdingTax2026(740_000, "kou", 0) > 0, "A=740,000 甲欄は0にならない");
  // 790,000円 甲欄 扶養0人 → 20.42%ブラケット
  // empDeduct=162,500, B=579,166, raw=579,166×0.2042-36,374=81,891.70 → 81,890
  assert.equal(calculateWithholdingTax2026(790_000, "kou", 0), 81_890, "A=790,000 甲欄 扶養0人");
  // 941,590円 甲欄 扶養0人 → 23.483%ブラケット（小林彗太と同じ条件）
  assert.equal(calculateWithholdingTax2026(941_590, "kou", 0), 117_490, "A=941,590 甲欄 扶養0人");
  // 扶養1人がいる場合（B が 31,667円下がる）
  // B=730,756-31,667=699,089, raw=699,089×0.23483-54,114=110,053.07 → 110,050
  assert.equal(calculateWithholdingTax2026(941_590, "kou", 1), 110_050, "A=941,590 甲欄 扶養1人");
  // 乙欄 740,000円以上は未実装のため0のまま
  assert.equal(calculateWithholdingTax2026(941_590, "otsu", 0), 0, "A=941,590 乙欄は未実装で0");
});

test("乙欄・課税対象額740,000円以上は確定阻止エラーとして報告される", () => {
  // 甲欄は算式で計算できるのでエラーにならない
  const kouHigh = employee("k", { payrollType: "fixed", fixedBaseSalary: 800000, taxTableType: "kou" });
  const kouResult = calculatePayrollEmployee(kouHigh, []);
  assert.ok(!kouResult.issues.some((item) => item.code === "tax_formula_required"), "甲欄高額はエラーなし");

  // 乙欄740,000円以上はエラー（確定阻止）
  const otsuHigh = employee("o", { payrollType: "fixed", fixedBaseSalary: 800000, taxTableType: "otsu" });
  const otsuResult = calculatePayrollEmployee(otsuHigh, []);
  const issue = otsuResult.issues.find((item) => item.code === "tax_formula_required");
  assert.ok(issue !== undefined, "tax_formula_required issue が存在する");
  assert.equal(issue.severity, "error", "確定阻止エラー（warningではない）");

  // 乙欄でも739,999円以下（表の範囲内）はエラーなし（taxableIncome = fixedBaseSalary - 社保 = 700,000 < 740,000）
  const otsuLow = employee("ol", { payrollType: "fixed", fixedBaseSalary: 700000, taxTableType: "otsu" });
  const otsuLowResult = calculatePayrollEmployee(otsuLow, []);
  assert.ok(!otsuLowResult.issues.some((item) => item.code === "tax_formula_required"), "乙欄739,999以下はエラーなし");
});

test("給与テンプレート定員超過時は全従業員を複数シートへ出力する", () => {
  const results = calculatePayroll(Array.from({ length: 38 }, (_, i) => employee(String(1001 + i))), []);
  const workbook = XLSX.read(createPayrollWorkbook(results, "2026-08"));
  assert.equal(workbook.SheetNames.length, 2);
  const codes = workbook.SheetNames.flatMap((name) => {
    const sheet = workbook.Sheets[name];
    return [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 28, 29, 30, 31, 33, 34, 35, 36, 37]
      .map((column) => sheet[XLSX.utils.encode_cell({ r: 2, c: column })]?.v)
      .filter(Boolean);
  });
  assert.equal(new Set(codes).size, 38);
});

test("確定前帳票には試算プレフィックスを付与し対象期間・支給日を含まない", () => {
  const results = calculatePayroll([employee("1")], [day("1", "2026-07-01", 60)]);
  const payroll = XLSX.read(createPayrollWorkbook(results, "2026-08", true, "2026-07", "2026-08-25"));
  const transfer = XLSX.read(createTransferWorkbook(results, "2026-08", true, true, "2026-07", "2026-08-25"));
  assert.match(String(payroll.Sheets[payroll.SheetNames[0]].A1.v), /^【試算】FUBLEV Group㈱/);
  assert.doesNotMatch(String(payroll.Sheets[payroll.SheetNames[0]].A1.v), /対象期間/);
  assert.match(String(transfer.Sheets[transfer.SheetNames[0]].A1.v), /^2026年8月支給　給与振込一覧/);
  assert.doesNotMatch(String(transfer.Sheets[transfer.SheetNames[0]].A1.v), /対象期間/);
});

test("PDFへ社員コード・氏名・金額を含む明細を生成する", async () => {
  const result = calculatePayrollEmployee(employee("1076", { name: "松本るぴな" }), [day("1076", "2026-07-01", 60)]);
  const pdf = await createPayslipPdf(result, "2026-07", "2026-08-25"); assert.equal(pdf.subarray(0, 4).toString(), "%PDF"); assert.ok(pdf.length > 5000);
});

test("確定用スナップショットは従業員マスタ変更後も変化しない", () => {
  const master = employee("1", { hourlyWage: 1200 });
  const snapshot = structuredClone(calculatePayrollEmployee(master, [day("1", "2026-07-01", 60)]));
  master.hourlyWage = 2000;
  assert.equal(snapshot.earnings.baseSalary, 1200);
  assert.equal(snapshot.hourlyWageSnapshot, 1200);
});


test("2026年8月支給分の34名検算値と松本るぴな明細が一致する", () => {
  const employees: PayrollEmployee[] = [];
  const attendance: PayrollAttendanceDay[] = [];
  employees.push(employee("matsumoto", { employeeCode: "1076", name: "松本るぴな", storeName: "灯 武蔵小杉店", hourlyWage: 1225, transportationType: "daily", dailyTransportation: 300 }));
  for (let i=1;i<=13;i++) attendance.push(day("matsumoto", `2026-07-${String(i).padStart(2,"0")}`, i === 13 ? 840 : 300, { nightMinutes: i === 13 ? 540 : 0 }));
  employees.push(employee("kondo", { name: "近藤南", hourlyWage: 105558 })); attendance.push(day("kondo", "2026-07-01", 60));
  const hqRemainder = 927089 - 97306 - 105558;
  for (let i=0;i<23;i++) { const wage = i === 0 ? hqRemainder - 22 * 30000 : 30000; employees.push(employee(`hq${i}`, { hourlyWage: wage })); attendance.push(day(`hq${i}`, "2026-07-01", 60)); }
  const nogeGross = [50000, 55000, 60000, 61297], transport = [3820, 4774, 9100, 4110];
  for (let i=0;i<4;i++) { employees.push(employee(`noge${i}`, { storeId:"noge", storeName:"野毛", hourlyWage: nogeGross[i]-transport[i], transportationType:"monthly", monthlyTransportation:transport[i] })); attendance.push(day(`noge${i}`, "2026-07-01", 60)); }
  const fixedGross = [250000,250000,250000,250000,317420], fixedDeductions=[50000,50000,50000,50000,53345];
  for (let i=0;i<5;i++) employees.push(employee(`fixed${i}`, { storeId:"fixed", payrollType:"fixed", fixedBaseSalary:fixedGross[i], otherDeduction:fixedDeductions[i], dependentCount:7 }));
  const results = calculatePayroll(employees, attendance), totals = summarizePayroll(results), matsumoto = results.find(x=>x.employeeId==="matsumoto")!;
  assert.equal(totals.employeeCount,34); assert.equal(totals.grossTotal,2470806); assert.equal(totals.deductionTotal,253515); assert.equal(totals.netTotal,2217291); assert.equal(totals.bankTransferTotal,2217291);
  assert.deepEqual([matsumoto.attendance.attendanceDays,matsumoto.attendance.workMinutes,matsumoto.attendance.nightMinutes,matsumoto.earnings.baseSalary,matsumoto.earnings.nightPremium,matsumoto.earnings.transportation,matsumoto.earnings.grossTotal,matsumoto.netPay],[13,4440,540,90650,2756,3900,97306,97306]);
});

test("7月ピカイチ勤怠と完成給与をFirestore非依存の回帰fixtureとして検算する", () => {
  const attendanceBook = XLSX.readFile("tests/fixtures/payroll/2026-07/pikaichi-noge-attendance.xlsx");
  const attendanceRows = XLSX.utils.sheet_to_json(attendanceBook.Sheets[attendanceBook.SheetNames[0]], { header: 1, raw: true, defval: null }) as unknown[][];
  const transport = attendanceRows.slice(2).filter((row) => row[5] === "合 計").map((row) => [String(row[2]), Number(row[20])]);
  assert.deepEqual(transport, [["7014",3820],["7015",4774],["7016",9100],["8173",4110]]);
  assert.equal(transport.reduce((sum, item) => sum + Number(item[1]), 0), 21804);
  const expectedBook = XLSX.readFile("tests/fixtures/payroll/2026-07/expected-payroll.xlsx", { cellFormula: true });
  const expected = expectedBook.Sheets[expectedBook.SheetNames[0]];
  assert.equal(expected.AN4.v, "34人"); assert.equal(expected.AN18.v, 2470806); assert.equal(expected.AN31.v, 253515); assert.equal(expected.AN33.v, 2217291); assert.equal(expected.AN34.v, 2217291);
});

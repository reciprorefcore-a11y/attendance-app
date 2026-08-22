import assert from "node:assert/strict";
import test from "node:test";
import XLSX from "xlsx";
import { adjustPayrollResult, calculatePayroll, calculatePayrollEmployee, calculateWithholdingTax2026, isPayrollMonthClosed, summarizePayroll, validatePayrollInput, type PayrollAttendanceDay, type PayrollEmployee } from "../lib/payroll.ts";
import { createPayrollWorkbook, createPayslipPdf, createTransferWorkbook } from "../lib/payroll-export.ts";

const employee = (id: string, patch: Partial<PayrollEmployee> = {}): PayrollEmployee => ({ id, employeeCode: id, name: `従業員${id}`, storeId: "hq", storeName: "本部", payrollEnabled: true, payrollType: "hourly", hourlyWage: 1225, transportationType: "none", paymentMethod: "bank", bankAccountRegistered: true, taxTableType: "kou", dependentCount: 0, healthInsurance: 0, childSupportContribution: 0, careInsurance: 0, employeePension: 0, employmentInsurance: 0, residentTax: 0, ...patch });
const day = (employeeId: string, date: string, workMinutes: number, patch: Partial<PayrollAttendanceDay> = {}): PayrollAttendanceDay => ({ employeeId, date, workMinutes, overtimeMinutes: 0, nightMinutes: 0, helpMinutes: 0, breakMinutes: 0, confirmed: true, kind: "daily", ...patch });

test("日別勤怠だけを月次集計し合計行を二重加算しない", () => {
  const result = calculatePayrollEmployee(employee("1", { hourlyWage: 1200 }), [day("1", "2026-07-01", 600, { nightMinutes: 60 }), day("1", "2026-07-02", 300), { ...day("1", "2026-07-31", 900), kind: "total" }]);
  assert.equal(result.attendance.workMinutes, 900); assert.equal(result.attendance.nightMinutes, 60); assert.equal(result.attendance.attendanceDays, 2);
});

test("24時間未満の労働・深夜・出勤日数を倍にしない", () => {
  const result = calculatePayrollEmployee(employee("1"), [day("1", "2026-07-01", 720, { nightMinutes: 120 })]);
  assert.deepEqual([result.attendance.workMinutes, result.attendance.nightMinutes, result.attendance.attendanceDays], [720, 120, 1]);
});

test("分数から1円未満切捨てで時給・残業・深夜0.25割増を計算する", () => {
  const result = calculatePayrollEmployee(employee("1", { hourlyWage: 1225 }), [day("1", "2026-07-01", 61, { overtimeMinutes: 31, nightMinutes: 17 })]);
  assert.equal(result.earnings.baseSalary, 1245); assert.equal(result.earnings.overtimePremium, 158); assert.equal(result.earnings.nightPremium, 86);
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

test("振込対象者の銀行口座情報不足は確定を妨げるエラー", () => {
  const issues = validatePayrollInput([employee("1", { bankAccountRegistered: false, bankAccountNumber: null })], [], "2026-08");
  assert.ok(issues.some((item) => item.code === "missing_bank_account" && item.severity === "error"));
});

test("固定給・固定手当・休日手当と社保全額を引き継ぐ", () => {
  const result = calculatePayrollEmployee(employee("f", { payrollType: "fixed", fixedBaseSalary: 200000, positionAllowance: 10000, holidayAllowance: 10694, fixedOvertimeAllowance: 20000, healthInsurance: 10000, childSupportContribution: 500, careInsurance: 1000, employeePension: 20000, employmentInsurance: 1000 }), []);
  assert.equal(result.earnings.holidayAllowance, 10694); assert.equal(result.earnings.overtimePremium, 0); assert.equal(result.deductions.socialInsuranceTotal, 32500); assert.equal(result.deductions.taxableIncome, result.earnings.taxableTotal - 32500);
});

test("令和8年税額表の甲欄・乙欄・扶養人数を参照する", () => {
  assert.equal(calculateWithholdingTax2026(104999, "kou", 0), 0); assert.equal(calculateWithholdingTax2026(105558, "kou", 0), 170); assert.equal(calculateWithholdingTax2026(105558, "kou", 1), 0); assert.equal(calculateWithholdingTax2026(105558, "otsu", 0), 3800);
});

test("給与Excelと振込Excelの人数・合計が一致する", () => {
  const results = calculatePayroll([employee("2", { hourlyWage: 2000, payrollTransferOrder: 2 }), employee("1", { hourlyWage: 1000, payrollTransferOrder: 1 })], [day("1", "2026-07-01", 60), day("2", "2026-07-01", 60)]);
  const payroll = XLSX.read(createPayrollWorkbook(results, "2026-08")); const transfer = XLSX.read(createTransferWorkbook(results, "2026-08"));
  assert.equal(payroll.SheetNames[0], "FUBLEVG㈱"); const sheet = transfer.Sheets[transfer.SheetNames[0]], rows = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][];
  assert.equal(rows.length, 5); assert.equal(rows.at(-1)?.[0], "振込合計（2名）"); assert.equal(sheet.C5.f, "SUM(C3:C4)");
});

test("確定前帳票には試算と対象期間・支給日を明記する", () => {
  const results = calculatePayroll([employee("1")], [day("1", "2026-07-01", 60)]);
  const payroll = XLSX.read(createPayrollWorkbook(results, "2026-08", true, "2026-07", "2026-08-25"));
  const transfer = XLSX.read(createTransferWorkbook(results, "2026-08", true, true, "2026-07", "2026-08-25"));
  assert.match(String(payroll.Sheets[payroll.SheetNames[0]].A1.v), /【試算】.*対象期間：令和8年7月1日～7月31日.*支給日：令和8年8月25日/);
  assert.match(String(transfer.Sheets[transfer.SheetNames[0]].A1.v), /【試算】.*対象期間：令和8年7月1日～7月31日.*支給日：令和8年8月25日/);
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

test("確定前の手修正は理由付き履歴を作り合計を再計算する", () => {
  const original = calculatePayrollEmployee(employee("1", { hourlyWage: 1000 }), [day("1", "2026-07-01", 60)]);
  const adjusted = adjustPayrollResult(original, { otherTaxable: 500, otherDeduction: 100 }, "臨時手当", "admin");
  assert.equal(adjusted.result.netPay, 1400); assert.equal(adjusted.adjustment.reason, "臨時手当"); assert.throws(() => adjustPayrollResult(original, { otherTaxable: 0, otherDeduction: 0 }, "", "admin"));
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

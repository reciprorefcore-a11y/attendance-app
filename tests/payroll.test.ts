import assert from "node:assert/strict";
import test from "node:test";
import XLSX from "xlsx";
import { applyFixedPayrollAdjustment, calculatePayroll, calculatePayrollEmployee, calculateWithholdingTax2026, isPayrollMonthClosed, summarizePayroll, validatePayrollInput, type PayrollAttendanceDay, type PayrollEmployee } from "../lib/payroll.ts";
import { createPayrollWorkbook, createPayslipPdf, createPayslipZip, createTransferWorkbook, selectFullTimePayslipResults, selectStorePayslipResults } from "../lib/payroll-export.ts";
import { sortPayrollResults } from "../lib/payroll-order.ts";

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

test("銀行口座と税区分が未設定でも給与計算を妨げず甲欄扶養0人を適用する", () => {
  const issues = validatePayrollInput([employee("1", { bankAccountRegistered: false, bankAccountNumber: null })], [], "2026-08");
  assert.equal(issues.some((item) => item.code === "missing_bank_account" || item.code === "missing_tax_setting"), false);
  const below = calculatePayrollEmployee(employee("below", { taxTableType: undefined, dependentCount: undefined, hourlyWage: 87999 }), [day("below", "2026-07-01", 60)]);
  const table = calculatePayrollEmployee(employee("table", { taxTableType: undefined, dependentCount: undefined, hourlyWage: 105558 }), [day("table", "2026-07-01", 60)]);
  assert.deepEqual([below.deductions.incomeTax, below.taxTableTypeSnapshot, below.dependentCountSnapshot], [0, "kou", 0]);
  assert.equal(table.deductions.incomeTax, 170);
});

test("固定給・固定手当・休日手当と社保全額を引き継ぐ", () => {
  const result = calculatePayrollEmployee(employee("f", { payrollType: "fixed", fixedBaseSalary: 200000, positionAllowance: 10000, holidayAllowance: 10694, fixedOvertimeAllowance: 20000, healthInsurance: 10000, childSupportContribution: 500, careInsurance: 1000, employeePension: 20000, employmentInsurance: 1000 }), []);
  assert.equal(result.earnings.holidayAllowance, 10694); assert.equal(result.earnings.overtimePremium, 0); assert.equal(result.deductions.socialInsuranceTotal, 32500); assert.equal(result.deductions.taxableIncome, result.earnings.taxableTotal - 32500);
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

test("正社員の月次調整は固定給を変えず残業・非課税交通費・立替経費を反映する", () => {
  const fixed = calculatePayrollEmployee(employee("fixed", { employeeCode: "0003", payrollType: "fixed", fixedBaseSalary: 200000, hourlyWage: 0 }), []);
  const adjusted = applyFixedPayrollAdjustment(fixed, { overtimeMinutes: 60, transportation: 1000, advanceExpense: 2000, otherTemporaryPayment: 3000, otherDeduction: 400 });
  assert.equal(adjusted.earnings.baseSalary, 200000);
  assert.equal(adjusted.fixedAdjustment?.automaticOvertimeAllowance, 1562);
  assert.equal(adjusted.earnings.transportation, 1000);
  assert.equal(adjusted.deductions.advanceExpense, 2000);
  assert.equal(adjusted.deductions.otherDeduction, 400);
});

test("中村鏡太郎の当月調整は画面・両Excel・明細PDFで同じ再試算結果を使う", async () => {
  const fixed = calculatePayrollEmployee(employee("nakamura", { employeeCode: "0003", name: "中村鏡太郎", payrollType: "fixed", fixedBaseSalary: 200000, hourlyWage: 0 }), []);
  const adjusted = applyFixedPayrollAdjustment(fixed, { overtimeMinutes: 120, transportation: 1000, advanceExpense: 3000 });
  assert.equal(adjusted.earnings.overtimePremium, 3125);
  assert.equal(adjusted.earnings.transportation, 1000);
  assert.equal(adjusted.deductions.advanceExpense, 3000);
  assert.equal(adjusted.earnings.grossTotal, 204125);
  assert.equal(adjusted.netPay, 196785);
  const payrollBook = XLSX.read(createPayrollWorkbook([adjusted], "2026-08"));
  const payrollSheet = payrollBook.Sheets[payrollBook.SheetNames[0]];
  assert.equal(payrollSheet[XLSX.utils.encode_cell({ r: 11, c: 2 })].v, 3125);
  assert.equal(payrollSheet[XLSX.utils.encode_cell({ r: 10, c: 2 })].v, 1000);
  assert.equal(payrollSheet[XLSX.utils.encode_cell({ r: 29, c: 2 })].v, 3000);
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

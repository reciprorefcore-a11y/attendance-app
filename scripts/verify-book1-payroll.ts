import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import XLSX from "xlsx";
import { applyFixedPayrollAdjustment, calculatePayrollEmployee, summarizePayroll, type FixedPayrollAdjustment, type PayrollAttendanceDay, type PayrollEmployee, type PayrollResult } from "../lib/payroll.ts";
import { createPayrollWorkbook, createPayslipPdf, createTransferWorkbook } from "../lib/payroll-export.ts";

const sourcePath = "/Users/kizukikohei/Desktop/Book1.xlsx";
const outputDir = "/private/tmp/attendance-app-payroll-2026-08";
mkdirSync(outputDir, { recursive: true });

const book = XLSX.readFile(sourcePath, { cellFormula: true });
const sheet = book.Sheets[book.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null }) as unknown[][];
const value = (row: number, col: number) => Number(rows[row - 1]?.[col] ?? 0) || 0;
const text = (row: number, col: number) => String(rows[row - 1]?.[col] ?? "").replace(/[\s　]/g, "");
const minutes = (row: number, col: number) => Math.round(value(row, col) * 24 * 60);

const knownIds: Record<string, string> = {
  松本るぴな: "rQQf2dwbkFbUNn13gG0M", 寺石彩乃: "h1Ikn9BABiXSknfiBWju", 中村鏡太郎: "hvjU14BKDB0pCdDrUZF1",
  小林彗太: "c6ADSFHwyHecwScuZ6g8", 佐藤雅信: "zbpOikyklko5CL6G6Yon", 岸桜来: "57siuRPs3nEZ1Ntm7ahJ",
  佐久間美涼: "AgqriwE0RpyrQiCLp97S", 井上美咲: "WN7dC2xNeRQl7xChcAZc", 小林美穂: "aHBZpujtiu93YEU2Es1a",
  田村香織: "g4la53I4y0wNbMj5iLz9", 寺嶌桃子: "lgudjtEcC9nLikILgmiY", 川島胡桃: "0T493reIkr5Oi9ch29ms",
  木下航平: "ONRefCpUMyX3eZ75ukA6", 有泉春花: "ov7awXLa6YaC5iI2qZiT", 松村絢菜: "g2w2qL82szcgbGoXQd5K",
  漆原健太: "V6Kg3SNfHCA5aUwLy1Lu", 安齋莉奈: "SpZ9m4UDdQqjpDnJInPY", 工藤紗玖良: "VyQG7qnkxuMGfBC1sR0u",
  溝上太康: "vwuoA0qj0Us1iFEmTO9r", 曽崎大輔: "gCDrwiiJECJopX5QEhyQ", 篠原美楽: "rM4NyRBrQvXXzIMgjq4f",
  森愛礼奈: "wW2ms6AsOWbwjxhCEQFl", 加藤愛菜: "oxPBdiFtQQz7joU0cEea", 三浦美帆: "EwOQ7tvxMQ8IJFbrLI7V",
};
const currentCodes: Record<string, string> = { 有泉春花: "7014", 川島胡桃: "7015", 松村絢菜: "7016", 三浦美帆: "7017" };
const fixedNames = new Set(["青山佳史", "中村鏡太郎", "木月徳子", "小林彗太", "佐藤雅信"]);
const nogeNames = new Set(["有泉春花", "松村絢菜", "三浦美帆", "川島胡桃"]);
const employeeColumns = Array.from({ length: rows[3].length - 1 }, (_, index) => index + 1).filter((col) => text(3, col) !== "＜大部門＞" && text(3, col) !== "＜総計＞");

const results: PayrollResult[] = [];
const bookByName = new Map<string, { col: number; code: string; store: string }>();
for (const col of employeeColumns) {
  const name = text(4, col);
  const bookCode = String(rows[2][col] ?? "").padStart(4, "0");
  let store = "";
  for (let cursor = col; cursor >= 1; cursor -= 1) {
    if (rows[1][cursor]) { store = text(2, cursor); break; }
  }
  bookByName.set(name, { col, code: bookCode, store });
  const id = knownIds[name] ?? `book1-unconfirmed-${col}`;
  const code = currentCodes[name] ?? bookCode;
  const fixed = fixedNames.has(name);
  const employee: PayrollEmployee = {
    id, employeeCode: code, name, payrollEnabled: true, payrollType: fixed ? "fixed" : "hourly",
    employeeType: fixed ? "fullTime" : "partTime", storeId: fixed ? "" : store, storeName: fixed ? "所属なし" : store,
    hourlyWage: fixed ? 0 : (nogeNames.has(name) ? 1300 : 1225), transportationType: "monthly", monthlyTransportation: value(11, col),
    paymentMethod: value(32, col) > 0 ? "bank" : "cash", taxTableType: "kou", dependentCount: 0,
    fixedBaseSalary: fixed ? value(5, col) : 0, directorCompensation: value(6, col), positionAllowance: value(7, col),
    fixedOvertimeAllowance: value(8, col), businessAllowance: value(10, col), healthInsurance: value(19, col),
    childSupportContribution: value(20, col), careInsurance: value(21, col), employeePension: value(22, col),
    employmentInsurance: value(23, col), incomeTax: fixed ? value(26, col) : undefined, residentTax: value(27, col),
    residentTaxEffectiveMonth: fixed ? "2026-08" : null,
    holidayAllowanceBaseSalary: name === "中村鏡太郎" ? 190000 : undefined,
  };
  if (name === "小林彗太") { employee.employmentInsurance = 1580; employee.incomeTax = 6650; employee.residentTax = 12200; }
  const attendance: PayrollAttendanceDay[] = fixed ? [] : [{
    employeeId: id, date: "2026-07-01", workMinutes: minutes(40, col), overtimeMinutes: minutes(42, col), nightMinutes: minutes(43, col),
    helpMinutes: minutes(44, col), breakMinutes: 0, confirmed: true, kind: "daily",
  }];
  const base = calculatePayrollEmployee(employee, attendance);
  let adjustment: FixedPayrollAdjustment = {};
  if (name === "中村鏡太郎") adjustment = { temporaryAttendanceCount: 1 };
  if (name === "小林彗太") adjustment = { temporaryAttendanceCount: 2, holidayAllowanceOverride: 30891, overrideReason: "公休6日のところ実休4日のため、休日出勤2回" };
  results.push(fixed ? applyFixedPayrollAdjustment(base, adjustment) : base);
}

writeFileSync(path.join(outputDir, "2026-08-payroll.xlsx"), createPayrollWorkbook(results, "2026-08", true, "2026-07", "2026-08-25"));
writeFileSync(path.join(outputDir, "2026-08-bank-transfer.xlsx"), createTransferWorkbook(results, "2026-08", true, true, "2026-07", "2026-08-25"));
for (const name of ["松本るぴな", "中村鏡太郎", "小林彗太", "青山佳史", "木月徳子"]) {
  const result = results.find((item) => item.employeeName === name)!;
  writeFileSync(path.join(outputDir, `${name}.pdf`), await createPayslipPdf(result, "2026-07", "2026-08-25"));
}

const csvRows: (string | number)[][] = [["employeeId", "社員コード", "氏名", "雇用区分", "所属", "Book1基本給", "システム基本給", "差額", "Book1各手当", "システム各手当", "Book1交通費", "システム交通費", "Book1控除", "システム控除", "Book1差引支給額", "システム最終支給額", "差額", "差異理由", "判定"]];
for (const result of results) {
  const bookItem = bookByName.get(result.employeeName)!;
  const col = bookItem.col;
  const bookAllowances = { position: value(7,col), fixedOvertime: value(8,col), holiday: value(9,col), business: value(10,col), overtime: value(12,col), night: value(13,col) };
  const systemAllowances = { position: result.earnings.positionAllowance, fixedOvertime: result.earnings.fixedOvertimeAllowance, holiday: result.earnings.holidayAllowance, business: result.earnings.businessAllowance, overtime: result.earnings.overtimePremium, night: result.earnings.nightPremium };
  const baseDiff = result.earnings.baseSalary - value(5,col);
  const netDiff = result.netPay - value(31,col);
  let reason = "端数処理を含む現行給与計算と一致"; let judgment = netDiff === 0 ? "正当差分" : "要確認";
  if (Math.abs(netDiff) === 1 && baseDiff === -1) { reason = "給与項目ごとの四捨五入による1円差"; judgment = "正当差分"; }
  if (result.employeeName === "小林彗太") { reason = "休日出勤2回・休日手当30,891円、雇用保険1,580円、所得税6,650円"; judgment = "正当差分"; }
  else if (nogeNames.has(result.employeeName)) { reason = "正しい時給1,300円（Book1は旧時給1,225円相当）"; judgment = "正当差分"; }
  else if (result.employeeName === "城菜月") { reason = "システム時給1,225円、Book1は逆算時給1,162円。Firestore履歴は未確認"; judgment = "要確認"; }
  else if (result.employeeName === "青山佳史") { reason = "Book1旧立替経費-8,948円を固定移行せず、当月精算初期値0円"; judgment = "要確認"; }
  csvRows.push([knownIds[result.employeeName] ?? "", result.employeeCode, result.employeeName, result.employeeType, result.storeName, value(5,col), result.earnings.baseSalary, baseDiff, JSON.stringify(bookAllowances), JSON.stringify(systemAllowances), value(11,col), result.earnings.transportation, value(29,col), result.deductions.total, value(31,col), result.netPay, netDiff, reason, judgment]);
}
writeFileSync(path.join(outputDir, "book1-diff.csv"), "\ufeff" + csvRows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"','""')}"`).join(",")).join("\n"));
writeFileSync(path.join(outputDir, "summary.json"), JSON.stringify({ sourcePath, totals: summarizePayroll(results), unknownEmployeeIds: results.filter((item) => !knownIds[item.employeeName]).map((item) => item.employeeName) }, null, 2));
console.log(JSON.stringify({ outputDir, totals: summarizePayroll(results), employees: results.map((item) => ({ name: item.employeeName, code: item.employeeCode, gross: item.earnings.grossTotal, deductions: item.deductions.total, reimbursement: item.reimbursements.total, net: item.netPay, bank: item.bankTransfer, cash: item.cashPayment })) }, null, 2));

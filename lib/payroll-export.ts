import * as XLSX from "xlsx";
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PayrollResult } from "./payroll";
import { sortPayrollResults } from "./payroll-order.ts";
import { createZip } from "./zip.ts";

const money = (value: number) => Math.trunc(value);
const hm = (minutes: number) => `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
const paymentLabel = (paymentMonth: string) => {
  const [year, month] = paymentMonth.split("-").map(Number);
  return `${year}年${month}月`;
};
const reiwa = (year: number) => `令和${year - 2018}年`;
const periodLabel = (targetMonth: string, paymentDate: string) => {
  const [year, month] = targetMonth.split("-").map(Number);
  const last = new Date(year, month, 0).getDate();
  const [payYear, payMonth, payDay] = paymentDate.split("-").map(Number);
  return `対象期間：${reiwa(year)}${month}月1日～${month}月${last}日　支給日：${reiwa(payYear)}${payMonth}月${payDay}日`;
};

export function createPayrollWorkbook(results: PayrollResult[], paymentMonth: string, draft = false, targetMonth = paymentMonth, paymentDate = `${paymentMonth}-25`) {
  results = sortPayrollResults(results);
  const workbook = XLSX.read(readFileSync(path.join(process.cwd(), "templates", "payroll", "payroll-summary-template.xlsx")), { type: "buffer", cellStyles: true, cellFormula: true });
  const templateName = workbook.SheetNames[0];
  const templateSheet = workbook.Sheets[templateName];
  const allGroups = [
    { name: "1～25", start: 2, end: 26, subtotal: 27 },
    { name: "26～29", start: 28, end: 31, subtotal: 32 },
    { name: "30～34", start: 33, end: 37, subtotal: 38 },
  ];
  const pageSize = allGroups.reduce((sum, group) => sum + group.end - group.start + 1, 0);
  const pageCount = Math.max(1, Math.ceil(results.length / pageSize));
  const rowValues: Record<number, (x: PayrollResult) => number> = {
    4:x=>x.earnings.baseSalary,5:x=>x.earnings.directorCompensation,6:x=>x.earnings.positionAllowance,7:x=>x.earnings.fixedOvertimeAllowance,8:x=>x.earnings.holidayAllowance,9:x=>x.earnings.businessAllowance,10:x=>x.earnings.transportation,11:x=>x.earnings.overtimePremium,12:x=>x.earnings.nightPremium,13:x=>x.earnings.absenceDeduction,14:x=>x.earnings.lateEarlyDeduction,15:x=>x.earnings.taxableTotal,16:x=>x.earnings.nonTaxableTotal,17:x=>x.earnings.grossTotal,18:x=>x.deductions.healthInsurance,19:x=>x.deductions.childSupportContribution,20:x=>x.deductions.careInsurance,21:x=>x.deductions.employeePension,22:x=>x.deductions.employmentInsurance,23:x=>x.deductions.socialInsuranceTotal,24:x=>x.deductions.taxableIncome,25:x=>x.deductions.incomeTax,26:x=>x.deductions.residentTax,27:x=>x.deductions.yearEndAdjustment,28:x=>x.deductions.otherDeduction,29:x=>x.deductions.advanceExpense,30:x=>x.deductions.total,31:()=>0,32:x=>x.netPay,33:x=>x.bankTransfer,34:x=>x.cashPayment,36:x=>x.attendance.attendanceDays,37:x=>x.attendance.absenceDays,38:x=>x.attendance.paidLeaveDays,39:()=>0,40:()=>0,41:x=>x.attendance.workMinutes/60,42:()=>0,43:x=>x.attendance.overtimeMinutes/60,44:x=>x.attendance.nightMinutes/60,45:x=>x.attendance.helpMinutes/60,
  };
  workbook.SheetNames = [];
  workbook.Sheets = {};
  for (let page = 0; page < pageCount; page++) {
    const sheet = structuredClone(templateSheet);
    let pageOffset = page * pageSize;
    const groups = allGroups.map((group) => {
      const capacity = group.end - group.start + 1;
      const items = results.slice(pageOffset, pageOffset + capacity);
      pageOffset += capacity;
      return { ...group, items };
    });
    sheet.A1 = { ...(sheet.A1 ?? {}), t: "s", v: `${draft ? "【試算】" : ""}FUBLEV Group㈱　R${Number(paymentMonth.slice(0,4))-2018}.${Number(paymentMonth.slice(5))}月支給${pageCount > 1 ? `（${page + 1}/${pageCount}）` : ""}　` };
    for (const group of groups) {
      sheet[XLSX.utils.encode_cell({ r:1,c:group.start })] = { ...(sheet[XLSX.utils.encode_cell({r:1,c:group.start})]??{}), t:"s",v:group.name };
      for (let col=group.start;col<=group.end;col++) {
        const item=group.items[col-group.start];
        sheet[XLSX.utils.encode_cell({r:2,c:col})]={...(sheet[XLSX.utils.encode_cell({r:2,c:col})]??{}),t:"s",v:item?.employeeCode??""};
        sheet[XLSX.utils.encode_cell({r:3,c:col})]={...(sheet[XLSX.utils.encode_cell({r:3,c:col})]??{}),t:"s",v:item?.employeeName??""};
        for(const [row,getter] of Object.entries(rowValues)){const r=Number(row);sheet[XLSX.utils.encode_cell({r,c:col})]={...(sheet[XLSX.utils.encode_cell({r,c:col})]??{}),t:"n",v:item?getter(item):0};}
      }
      sheet[XLSX.utils.encode_cell({r:3,c:group.subtotal})]={...(sheet[XLSX.utils.encode_cell({r:3,c:group.subtotal})]??{}),t:"s",v:`${group.items.length}人`};
      for(const row of Object.keys(rowValues).map(Number)){const from=XLSX.utils.encode_cell({r:row,c:group.start}),to=XLSX.utils.encode_cell({r:row,c:group.end});sheet[XLSX.utils.encode_cell({r:row,c:group.subtotal})]={...(sheet[XLSX.utils.encode_cell({r:row,c:group.subtotal})]??{}),t:"n",f:`SUM(${from}:${to})`};}
    }
    const pageEmployeeCount = groups.reduce((sum, group) => sum + group.items.length, 0);
    sheet.AN4={...(sheet.AN4??{}),t:"s",v:`${pageEmployeeCount}人`};
    for(const row of Object.keys(rowValues).map(Number)) sheet[XLSX.utils.encode_cell({r:row,c:39})]={...(sheet[XLSX.utils.encode_cell({r:row,c:39})]??{}),t:"n",f:`SUM(${XLSX.utils.encode_cell({r:row,c:27})},${XLSX.utils.encode_cell({r:row,c:32})},${XLSX.utils.encode_cell({r:row,c:38})})`};
    const sheetName = page === 0 ? templateName : `${templateName}_${page + 1}`;
    workbook.SheetNames.push(sheetName);
    workbook.Sheets[sheetName] = sheet;
  }
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

export function createTransferWorkbook(results: PayrollResult[], paymentMonth: string, excludeZero = true, draft = false, targetMonth = paymentMonth, paymentDate = `${paymentMonth}-25`) {
  const sorted = sortPayrollResults(results).filter((item) => item.paymentMethod === "bank" && (!excludeZero || item.bankTransfer !== 0));
  const workbook = XLSX.read(readFileSync(path.join(process.cwd(), "templates", "payroll", "bank-transfer-template.xlsx")), { type: "buffer", cellStyles: true, cellFormula: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]]; sheet.A1={...(sheet.A1??{}),t:"s",v:`${paymentLabel(paymentMonth)}支給　給与振込一覧`};
  const templateStyle=[sheet.A3,sheet.B3,sheet.B3,sheet.C3];
  const oldRange = XLSX.utils.decode_range(sheet["!ref"] ?? "A1:C3");
  for (let r=2;r<=oldRange.e.r;r++) for (let c=0;c<=3;c++) delete sheet[XLSX.utils.encode_cell({r,c})];
  ["No.", "社員コード", "氏名", "振込金額"].forEach((value, c) => { sheet[XLSX.utils.encode_cell({r:1,c})] = { ...(sheet[XLSX.utils.encode_cell({r:1,c:Math.min(c,2)})] ?? {}), t:"s", v:value }; });
  sorted.forEach((item,index)=>{const row=index+2;sheet[XLSX.utils.encode_cell({r:row,c:0})]={...templateStyle[0],t:"n",v:index+1};sheet[XLSX.utils.encode_cell({r:row,c:1})]={...templateStyle[1],t:"s",v:item.employeeCode};sheet[XLSX.utils.encode_cell({r:row,c:2})]={...templateStyle[2],t:"s",v:item.employeeName};sheet[XLSX.utils.encode_cell({r:row,c:3})]={...templateStyle[3],t:"n",v:item.bankTransfer,z:"#,##0\"円\""};});
  const totalRow=sorted.length+2;sheet[XLSX.utils.encode_cell({r:totalRow,c:0})]={...templateStyle[0],t:"s",v:`振込合計（${sorted.length}名）`};sheet[XLSX.utils.encode_cell({r:totalRow,c:1})]={...templateStyle[1],t:"s",v:""};sheet[XLSX.utils.encode_cell({r:totalRow,c:2})]={...templateStyle[2],t:"s",v:""};sheet[XLSX.utils.encode_cell({r:totalRow,c:3})]={...templateStyle[3],t:"n",f:`SUM(D3:D${totalRow})`,z:"#,##0\"円\""};sheet["!ref"]=`A1:D${totalRow+1}`;
  workbook.SheetNames[0]=`${Number(paymentMonth.slice(5))}月給与振込一覧`;workbook.Sheets[workbook.SheetNames[0]]=sheet;
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

async function loadJapaneseFont() {
  return readFile(path.join(process.cwd(), "public", "fonts", "ipaexg.ttf"));
}

export async function createPayslipPdf(result: PayrollResult, targetMonth: string, paymentDate: string, draft = false) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(await loadJapaneseFont(), { subset: true });
  const page = pdf.addPage([841.89, 595.28]);
  const blue = rgb(0.12, 0.47, 0.72), dark = rgb(0.08, 0.12, 0.18), pale = rgb(0.94, 0.97, 0.99), white = rgb(1, 1, 1);
  const [payYear, payMonth, payDay] = paymentDate.split("-").map(Number);
  const draw = (text: string, x: number, y: number, size = 9, color = dark) => page.drawText(text, { x, y, size, font, color });
  const drawRight = (text: string, right: number, y: number, size = 9, color = dark) => draw(text, right - font.widthOfTextAtSize(text, size), y, size, color);
  page.drawRectangle({ x: 28, y: 28, width: 785.89, height: 539.28, borderColor: blue, borderWidth: 1.4 });
  draw(`${draft ? "【試算】" : ""}令和${payYear - 2018}年${payMonth}月給与　明細書`, 44, 535, 18, blue);
  draw("FUBLEV Group株式会社", 44, 509, 9);
  draw(`所属　${result.storeName}`, 44, 487, 9);
  draw(`個人番号　${result.employeeCode}　　${result.employeeName} 様`, 44, 465, 9);
  drawRight(`支給日　令和${payYear - 2018}年${payMonth}月${payDay}日`, 797, 535, 9);
  const yenText = (value: number) => `${money(value).toLocaleString()}円`;
  const sections: { title: string; rows: [string, string][] }[] = [
    { title: "勤怠", rows: [["就業日数", `${result.attendance.workingDays}日`], ["出勤日数", `${result.attendance.attendanceDays}日`], ["欠勤日数", `${result.attendance.absenceDays}日`], ["有休日数", `${result.attendance.paidLeaveDays}日`], ["労働時間", hm(result.attendance.workMinutes)], ["普通残業時間", hm(result.attendance.overtimeMinutes)], ["深夜時間", hm(result.attendance.nightMinutes)], ["休出時間", hm(result.attendance.holidayMinutes)], ["休憩時間", hm(result.attendance.breakMinutes)]] },
    { title: "支給", rows: [["基本給", yenText(result.earnings.baseSalary)], ["役員報酬", yenText(result.earnings.directorCompensation)], ["職能手当", yenText(result.earnings.positionAllowance)], ["業務手当", yenText(result.earnings.businessAllowance)], ["休日手当", yenText(result.earnings.holidayAllowance)], ["普通残業手当", yenText(result.earnings.overtimePremium)], ["深夜手当", yenText(result.earnings.nightPremium)], ["非課税通勤費", yenText(result.earnings.transportation)], ["支給合計", yenText(result.earnings.grossTotal)]] },
    { title: "控除", rows: [["健康保険", yenText(result.deductions.healthInsurance)], ["介護保険", yenText(result.deductions.careInsurance)], ["厚生年金", yenText(result.deductions.employeePension)], ["雇用保険", yenText(result.deductions.employmentInsurance)], ["所得税", yenText(result.deductions.incomeTax)], ["住民税", yenText(result.deductions.residentTax)], ["その他控除", yenText(result.deductions.otherDeduction)], ["立替経費", yenText(result.deductions.advanceExpense)], ["控除合計", yenText(result.deductions.total)]] },
    { title: "その他", rows: [["課税支給額", yenText(result.earnings.taxableTotal)], ["非課税支給額", yenText(result.earnings.nonTaxableTotal)], ["振込支給額", yenText(result.bankTransfer)], ["現金支給額", yenText(result.cashPayment)]] },
  ];
  const tableX = 44, tableY = 420, tableWidth = 184, gap = 9, rowHeight = 28, labelWidth = 92;
  sections.forEach((section, sectionIndex) => {
    const x = tableX + sectionIndex * (tableWidth + gap);
    page.drawRectangle({ x, y: tableY, width: tableWidth, height: 27, color: blue });
    draw(section.title, x + 8, tableY + 8, 10, white);
    section.rows.forEach(([label, value], rowIndex) => {
      const y = tableY - (rowIndex + 1) * rowHeight;
      page.drawRectangle({ x, y, width: tableWidth, height: rowHeight, color: rowIndex % 2 === 0 ? pale : white, borderColor: blue, borderWidth: 0.55 });
      page.drawLine({ start: { x: x + labelWidth, y }, end: { x: x + labelWidth, y: y + rowHeight }, color: blue, thickness: 0.55 });
      draw(label, x + 7, y + 9, 8);
      drawRight(value, x + tableWidth - 7, y + 9, 8.5);
    });
  });
  draw(periodLabel(targetMonth, paymentDate), 44, 83, 8);
  page.drawRectangle({ x: 608, y: 58, width: 189, height: 58, borderColor: blue, borderWidth: 1.2, color: pale });
  draw("差引支給額", 620, 92, 9, blue);
  drawRight(yenText(result.netPay), 785, 70, 18, dark);
  return Buffer.from(await pdf.save());
}

export function selectStorePayslipResults(results: PayrollResult[], storeId: string) {
  return results.filter((result) => result.employeeType === "partTime" && result.storeId === storeId);
}

export function selectFullTimePayslipResults(results: PayrollResult[]) {
  return results.filter((result) => result.employeeType === "fullTime");
}

const safeFilename = (value: string) => value.replace(/[\\/:*?"<>|]/g, "_");

export async function createPayslipZip(results: PayrollResult[], targetMonth: string, paymentMonth: string, paymentDate: string) {
  const label = `${Number(paymentMonth.slice(0, 4))}年${String(Number(paymentMonth.slice(5))).padStart(2, "0")}月`;
  const entries = await Promise.all(results.map(async (result) => ({
    name: `${safeFilename(result.employeeCode)}_${safeFilename(result.employeeName)}_${label}給与明細.pdf`,
    data: await createPayslipPdf(result, targetMonth, paymentDate, false),
  })));
  return createZip(entries);
}

import * as XLSX from "xlsx";
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PayrollResult } from "./payroll";

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
  const workbook = XLSX.read(readFileSync(path.join(process.cwd(), "templates", "payroll", "payroll-summary-template.xlsx")), { type: "buffer", cellStyles: true, cellFormula: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const groups = [
    { name: "本部", items: results.filter((x) => x.payrollType === "hourly" && !x.storeName.includes("野毛")), start: 2, end: 26, subtotal: 27 },
    { name: "野毛", items: results.filter((x) => x.payrollType === "hourly" && x.storeName.includes("野毛")), start: 28, end: 31, subtotal: 32 },
    { name: "幹部", items: results.filter((x) => x.payrollType === "fixed"), start: 33, end: 37, subtotal: 38 },
  ];
  const rowValues: Record<number, (x: PayrollResult) => number> = {
    4:x=>x.earnings.baseSalary,5:x=>x.earnings.directorCompensation,6:x=>x.earnings.positionAllowance,7:x=>x.earnings.fixedOvertimeAllowance,8:x=>x.earnings.holidayAllowance,9:x=>x.earnings.businessAllowance,10:x=>x.earnings.transportation,11:x=>x.earnings.overtimePremium,12:x=>x.earnings.nightPremium,13:x=>x.earnings.absenceDeduction,14:x=>x.earnings.lateEarlyDeduction,15:x=>x.earnings.taxableTotal,16:x=>x.earnings.nonTaxableTotal,17:x=>x.earnings.grossTotal,18:x=>x.deductions.healthInsurance,19:x=>x.deductions.childSupportContribution,20:x=>x.deductions.careInsurance,21:x=>x.deductions.employeePension,22:x=>x.deductions.employmentInsurance,23:x=>x.deductions.socialInsuranceTotal,24:x=>x.deductions.taxableIncome,25:x=>x.deductions.incomeTax,26:x=>x.deductions.residentTax,27:x=>x.deductions.yearEndAdjustment,28:x=>x.deductions.otherDeduction,29:x=>x.deductions.advanceExpense,30:x=>x.deductions.total,31:()=>0,32:x=>x.netPay,33:x=>x.bankTransfer,34:x=>x.cashPayment,36:x=>x.attendance.attendanceDays,37:x=>x.attendance.absenceDays,38:x=>x.attendance.paidLeaveDays,39:()=>0,40:()=>0,41:x=>x.attendance.workMinutes/60,42:()=>0,43:x=>x.attendance.overtimeMinutes/60,44:x=>x.attendance.nightMinutes/60,45:x=>x.attendance.helpMinutes/60,
  };
  sheet.A1 = { ...(sheet.A1 ?? {}), t: "s", v: `${draft ? "【試算】" : ""}FUBLEV Group㈱　R${Number(paymentMonth.slice(0,4))-2018}.${Number(paymentMonth.slice(5))}月支給　` };
  for (const group of groups) {
    if (group.items.length > group.end - group.start + 1) throw new Error(`${group.name}の給与対象者数がテンプレート列数を超えています`);
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
  sheet.AN4={...(sheet.AN4??{}),t:"s",v:`${results.length}人`};
  for(const row of Object.keys(rowValues).map(Number)) sheet[XLSX.utils.encode_cell({r:row,c:39})]={...(sheet[XLSX.utils.encode_cell({r:row,c:39})]??{}),t:"n",f:`SUM(${XLSX.utils.encode_cell({r:row,c:27})},${XLSX.utils.encode_cell({r:row,c:32})},${XLSX.utils.encode_cell({r:row,c:38})})`};
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

export function createTransferWorkbook(results: PayrollResult[], paymentMonth: string, excludeZero = true, draft = false, targetMonth = paymentMonth, paymentDate = `${paymentMonth}-25`) {
  const sorted = results.filter((item) => item.paymentMethod === "bank" && (!excludeZero || item.bankTransfer !== 0)).sort((a, b) => {
    const ao = a.payrollTransferOrder ?? Number.MAX_SAFE_INTEGER;
    const bo = b.payrollTransferOrder ?? Number.MAX_SAFE_INTEGER;
    return ao - bo || a.employeeCode.localeCompare(b.employeeCode, "ja", { numeric: true });
  });
  const workbook = XLSX.read(readFileSync(path.join(process.cwd(), "templates", "payroll", "bank-transfer-template.xlsx")), { type: "buffer", cellStyles: true, cellFormula: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]]; sheet.A1={...(sheet.A1??{}),t:"s",v:`${paymentLabel(paymentMonth)}支給　給与振込一覧`};
  const templateStyle=[sheet.A3,sheet.B3,sheet.C3];
  sorted.forEach((item,index)=>{const row=index+2;sheet[XLSX.utils.encode_cell({r:row,c:0})]={...templateStyle[0],t:"n",v:index+1};sheet[XLSX.utils.encode_cell({r:row,c:1})]={...templateStyle[1],t:"s",v:item.employeeName};sheet[XLSX.utils.encode_cell({r:row,c:2})]={...templateStyle[2],t:"n",v:item.bankTransfer,z:"#,##0\"円\""};});
  const totalRow=sorted.length+2;sheet[XLSX.utils.encode_cell({r:totalRow,c:0})]={...templateStyle[0],t:"s",v:`振込合計（${sorted.length}名）`};sheet[XLSX.utils.encode_cell({r:totalRow,c:1})]={...templateStyle[1],t:"s",v:""};sheet[XLSX.utils.encode_cell({r:totalRow,c:2})]={...templateStyle[2],t:"n",f:`SUM(C3:C${totalRow})`,z:"#,##0\"円\""};sheet["!ref"]=`A1:C${totalRow+1}`;
  workbook.SheetNames[0]=`${Number(paymentMonth.slice(5))}月給与振込一覧`;workbook.Sheets[workbook.SheetNames[0]]=sheet;
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

async function loadJapaneseFont() {
  return readFile(path.join(process.cwd(), "node_modules", "@fontsource", "noto-sans-jp", "files", "noto-sans-jp-japanese-400-normal.woff"));
}

export async function createPayslipPdf(result: PayrollResult, targetMonth: string, paymentDate: string, draft = false) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(await loadJapaneseFont(), { subset: true });
  const page = pdf.addPage([595.28, 419.53]);
  const blue = rgb(0.10, 0.48, 0.72), dark = rgb(0.12, 0.18, 0.25), light = rgb(0.93, 0.97, 1);
  page.drawRectangle({ x: 14, y: 14, width: 567, height: 391, borderColor: blue, borderWidth: 1.2 });
  page.drawText("給与支給明細書", { x: 24, y: 382, size: 17, font, color: blue });
  if (draft) page.drawText("試算", { x: 525, y: 382, size: 13, font, color: rgb(0.75, 0.12, 0.12) });
  page.drawText(`${result.employeeCode}  ${result.employeeName} 様`, { x: 24, y: 358, size: 10, font, color: dark });
  page.drawText(`所属：${result.storeName}`, { x: 230, y: 358, size: 9, font, color: dark });
  page.drawText(periodLabel(targetMonth, paymentDate), { x: 350, y: 358, size: 6.5, font, color: dark });
  const sections: { title: string; x: number; y: number; width: number; rows: [string, string][] }[] = [
    { title: "勤怠", x: 24, y: 330, width: 130, rows: [["就業日数", String(result.attendance.workingDays)], ["出勤日数", String(result.attendance.attendanceDays)], ["欠勤日数", String(result.attendance.absenceDays)], ["有休日数", String(result.attendance.paidLeaveDays)], ["労働時間", hm(result.attendance.workMinutes)], ["普通残業時間", hm(result.attendance.overtimeMinutes)], ["深夜時間", hm(result.attendance.nightMinutes)], ["休出時間", hm(result.attendance.holidayMinutes)], ["休憩時間", hm(result.attendance.breakMinutes)]] },
    { title: "支給", x: 160, y: 330, width: 140, rows: [["基本給", money(result.earnings.baseSalary).toLocaleString()], ["普通残業手当", money(result.earnings.overtimePremium).toLocaleString()], ["深夜手当", money(result.earnings.nightPremium).toLocaleString()], ["休日手当", money(result.earnings.holidayAllowance).toLocaleString()], ["非課税通勤費", money(result.earnings.transportation).toLocaleString()], ["その他支給", money(result.earnings.otherTaxable + result.earnings.otherNonTaxable).toLocaleString()], ["支給合計", money(result.earnings.grossTotal).toLocaleString()]] },
    { title: "控除", x: 306, y: 330, width: 125, rows: [["健康保険", money(result.deductions.healthInsurance).toLocaleString()], ["介護保険", money(result.deductions.careInsurance).toLocaleString()], ["厚生年金", money(result.deductions.employeePension).toLocaleString()], ["雇用保険", money(result.deductions.employmentInsurance).toLocaleString()], ["所得税", money(result.deductions.incomeTax).toLocaleString()], ["住民税", money(result.deductions.residentTax).toLocaleString()], ["控除合計", money(result.deductions.total).toLocaleString()]] },
    { title: "その他", x: 437, y: 330, width: 134, rows: [["課税支給額", money(result.earnings.taxableTotal).toLocaleString()], ["非課税支給額", money(result.earnings.nonTaxableTotal).toLocaleString()], ["振込支給額", money(result.bankTransfer).toLocaleString()], ["現金支給額", money(result.cashPayment).toLocaleString()]] },
  ];
  for (const section of sections) {
    page.drawRectangle({ x: section.x, y: section.y, width: section.width, height: 20, color: blue });
    page.drawText(section.title, { x: section.x + 6, y: section.y + 6, size: 9, font, color: rgb(1, 1, 1) });
    section.rows.forEach(([label, value], index) => {
      const y = section.y - 17 - index * 19;
      if (index % 2 === 0) page.drawRectangle({ x: section.x, y: y - 3, width: section.width, height: 18, color: light });
      page.drawText(label, { x: section.x + 5, y, size: 7.5, font, color: dark });
      page.drawText(value, { x: section.x + section.width - 7 - font.widthOfTextAtSize(value, 8), y, size: 8, font, color: dark });
    });
  }
  page.drawRectangle({ x: 405, y: 28, width: 166, height: 54, color: blue });
  page.drawText("差引支給額", { x: 416, y: 62, size: 9, font, color: rgb(1, 1, 1) });
  const net = `${money(result.netPay).toLocaleString()} 円`;
  page.drawText(net, { x: 558 - font.widthOfTextAtSize(net, 18), y: 37, size: 18, font, color: rgb(1, 1, 1) });
  return Buffer.from(await pdf.save());
}


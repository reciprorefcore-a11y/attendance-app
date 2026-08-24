/**
 * 給与明細 PDF を生成して /tmp に保存するスクリプト。
 * node --input-type=module < gen-payslip-pdf.ts ではなく
 * node scripts/gen-payslip-pdf.ts で呼ぶ（TypeScript stripping 対応）。
 */
import { writeFileSync } from "node:fs";
import { calculatePayrollEmployee, applyFixedPayrollAdjustment, type PayrollEmployee } from "../lib/payroll.ts";
import { createPayslipPdf } from "../lib/payroll-export.ts";

const employee = (id: string, patch: Partial<PayrollEmployee> = {}): PayrollEmployee => ({
  id, employeeCode: id, name: `従業員${id}`, storeId: "hq", storeName: "本部",
  payrollEnabled: true, payrollType: "hourly", hourlyWage: 1225, transportationType: "none",
  paymentMethod: "bank", bankAccountRegistered: true, taxTableType: "kou", dependentCount: 0,
  healthInsurance: 0, childSupportContribution: 0, careInsurance: 0, employeePension: 0,
  employmentInsurance: 0, residentTax: 0, ...patch,
});

// 小林彗太
const kobayashi = employee("0064", {
  name: "小林彗太", payrollType: "fixed", fixedBaseSalary: 183000, hourlyWage: 0,
  monthlyTransportation: 10110,
  healthInsurance: 13888, childSupportContribution: 322, employeePension: 25620,
  employmentInsurance: 1580, residentTax: 10000, taxTableType: "kou",
});
const kobBase = calculatePayrollEmployee(kobayashi, []);
const kobAdj = applyFixedPayrollAdjustment(kobBase, { expenseReimbursement: 800000 });

// 青山佳史
const aoyama = employee("0002", {
  name: "青山佳史", payrollType: "fixed",
  directorCompensation: 150000, fixedBaseSalary: 0, hourlyWage: 0,
  healthInsurance: 7440, childSupportContribution: 172, careInsurance: 1215,
  employeePension: 13725, employmentInsurance: 0, residentTax: 12600,
  paymentMethod: "cash", taxTableType: "kou",
});
const aoBase = calculatePayrollEmployee(aoyama, []);
const aoAdj = applyFixedPayrollAdjustment(aoBase, { expenseReimbursement: 7599 });

const kobPdf = await createPayslipPdf(kobAdj, "2026-08", "2026-09-25");
const aoPdf = await createPayslipPdf(aoAdj, "2026-08", "2026-09-25");

writeFileSync("/tmp/payslip_kobayashi.pdf", kobPdf);
writeFileSync("/tmp/payslip_aoyama.pdf", aoPdf);

console.log("kobayashi netPay:", kobAdj.netPay);
console.log("kobayashi payrollNetPay:", kobAdj.payrollNetPay);
console.log("kobayashi expenseReimbursement:", kobAdj.reimbursements.expenseReimbursement);
console.log("kobayashi grossTotal:", kobAdj.earnings.grossTotal);
console.log("kobayashi deductions.total:", kobAdj.deductions.total);
console.log("aoyama netPay:", aoAdj.netPay);
console.log("aoyama payrollNetPay:", aoAdj.payrollNetPay);
console.log("aoyama cashPayment:", aoAdj.cashPayment);
console.log("Saved: /tmp/payslip_kobayashi.pdf");
console.log("Saved: /tmp/payslip_aoyama.pdf");

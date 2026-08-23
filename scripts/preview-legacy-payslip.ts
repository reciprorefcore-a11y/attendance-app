import { writeFile } from "node:fs/promises";
import { calculatePayrollEmployee, type PayrollAttendanceDay, type PayrollEmployee } from "../lib/payroll.ts";
import { createPayslipPdf } from "../lib/payroll-export.ts";

const employee: PayrollEmployee = {
  id: "preview-matsumoto", employeeCode: "1076", name: "松本るぴな", storeId: "noge", storeName: "野毛店",
  payrollEnabled: true, payrollType: "hourly", hourlyWage: 1225, transportationType: "daily", dailyTransportation: 300,
  paymentMethod: "bank", bankAccountRegistered: false, taxTableType: "kou", dependentCount: 0,
  healthInsurance: 0, childSupportContribution: 0, careInsurance: 0, employeePension: 0, employmentInsurance: 0, residentTax: 0,
};
const attendance: PayrollAttendanceDay[] = Array.from({ length: 13 }, (_, index) => ({
  employeeId: employee.id, date: `2026-07-${String(index + 1).padStart(2, "0")}`, workMinutes: index === 12 ? 120 : 360,
  overtimeMinutes: 0, nightMinutes: index < 9 ? 60 : 0, helpMinutes: 0, breakMinutes: 0,
  confirmed: true, kind: "daily",
}));
const result = calculatePayrollEmployee(employee, attendance);
await writeFile("/tmp/2026-08-legacy-payslip-preview.pdf", await createPayslipPdf(result, "2026-07", "2026-08-25"));

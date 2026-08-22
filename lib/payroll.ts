import tax2026 from "./tax-tables/2026.ts";

export type PayrollType = "hourly" | "fixed";
export type TaxTableType = "kou" | "otsu";
export type PaymentMethod = "bank" | "cash";

export type PayrollEmployee = {
  id: string;
  employeeCode: string;
  name: string;
  storeId: string;
  storeName?: string;
  payrollEnabled?: boolean;
  payrollType?: PayrollType;
  hourlyWage?: number | null;
  baseWage?: number | null;
  transportationType?: "daily" | "monthly" | "none";
  dailyTransportation?: number | null;
  transportationCost?: number | null;
  monthlyTransportation?: number | null;
  payrollTransferOrder?: number | null;
  paymentMethod?: PaymentMethod;
  taxTableType?: TaxTableType;
  dependentCount?: number;
  healthInsurance?: number;
  childSupportContribution?: number;
  careInsurance?: number;
  employeePension?: number;
  employmentInsurance?: number;
  residentTax?: number;
  fixedBaseSalary?: number;
  directorCompensation?: number;
  positionAllowance?: number;
  businessAllowance?: number;
  holidayAllowance?: number;
  fixedOvertimeAllowance?: number;
  otherAllowance?: number;
  otherNonTaxableAllowance?: number;
  otherDeduction?: number;
  advanceExpense?: number;
  bankAccountRegistered?: boolean;
  bankAccountNumber?: string | null;
  yearEndAdjustment?: number;
  otherTotal?: number;
  workingDays?: number;
  paidLeaveDays?: number;
  absenceDays?: number;
  absenceDeduction?: number;
  lateEarlyDeduction?: number;
};

export type PayrollAttendanceDay = {
  employeeId: string;
  date: string;
  workMinutes: number;
  overtimeMinutes: number;
  nightMinutes: number;
  helpMinutes: number;
  breakMinutes: number;
  confirmed?: boolean;
  warnings?: string[];
  kind?: "daily" | "total";
  dailyTransportationUnit?: number;
  dailyTransportationAmount?: number;
  clockIn?: string | null;
  clockOut?: string | null;
  breakPeriods?: { start: string | null; end: string | null }[];
  storeNames?: string[];
};

export type PayrollIssue = {
  severity: "error" | "warning";
  code: string;
  employeeId?: string;
  message: string;
};

export type PayrollResult = {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  storeId: string;
  storeName: string;
  payrollType: PayrollType;
  paymentMethod: PaymentMethod;
  payrollTransferOrder: number | null;
  attendance: {
    workingDays: number;
    attendanceDays: number;
    absenceDays: number;
    paidLeaveDays: number;
    workMinutes: number;
    overtimeMinutes: number;
    nightMinutes: number;
    holidayMinutes: number;
    breakMinutes: number;
    helpMinutes: number;
  };
  earnings: {
    baseSalary: number;
    directorCompensation: number;
    positionAllowance: number;
    fixedOvertimeAllowance: number;
    holidayAllowance: number;
    businessAllowance: number;
    overtimePremium: number;
    nightPremium: number;
    otherTaxable: number;
    absenceDeduction: number;
    lateEarlyDeduction: number;
    taxableTotal: number;
    transportation: number;
    otherNonTaxable: number;
    nonTaxableTotal: number;
    grossTotal: number;
  };
  deductions: {
    healthInsurance: number;
    childSupportContribution: number;
    careInsurance: number;
    employeePension: number;
    employmentInsurance: number;
    socialInsuranceTotal: number;
    taxableIncome: number;
    incomeTax: number;
    residentTax: number;
    yearEndAdjustment: number;
    otherDeduction: number;
    advanceExpense: number;
    total: number;
  };
  netPay: number;
  bankTransfer: number;
  cashPayment: number;
  hourlyWageSnapshot: number | null;
  taxTableTypeSnapshot: TaxTableType;
  dependentCountSnapshot: number;
  issues: PayrollIssue[];
  attendanceDaysDetail: PayrollAttendanceDay[];
};

const yen = (value: unknown) => Math.max(0, Math.trunc(Number(value) || 0));

export function calculateWithholdingTax2026(taxableIncome: number, type: TaxTableType, dependentCount: number) {
  const amount = Math.max(0, Math.trunc(taxableIncome));
  if (amount < 105_000) return type === "kou" ? 0 : Math.floor(amount * 0.03063);
  const row = tax2026.rows.find((item) => amount >= item.min && amount < item.max);
  if (row) {
    if (type === "otsu") return row.otsu;
    if (dependentCount <= 7) return row.kou[Math.max(0, dependentCount)] ?? 0;
    return Math.max(0, row.kou[7] - (dependentCount - 7) * 1_610);
  }
  // 740,000円以上は月額表の算式適用が必要なため、自動確定を止める側で警告する。
  return 0;
}

export function validatePayrollInput(employees: PayrollEmployee[], attendance: PayrollAttendanceDay[], targetMonth: string, alreadyConfirmed = false) {
  const issues: PayrollIssue[] = [];
  if (alreadyConfirmed) issues.push({ severity: "error", code: "already_confirmed", message: `${targetMonth}の給与はすでに確定済みです` });
  const ids = new Set<string>();
  const codes = new Map<string, string>();
  for (const employee of employees.filter((item) => item.payrollEnabled !== false)) {
    if (ids.has(employee.id)) issues.push({ severity: "error", code: "duplicate_employee_id", employeeId: employee.id, message: "同一従業員IDが重複しています" });
    ids.add(employee.id);
    const previous = codes.get(employee.employeeCode);
    if (previous && previous !== employee.id) issues.push({ severity: "warning", code: "duplicate_employee_code", employeeId: employee.id, message: `社員コード${employee.employeeCode}が重複しています` });
    codes.set(employee.employeeCode, employee.id);
    const type = employee.payrollType ?? (employee.fixedBaseSalary ? "fixed" : "hourly");
    if (type === "hourly" && !yen(employee.hourlyWage ?? employee.baseWage)) issues.push({ severity: "error", code: "missing_hourly_wage", employeeId: employee.id, message: "時給が未設定です" });
    if (type === "fixed" && !yen(employee.fixedBaseSalary) && !yen(employee.directorCompensation)) issues.push({ severity: "error", code: "missing_fixed_salary", employeeId: employee.id, message: "固定給または役員報酬が未設定です" });
    if (!employee.taxTableType) issues.push({ severity: "error", code: "missing_tax_setting", employeeId: employee.id, message: "税区分が未設定です" });
    if ((employee.paymentMethod ?? "bank") === "bank" && employee.bankAccountRegistered !== true && !employee.bankAccountNumber) issues.push({ severity: "error", code: "missing_bank_account", employeeId: employee.id, message: "銀行口座情報が未登録です" });
    if (employee.healthInsurance == null || employee.employeePension == null || employee.employmentInsurance == null) issues.push({ severity: "warning", code: "missing_social_insurance_setting", employeeId: employee.id, message: "社会保険設定に未入力項目があります" });
    if (!employee.transportationType) issues.push({ severity: "warning", code: "missing_transportation_setting", employeeId: employee.id, message: "交通費区分が未設定です" });
  }
  for (const day of attendance.filter((item) => item.date.startsWith(targetMonth) && item.kind !== "total")) {
    if (day.confirmed !== true) issues.push({ severity: "error", code: "attendance_unconfirmed", employeeId: day.employeeId, message: `${day.date}の勤怠が未確定です` });
    for (const warning of day.warnings ?? []) issues.push({ severity: "error", code: "attendance_invalid", employeeId: day.employeeId, message: `${day.date}: ${warning}` });
  }
  return issues;
}

export function isPayrollMonthClosed(targetMonth: string, now = new Date()) {
  const [year, month] = targetMonth.split("-").map(Number);
  if (!year || !month) return false;
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const currentMonth = `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}`;
  return currentMonth > targetMonth;
}

export function calculatePayrollEmployee(employee: PayrollEmployee, allAttendance: PayrollAttendanceDay[]): PayrollResult {
  const days = allAttendance.filter((day) => day.kind !== "total" && day.employeeId === employee.id).sort((a, b) => a.date.localeCompare(b.date));
  const totals = days.reduce((sum, day) => ({
    work: sum.work + day.workMinutes, overtime: sum.overtime + day.overtimeMinutes, night: sum.night + day.nightMinutes,
    help: sum.help + day.helpMinutes, break: sum.break + day.breakMinutes,
  }), { work: 0, overtime: 0, night: 0, help: 0, break: 0 });
  const attendanceDays = new Set(days.filter((day) => day.workMinutes > 0).map((day) => day.date)).size;
  const payrollType = employee.payrollType ?? (employee.fixedBaseSalary ? "fixed" : "hourly");
  const hourlyWage = yen(employee.hourlyWage ?? employee.baseWage);
  const baseSalary = payrollType === "hourly" ? Math.floor(totals.work * hourlyWage / 60) : yen(employee.fixedBaseSalary);
  const overtimePremium = payrollType === "hourly" ? Math.floor(totals.overtime * hourlyWage * 0.25 / 60) : 0;
  const nightPremium = payrollType === "hourly" ? Math.floor(totals.night * hourlyWage * 0.25 / 60) : 0;
  const transportationType = employee.transportationType ?? "none";
  const configuredDailyUnit = yen(employee.dailyTransportation ?? (transportationType === "daily" ? employee.transportationCost : 0));
  const dailyTransportationByDate = new Map<string, number>();
  for (const day of days.filter((item) => item.workMinutes > 0)) {
    const amount = yen(day.dailyTransportationAmount ?? day.dailyTransportationUnit ?? configuredDailyUnit);
    dailyTransportationByDate.set(day.date, Math.max(dailyTransportationByDate.get(day.date) ?? 0, amount));
  }
  const dailyTransportation = [...dailyTransportationByDate.values()].reduce((sum, amount) => sum + amount, 0);
  const monthlyTransportation = yen(employee.monthlyTransportation ?? (transportationType === "monthly" ? employee.transportationCost : 0));
  const transportation = dailyTransportation + monthlyTransportation;
  const transportationAccountedDates = new Set<string>();
  const attendanceDaysDetail = days.map((day) => {
    const shouldAccount = day.workMinutes > 0 && !transportationAccountedDates.has(day.date);
    if (shouldAccount) transportationAccountedDates.add(day.date);
    return { ...day, dailyTransportationUnit: yen(day.dailyTransportationUnit ?? configuredDailyUnit), dailyTransportationAmount: shouldAccount ? (dailyTransportationByDate.get(day.date) ?? 0) : 0 };
  });
  const absenceDeduction = yen(employee.absenceDeduction);
  const lateEarlyDeduction = yen(employee.lateEarlyDeduction);
  const taxableTotal = baseSalary + yen(employee.directorCompensation) + yen(employee.positionAllowance) + yen(employee.fixedOvertimeAllowance) + yen(employee.holidayAllowance) + yen(employee.businessAllowance) + overtimePremium + nightPremium + yen(employee.otherAllowance) - absenceDeduction - lateEarlyDeduction;
  const nonTaxableTotal = transportation + yen(employee.otherNonTaxableAllowance);
  const grossTotal = taxableTotal + nonTaxableTotal;
  const socialInsuranceTotal = yen(employee.healthInsurance) + yen(employee.childSupportContribution) + yen(employee.careInsurance) + yen(employee.employeePension) + yen(employee.employmentInsurance);
  const taxableIncome = Math.max(0, taxableTotal - socialInsuranceTotal);
  const taxTableType = employee.taxTableType ?? "kou";
  const dependentCount = Math.max(0, Math.trunc(employee.dependentCount ?? 0));
  const issues: PayrollIssue[] = [];
  if (taxableIncome >= 740_000) issues.push({ severity: "error", code: "tax_formula_required", employeeId: employee.id, message: "課税対象額740,000円以上は税額表の算式確認が必要です" });
  const incomeTax = calculateWithholdingTax2026(taxableIncome, taxTableType, dependentCount);
  const deductionTotal = socialInsuranceTotal + incomeTax + yen(employee.residentTax) + yen(employee.yearEndAdjustment) + yen(employee.otherDeduction) + yen(employee.advanceExpense);
  const netPay = grossTotal - deductionTotal + Math.trunc(employee.otherTotal ?? 0);
  const paymentMethod = employee.paymentMethod ?? "bank";
  return {
    employeeId: employee.id, employeeCode: employee.employeeCode, employeeName: employee.name,
    storeId: employee.storeId, storeName: employee.storeName ?? employee.storeId, payrollType, paymentMethod,
    payrollTransferOrder: employee.payrollTransferOrder ?? null,
    attendance: { workingDays: yen(employee.workingDays), attendanceDays, absenceDays: yen(employee.absenceDays), paidLeaveDays: yen(employee.paidLeaveDays), workMinutes: totals.work, overtimeMinutes: totals.overtime, nightMinutes: totals.night, holidayMinutes: 0, breakMinutes: totals.break, helpMinutes: totals.help },
    earnings: { baseSalary, directorCompensation: yen(employee.directorCompensation), positionAllowance: yen(employee.positionAllowance), fixedOvertimeAllowance: yen(employee.fixedOvertimeAllowance), holidayAllowance: yen(employee.holidayAllowance), businessAllowance: yen(employee.businessAllowance), overtimePremium, nightPremium, otherTaxable: yen(employee.otherAllowance), absenceDeduction, lateEarlyDeduction, taxableTotal, transportation, otherNonTaxable: yen(employee.otherNonTaxableAllowance), nonTaxableTotal, grossTotal },
    deductions: { healthInsurance: yen(employee.healthInsurance), childSupportContribution: yen(employee.childSupportContribution), careInsurance: yen(employee.careInsurance), employeePension: yen(employee.employeePension), employmentInsurance: yen(employee.employmentInsurance), socialInsuranceTotal, taxableIncome, incomeTax, residentTax: yen(employee.residentTax), yearEndAdjustment: yen(employee.yearEndAdjustment), otherDeduction: yen(employee.otherDeduction), advanceExpense: yen(employee.advanceExpense), total: deductionTotal },
    netPay, bankTransfer: paymentMethod === "bank" ? netPay : 0, cashPayment: paymentMethod === "cash" ? netPay : 0,
    hourlyWageSnapshot: payrollType === "hourly" ? hourlyWage : null, taxTableTypeSnapshot: taxTableType, dependentCountSnapshot: dependentCount,
    issues, attendanceDaysDetail,
  };
}

export function calculatePayroll(employees: PayrollEmployee[], attendance: PayrollAttendanceDay[]) {
  const unique = new Map(employees.filter((item) => item.payrollEnabled !== false).map((item) => [item.id, item]));
  return [...unique.values()].map((employee) => calculatePayrollEmployee(employee, attendance));
}

export function summarizePayroll(results: PayrollResult[]) {
  return results.reduce((sum, item) => ({
    employeeCount: sum.employeeCount + 1,
    taxableTotal: sum.taxableTotal + item.earnings.taxableTotal,
    transportationTotal: sum.transportationTotal + item.earnings.transportation,
    grossTotal: sum.grossTotal + item.earnings.grossTotal,
    socialInsuranceTotal: sum.socialInsuranceTotal + item.deductions.socialInsuranceTotal,
    incomeTaxTotal: sum.incomeTaxTotal + item.deductions.incomeTax,
    residentTaxTotal: sum.residentTaxTotal + item.deductions.residentTax,
    deductionTotal: sum.deductionTotal + item.deductions.total,
    netTotal: sum.netTotal + item.netPay,
    bankTransferTotal: sum.bankTransferTotal + item.bankTransfer,
  }), { employeeCount: 0, taxableTotal: 0, transportationTotal: 0, grossTotal: 0, socialInsuranceTotal: 0, incomeTaxTotal: 0, residentTaxTotal: 0, deductionTotal: 0, netTotal: 0, bankTransferTotal: 0 });
}

export function adjustPayrollResult(result: PayrollResult, values: { otherTaxable: number; otherDeduction: number }, reason: string, adjustedBy: string) {
  if (!reason.trim()) throw new Error("adjustment_reason_required");
  const next = structuredClone(result);
  next.earnings.otherTaxable = yen(values.otherTaxable);
  next.earnings.taxableTotal = next.earnings.baseSalary + next.earnings.directorCompensation + next.earnings.positionAllowance + next.earnings.fixedOvertimeAllowance + next.earnings.holidayAllowance + next.earnings.businessAllowance + next.earnings.overtimePremium + next.earnings.nightPremium + next.earnings.otherTaxable - next.earnings.absenceDeduction - next.earnings.lateEarlyDeduction;
  next.earnings.grossTotal = next.earnings.taxableTotal + next.earnings.nonTaxableTotal;
  next.deductions.taxableIncome = Math.max(0, next.earnings.taxableTotal - next.deductions.socialInsuranceTotal);
  next.deductions.incomeTax = calculateWithholdingTax2026(next.deductions.taxableIncome, next.taxTableTypeSnapshot, next.dependentCountSnapshot);
  next.deductions.otherDeduction = yen(values.otherDeduction);
  next.deductions.total = next.deductions.socialInsuranceTotal + next.deductions.incomeTax + next.deductions.residentTax + next.deductions.yearEndAdjustment + next.deductions.otherDeduction + next.deductions.advanceExpense;
  next.netPay = next.earnings.grossTotal - next.deductions.total;
  next.bankTransfer = next.paymentMethod === "bank" ? next.netPay : 0;
  next.cashPayment = next.paymentMethod === "cash" ? next.netPay : 0;
  return { result: next, adjustment: { before: { otherTaxable: result.earnings.otherTaxable, otherDeduction: result.deductions.otherDeduction }, after: values, reason: reason.trim(), adjustedBy, adjustedAt: new Date().toISOString() } };
}

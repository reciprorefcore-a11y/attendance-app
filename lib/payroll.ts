import tax2026 from "./tax-tables/2026.ts";
import { calculateAutomaticStatutoryDeductions } from "./payroll-statutory.ts";

export const HOLIDAY_MONTHLY_HOURS = 177.67;
export const HOLIDAY_DAILY_HOURS = 8;
export const HOLIDAY_RATE = 1.25;
export function calculateHolidayUnitPay(baseSalary: number): number {
  return Math.round(baseSalary / HOLIDAY_MONTHLY_HOURS * HOLIDAY_DAILY_HOURS * HOLIDAY_RATE);
}

/** 会社の現行規程に合わせた休日・時間外手当算定基礎。手当や通勤費は根拠確認前に含めない。 */
export const PREMIUM_CALCULATION_BASIS_POLICY = {
  fixedBaseSalary: true,
  positionAllowance: false,
  skillAllowance: false,
  fixedOvertimeAllowance: false,
  otherFixedAllowance: false,
  transportation: false,
} as const;
export function calculatePremiumBasis(employee: Pick<PayrollEmployee,"fixedBaseSalary"|"positionAllowance"|"skillAllowance"|"fixedOvertimeAllowance"|"otherFixedAllowance"|"monthlyTransportation"|"dailyTransportation">) {
  return yen(employee.fixedBaseSalary);
}
/** 確定した分類に基づく改定案。給与へはまだ適用せず差額試算にのみ使用する。 */
export function calculateProposedPremiumBasis(employee: Pick<PayrollEmployee,"fixedBaseSalary"|"positionAllowance"|"skillAllowance"|"otherFixedAllowance">) {
  return yen(employee.fixedBaseSalary)+yen(employee.positionAllowance)+yen(employee.skillAllowance)+yen(employee.otherFixedAllowance);
}

export type PayrollType = "hourly" | "fixed";
export type TaxTableType = "kou" | "otsu";
export type PaymentMethod = "bank" | "cash";

export type PayrollEmployee = {
  id: string;
  employeeCode: string;
  name: string;
  storeId?: string;
  storeName?: string;
  employeeType?: "partTime" | "fullTime";
  payrollEnabled?: boolean;
  payrollType?: PayrollType;
  employmentType?: string;
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
  socialInsuranceEnrolled?: boolean | null;
  standardMonthlyRemuneration?: number | null;
  careInsuranceApplicable?: boolean | null;
  employmentInsuranceEnrolled?: boolean | null;
  residentTax?: number;
  residentTaxHistory?: ResidentTaxHistoryEntry[];
  residentTaxFallbackUsed?: boolean;
  residentTaxEffectiveMonth?: string | null;
  incomeTax?: number;
  previousConfirmedPayrollMissing?: boolean;
  fixedBaseSalary?: number;
  /** 休日出勤1回単価の算定基礎。未設定時はfixedBaseSalaryを使用する。 */
  holidayAllowanceBaseSalary?: number;
  directorCompensation?: number;
  positionAllowance?: number;
  skillAllowance?: number;
  businessAllowance?: number;
  holidayAllowance?: number;
  fixedOvertimeAllowance?: number;
  fixedOvertimeSupplement?: number;
  fixedOvertimeHours?: number | null;
  otherFixedAllowance?: number;
  otherFixedAllowanceName?: string;
  otherAllowance?: number;
  otherNonTaxableAllowance?: number;
  otherDeduction?: number;
  expenseReimbursement?: number;
  /** @deprecated 旧形式。負値は expenseReimbursement へ移行。 */
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

export type ResidentTaxHistoryEntry = {
  amount: number;
  effectiveMonth: string;
  updatedAt?: unknown;
  updatedBy?: string;
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

export type FixedPayrollAdjustment = {
  temporaryAttendanceCount?: number;
  /** 当月だけ使用する休日手当総額。自動額と異なる場合は overrideReason が必須。 */
  holidayAllowanceOverride?: number | null;
  overrideReason?: string;
  overtimeMinutes?: number;
  overtimeAllowanceOverride?: number | null;
  overtimeReason?: string;
  transportation?: number;
  /** 立替経費精算（会社から本人へ返金）。正数で入力。控除に含めず最終支給額に加算する。 */
  expenseReimbursement?: number;
  /** @deprecated 旧形式。負値は expenseReimbursement へ変換。正値はエラー。 */
  advanceExpense?: number;
  /** 月次給与に算入するその他課税支給（月額表で源泉徴収）。賞与（賞与表）とは別扱い。 */
  otherTemporaryPayment?: number;
  otherDeduction?: number;
  note?: string;
};

export type PayrollResult = {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  storeId: string;
  storeName: string;
  employeeType: "partTime" | "fullTime";
  payrollType: PayrollType;
  paymentMethod: PaymentMethod;
  payrollTransferOrder: number | null;
  bankAccountRegisteredSnapshot: boolean | null;
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
    skillAllowance: number;
    fixedOvertimeAllowance: number;
    fixedOvertimeSupplement: number;
    holidayAllowance: number;
    businessAllowance: number;
    otherFixedAllowance: number;
    otherFixedAllowanceName: string;
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
    total: number;
  };
  reimbursements: {
    expenseReimbursement: number;
    total: number;
  };
  payrollNetPay: number;
  netPay: number;
  bankTransfer: number;
  cashPayment: number;
  hourlyWageSnapshot: number | null;
  taxTableTypeSnapshot: TaxTableType;
  dependentCountSnapshot: number;
  residentTaxEffectiveMonthSnapshot: string | null;
  holidayAllowanceBaseSalarySnapshot: number;
  fixedOvertimeHoursSnapshot: number | null;
  issues: PayrollIssue[];
  attendanceDaysDetail: PayrollAttendanceDay[];
  fixedAdjustment?: FixedPayrollAdjustment & { automaticOvertimeAllowance: number; overtimeWithinFixedMinutes: number; excessOvertimeMinutes: number };
};

const yen = (value: unknown) => Math.max(0, Math.trunc(Number(value) || 0));
const FIXED_EMPLOYEE_CODES = new Set(["0002", "0003", "0017", "0064", "0083"]);

export function resolvePayrollType(employee: PayrollEmployee): PayrollType {
  if (employee.employeeType === "fullTime") return "fixed";
  if (employee.employeeType === "partTime") return "hourly";
  if (FIXED_EMPLOYEE_CODES.has(String(employee.employeeCode).padStart(4, "0")) || employee.payrollType === "fixed") return "fixed";
  return "hourly";
}

function employeeLabel(employee: PayrollEmployee) {
  return `${employee.employeeCode || "社員コード不明"} ${employee.name || "氏名不明"}`;
}

export function calculateWithholdingTax2026(taxableIncome: number, type: TaxTableType, dependentCount: number) {
  const amount = Math.max(0, Math.trunc(taxableIncome));
  if (type === "kou" && amount < 88_000) return 0;
  const row = tax2026.rows.find((item) => amount >= item.min && amount < item.max);
  if (row) {
    if (type === "otsu") return row.otsu;
    if (dependentCount <= 7) return row.kou[Math.max(0, dependentCount)] ?? 0;
    return Math.max(0, row.kou[7] - (dependentCount - 7) * 1_610);
  }
  if (amount < 105_000) return type === "otsu" ? Math.floor(amount * 0.03063) : 0;
  // 740,000円以上：甲欄は電算機計算の特例（令和8年分 月額表 算式）で計算する
  if (type === "kou") {
    // 別表第一：月額給与所得控除
    let empDeduct: number;
    if (amount <= 130_417)      empDeduct = 45_833;
    else if (amount <= 150_000) empDeduct = Math.floor(amount * 0.4) - 8_334;
    else if (amount <= 300_000) empDeduct = Math.floor(amount * 0.3) + 6_667;
    else if (amount <= 550_000) empDeduct = Math.floor(amount * 0.2) + 36_667;
    else if (amount <= 708_333) empDeduct = Math.floor(amount * 0.1) + 91_667;
    else                        empDeduct = 162_500;
    // 別表第二：月額扶養控除 31,667円/人、別表第三：月額基礎控除 48,334円
    const deps = Math.max(0, Math.trunc(dependentCount));
    const B = Math.max(0, amount - empDeduct - 48_334 - deps * 31_667);
    // 別表第四：税額計算（復興特別所得税込み）
    let raw: number;
    if (B <= 162_500)       raw = B * 0.05105;
    else if (B <= 275_000)  raw = B * 0.10210 - 8_296;
    else if (B <= 579_167)  raw = B * 0.20420 - 36_374;
    else if (B <= 750_000)  raw = B * 0.23483 - 54_114;
    else if (B <= 1_500_000) raw = B * 0.33693 - 130_690;
    else if (B <= 3_333_333) raw = B * 0.40840 - 237_895;
    else                    raw = B * 0.45945 - 408_062;
    return Math.max(0, Math.round(raw / 10) * 10);
  }
  // 乙欄：740,000円以上の算式は非公開のため未実装
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
    const type = resolvePayrollType(employee);
    const hourlyWageRequired = employee.payrollType === "hourly" || employee.employmentType === "hourly" || employee.employmentType === "part_time";
    if (type === "hourly" && hourlyWageRequired && !yen(employee.hourlyWage ?? employee.baseWage)) issues.push({ severity: "error", code: "missing_hourly_wage", employeeId: employee.id, message: `${employeeLabel(employee)}：時給が未設定です` });
    if (type === "fixed" && employee.previousConfirmedPayrollMissing) issues.push({ severity: "error", code: "missing_previous_fixed_payroll", employeeId: employee.id, message: `${employeeLabel(employee)}：幹部の前月確定値または給与テンプレート固定値がありません` });
    if (type === "fixed" && employee.residentTaxFallbackUsed) issues.push({ severity: "warning", code: "resident_tax_history_fallback", employeeId: employee.id, message: `${employeeLabel(employee)}：${targetMonth}以前の住民税履歴がないため既存住民税を使用しました` });
    if (type === "fixed") {
      const missingInsurance = [["健康保険", employee.healthInsurance], ["子育て支援金", employee.childSupportContribution], ["介護保険", employee.careInsurance], ["厚生年金", employee.employeePension], ["雇用保険", employee.employmentInsurance]].filter(([, value]) => value == null).map(([label]) => label);
      if (missingInsurance.length) issues.push({ severity: "warning", code: "missing_social_insurance_setting", employeeId: employee.id, message: `${employeeLabel(employee)}：未入力の社会保険項目（${missingInsurance.join("、")}）` });
      if (!employee.transportationType) issues.push({ severity: "warning", code: "missing_transportation_setting", employeeId: employee.id, message: `${employeeLabel(employee)}：交通費区分が未設定です` });
    }
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
  const payrollType = resolvePayrollType(employee);
  const hourlyWage = yen(employee.hourlyWage ?? employee.baseWage);
  const baseSalary = payrollType === "hourly" ? Math.round(totals.work * hourlyWage / 60) : yen(employee.fixedBaseSalary);
  // 旧businessAllowanceは業務手当（固定残業）、旧fixedOvertimeAllowanceは別枠固定残業手当。
  const legacyBusinessAllowance = yen(employee.businessAllowance);
  const legacyFixedOvertimeAllowance = yen(employee.fixedOvertimeAllowance);
  const isNewBreakdown = employee.skillAllowance != null || employee.fixedOvertimeSupplement != null;
  const explicitOtherFixedAllowance = yen(employee.otherFixedAllowance);
  const fixedOvertimeAllowance = legacyBusinessAllowance > 0 ? legacyBusinessAllowance : legacyFixedOvertimeAllowance;
  const fixedOvertimeSupplement = isNewBreakdown ? yen(employee.fixedOvertimeSupplement) : (legacyBusinessAllowance > 0 ? legacyFixedOvertimeAllowance : 0);
  const otherFixedAllowance = explicitOtherFixedAllowance;
  const positionAllowance = isNewBreakdown ? yen(employee.positionAllowance) : 0;
  const skillAllowance = isNewBreakdown ? yen(employee.skillAllowance) : yen(employee.positionAllowance);
  const overtimePremium = payrollType === "hourly" ? Math.round(totals.overtime * hourlyWage * 0.25 / 60) : 0;
  const nightPremium = payrollType === "hourly" ? Math.round(totals.night * hourlyWage * 0.25 / 60) : 0;
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
  const taxableTotal = baseSalary + yen(employee.directorCompensation) + positionAllowance + skillAllowance + fixedOvertimeAllowance + fixedOvertimeSupplement + otherFixedAllowance + overtimePremium + nightPremium + yen(employee.otherAllowance) - absenceDeduction - lateEarlyDeduction;
  const nonTaxableTotal = transportation + yen(employee.otherNonTaxableAllowance);
  const grossTotal = taxableTotal + nonTaxableTotal;
  const automatic = calculateAutomaticStatutoryDeductions({ taxableEarnings: taxableTotal, socialInsuranceEnrolled: employee.socialInsuranceEnrolled, standardMonthlyRemuneration: employee.standardMonthlyRemuneration, careInsuranceApplicable: employee.careInsuranceApplicable, employmentInsuranceEnrolled: employee.employmentInsuranceEnrolled });
  const healthInsurance = automatic.healthInsurance ?? yen(employee.healthInsurance);
  const childSupportContribution = automatic.childSupportContribution ?? yen(employee.childSupportContribution);
  const careInsurance = automatic.careInsurance ?? yen(employee.careInsurance);
  const employeePension = automatic.employeePension ?? yen(employee.employeePension);
  const employmentInsurance = automatic.employmentInsurance ?? yen(employee.employmentInsurance);
  const socialInsuranceTotal = healthInsurance + childSupportContribution + careInsurance + employeePension + employmentInsurance;
  const taxableIncome = Math.max(0, taxableTotal - socialInsuranceTotal);
  const taxTableType = employee.taxTableType ?? "kou";
  const dependentCount = Math.max(0, Math.trunc(employee.dependentCount ?? 0));
  const issues: PayrollIssue[] = [];
  if (taxTableType === "otsu" && taxableIncome >= 740_000) issues.push({ severity: "error", code: "tax_formula_required", employeeId: employee.id, message: `${employeeLabel(employee)}：課税対象額740,000円以上（乙欄）の所得税は自動計算できないため確定できません。手動入力してください` });
  const incomeTax = payrollType === "fixed" && employee.incomeTax != null
    ? yen(employee.incomeTax)
    : calculateWithholdingTax2026(taxableIncome, taxTableType, dependentCount);
  const deductionTotal = socialInsuranceTotal + incomeTax + yen(employee.residentTax) + yen(employee.yearEndAdjustment) + yen(employee.otherDeduction);
  const expenseReimbursement = Math.max(0, Math.trunc(Number(employee.expenseReimbursement) || 0));
  const reimbursements = { expenseReimbursement, total: expenseReimbursement };
  const payrollNetPay = grossTotal - deductionTotal + Math.trunc(employee.otherTotal ?? 0);
  const netPay = payrollNetPay + reimbursements.total;
  const paymentMethod = employee.paymentMethod ?? "bank";
  return {
    employeeId: employee.id, employeeCode: employee.employeeCode, employeeName: employee.name,
    storeId: payrollType === "fixed" ? "" : (employee.storeId ?? ""), storeName: payrollType === "fixed" ? "所属なし" : (employee.storeName ?? employee.storeId ?? ""), employeeType: payrollType === "fixed" ? "fullTime" : "partTime", payrollType, paymentMethod,
    payrollTransferOrder: employee.payrollTransferOrder ?? null,
    attendance: { workingDays: yen(employee.workingDays), attendanceDays, absenceDays: yen(employee.absenceDays), paidLeaveDays: yen(employee.paidLeaveDays), workMinutes: totals.work, overtimeMinutes: totals.overtime, nightMinutes: totals.night, holidayMinutes: 0, breakMinutes: totals.break, helpMinutes: totals.help },
    earnings: { baseSalary, directorCompensation: yen(employee.directorCompensation), positionAllowance, skillAllowance, fixedOvertimeAllowance, fixedOvertimeSupplement, holidayAllowance: 0, businessAllowance: 0, otherFixedAllowance, otherFixedAllowanceName: String(employee.otherFixedAllowanceName ?? ""), overtimePremium, nightPremium, otherTaxable: yen(employee.otherAllowance), absenceDeduction, lateEarlyDeduction, taxableTotal, transportation, otherNonTaxable: yen(employee.otherNonTaxableAllowance), nonTaxableTotal, grossTotal },
    deductions: { healthInsurance, childSupportContribution, careInsurance, employeePension, employmentInsurance, socialInsuranceTotal, taxableIncome, incomeTax, residentTax: yen(employee.residentTax), yearEndAdjustment: yen(employee.yearEndAdjustment), otherDeduction: yen(employee.otherDeduction), total: deductionTotal },
    reimbursements, payrollNetPay, netPay, bankTransfer: paymentMethod === "bank" ? netPay : 0, cashPayment: paymentMethod === "cash" ? netPay : 0,
    bankAccountRegisteredSnapshot: employee.bankAccountRegistered == null ? null : employee.bankAccountRegistered === true,
    hourlyWageSnapshot: payrollType === "hourly" ? hourlyWage : null, taxTableTypeSnapshot: taxTableType, dependentCountSnapshot: dependentCount,
    residentTaxEffectiveMonthSnapshot: employee.residentTaxEffectiveMonth ?? null,
    holidayAllowanceBaseSalarySnapshot: payrollType === "fixed" ? calculatePremiumBasis(employee) : 0,
    fixedOvertimeHoursSnapshot: payrollType === "fixed" && employee.fixedOvertimeHours != null && Number.isFinite(employee.fixedOvertimeHours) ? Math.max(0, Number(employee.fixedOvertimeHours)) : null,
    issues, attendanceDaysDetail,
  };
}

export function calculatePayroll(employees: PayrollEmployee[], attendance: PayrollAttendanceDay[]) {
  const unique = new Map(employees.filter((item) => item.payrollEnabled !== false).map((item) => [item.id, item]));
  return [...unique.values()].map((employee) => calculatePayrollEmployee(employee, attendance));
}

export function applyFixedPayrollAdjustment(result: PayrollResult, adjustment: FixedPayrollAdjustment): PayrollResult {
  if (result.payrollType !== "fixed") return result;
  const overtimeMinutes = Math.max(0, Math.trunc(Number(adjustment.overtimeMinutes) || 0));
  const fixedOvertimeMinutes = result.fixedOvertimeHoursSnapshot == null ? null : Math.round(result.fixedOvertimeHoursSnapshot * 60);
  const overtimeWithinFixedMinutes = fixedOvertimeMinutes == null ? 0 : Math.min(overtimeMinutes, fixedOvertimeMinutes);
  const excessOvertimeMinutes = fixedOvertimeMinutes == null ? overtimeMinutes : Math.max(0, overtimeMinutes - fixedOvertimeMinutes);
  const automaticOvertimeAllowance = Math.round(excessOvertimeMinutes * (result.earnings.baseSalary / 160) * 1.25 / 60);
  const overtimePremium = adjustment.overtimeAllowanceOverride == null ? automaticOvertimeAllowance : yen(adjustment.overtimeAllowanceOverride);
  const transportation = adjustment.transportation != null ? yen(adjustment.transportation) : result.earnings.transportation;
  const otherTaxable = yen(adjustment.otherTemporaryPayment);
  const otherDeduction = yen(adjustment.otherDeduction);
  const temporaryAttendanceCount = Math.max(0, Math.trunc(Number(adjustment.temporaryAttendanceCount) || 0));
  const holidayUnitPay = calculateHolidayUnitPay(result.holidayAllowanceBaseSalarySnapshot ?? result.earnings.baseSalary);
  const automaticHolidayAllowance = holidayUnitPay * temporaryAttendanceCount;
  const holidayAllowance = adjustment.holidayAllowanceOverride == null
    ? automaticHolidayAllowance
    : yen(adjustment.holidayAllowanceOverride);
  // 立替経費精算：正数で入力、控除に含めず payrollNetPay に加算して最終支給額を増やす
  // 新フィールド expenseReimbursement が明示されている場合は必ず優先し、旧フィールド advanceExpense を無視する
  const additionalIssues: PayrollIssue[] = [];
  if (result.earnings.fixedOvertimeAllowance > 0 && result.fixedOvertimeHoursSnapshot == null) {
    additionalIssues.push({ severity: "warning", code: "fixed_overtime_hours_missing", employeeId: result.employeeId, message: `${result.employeeName}：固定残業時間未設定のため、当月の普通残業時間をすべて超過分として計算します` });
  }
  if (holidayAllowance !== automaticHolidayAllowance && !adjustment.overrideReason?.trim()) {
    additionalIssues.push({ severity: "error", code: "holiday_allowance_override_reason_required", employeeId: result.employeeId, message: `${result.employeeName}：休日手当修正額が自動計算額と異なるため修正理由を入力してください` });
  }
  let expenseReimbursement: number;
  if (adjustment.expenseReimbursement != null) {
    expenseReimbursement = Math.max(0, Math.trunc(Number(adjustment.expenseReimbursement) || 0));
  } else {
    const legacyAdvance = Number(adjustment.advanceExpense);
    if (!isNaN(legacyAdvance) && legacyAdvance !== 0) {
      if (legacyAdvance < 0) {
        // 旧負値（返金）→ expenseReimbursement へ自動変換
        expenseReimbursement = Math.abs(Math.trunc(legacyAdvance));
      } else {
        // 旧正値：支給方向が逆転するリスクがあるため blocking error として確定を阻止する
        additionalIssues.push({ severity: "error", code: "legacy_advance_expense", employeeId: result.employeeId, message: `${result.employeeName}：旧形式の立替経費データがあります。支給する精算額を確認し、立替経費精算へ入力し直してください` });
        expenseReimbursement = 0;
      }
    } else {
      expenseReimbursement = 0;
    }
  }
  const earnings = { ...result.earnings, overtimePremium, transportation, otherTaxable, holidayAllowance };
  earnings.taxableTotal = earnings.baseSalary + earnings.directorCompensation + earnings.positionAllowance + earnings.skillAllowance + earnings.fixedOvertimeAllowance + earnings.fixedOvertimeSupplement + earnings.otherFixedAllowance + earnings.holidayAllowance + earnings.overtimePremium + earnings.nightPremium + earnings.otherTaxable - earnings.absenceDeduction - earnings.lateEarlyDeduction;
  earnings.nonTaxableTotal = earnings.transportation + earnings.otherNonTaxable;
  earnings.grossTotal = earnings.taxableTotal + earnings.nonTaxableTotal;
  const deductions = { ...result.deductions, otherDeduction };
  deductions.taxableIncome = Math.max(0, earnings.taxableTotal - deductions.socialInsuranceTotal);
  deductions.incomeTax = calculateWithholdingTax2026(deductions.taxableIncome, result.taxTableTypeSnapshot, result.dependentCountSnapshot);
  deductions.total = deductions.socialInsuranceTotal + deductions.incomeTax + deductions.residentTax + deductions.yearEndAdjustment + deductions.otherDeduction;
  const reimbursements = { expenseReimbursement, total: expenseReimbursement };
  const payrollNetPay = earnings.grossTotal - deductions.total;
  const netPay = payrollNetPay + reimbursements.total;
  return {
    ...result,
    attendance: { ...result.attendance, overtimeMinutes },
    earnings,
    deductions,
    reimbursements,
    payrollNetPay,
    netPay,
    bankTransfer: result.paymentMethod === "bank" ? netPay : 0,
    cashPayment: result.paymentMethod === "cash" ? netPay : 0,
    fixedAdjustment: { ...adjustment, overtimeMinutes, temporaryAttendanceCount, holidayAllowanceOverride: adjustment.holidayAllowanceOverride ?? null, overrideReason: adjustment.overrideReason?.trim() ?? "", automaticOvertimeAllowance, overtimeWithinFixedMinutes, excessOvertimeMinutes },
    issues: additionalIssues.length > 0 ? [...result.issues, ...additionalIssues] : result.issues,
  };
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
    reimbursementsTotal: sum.reimbursementsTotal + item.reimbursements.total,
    netTotal: sum.netTotal + item.netPay,
    bankTransferTotal: sum.bankTransferTotal + item.bankTransfer,
  }), { employeeCount: 0, taxableTotal: 0, transportationTotal: 0, grossTotal: 0, socialInsuranceTotal: 0, incomeTaxTotal: 0, residentTaxTotal: 0, deductionTotal: 0, reimbursementsTotal: 0, netTotal: 0, bankTransferTotal: 0 });
}

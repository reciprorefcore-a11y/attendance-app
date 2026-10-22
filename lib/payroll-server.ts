import { createHash } from "node:crypto";
import type { FirestoreRest } from "./firebase-rest.ts";
import { buildAttendanceRows, getApplicableWage, type CalculationClockLog, type CalculationWage } from "./attendance-calculation.ts";
import { applyFixedPayrollAdjustment, applyPayrollBreakPolicy, calculatePayroll, isPayrollMonthClosed, resolvePayrollType, summarizePayroll, validatePayrollBreakPolicy, validatePayrollInput, type FixedPayrollAdjustment, type PayrollAttendanceDay, type PayrollEmployee, type PayrollResult, type ResidentTaxHistoryEntry } from "./payroll.ts";
import { sortPayrollResults } from "./payroll-order.ts";
import { resolveEffectiveHistory } from "./fulltime-master.ts";

const FIXED_PAYROLL_TEMPLATE: Record<string, Partial<PayrollEmployee>> = {
  "0002": { directorCompensation: 150000, healthInsurance: 7440, childSupportContribution: 172, careInsurance: 1215, employeePension: 13725, employmentInsurance: 0, residentTax: 12600, paymentMethod: "cash" as const },
  "0003": { fixedBaseSalary: 185000, positionAllowance: 9000, businessAllowance: 110000, monthlyTransportation: 15670, healthInsurance: 15872, childSupportContribution: 368, careInsurance: 2592, employeePension: 29280, employmentInsurance: 1651, incomeTax: 6650, residentTax: 14100 },
  "0064": { fixedBaseSalary: 183000, positionAllowance: 8000, fixedOvertimeAllowance: 27678, businessAllowance: 56417, monthlyTransportation: 10110, healthInsurance: 13888, childSupportContribution: 322, careInsurance: 0, employeePension: 25620, employmentInsurance: 1580, incomeTax: 6650, residentTax: 12200 },
  "0083": { fixedBaseSalary: 175000, positionAllowance: 34000, businessAllowance: 100000, monthlyTransportation: 5960, healthInsurance: 14880, childSupportContribution: 345, careInsurance: 2430, employeePension: 27450, employmentInsurance: 1574, incomeTax: 6530, residentTax: 12300 },
  "0017": { fixedBaseSalary: 200000, positionAllowance: 6000, healthInsurance: 9920, childSupportContribution: 230, careInsurance: 1620, employeePension: 18300, employmentInsurance: 1030, residentTax: 0 },
};

function asDate(value: unknown) {
  if (value instanceof Date) return value;
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") return value.toDate() as Date;
  return new Date(String(value));
}

export function shouldIncludePayrollClockLog(data: Record<string, unknown>, employeeIds: Set<string>) {
  const employeeId = typeof data.employeeId === "string" ? data.employeeId : "";
  return Boolean(employeeId && employeeIds.has(employeeId) && data.isDeleted !== true && data.isCancelled !== true && data.timestamp);
}

export function resolveResidentTaxForMonth(employee: PayrollEmployee, targetMonth: string): PayrollEmployee {
  const history = Array.isArray(employee.residentTaxHistory) ? employee.residentTaxHistory : [];
  const applicable = history
    .filter((entry): entry is ResidentTaxHistoryEntry => !!entry && /^\d{4}-\d{2}$/.test(entry.effectiveMonth) && entry.effectiveMonth <= targetMonth && Number.isFinite(entry.amount) && entry.amount >= 0 && Number.isInteger(entry.amount))
    .sort((a, b) => b.effectiveMonth.localeCompare(a.effectiveMonth))[0];
  if (applicable) return { ...employee, residentTax: applicable.amount, residentTaxFallbackUsed: false, residentTaxEffectiveMonth: applicable.effectiveMonth };
  return { ...employee, residentTaxFallbackUsed: true, residentTaxEffectiveMonth: null };
}

export function resolveTransportationForMonth(employee: PayrollEmployee, targetMonth: string): PayrollEmployee {
  const history = Array.isArray((employee as PayrollEmployee & { transportationHistory?: unknown[] }).transportationHistory)
    ? (employee as PayrollEmployee & { transportationHistory: { effectiveMonth?: unknown; type?: unknown; amount?: unknown }[] }).transportationHistory
    : [];
  const applicable = history
    .filter((entry) => /^\d{4}-\d{2}$/.test(String(entry?.effectiveMonth ?? "")) && String(entry.effectiveMonth) <= targetMonth)
    .sort((a, b) => String(b.effectiveMonth).localeCompare(String(a.effectiveMonth)))[0];
  if (!applicable) return employee;
  const type = ["daily", "monthly", "none"].includes(String(applicable.type)) ? applicable.type as "daily" | "monthly" | "none" : "none";
  const amount = Math.max(0, Math.trunc(Number(applicable.amount) || 0));
  return { ...employee, transportationType: type, dailyTransportation: type === "daily" ? amount : 0, monthlyTransportation: type === "monthly" ? amount : 0 };
}

export function resolveDailyTransportationForDate(employee: PayrollEmployee | undefined, wages: CalculationWage[], workDate: string, logs: CalculationClockLog[] = []) {
  if (!employee || employee.transportationType !== "daily") return 0;
  const historyAmount = getApplicableWage(wages, workDate)?.dailyTransportation;
  const snapshotAmount = logs.map((log) => Number(log.dailyTransportationAtWork ?? log.dailyTransportationSnapshot) || 0).find((amount) => amount > 0);
  return Math.max(0, Math.trunc(Number(historyAmount ?? snapshotAmount ?? employee.dailyTransportation ?? employee.transportationCost) || 0));
}

export async function loadPayrollSource(db: FirestoreRest, targetMonth: string) {
  const [y, m] = targetMonth.split("-").map(Number);
  const prevMonth = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  const [employeeSnapshot, payrollSettingsSnapshot, storeSnapshot, logSnapshot, confirmedSnapshot, prevConfirmedSnapshot] = await Promise.all([
    db.collection("employees").get(), db.collection("payrollSettings").get(), db.collection("stores").get(), db.collection("clockLogs").get(),
    db.collection("payrollRuns").where("targetMonth", "==", targetMonth).where("status", "==", "confirmed").limit(1).get(),
    db.collection("payrollRuns").where("targetMonth", "==", prevMonth).where("status", "==", "confirmed").limit(1).get(),
  ]);
  const stores = new Map(storeSnapshot.docs.map((item) => [item.id, item.data()]));
  const payrollSettings = new Map(payrollSettingsSnapshot.docs.map((item) => [item.id, item.data()]));
  const breakPolicy = validatePayrollBreakPolicy(payrollSettings.get("attendanceBreakPolicy"));
  const employees: PayrollEmployee[] = employeeSnapshot.docs.map((item) => {
    const data = item.data();
    const settings = payrollSettings.get(item.id) ?? {};
    const employee = { id: item.id, ...data, ...settings, storeName: data.storeName || stores.get(data.storeId)?.storeName || stores.get(data.storeId)?.name || data.storeId } as PayrollEmployee;
    employee.payrollType = resolvePayrollType(employee);
    employee.employeeType = employee.payrollType === "fixed" ? "fullTime" : "partTime";
    const template = FIXED_PAYROLL_TEMPLATE[String(employee.employeeCode).padStart(4, "0")];
    return template ? { ...template, ...employee, payrollType: "fixed" as const } : employee;
  }).filter((item) => item.payrollEnabled !== false && !(item as PayrollEmployee & { isDeleted?: boolean }).isDeleted);
  if (!prevConfirmedSnapshot.empty) {
    const prevRunId = prevConfirmedSnapshot.docs[0].id;
    const prevEmployeesSnapshot = await db.collection("payrollRuns").doc(prevRunId).collection("employees").get();
    const prevResults = new Map(prevEmployeesSnapshot.docs.map((item) => [item.id, item.data() as PayrollResult]));
    for (const emp of employees) {
      if (resolvePayrollType(emp) !== "fixed") continue;
      const prev = prevResults.get(emp.id);
      if (!prev) { emp.previousConfirmedPayrollMissing = !FIXED_PAYROLL_TEMPLATE[String(emp.employeeCode).padStart(4, "0")]; continue; }
      emp.fixedBaseSalary = prev.earnings.baseSalary;
      emp.directorCompensation = prev.earnings.directorCompensation;
      emp.positionAllowance = prev.earnings.positionAllowance;
      emp.skillAllowance = prev.earnings.skillAllowance ?? 0;
      emp.fixedOvertimeAllowance = prev.earnings.fixedOvertimeAllowance;
      emp.fixedOvertimeSupplement = prev.earnings.fixedOvertimeSupplement ?? 0;
      emp.businessAllowance = prev.earnings.businessAllowance;
      emp.otherFixedAllowance = prev.earnings.otherFixedAllowance ?? 0;
      emp.otherFixedAllowanceName = prev.earnings.otherFixedAllowanceName ?? "";
      emp.fixedOvertimeHours = prev.fixedOvertimeHoursSnapshot ?? null;
      emp.monthlyTransportation = prev.earnings.transportation;
      emp.healthInsurance = prev.deductions.healthInsurance;
      emp.childSupportContribution = prev.deductions.childSupportContribution;
      emp.careInsurance = prev.deductions.careInsurance;
      emp.employeePension = prev.deductions.employeePension;
      emp.employmentInsurance = prev.deductions.employmentInsurance;
      emp.incomeTax = prev.deductions.incomeTax;
      emp.residentTax = prev.deductions.residentTax;
      emp.otherDeduction = prev.deductions.otherDeduction;
    }
  } else {
    for (const emp of employees) if (resolvePayrollType(emp) === "fixed") emp.previousConfirmedPayrollMissing = !FIXED_PAYROLL_TEMPLATE[String(emp.employeeCode).padStart(4, "0")];
  }
  // 明示保存された固定給与マスターは、前月引継ぎ値より優先する。
  for (const emp of employees) {
    const savedSettings = payrollSettings.get(emp.id);
    if (savedSettings && resolvePayrollType(emp) === "fixed") {
      Object.assign(emp, savedSettings);
      const salary = resolveEffectiveHistory(savedSettings.fixedSalaryHistory, targetMonth) as Record<string,unknown>|null;
      if (salary) Object.assign(emp, { fixedBaseSalary:salary.baseSalary, directorCompensation:salary.directorCompensation, positionAllowance:salary.positionAllowance, skillAllowance:salary.skillAllowance, fixedOvertimeAllowance:salary.fixedOvertimeAllowance, fixedOvertimeSupplement:salary.fixedOvertimeSupplement, fixedOvertimeHours:salary.fixedOvertimeHours, otherFixedAllowance:salary.otherFixedAllowance, otherFixedAllowanceName:salary.otherFixedAllowanceName, businessAllowance:0 });
    }
  }
  for (let index = 0; index < employees.length; index += 1) employees[index] = resolveResidentTaxForMonth(employees[index], targetMonth);
  for (let index = 0; index < employees.length; index += 1) employees[index] = resolveTransportationForMonth(employees[index], targetMonth);
  const employeeIds = new Set(employees.map((item) => item.id));
  const employeeById = new Map(employees.map((item) => [item.id, item]));
  const wageHistoryEntries = await Promise.all(employees.map(async (employee) => {
    const snapshot = await db.collection("employees").doc(employee.id).collection("wageHistory").get();
    return [employee.id, snapshot.docs.map((item) => item.data() as CalculationWage)] as const;
  }));
  const wagesByEmployee = Object.fromEntries(wageHistoryEntries) as Record<string, CalculationWage[]>;
  const logs: CalculationClockLog[] = logSnapshot.docs.flatMap((item) => {
    const data = item.data();
    if (!shouldIncludePayrollClockLog(data, employeeIds)) return [];
    return [{ id: item.id, ...data, timestamp: asDate(data.timestamp) } as CalculationClockLog];
  });
  const homeStores = Object.fromEntries(employees.filter((employee) => employee.employeeType === "partTime").map((employee) => [employee.id, { storeId: employee.storeId ?? "", storeName: employee.storeName ?? employee.storeId ?? "" }]));
  const baseWages = Object.fromEntries(employees.map((employee) => [employee.id, Number(employee.hourlyWage ?? employee.baseWage) || 0]));
  const rows = buildAttendanceRows(logs, wagesByEmployee, {}, baseWages, homeStores).filter((row) => row.date.startsWith(targetMonth));
  const attendance: PayrollAttendanceDay[] = rows.map((row) => applyPayrollBreakPolicy({
    employeeId: row.employeeKey, date: row.date, workMinutes: row.workMinutes, overtimeMinutes: row.overtimeMinutes,
    nightMinutes: row.nightMinutes, helpMinutes: row.helpMinutes, breakMinutes: row.breakMinutes, recordedBreakMinutes: row.breakMinutes,
    confirmed: row.diagnostics.length === 0,
    warnings: [...new Set(row.diagnostics.map((item) => item.message))], kind: "daily",
    dailyTransportationUnit: resolveDailyTransportationForDate(employeeById.get(row.employeeKey), wagesByEmployee[row.employeeKey] ?? [], row.date, row.logs),
    dailyTransportationAmount: resolveDailyTransportationForDate(employeeById.get(row.employeeKey), wagesByEmployee[row.employeeKey] ?? [], row.date, row.logs),
    clockIn: row.clockIn?.toISOString() ?? null,
    clockOut: row.clockOut?.toISOString() ?? null,
    breakPeriods: row.sessions.flatMap((session) => session.breaks.map((item) => ({ start: item.start?.toISOString() ?? null, end: item.end?.toISOString() ?? null }))),
    storeNames: [...new Set(row.sessions.map((session) => session.storeName))],
  }, breakPolicy));
  const versionPayload = {
    logs: rows.flatMap((row) => row.logs.map((log) => [log.id, log.timestamp.toISOString(), log.type, log.storeId, log.employeeId, log.isDeleted === true, log.isCancelled === true])),
    employees,
    wagesByEmployee,
    breakPolicy,
  };
  const sourceAttendanceVersion = createHash("sha256").update(JSON.stringify(versionPayload)).digest("hex");
  return { employees, attendance, alreadyConfirmed: !confirmedSnapshot.empty, sourceAttendanceVersion, breakPolicy };
}

export async function createPayrollDraft(db: FirestoreRest, input: { targetMonth: string; paymentMonth: string; paymentDate: string; adjustments?: Record<string, FixedPayrollAdjustment> }) {
  const source = await loadPayrollSource(db, input.targetMonth);
  if (source.alreadyConfirmed) throw new Error("already_confirmed");
  const issues = validatePayrollInput(source.employees, source.attendance, input.targetMonth, source.alreadyConfirmed);
  if (!isPayrollMonthClosed(input.targetMonth)) issues.unshift({ severity: "warning", code: "month_not_closed", message: `${input.targetMonth}は月途中のため試算・帳票プレビューのみ可能です。翌月以降に確定してください` });
  const results = sortPayrollResults(calculatePayroll(source.employees, source.attendance).map((result) => applyFixedPayrollAdjustment(result, input.adjustments?.[result.employeeId] ?? {})));
  const allIssues = [...issues, ...results.flatMap((item) => item.issues)];
  const totals = summarizePayroll(results);
  const now = new Date();
  const { adjustments: _adjustments, ...period } = input;
  void _adjustments;
  if (!source.breakPolicy && input.targetMonth >= "2026-11") allIssues.unshift({ severity: "error", code: "break_policy_not_configured", message: "一律休憩設定が未保存です。閾値・控除時間・適用開始日を保存してから再計算してください" });
  const run = { ...period, status: "draft" as const, calculatedAt: now.toISOString(), ...totals, sourceAttendanceVersion: source.sourceAttendanceVersion, breakPolicySnapshot: source.breakPolicy, adjustmentsSnapshot: input.adjustments ?? {}, revision: 2, canConfirm: isPayrollMonthClosed(input.targetMonth) && !allIssues.some((item) => item.severity === "error"), issues: allIssues };
  return { ...run, results };
}

export type PayrollConfirmationInput = {
  targetMonth: string;
  paymentMonth: string;
  paymentDate: string;
  sourceAttendanceVersion: string;
  adjustments?: Record<string, FixedPayrollAdjustment>;
};

export async function confirmPayrollRun(db: FirestoreRest, uid: string, input: PayrollConfirmationInput) {
  if (!isPayrollMonthClosed(input.targetMonth)) throw new Error("month_not_closed");
  const recalculated = await createPayrollDraft(db, input);
  if (recalculated.sourceAttendanceVersion !== input.sourceAttendanceVersion) throw new Error("source_changed");
  if (recalculated.issues.some((item) => item.severity === "error")) throw new Error("blocking_errors");
  const totals = summarizePayroll(recalculated.results);
  if (recalculated.results.some((item) => item.netPay < 0 || item.earnings.grossTotal < 0 || item.deductions.total < 0)) throw new Error("invalid_result");
  if (totals.grossTotal - totals.deductionTotal + totals.reimbursementsTotal !== totals.netTotal || totals.bankTransferTotal + recalculated.results.reduce((sum, item) => sum + item.cashPayment, 0) !== totals.netTotal) throw new Error("report_mismatch");

  const ref = db.collection("payrollRuns").doc();
  const confirmedAt = new Date();
  const { results, canConfirm: _canConfirm, ...draftFields } = recalculated;
  void _canConfirm;
  const run = { ...draftFields, ...totals, status: "confirmed", calculatedAt: asDate(recalculated.calculatedAt), calculatedBy: uid, confirmedAt, confirmedBy: uid };
  await db.runTransaction(async (transaction) => {
    const duplicate = await transaction.get(db.collection("payrollRuns").where("targetMonth", "==", input.targetMonth).where("status", "==", "confirmed").limit(1));
    if (!duplicate.empty) throw new Error("already_confirmed");
    const batch = transaction;
    batch.set(ref, run);
    results.forEach((result) => batch.set(ref.collection("employees").doc(result.employeeId), result));
  });
  return { id: ref.id, ...run, calculatedAt: asDate(run.calculatedAt).toISOString(), confirmedAt: confirmedAt.toISOString(), results };
}

/**
 * 確定済みrunのFirestoreデータを現行PayrollResult型に正規化する。
 * 旧フォーマット（reimbursements / payrollNetPay なし）をデフォルト値で補完する。
 * netPay など保存済みの金額は一切再計算しない。
 */
export function normalizePayrollResult(raw: Record<string, unknown>): PayrollResult {
  const typed = raw as Partial<PayrollResult>;
  const oldEarnings = typed.earnings as PayrollResult["earnings"] | undefined;
  const legacyBusiness = Number(oldEarnings?.businessAllowance) || 0;
  const legacyFixed = Number(oldEarnings?.fixedOvertimeAllowance) || 0;
  const isNewBreakdown=oldEarnings?.skillAllowance!=null||oldEarnings?.fixedOvertimeSupplement!=null;
  const earnings = oldEarnings ? { ...oldEarnings, positionAllowance:isNewBreakdown?(oldEarnings.positionAllowance??0):0, skillAllowance: isNewBreakdown?(oldEarnings.skillAllowance??0):(oldEarnings.positionAllowance??0), fixedOvertimeAllowance: legacyBusiness > 0 ? legacyBusiness : legacyFixed, fixedOvertimeSupplement:isNewBreakdown?(oldEarnings.fixedOvertimeSupplement??0):(legacyBusiness>0?legacyFixed:0), businessAllowance: 0, otherFixedAllowance: oldEarnings.otherFixedAllowance ?? 0, otherFixedAllowanceName: oldEarnings.otherFixedAllowanceName ?? "" } : oldEarnings;
  const reimbursements = typed.reimbursements ?? { expenseReimbursement: 0, total: 0 };
  const netPay = Number(typed.netPay) || 0;
  const payrollNetPay = typed.payrollNetPay ?? netPay;
  const employeeType = typed.employeeType ?? (typed.payrollType === "fixed" ? "fullTime" : "partTime");
  const base = employeeType === "fullTime" ? { storeId: "", storeName: "所属なし" } : {};
  const attendance = typed.attendance ? { ...typed.attendance, recordedBreakMinutes: typed.attendance.recordedBreakMinutes ?? typed.attendance.breakMinutes ?? 0, automaticBreakMinutes: typed.attendance.automaticBreakMinutes ?? 0 } : typed.attendance;
  return { ...typed, ...base, employeeType, attendance, earnings, reimbursements, payrollNetPay, netPay, fixedOvertimeHoursSnapshot: typed.fixedOvertimeHoursSnapshot ?? null } as PayrollResult;
}

export async function loadPayrollRun(db: FirestoreRest, runId: string) {
  const [run, employees] = await Promise.all([db.collection("payrollRuns").doc(runId).get(), db.collection("payrollRuns").doc(runId).collection("employees").get()]);
  if (!run.exists) return null;
  const results = employees.docs.map((item) => normalizePayrollResult(item.data() as Record<string, unknown>));
  return { id: run.id, ...run.data(), results } as { id: string; targetMonth: string; paymentMonth: string; paymentDate: string; status: string; results: PayrollResult[]; [key: string]: unknown };
}

export async function loadLatestPayrollRun(db: FirestoreRest, targetMonth: string) {
  const snapshot = await db.collection("payrollRuns").where("targetMonth", "==", targetMonth).get();
  const latest = snapshot.docs.sort((a, b) => asDate(b.data().calculatedAt).getTime() - asDate(a.data().calculatedAt).getTime())[0];
  return latest ? loadPayrollRun(db, latest.id) : null;
}

export async function loadPayrollWorkspace(db: FirestoreRest, targetMonth: string) {
  const [run, source] = await Promise.all([loadLatestPayrollRun(db, targetMonth), loadPayrollSource(db, targetMonth)]);
  const fixedEmployees = source.employees.filter((employee) => resolvePayrollType(employee) === "fixed").map((employee) => ({
    employeeId: employee.id, employeeCode: employee.employeeCode, employeeName: employee.name, storeName: "所属なし",
    fixedBaseSalary: employee.fixedBaseSalary ?? 0,
    holidayAllowanceBaseSalary: null,
    holidayAllowanceCalculationBasis: (Number(employee.fixedBaseSalary) || 0) > 0 ? Number(employee.fixedBaseSalary) : null,
    directorCompensation: employee.directorCompensation ?? 0,
    positionAllowance: employee.positionAllowance ?? 0, skillAllowance: employee.skillAllowance ?? 0, businessAllowance: employee.businessAllowance ?? 0,
    fixedOvertimeAllowance: employee.fixedOvertimeAllowance ?? 0, fixedOvertimeSupplement: employee.fixedOvertimeSupplement ?? 0,
    fixedOvertimeHours: employee.fixedOvertimeHours ?? null, otherFixedAllowance: employee.otherFixedAllowance ?? 0, otherFixedAllowanceName: employee.otherFixedAllowanceName ?? "",
    healthInsurance: employee.healthInsurance ?? null, childSupportContribution: employee.childSupportContribution ?? null,
    careInsurance: employee.careInsurance ?? null, employeePension: employee.employeePension ?? null,
    employmentInsurance: employee.employmentInsurance ?? null, incomeTax: employee.incomeTax ?? null,
    residentTax: employee.residentTax ?? null, transportationType: employee.transportationType ?? "none",
  }));
  return { run, fixedEmployees, breakPolicy: source.breakPolicy };
}

export async function saveFixedPayrollMaster(db: FirestoreRest, employeeId: string, values: Record<string, unknown>) {
  const employee = await db.collection("employees").doc(employeeId).get();
  if (!employee.exists) throw new Error("employee_not_found");
  const data = employee.data();
  if (resolvePayrollType({ id: employee.id, ...data } as PayrollEmployee) !== "fixed") throw new Error("not_fixed_employee");
  const numericFields = ["fixedBaseSalary", "directorCompensation", "positionAllowance", "skillAllowance", "businessAllowance", "fixedOvertimeAllowance", "fixedOvertimeSupplement", "otherFixedAllowance", "healthInsurance", "childSupportContribution", "careInsurance", "employeePension", "employmentInsurance", "incomeTax", "residentTax"];
  const saved = Object.fromEntries(numericFields.map((field) => [field, Math.max(0, Math.trunc(Number(values[field]) || 0))]));
  const transportationType = ["daily", "monthly", "none"].includes(String(values.transportationType)) ? values.transportationType : "none";
  const batch = db.batch();
  batch.set(db.collection("payrollSettings").doc(employeeId), { ...saved, transportationType, updatedAt: new Date() });
  await batch.commit();
  return { employeeId, ...saved, transportationType };
}

export async function listConfirmedRuns(db: FirestoreRest) {
  const snapshot = await db.collection("payrollRuns").where("status", "==", "confirmed").get();
  return snapshot.docs
    .map((item) => {
      const data = item.data();
      return { id: item.id, targetMonth: data.targetMonth as string, paymentMonth: data.paymentMonth as string, paymentDate: data.paymentDate as string, employeeCount: (data.employeeCount as number) ?? 0 };
    })
    .sort((a, b) => b.targetMonth.localeCompare(a.targetMonth));
}

export async function cancelPayrollRun(db: FirestoreRest, runId: string, cancelledBy: string, reason: string) {
  const ref = db.collection("payrollRuns").doc(runId);
  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) throw new Error("not_found");
    if (snap.data().status !== "confirmed") throw new Error("not_confirmed");
    transaction.update(ref, { status: "cancelled", cancelledAt: new Date(), cancelledBy, cancellationReason: reason });
  });
}

export async function savePayrollBreakPolicy(db: FirestoreRest, uid: string, value: unknown) {
  const policy = validatePayrollBreakPolicy(value);
  if (!policy) throw new Error("invalid_break_policy");
  const ref = db.collection("payrollSettings").doc("attendanceBreakPolicy");
  await db.runTransaction(async (transaction) => {
    transaction.set(ref, { ...policy, updatedAt: new Date(), updatedBy: uid });
  });
  return policy;
}

import { createHash } from "node:crypto";
import type { FirestoreRest } from "./firebase-rest.ts";
import { buildAttendanceRows, type CalculationClockLog } from "./attendance-calculation.ts";
import { calculatePayroll, isPayrollMonthClosed, summarizePayroll, validatePayrollInput, type PayrollAttendanceDay, type PayrollEmployee, type PayrollResult } from "./payroll.ts";

function asDate(value: unknown) {
  if (value instanceof Date) return value;
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") return value.toDate() as Date;
  return new Date(String(value));
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
  const employees: PayrollEmployee[] = employeeSnapshot.docs.map((item) => {
    const data = item.data();
    const settings = payrollSettings.get(item.id) ?? {};
    return { id: item.id, ...data, ...settings, storeName: data.storeName || stores.get(data.storeId)?.storeName || stores.get(data.storeId)?.name || data.storeId } as PayrollEmployee;
  }).filter((item) => item.payrollEnabled !== false && !(item as PayrollEmployee & { isDeleted?: boolean }).isDeleted);
  if (!prevConfirmedSnapshot.empty) {
    const prevRunId = prevConfirmedSnapshot.docs[0].id;
    const prevEmployeesSnapshot = await db.collection("payrollRuns").doc(prevRunId).collection("employees").get();
    const prevResults = new Map(prevEmployeesSnapshot.docs.map((item) => [item.id, item.data() as PayrollResult]));
    for (const emp of employees) {
      if (emp.payrollType !== "fixed") continue;
      const prev = prevResults.get(emp.id);
      if (!prev) continue;
      emp.fixedBaseSalary = prev.earnings.baseSalary;
      emp.directorCompensation = prev.earnings.directorCompensation;
      emp.positionAllowance = prev.earnings.positionAllowance;
      emp.fixedOvertimeAllowance = prev.earnings.fixedOvertimeAllowance;
      emp.holidayAllowance = prev.earnings.holidayAllowance;
      emp.businessAllowance = prev.earnings.businessAllowance;
      emp.monthlyTransportation = prev.earnings.transportation;
      emp.healthInsurance = prev.deductions.healthInsurance;
      emp.childSupportContribution = prev.deductions.childSupportContribution;
      emp.careInsurance = prev.deductions.careInsurance;
      emp.employeePension = prev.deductions.employeePension;
      emp.employmentInsurance = prev.deductions.employmentInsurance;
      emp.residentTax = prev.deductions.residentTax;
      emp.otherDeduction = prev.deductions.otherDeduction;
      emp.advanceExpense = prev.deductions.advanceExpense;
    }
  }
  const employeeIds = new Set(employees.map((item) => item.id));
  const employeeById = new Map(employees.map((item) => [item.id, item]));
  const logs: CalculationClockLog[] = logSnapshot.docs.flatMap((item) => {
    const data = item.data();
    const employeeId = data.employeeId as string | undefined;
    if (!employeeId || !employeeIds.has(employeeId) || data.isDeleted === true || !data.timestamp) return [];
    return [{ id: item.id, ...data, timestamp: asDate(data.timestamp) } as CalculationClockLog];
  });
  const homeStores = Object.fromEntries(employees.map((employee) => [employee.id, { storeId: employee.storeId, storeName: employee.storeName ?? employee.storeId }]));
  const baseWages = Object.fromEntries(employees.map((employee) => [employee.id, Number(employee.hourlyWage ?? employee.baseWage) || 0]));
  const rows = buildAttendanceRows(logs, {}, {}, baseWages, homeStores).filter((row) => row.date.startsWith(targetMonth));
  const attendance: PayrollAttendanceDay[] = rows.map((row) => ({
    employeeId: row.employeeKey, date: row.date, workMinutes: row.workMinutes, overtimeMinutes: row.overtimeMinutes,
    nightMinutes: row.nightMinutes, helpMinutes: row.helpMinutes, breakMinutes: row.breakMinutes,
    confirmed: !row.isMissingClockOut && row.diagnostics.length === 0,
    warnings: [...row.diagnostics.map((item) => item.message), ...(row.isMissingClockOut ? ["退勤が打刻されていません"] : [])], kind: "daily",
    dailyTransportationUnit: Math.max(0, ...row.logs.map((log) => Number(log.dailyTransportationAtWork ?? log.dailyTransportationSnapshot) || 0), Number(employeeById.get(row.employeeKey)?.dailyTransportation ?? (employeeById.get(row.employeeKey)?.transportationType === "daily" ? employeeById.get(row.employeeKey)?.transportationCost : 0)) || 0),
    dailyTransportationAmount: Math.max(0, ...row.logs.map((log) => Number(log.dailyTransportationAtWork ?? log.dailyTransportationSnapshot) || 0), Number(employeeById.get(row.employeeKey)?.dailyTransportation ?? (employeeById.get(row.employeeKey)?.transportationType === "daily" ? employeeById.get(row.employeeKey)?.transportationCost : 0)) || 0),
    clockIn: row.clockIn?.toISOString() ?? null,
    clockOut: row.clockOut?.toISOString() ?? null,
    breakPeriods: row.sessions.flatMap((session) => session.breaks.map((item) => ({ start: item.start?.toISOString() ?? null, end: item.end?.toISOString() ?? null }))),
    storeNames: [...new Set(row.sessions.map((session) => session.storeName))],
  }));
  const sourceAttendanceVersion = createHash("sha256").update(JSON.stringify(rows.flatMap((row) => row.logs.map((log) => [log.id, log.timestamp.toISOString(), log.type])))).digest("hex");
  return { employees, attendance, alreadyConfirmed: !confirmedSnapshot.empty, sourceAttendanceVersion };
}

export async function createPayrollDraft(db: FirestoreRest, uid: string, input: { targetMonth: string; paymentMonth: string; paymentDate: string }) {
  const source = await loadPayrollSource(db, input.targetMonth);
  if (source.alreadyConfirmed) throw new Error("already_confirmed");
  const issues = validatePayrollInput(source.employees, source.attendance, input.targetMonth, source.alreadyConfirmed);
  if (!isPayrollMonthClosed(input.targetMonth)) issues.unshift({ severity: "warning", code: "month_not_closed", message: `${input.targetMonth}は月途中のため試算・帳票プレビューのみ可能です。翌月以降に確定してください` });
  const results = calculatePayroll(source.employees, source.attendance);
  const allIssues = [...issues, ...results.flatMap((item) => item.issues)];
  const totals = summarizePayroll(results);
  const ref = db.collection("payrollRuns").doc();
  const now = new Date();
  const run = { ...input, status: "draft", calculatedAt: now, calculatedBy: uid, confirmedAt: null, confirmedBy: null, ...totals, sourceAttendanceVersion: source.sourceAttendanceVersion, revision: 1, canConfirm: isPayrollMonthClosed(input.targetMonth) && !allIssues.some((item) => item.severity === "error"), issues: allIssues };
  const batch = db.batch();
  batch.set(ref, run);
  results.forEach((result) => batch.set(ref.collection("employees").doc(result.employeeId), result));
  await batch.commit();
  return { id: ref.id, ...run, calculatedAt: now.toISOString(), results };
}

export async function loadPayrollRun(db: FirestoreRest, runId: string) {
  const [run, employees] = await Promise.all([db.collection("payrollRuns").doc(runId).get(), db.collection("payrollRuns").doc(runId).collection("employees").get()]);
  if (!run.exists) return null;
  return { id: run.id, ...run.data(), results: employees.docs.map((item) => item.data() as PayrollResult) } as { id: string; targetMonth: string; paymentMonth: string; paymentDate: string; status: string; results: PayrollResult[]; [key: string]: unknown };
}

export async function loadLatestPayrollRun(db: FirestoreRest, targetMonth: string) {
  const snapshot = await db.collection("payrollRuns").where("targetMonth", "==", targetMonth).get();
  const latest = snapshot.docs.sort((a, b) => asDate(b.data().calculatedAt).getTime() - asDate(a.data().calculatedAt).getTime())[0];
  return latest ? loadPayrollRun(db, latest.id) : null;
}

export async function loadPayrollWorkspace(db: FirestoreRest, targetMonth: string) {
  const run = await loadLatestPayrollRun(db, targetMonth);
  return { run };
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

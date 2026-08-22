import { createHash } from "node:crypto";
import type { firestore } from "firebase-admin";
import { buildAttendanceRows, type CalculationClockLog } from "./attendance-calculation.ts";
import { calculatePayroll, isPayrollMonthClosed, summarizePayroll, validatePayrollInput, type PayrollAttendanceDay, type PayrollEmployee, type PayrollResult } from "./payroll.ts";

function asDate(value: unknown) {
  if (value instanceof Date) return value;
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") return value.toDate() as Date;
  return new Date(String(value));
}

export async function loadPayrollSource(db: firestore.Firestore, targetMonth: string) {
  const [employeeSnapshot, payrollSettingsSnapshot, storeSnapshot, logSnapshot, confirmedSnapshot] = await Promise.all([
    db.collection("employees").get(), db.collection("payrollSettings").get(), db.collection("stores").get(), db.collection("clockLogs").get(),
    db.collection("payrollRuns").where("targetMonth", "==", targetMonth).where("status", "==", "confirmed").limit(1).get(),
  ]);
  const stores = new Map(storeSnapshot.docs.map((item) => [item.id, item.data()]));
  const payrollSettings = new Map(payrollSettingsSnapshot.docs.map((item) => [item.id, item.data()]));
  const employees: PayrollEmployee[] = employeeSnapshot.docs.map((item) => {
    const data = item.data();
    const settings = payrollSettings.get(item.id) ?? {};
    const applicable = Array.isArray(settings.history)
      ? settings.history.filter((entry: { effectiveFrom?: string }) => (entry.effectiveFrom ?? "") <= targetMonth).sort((a: { effectiveFrom?: string }, b: { effectiveFrom?: string }) => (b.effectiveFrom ?? "").localeCompare(a.effectiveFrom ?? ""))[0]?.settings ?? settings
      : settings;
    return { id: item.id, ...data, ...applicable, storeName: data.storeName || stores.get(data.storeId)?.storeName || stores.get(data.storeId)?.name || data.storeId } as PayrollEmployee;
  }).filter((item) => item.payrollEnabled !== false && !(item as PayrollEmployee & { isDeleted?: boolean }).isDeleted);
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

export async function createPayrollDraft(db: firestore.Firestore, uid: string, input: { targetMonth: string; paymentMonth: string; paymentDate: string }) {
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

export async function loadPayrollRun(db: firestore.Firestore, runId: string) {
  const [run, employees] = await Promise.all([db.collection("payrollRuns").doc(runId).get(), db.collection("payrollRuns").doc(runId).collection("employees").get()]);
  if (!run.exists) return null;
  return { id: run.id, ...run.data(), results: employees.docs.map((item) => item.data() as PayrollResult) } as { id: string; targetMonth: string; paymentMonth: string; paymentDate: string; status: string; results: PayrollResult[]; [key: string]: unknown };
}

export async function loadLatestPayrollRun(db: firestore.Firestore, targetMonth: string) {
  const snapshot = await db.collection("payrollRuns").where("targetMonth", "==", targetMonth).get();
  const latest = snapshot.docs.sort((a, b) => asDate(b.data().calculatedAt).getTime() - asDate(a.data().calculatedAt).getTime())[0];
  return latest ? loadPayrollRun(db, latest.id) : null;
}

export async function loadPayrollWorkspace(db: firestore.Firestore, targetMonth: string) {
  // Payroll settings belong exclusively to the payroll workspace. Keep this
  // server-side read out of the shared admin stores/employees/attendance load.
  const payrollSettingsSnapshot = await db.collection("payrollSettings").get();
  const run = await loadLatestPayrollRun(db, targetMonth);
  return {
    run,
    payrollSettings: payrollSettingsSnapshot.docs.map((item) => ({ id: item.id, ...item.data() })),
  };
}

import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { cert, initializeApp } from "firebase-admin/app";
import { FieldValue, Timestamp, getFirestore } from "firebase-admin/firestore";
import { FirestoreRest } from "../lib/firebase-rest.ts";
import { applyFixedPayrollAdjustment, calculatePayroll, summarizePayroll } from "../lib/payroll.ts";
import { loadPayrollSource } from "../lib/payroll-server.ts";
import { selectFullTimePayslipResults, selectStorePayslipResults } from "../lib/payroll-export.ts";

const backupDir = "/private/tmp/attendance-app-fulltime-recovery-2026-08-24";
const runDir = `${backupDir}/executed-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const serviceAccountPath = process.argv[2];
if (!serviceAccountPath) throw new Error("service account path is required");

const originalBackup = JSON.parse(readFileSync(`${backupDir}/employees-before.json`, "utf8"));
const recoveryPlan = JSON.parse(readFileSync(`${backupDir}/recovery-plan.json`, "utf8"));
if (originalBackup.documents?.length !== 3 || recoveryPlan.firestoreWritesPerformed !== false) throw new Error("backup validation failed");

const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, "utf8"));
if (serviceAccount.project_id !== "fublev-attendance") throw new Error("unexpected Firebase project");
const app = initializeApp({ credential: cert(serviceAccount) }, `fulltime-recovery-${Date.now()}`);
const db = getFirestore(app);

const existing = [
  { id: "hvjU14BKDB0pCdDrUZF1", code: "0003", name: "中村" },
  { id: "c6ADSFHwyHecwScuZ6g8", code: "0064", name: "小林" },
  { id: "zbpOikyklko5CL6G6Yon", code: "0083", name: "佐藤" },
] as const;
const created = [
  { id: "8gPG2ASRkf52GLednUL3", code: "0002", name: "青山佳史" },
  { id: "GHs3TOpfNsTb2cVHFpoQ", code: "0017", name: "木月徳子" },
] as const;
const targetIds = new Set<string>([...existing, ...created].map((item) => item.id));

function normalize(value: unknown): unknown {
  if (value instanceof Timestamp) return { __timestamp: value.toDate().toISOString() };
  if (value instanceof Date) return { __date: value.toISOString() };
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)]));
  return value;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(normalize(value)) ?? "__undefined").digest("hex");
const snapshotState = (snapshot: FirebaseFirestore.QuerySnapshot) => snapshot.docs.map((doc) => ({ id: doc.id, data: normalize(doc.data()) })).sort((a, b) => a.id.localeCompare(b.id));

const [employeesBeforeSnap, clocksBeforeSnap, payrollBeforeSnaps] = await Promise.all([
  db.collection("employees").get(),
  db.collection("clockLogs").get(),
  Promise.all(existing.map((item) => db.collection("payrollSettings").doc(item.id).get())),
]);
const employeesBefore = snapshotState(employeesBeforeSnap);
const nonTargetEmployeesBefore = employeesBefore.filter((item) => !targetIds.has(item.id));
const clocksBefore = snapshotState(clocksBeforeSnap);
const payrollBefore = payrollBeforeSnaps.map((snap) => ({ id: snap.id, exists: snap.exists, data: snap.exists ? normalize(snap.data()) : null, hash: hash(snap.exists ? snap.data() : null) }));
mkdirSync(runDir, { recursive: true });
writeFileSync(`${runDir}/pre-write-snapshot.json`, JSON.stringify({
  capturedAt: new Date().toISOString(),
  employees: employeesBefore.filter((item) => targetIds.has(item.id)),
  payrollSettings: payrollBefore,
  safeguards: { nonTargetEmployeesCount: nonTargetEmployeesBefore.length, nonTargetEmployeesHash: hash(nonTargetEmployeesBefore), clockLogsCount: clocksBefore.length, clockLogsHash: hash(clocksBefore) },
}, null, 2));

const employeeCommon = {
  isDeleted: false,
  employeeType: "fullTime",
  employmentType: "full_time",
  payrollType: "fixed",
  payrollEnabled: true,
  clockEnabled: false,
  status: "active",
};
const employeeCreates: Record<string, Record<string, unknown>> = {
  "8gPG2ASRkf52GLednUL3": { employeeCode: "0002", name: "青山佳史", nameKana: "あおやま よしふみ", ...employeeCommon },
  "GHs3TOpfNsTb2cVHFpoQ": { employeeCode: "0017", name: "木月徳子", nameKana: "きづき のりこ", ...employeeCommon },
};
const historyTimestamp = Timestamp.now();
const auditActor = serviceAccount.client_email;
const settingsCreates: Record<string, Record<string, unknown>> = {
  "8gPG2ASRkf52GLednUL3": {
    fixedBaseSalary: 0, directorCompensation: 150000, positionAllowance: 0, businessAllowance: 0,
    fixedOvertimeAllowance: 0, healthInsurance: 7440, childSupportContribution: 172, careInsurance: 1215,
    employeePension: 13725, employmentInsurance: 0, residentTax: 12600, paymentMethod: "cash",
    residentTaxHistory: [{ amount: 12600, effectiveMonth: "2026-08", updatedAt: historyTimestamp, updatedBy: auditActor }],
  },
  "GHs3TOpfNsTb2cVHFpoQ": {
    fixedBaseSalary: 200000, directorCompensation: 0, positionAllowance: 6000, businessAllowance: 0,
    fixedOvertimeAllowance: 0, healthInsurance: 9920, childSupportContribution: 230, careInsurance: 1620,
    employeePension: 18300, employmentInsurance: 1030, residentTax: 0, paymentMethod: "bank",
    residentTaxHistory: [{ amount: 0, effectiveMonth: "2026-08", updatedAt: historyTimestamp, updatedBy: auditActor }],
  },
};

await db.runTransaction(async (transaction) => {
  const existingRefs = existing.map((item) => db.collection("employees").doc(item.id));
  const newEmployeeRefs = created.map((item) => db.collection("employees").doc(item.id));
  const newSettingsRefs = created.map((item) => db.collection("payrollSettings").doc(item.id));
  const snapshots = await transaction.getAll(...existingRefs, ...newEmployeeRefs, ...newSettingsRefs);
  for (let index = 0; index < existing.length; index += 1) {
    const snap = snapshots[index];
    const expected = existing[index];
    if (!snap.exists || String(snap.data()?.employeeCode).padStart(4, "0") !== expected.code || !String(snap.data()?.name ?? "").includes(expected.name)) {
      throw new Error(`existing employee identity mismatch: ${expected.id}`);
    }
  }
  for (const snap of snapshots.slice(existing.length)) if (snap.exists) throw new Error(`create-only path already exists: ${snap.ref.path}`);
  for (const ref of existingRefs) transaction.update(ref, { ...employeeCommon, updatedAt: FieldValue.serverTimestamp() });
  for (const item of created) {
    transaction.create(db.collection("employees").doc(item.id), { ...employeeCreates[item.id], createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    transaction.create(db.collection("payrollSettings").doc(item.id), { ...settingsCreates[item.id], createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  }
});

const [employeesAfterSnap, clocksAfterSnap, payrollAfterSnaps, newSettingsSnaps] = await Promise.all([
  db.collection("employees").get(),
  db.collection("clockLogs").get(),
  Promise.all(existing.map((item) => db.collection("payrollSettings").doc(item.id).get())),
  Promise.all(created.map((item) => db.collection("payrollSettings").doc(item.id).get())),
]);
const employeesAfter = snapshotState(employeesAfterSnap);
const nonTargetEmployeesAfter = employeesAfter.filter((item) => !targetIds.has(item.id));
const clocksAfter = snapshotState(clocksAfterSnap);
const payrollAfter = payrollAfterSnaps.map((snap) => ({ id: snap.id, exists: snap.exists, data: snap.exists ? normalize(snap.data()) : null, hash: hash(snap.exists ? snap.data() : null) }));
const targetAfter = employeesAfter.filter((item) => targetIds.has(item.id));
const forbiddenValues = new Set([800000, 7599, 8948]);
const containsForbidden = (value: unknown): boolean => forbiddenValues.has(value as number) || (Array.isArray(value) ? value.some(containsForbidden) : !!value && typeof value === "object" && Object.values(value as Record<string, unknown>).some(containsForbidden));
const managerFields = ["hasManagerAccount", "managerUid", "accountRole", "accountStoreIds"];
const beforeManagerData = employeesBeforeSnap.docs.find((doc) => doc.id === existing[0].id)?.data() ?? {};
const afterManagerData = employeesAfterSnap.docs.find((doc) => doc.id === existing[0].id)?.data() ?? {};
const managerComparison = Object.fromEntries(managerFields.map((key) => [key, { before: normalize(beforeManagerData[key]), after: normalize(afterManagerData[key]), equal: hash(beforeManagerData[key]) === hash(afterManagerData[key]) }]));

const accessToken = await app.options.credential!.getAccessToken();
const restDb = new FirestoreRest(accessToken.access_token);
const source = await loadPayrollSource(restDb, "2026-08");
const calculated = calculatePayroll(source.employees, source.attendance).map((result) => result.employeeId === "c6ADSFHwyHecwScuZ6g8"
  ? applyFixedPayrollAdjustment(result, { temporaryAttendanceCount: 2, holidayAllowanceOverride: 30891, overrideReason: "公休6日のところ実休4日のため、休日出勤2回" })
  : result);
const targetResults = calculated.filter((result) => targetIds.has(result.employeeId));
const fulltimeZip = selectFullTimePayslipResults(calculated).filter((result) => targetIds.has(result.employeeId));
const storeZipLeak = [...new Set(calculated.filter((result) => result.storeId).flatMap((result) => selectStorePayslipResults(calculated, result.storeId)).filter((result) => targetIds.has(result.employeeId)).map((result) => result.employeeId))];

const report = {
  completedAt: new Date().toISOString(),
  projectId: serviceAccount.project_id,
  writes: [
    ...existing.map((item) => ({ path: `employees/${item.id}`, operation: "update", fields: [...Object.keys(employeeCommon), "updatedAt"] })),
    ...created.flatMap((item) => [{ path: `employees/${item.id}`, operation: "create" }, { path: `payrollSettings/${item.id}`, operation: "create" }]),
  ],
  employees: targetAfter,
  safeguards: {
    allFiveValid: targetAfter.length === 5 && targetAfter.every((item) => {
      const data = item.data as Record<string, unknown>;
      return data.isDeleted === false && data.employeeType === "fullTime" && data.payrollType === "fixed" && data.payrollEnabled === true && data.clockEnabled === false;
    }),
    adminPartTimeSelection: targetAfter.filter((item) => {
      const data = item.data as Record<string, unknown>;
      return data.isDeleted !== true && data.employeeType !== "fullTime" && data.employmentType !== "full_time" && data.payrollType !== "fixed";
    }).map((item) => item.id),
    hqFullTimeSelection: targetAfter.filter((item) => {
      const data = item.data as Record<string, unknown>;
      return data.isDeleted !== true && (data.employeeType === "fullTime" || data.employmentType === "full_time" || data.payrollType === "fixed");
    }).map((item) => item.id),
    managerComparison,
    existingPayrollSettingsUnchanged: payrollBefore.every((before, index) => before.hash === payrollAfter[index].hash),
    existingPayrollSettings: payrollAfter,
    newPayrollSettings: newSettingsSnaps.map((snap) => ({ id: snap.id, exists: snap.exists, data: normalize(snap.data()) })),
    forbiddenValuesInCreatedData: containsForbidden([...created.map((item) => employeeCreates[item.id]), ...created.map((item) => settingsCreates[item.id])]),
    nonTargetEmployees: { beforeCount: nonTargetEmployeesBefore.length, afterCount: nonTargetEmployeesAfter.length, beforeHash: hash(nonTargetEmployeesBefore), afterHash: hash(nonTargetEmployeesAfter), unchanged: hash(nonTargetEmployeesBefore) === hash(nonTargetEmployeesAfter) },
    clockLogs: { beforeCount: clocksBefore.length, afterCount: clocksAfter.length, beforeHash: hash(clocksBefore), afterHash: hash(clocksAfter), unchanged: hash(clocksBefore) === hash(clocksAfter) },
  },
  payrollTrial: {
    targetMonth: "2026-08", persistenceWrites: 0, targetResults,
    targetSummary: summarizePayroll(targetResults),
    fulltimeZipTargetIds: fulltimeZip.map((result) => result.employeeId),
    storeZipTargetLeakIds: storeZipLeak,
  },
};
writeFileSync(`${runDir}/post-write-verification.json`, JSON.stringify(normalize(report), null, 2));
console.log(JSON.stringify({
  runDir,
  writes: report.writes,
  allFiveValid: report.safeguards.allFiveValid,
  adminPartTimeSelection: report.safeguards.adminPartTimeSelection,
  hqFullTimeSelection: report.safeguards.hqFullTimeSelection,
  managerFieldsEqual: Object.values(managerComparison).every((item) => item.equal),
  existingPayrollSettingsUnchanged: report.safeguards.existingPayrollSettingsUnchanged,
  forbiddenValuesInCreatedData: report.safeguards.forbiddenValuesInCreatedData,
  nonTargetEmployeesUnchanged: report.safeguards.nonTargetEmployees.unchanged,
  clockLogsUnchanged: report.safeguards.clockLogs.unchanged,
  payrollTrial: targetResults.map((result) => ({ employeeId: result.employeeId, employeeCode: result.employeeCode, name: result.employeeName, employeeType: result.employeeType, gross: result.earnings.grossTotal, deductions: result.deductions.total, netPay: result.netPay, bank: result.bankTransfer, cash: result.cashPayment })),
  fulltimeZipTargetIds: report.payrollTrial.fulltimeZipTargetIds,
  storeZipTargetLeakIds: report.payrollTrial.storeZipTargetLeakIds,
}, null, 2));

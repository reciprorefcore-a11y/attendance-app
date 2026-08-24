import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { cert, initializeApp } from "firebase-admin/app";
import { Timestamp, getFirestore } from "firebase-admin/firestore";
import { FirestoreRest } from "../lib/firebase-rest.ts";
import { applyFixedPayrollAdjustment, calculatePayroll, summarizePayroll } from "../lib/payroll.ts";
import { loadPayrollSource } from "../lib/payroll-server.ts";
import { selectFullTimePayslipResults, selectStorePayslipResults } from "../lib/payroll-export.ts";

const serviceAccountPath = process.argv[2];
const runDir = process.argv[3];
if (!serviceAccountPath || !runDir) throw new Error("service account path and run directory are required");
const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, "utf8"));
if (serviceAccount.project_id !== "fublev-attendance") throw new Error("unexpected Firebase project");
const pre = JSON.parse(readFileSync(`${runDir}/pre-write-snapshot.json`, "utf8"));
const app = initializeApp({ credential: cert(serviceAccount) }, `fulltime-verify-${Date.now()}`);
const db = getFirestore(app);
const ids = ["8gPG2ASRkf52GLednUL3", "hvjU14BKDB0pCdDrUZF1", "GHs3TOpfNsTb2cVHFpoQ", "c6ADSFHwyHecwScuZ6g8", "zbpOikyklko5CL6G6Yon"];
const existingIds = ["hvjU14BKDB0pCdDrUZF1", "c6ADSFHwyHecwScuZ6g8", "zbpOikyklko5CL6G6Yon"];
const newIds = ["8gPG2ASRkf52GLednUL3", "GHs3TOpfNsTb2cVHFpoQ"];
const idSet = new Set(ids);

function normalize(value: unknown): unknown {
  if (value instanceof Timestamp) return { __timestamp: value.toDate().toISOString() };
  if (value instanceof Date) return { __date: value.toISOString() };
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)]));
  return value;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(normalize(value)) ?? "__undefined").digest("hex");
const state = (snapshot: FirebaseFirestore.QuerySnapshot) => snapshot.docs.map((doc) => ({ id: doc.id, data: normalize(doc.data()) })).sort((a, b) => a.id.localeCompare(b.id));

const [employeeSnap, clockSnap, existingSettings, newSettings] = await Promise.all([
  db.collection("employees").get(), db.collection("clockLogs").get(),
  Promise.all(existingIds.map((id) => db.collection("payrollSettings").doc(id).get())),
  Promise.all(newIds.map((id) => db.collection("payrollSettings").doc(id).get())),
]);
const employees = state(employeeSnap);
const targets = employees.filter((item) => idSet.has(item.id));
const nonTargets = employees.filter((item) => !idSet.has(item.id));
const clocks = state(clockSnap);
const beforeNakamura = pre.employees.find((item: { id: string }) => item.id === "hvjU14BKDB0pCdDrUZF1")?.data ?? {};
const afterNakamura = targets.find((item) => item.id === "hvjU14BKDB0pCdDrUZF1")?.data as Record<string, unknown> ?? {};
const managerFields = ["hasManagerAccount", "managerUid", "accountRole", "accountStoreIds"];
const managerComparison = Object.fromEntries(managerFields.map((key) => [key, { before: beforeNakamura[key], after: afterNakamura[key], equal: hash(beforeNakamura[key]) === hash(afterNakamura[key]) }]));
const payrollComparisons = existingSettings.map((snap) => {
  const before = pre.payrollSettings.find((item: { id: string }) => item.id === snap.id);
  return { id: snap.id, exists: snap.exists, beforeHash: before?.hash, afterHash: hash(snap.exists ? snap.data() : null), unchanged: before?.hash === hash(snap.exists ? snap.data() : null), fields: snap.exists ? normalize(snap.data()) : null };
});
const forbidden = new Set([800000, 7599, 8948]);
const hasForbidden = (value: unknown): boolean => forbidden.has(value as number) || (Array.isArray(value) ? value.some(hasForbidden) : !!value && typeof value === "object" && Object.values(value as Record<string, unknown>).some(hasForbidden));

const token = await app.options.credential!.getAccessToken();
const source = await loadPayrollSource(new FirestoreRest(token.access_token), "2026-08");
const results = calculatePayroll(source.employees, source.attendance).map((result) => result.employeeId === "c6ADSFHwyHecwScuZ6g8"
  ? applyFixedPayrollAdjustment(result, { temporaryAttendanceCount: 2, holidayAllowanceOverride: 30891, overrideReason: "公休6日のところ実休4日のため、休日出勤2回" })
  : result);
const targetResults = results.filter((result) => idSet.has(result.employeeId));
const storeIds = [...new Set(results.map((result) => result.storeId).filter(Boolean))];
const storeLeak = storeIds.flatMap((storeId) => selectStorePayslipResults(results, storeId)).filter((result) => idSet.has(result.employeeId));
const fulltime = selectFullTimePayslipResults(results).filter((result) => idSet.has(result.employeeId));

const report = {
  verifiedAt: new Date().toISOString(),
  employees: targets,
  allFiveValid: targets.length === 5 && targets.every((item) => {
    const data = item.data as Record<string, unknown>;
    return data.isDeleted === false && data.employeeType === "fullTime" && data.payrollType === "fixed" && data.payrollEnabled === true && data.clockEnabled === false;
  }),
  adminPartTimeIds: targets.filter((item) => { const d = item.data as Record<string, unknown>; return d.isDeleted !== true && d.employeeType !== "fullTime" && d.employmentType !== "full_time" && d.payrollType !== "fixed"; }).map((item) => item.id),
  hqFullTimeIds: targets.filter((item) => { const d = item.data as Record<string, unknown>; return d.isDeleted !== true && (d.employeeType === "fullTime" || d.employmentType === "full_time" || d.payrollType === "fixed"); }).map((item) => item.id),
  managerComparison,
  existingPayrollSettings: payrollComparisons,
  existingPayrollSettingsUnchanged: payrollComparisons.every((item) => item.unchanged),
  newPayrollSettings: newSettings.map((snap) => ({ id: snap.id, exists: snap.exists, fields: snap.exists ? normalize(snap.data()) : null })),
  forbiddenValuesInNewDocuments: hasForbidden([...targets.filter((item) => newIds.includes(item.id)), ...newSettings.map((snap) => snap.data())]),
  nonTargetEmployees: { beforeCount: pre.safeguards.nonTargetEmployeesCount, afterCount: nonTargets.length, beforeHash: pre.safeguards.nonTargetEmployeesHash, afterHash: hash(nonTargets), unchanged: pre.safeguards.nonTargetEmployeesHash === hash(nonTargets) },
  clockLogs: { beforeCount: pre.safeguards.clockLogsCount, afterCount: clocks.length, beforeHash: pre.safeguards.clockLogsHash, afterHash: hash(clocks), unchanged: pre.safeguards.clockLogsHash === hash(clocks) },
  payrollTrial: { persistenceWrites: 0, results: targetResults, summary: summarizePayroll(targetResults), fulltimeZipIds: fulltime.map((item) => item.employeeId), storeZipLeakIds: storeLeak.map((item) => item.employeeId) },
};
writeFileSync(`${runDir}/post-write-verification.json`, JSON.stringify(normalize(report), null, 2));
console.log(JSON.stringify({
  runDir, allFiveValid: report.allFiveValid, adminPartTimeIds: report.adminPartTimeIds, hqFullTimeIds: report.hqFullTimeIds,
  managerFieldsEqual: Object.values(managerComparison).every((item) => item.equal), existingPayrollSettingsUnchanged: report.existingPayrollSettingsUnchanged,
  existingPayrollSettings: payrollComparisons.map((item) => ({ id: item.id, exists: item.exists, unchanged: item.unchanged })),
  newPayrollSettings: report.newPayrollSettings.map((item) => ({ id: item.id, exists: item.exists })), forbiddenValuesInNewDocuments: report.forbiddenValuesInNewDocuments,
  nonTargetEmployees: report.nonTargetEmployees, clockLogs: report.clockLogs,
  payrollTrial: targetResults.map((result) => ({ employeeId: result.employeeId, employeeCode: result.employeeCode, name: result.employeeName, employeeType: result.employeeType, gross: result.earnings.grossTotal, deductions: result.deductions.total, holidayAllowance: result.earnings.holidayAllowance, residentTax: result.deductions.residentTax, incomeTax: result.deductions.incomeTax, netPay: result.netPay, bank: result.bankTransfer, cash: result.cashPayment })),
  fulltimeZipIds: report.payrollTrial.fulltimeZipIds, storeZipLeakIds: report.payrollTrial.storeZipLeakIds,
}, null, 2));

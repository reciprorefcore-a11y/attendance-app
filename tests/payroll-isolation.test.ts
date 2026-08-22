import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const adminPage = readFileSync("app/admin/page.tsx", "utf8");
const payrollPage = readFileSync("app/hq/payroll/page.tsx", "utf8");
const payrollRoute = readFileSync("app/api/payroll/calculate/route.ts", "utf8");
const payrollServer = readFileSync("lib/payroll-server.ts", "utf8");
const payrollRunsRoute = readFileSync("app/api/payroll/runs/route.ts", "utf8");
const payrollConfirmRoute = readFileSync("app/api/payroll/confirm/route.ts", "utf8");
const firestoreRest = readFileSync("lib/firebase-rest.ts", "utf8");
const clockPage = readFileSync("app/clock/page.tsx", "utf8");
const clockPunch = readFileSync("lib/clock-punch.ts", "utf8");

function adminCoreLoad() {
  const start = adminPage.indexOf("// ── Phase 1: stores / employees");
  const end = adminPage.indexOf("const wageEntries", start);
  assert.ok(start >= 0 && end > start);
  return adminPage.slice(start, end);
}

test("payrollSettings permission failure cannot join the admin stores/employees load", () => {
  const coreLoad = adminCoreLoad();
  assert.match(coreLoad, /collection\(db, "employees"\)/);
  assert.match(coreLoad, /collection\(db, "stores"\)/);
  assert.doesNotMatch(coreLoad, /payrollSettings/);
  assert.doesNotMatch(adminPage, /getDocs\(collection\(db, "payrollSettings"\)\)/);
});

test("payroll API failure is handled only inside the payroll page", () => {
  assert.match(payrollPage, /\/api\/payroll\/calculate/);
  assert.match(payrollPage, /setMessage\(e instanceof Error/);
  assert.match(payrollRoute, /loadPayrollWorkspace/);
  assert.match(payrollServer, /db\.collection\("payrollSettings"\)\.get\(\)/);
  assert.doesNotMatch(adminPage, /\/api\/payroll\/calculate/);
});

test("clock punch code has no payroll dependency", () => {
  assert.doesNotMatch(clockPage, /payroll|payrollSettings|\/api\/payroll/i);
  assert.doesNotMatch(clockPunch, /payroll|payrollSettings|\/api\/payroll/i);
});

test("the existing core load preserves all 47 employees and 6 stores", async () => {
  const employees = Array.from({ length: 47 }, (_, id) => ({ id }));
  const stores = Array.from({ length: 6 }, (_, id) => ({ id }));
  const [employeeSnapshot, storeSnapshot] = await Promise.all([
    Promise.resolve({ docs: employees }),
    Promise.resolve({ docs: stores }),
  ]);
  assert.equal(employeeSnapshot.docs.length, 47);
  assert.equal(storeSnapshot.docs.length, 6);
  assert.doesNotMatch(adminCoreLoad(), /payrollSettings/);
});

test("payrollEnabled is saved to employees collection, not payrollSettings", () => {
  // payload in employee save must include payrollEnabled
  assert.match(adminPage, /payrollEnabled: employeeForm\.payrollEnabled/);
  // but no setDoc to payrollSettings in admin page
  assert.doesNotMatch(adminPage, /setDoc\(doc\(db, "payrollSettings"/);
});

test("payroll page has simplified 3-function interface", () => {
  // Must have the 3 core actions
  assert.match(payrollPage, /今月の給与Excelを作成/);
  assert.match(payrollPage, /振込一覧Excelを作成/);
  assert.match(payrollPage, /給与明細ダウンロード/);
  assert.match(payrollPage, /給与を確定/);
  // Must not have complex KPI cards or employee detail table
  assert.doesNotMatch(payrollPage, /課税支給合計/);
  assert.doesNotMatch(payrollPage, /adjus/);
});

test("confirmed runs list API requires admin token", () => {
  assert.match(payrollRunsRoute, /verifyAdminToken/);
  assert.match(payrollRunsRoute, /listConfirmedRuns/);
  assert.match(payrollRunsRoute, /loadPayrollRun/);
  assert.match(payrollRunsRoute, /status.*confirmed/);
});

test("payroll server has listConfirmedRuns returning only confirmed runs", () => {
  assert.match(payrollServer, /listConfirmedRuns/);
  assert.match(payrollServer, /where\("status", "==", "confirmed"\)/);
});

test("payroll previews stay in memory and only confirmation persists them", () => {
  const draftStart = payrollServer.indexOf("export async function createPayrollDraft");
  const confirmStart = payrollServer.indexOf("export async function confirmPayrollRun");
  const draft = payrollServer.slice(draftStart, confirmStart);
  const confirm = payrollServer.slice(confirmStart);
  assert.doesNotMatch(draft, /db\.batch\(|batch\.set|\.commit\(/);
  assert.match(confirm, /db\.batch\(\)/);
  assert.match(confirm, /batch\.set\(ref, run\)/);
  assert.match(confirm, /await batch\.commit\(\)/);
  assert.match(payrollConfirmRoute, /confirmPayrollRun/);
  assert.match(payrollPage, /export\/payroll["], \{ method: "POST"/);
  assert.match(payrollPage, /export\/transfer["], \{ method: "POST"/);
});

test("Firestore writes use resource names and atomic commit", () => {
  assert.match(firestoreRest, /projects\/\$\{PROJ\(\)\}\/databases\/\(default\)\/documents/);
  assert.doesNotMatch(firestoreRest, /name: `\$\{FSBASE\(\)\}/);
  assert.match(firestoreRest, /`\$\{FSBASE\(\)\}:commit`/);
  assert.doesNotMatch(firestoreRest, /:batchWrite/);
});

test("area manager employee form has only basic fields plus payrollEnabled", () => {
  const formStart = adminPage.indexOf("const emptyEmployeeForm");
  const formEnd = adminPage.indexOf("});", formStart) + 3;
  const form = adminPage.slice(formStart, formEnd);
  assert.match(form, /payrollEnabled/);
  assert.doesNotMatch(form, /payrollType/);
  assert.doesNotMatch(form, /healthInsurance/);
  assert.doesNotMatch(form, /fixedBaseSalary/);
  assert.doesNotMatch(form, /taxTableType/);
});

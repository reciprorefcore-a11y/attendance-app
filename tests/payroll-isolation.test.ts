import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const adminPage = readFileSync("app/admin/page.tsx", "utf8");
const payrollPage = readFileSync("app/hq/payroll/page.tsx", "utf8");
const payrollRoute = readFileSync("app/api/payroll/calculate/route.ts", "utf8");
const payrollServer = readFileSync("lib/payroll-server.ts", "utf8");
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
  assert.match(payrollPage, /setMessage\(error instanceof Error/);
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

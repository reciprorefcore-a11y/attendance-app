import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { authorizeEmployeeDeletion } from "../lib/employee-deletion.ts";

test("managerは自店舗のアルバイトを論理削除できる", () => {
  assert.deepEqual(authorizeEmployeeDeletion({ role: "manager", storeId: "store-a" }, { storeId: "store-a", payrollType: "hourly" }), { allowed: true });
});

test("managerによる他店舗アルバイト削除を403で拒否する", () => {
  assert.equal(authorizeEmployeeDeletion({ role: "manager", storeId: "store-a" }, { storeId: "store-b", payrollType: "hourly" }).allowed, false);
});

test("adminは全店舗のアルバイトを削除できる", () => {
  assert.deepEqual(authorizeEmployeeDeletion({ role: "admin" }, { storeId: "store-b", payrollType: "hourly" }), { allowed: true });
});

test("正社員はadmin・managerの双方で403拒否する", () => {
  for (const employee of [{ employeeType: "fullTime" }, { employmentType: "full_time" }, { payrollType: "fixed" }]) {
    assert.equal(authorizeEmployeeDeletion({ role: "admin" }, employee).allowed, false);
    assert.equal(authorizeEmployeeDeletion({ role: "manager", storeId: "store-a" }, { ...employee, storeId: "store-a" }).allowed, false);
  }
});

test("削除APIはemployeesの論理削除だけを行う", () => {
  const route = readFileSync(new URL("../app/api/employees/[employeeId]/route.ts", import.meta.url), "utf8");
  assert.match(route, /authorizeEmployeeDeletion/);
  assert.match(route, /isDeleted: true, status: "inactive"/);
  assert.doesNotMatch(route, /deleteDoc|\.delete\(|clockLogs|payrollRuns|collection\("users"\)/);
});

test("admin画面は氏名付き確認後に削除APIを呼び正社員ボタンを隠す", () => {
  const page = readFileSync(new URL("../app/admin/page.tsx", import.meta.url), "utf8");
  assert.match(page, /window\.confirm\(`\$\{employee\.name\} を削除しますか/);
  assert.match(page, /fetch\(`\/api\/employees\/\$\{employee\.id\}`/);
  assert.match(page, /\(isAdmin \|\| isManager\) && !isFullTimeEmployee\(employee\)/);
});

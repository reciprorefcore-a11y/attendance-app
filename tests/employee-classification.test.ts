import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  isActiveFullTimeEmployee,
  isAdminPartTimeEmployee,
  isFullTimeEmployee,
} from "../lib/employee-classification.ts";

test("正社員の3種類の判定フィールドをすべて認識する", () => {
  assert.equal(isFullTimeEmployee({ employeeType: "fullTime" }), true);
  assert.equal(isFullTimeEmployee({ employmentType: "full_time" }), true);
  assert.equal(isFullTimeEmployee({ payrollType: "fixed" }), true);
  assert.equal(isFullTimeEmployee({ employeeType: "partTime", employmentType: "part_time", payrollType: "hourly" }), false);
});

test("正社員と削除済み社員はadminアルバイト一覧へ出さない", () => {
  assert.equal(isAdminPartTimeEmployee({ employeeType: "fullTime" }), false);
  assert.equal(isAdminPartTimeEmployee({ employmentType: "full_time" }), false);
  assert.equal(isAdminPartTimeEmployee({ payrollType: "fixed" }), false);
  assert.equal(isAdminPartTimeEmployee({ isDeleted: true }), false);
  assert.equal(isAdminPartTimeEmployee({ employeeType: "partTime", payrollType: "hourly" }), true);
});

test("manager連携中でも給与区分を優先して正社員として扱う", () => {
  const managerLinked = { employeeType: "fullTime", hasManagerAccount: true, managerUid: "manager-uid" };
  assert.equal(isAdminPartTimeEmployee(managerLinked), false);
  assert.equal(isActiveFullTimeEmployee(managerLinked), true);
});

test("論理削除解除後の正社員5名はhq対象となり店舗側から除外される", () => {
  const restored = ["0002", "0003", "0017", "0064", "0083"].map((employeeCode) => ({
    employeeCode,
    isDeleted: false,
    employeeType: "fullTime",
    employmentType: "full_time",
    payrollType: "fixed",
  }));
  assert.deepEqual(restored.filter(isActiveFullTimeEmployee).map((e) => e.employeeCode), ["0002", "0003", "0017", "0064", "0083"]);
  assert.deepEqual(restored.filter(isAdminPartTimeEmployee), []);
});

test("admin削除処理はサーバーAPIを使用して正社員を拒否する", () => {
  const source = readFileSync(new URL("../app/admin/page.tsx", import.meta.url), "utf8");
  const operationBlock = source.slice(source.indexOf("const submitEmployeeOperation"), source.indexOf("const saveStore"));
  assert.match(operationBlock, /\/api\/employees\/\$\{employee\.id\}/);
  assert.doesNotMatch(operationBlock, /updateDoc|deleteDoc/);
  assert.match(source, /!isFullTimeEmployee\(employee\)/);
  assert.match(source, /state==="deleted"[\s\S]*復元/);
});

test("旧形式のアルバイトを編集・再有効化すると雇用区分を補完する", () => {
  const route = readFileSync(new URL("../app/api/employees/[employeeId]/route.ts", import.meta.url), "utf8");
  assert.match(route, /employeeType:"partTime",employmentType:"part_time",payrollType:"hourly"/);
  assert.equal(isAdminPartTimeEmployee({}), true, "未設定旧データも互換判定で一覧から消えない");
});

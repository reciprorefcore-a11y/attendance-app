import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { authorizeEmployeeManagement, buildEmployeeChanges, classifyPartTimeEmployee, employeeActionUpdate, validateEmployeeReason } from "../lib/employee-management.ts";

test("managerは自店舗のアルバイトを論理削除できる", () => {
  assert.deepEqual(authorizeEmployeeManagement({ role: "manager", storeId: "store-a" }, { storeId: "store-a", payrollType: "hourly" }), { allowed: true });
});

test("managerによる他店舗アルバイト削除を403で拒否する", () => {
  assert.equal(authorizeEmployeeManagement({ role: "manager", storeId: "store-a" }, { storeId: "store-b", payrollType: "hourly" }).allowed, false);
});

test("adminは全店舗のアルバイトを削除できる", () => {
  assert.deepEqual(authorizeEmployeeManagement({ role: "admin" }, { storeId: "store-b", payrollType: "hourly" }), { allowed: true });
});

test("正社員はadmin・managerの双方で403拒否する", () => {
  for (const employee of [{ employeeType: "fullTime" }, { employmentType: "full_time" }, { payrollType: "fixed" }]) {
    assert.equal(authorizeEmployeeManagement({ role: "admin" }, employee).allowed, false);
    assert.equal(authorizeEmployeeManagement({ role: "manager", storeId: "store-a" }, { ...employee, storeId: "store-a" }).allowed, false);
  }
});

test("削除APIはemployeesの論理削除だけを行う", () => {
  const route = readFileSync(new URL("../app/api/employees/[employeeId]/route.ts", import.meta.url), "utf8");
  assert.match(route, /authorizeEmployeeManagement/);
  assert.match(route, /employeeActionUpdate\("delete"/);
  assert.match(route, /changeHistory/);
  assert.match(route, /runTransaction/);
  assert.doesNotMatch(route, /deleteDoc|\.delete\(|clockLogs|payrollRuns|collection\("users"\)/);
});

test("admin画面は操作モーダルからAPIを呼び正社員を一覧から除外する", () => {
  const page = readFileSync(new URL("../app/admin/page.tsx", import.meta.url), "utf8");
  assert.match(page, /employeeActionDialog/);
  assert.match(page, /fetch\(`\/api\/employees\/\$\{employee\.id\}`/);
  assert.match(page, /!isFullTimeEmployee\(employee\)/);
  for(const label of ["無効化","再有効化","削除","復元"])assert.match(page,new RegExp(label));
});

test("状態操作は無効化・再有効化・論理削除・無効状態への復元を分離する",()=>{const now=new Date("2026-08-25T00:00:00Z");const inactive=employeeActionUpdate("deactivate","u","休職",now);assert.equal(inactive.status,"inactive");assert.equal(inactive.isActive,false);const active=employeeActionUpdate("reactivate","u","復帰",now);assert.equal(active.status,"active");assert.equal(active.isActive,true);const deleted=employeeActionUpdate("delete","u","退職",now);assert.equal(deleted.isDeleted,true);const restored=employeeActionUpdate("restore","u","復元",now);assert.equal(restored.isDeleted,false);assert.equal(restored.status,"inactive");assert.equal(restored.isActive,false);assert.equal(classifyPartTimeEmployee(restored),"inactive");});

test("修正理由は必須でその他は詳細必須",()=>{assert.match(validateEmployeeReason("","")??"",/選択/);assert.match(validateEmployeeReason("その他","")??"",/理由詳細/);assert.equal(validateEmployeeReason("時給改定",""),null);});

test("互換用PINは変更履歴へ保存しない",()=>{const changes=buildEmployeeChanges({pin:"1234",storeId:"s1"},{pin:"5678",storeId:"s2"});assert.deepEqual(changes,[{field:"storeId",label:"所属店舗",before:"s1",after:"s2"}]);assert.doesNotMatch(JSON.stringify(changes),/pin|1234|5678/i);});

test("社員更新と履歴は同じtransactionでcommitされ物理削除しない",()=>{const route=readFileSync(new URL("../app/api/employees/[employeeId]/route.ts",import.meta.url),"utf8");const transactionBlock=route.slice(route.indexOf("runTransaction"),route.indexOf("export async function GET"));assert.match(transactionBlock,/tx\.update\(ref,payload\);tx\.set\(ref\.collection\("changeHistory"\)/);assert.doesNotMatch(transactionBlock,/\.delete\(/);assert.doesNotMatch(route,/clockLogs|payrollRuns|collection\("users"\)/);});

test("編集はその場のモーダル・変更確認・履歴タブを使いページ上部へ移動しない",()=>{const page=readFileSync(new URL("../app/admin/page.tsx",import.meta.url),"utf8");assert.match(page,/employeeEditor&&/);assert.match(page,/変更内容を確認/);assert.match(page,/変更を確定/);assert.match(page,/変更履歴/);assert.match(page,/変更前/);assert.match(page,/変更後/);assert.doesNotMatch(page,/scrollIntoView|window\.scroll/);});

test("一覧カードは行クリックで詳細、常時操作は編集と三点メニューだけ",()=>{const page=readFileSync(new URL("../app/admin/page.tsx",import.meta.url),"utf8");const cards=page.slice(page.indexOf('data-testid="employee-card-list"'),page.indexOf("{employeeEditor&&"));assert.match(cards,/onClick=\{\(\)=>openEmployeeDetail\(employee\)\}/);assert.match(cards,/>編集<\/button>/);assert.match(cards,/>…<\/button>/);assert.doesNotMatch(cards,/>詳細<\/button>/);assert.match(cards,/state==="active"[\s\S]*無効化[\s\S]*削除/);assert.match(cards,/state==="inactive"[\s\S]*再有効化[\s\S]*削除/);assert.match(cards,/state==="deleted"[\s\S]*復元/);});

test("上部は登録ボタンと三点メニュー、フィルターは3状態だけ",()=>{const page=readFileSync(new URL("../app/admin/page.tsx",import.meta.url),"utf8");assert.match(page,/＋ アルバイトを登録/);assert.match(page,/CSV一括登録/);assert.match(page,/CSVテンプレートをダウンロード/);assert.match(page,/\['active','在籍中'\],\['inactive','無効'\],\['deleted','削除済み'\]/);assert.doesNotMatch(page,/\['all','すべて'\]/);});

test("カードはレスポンシブgridでモバイルでも操作をカード内に保持する",()=>{const page=readFileSync(new URL("../app/admin/page.tsx",import.meta.url),"utf8");assert.match(page,/repeat\(auto-fit,minmax\(min\(100%,320px\),1fr\)\)/);assert.match(page,/width:"100%",minHeight:40/);});

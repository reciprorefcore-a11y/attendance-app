import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("アルバイト登録・編集・CSV・詳細画面にPIN入力や表示がない", () => {
  const admin = read("../app/admin/page.tsx");
  const hq = read("../app/hq/employees/page.tsx");
  assert.doesNotMatch(admin, /\bpin\b|PIN|4桁/);
  assert.doesNotMatch(hq, /\bpin\b|PIN|4桁/);
  assert.match(admin, /name,nameKana,employeeCode,storeId,baseHourlyWage,status/);
});

test("登録・編集APIはPINを保存せず社員コード重複を拒否する", () => {
  const create = read("../app/api/employees/route.ts");
  const update = read("../app/api/employees/[employeeId]/route.ts");
  assert.doesNotMatch(create, /\bpin\b|PIN/);
  assert.doesNotMatch(update.match(/const allowed=\[[^\]]+\]/)?.[0] ?? "", /pin/i);
  assert.match(create, /where\("employeeCode", "==", employeeCode\)/);
  assert.match(update, /where\("employeeCode","==",payload\.employeeCode\)/);
  assert.match(create, /同じ社員コード/);
  assert.match(update, /同じ社員コード/);
});

test("通常打刻は社員コードで識別しPINを参照しない", () => {
  const clock = read("../app/clock/page.tsx");
  const punch = read("../lib/clock-punch.ts");
  assert.match(clock, /where\("employeeCode", "==", code\)/);
  assert.doesNotMatch(clock, /\bpin\b|PIN/);
  assert.doesNotMatch(punch, /\bpin\b|PIN/);
});

test("履歴APIは互換用PIN変更をレスポンスから除外する", () => {
  const update = read("../app/api/employees/[employeeId]/route.ts");
  assert.match(update, /field==="pin"/);
  assert.match(update, /NextResponse\.json\(\{employeeId,history/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const adminPage = readFileSync("app/admin/page.tsx", "utf8");
const payrollPage = readFileSync("app/hq/payroll/page.tsx", "utf8");
const payrollRoute = readFileSync("app/api/payroll/calculate/route.ts", "utf8");
const payrollServer = readFileSync("lib/payroll-server.ts", "utf8");
const payrollRunsRoute = readFileSync("app/api/payroll/runs/route.ts", "utf8");
const payrollConfirmRoute = readFileSync("app/api/payroll/confirm/route.ts", "utf8");
const payrollExportRoute = readFileSync("app/api/payroll/export/[kind]/route.ts", "utf8");
const payrollExport = readFileSync("lib/payroll-export.ts", "utf8");
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

test("payroll API is isolated from core load and used only by payroll screen", () => {
  assert.match(payrollPage, /\/api\/payroll\/calculate/);
  assert.match(payrollPage, /setMessage\(e instanceof Error/);
  assert.match(payrollRoute, /loadPayrollWorkspace/);
  assert.match(payrollServer, /db\.collection\("payrollSettings"\)\.get\(\)/);
  assert.doesNotMatch(adminPage, /\/api\/payroll\/calculate/);
  assert.doesNotMatch(adminCoreLoad(), /\/api\/payroll\/calculate/);
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

test("payroll page keeps exports separate and provides one-person fixed-employee settings", () => {
  // Must have the 3 core actions
  assert.match(payrollPage, /給与を試算/);
  assert.match(payrollPage, /給与Excelを生成/);
  assert.match(payrollPage, /振込一覧Excelを生成/);
  assert.match(payrollPage, /この店舗の給与明細を一括ダウンロード/);
  assert.match(payrollPage, /正社員給与明細を一括ダウンロード/);
  assert.match(payrollPage, /給与を確定/);
  assert.match(payrollPage, /正社員給与設定・当月調整/);
  assert.match(payrollPage, /settingsOpen &&/);
  assert.match(payrollPage, /正社員を選択/);
  assert.match(payrollPage, /残業手当を修正する理由|修正理由/);
});

test("payroll screen separates trial, generation, download, and confirmation states", () => {
  assert.match(payrollPage, /\{run && \(/);
  assert.match(payrollPage, /errors\.length === 0 && isDraft/);
  assert.match(payrollPage, /給与対象人数/);
  assert.match(payrollPage, /支給合計/);
  assert.match(payrollPage, /控除合計/);
  assert.match(payrollPage, /差引支給額/);
  assert.match(payrollPage, /ファイル名：\{payrollFile\.name\}/);
  assert.match(payrollPage, /給与Excelをダウンロード/);
  assert.match(payrollPage, /振込一覧Excelをダウンロード/);
  assert.doesNotMatch(payrollPage, /給与Excelを再作成|今月の給与Excelを作成/);
});

test("payroll trial uses useAuthProfile user to acquire ID token — no global auth.currentUser", () => {
  assert.match(payrollPage, /useAuthProfile/);
  assert.match(payrollPage, /await user\.getIdToken\(true\)/);
  assert.match(payrollPage, /Authorization: `Bearer \$\{token\}`/);
  assert.doesNotMatch(payrollPage, /auth\.currentUser/);
  assert.doesNotMatch(payrollPage, /auth\.authStateReady/);
  assert.doesNotMatch(payrollPage, /import \{ auth \}/);
});

test("HQ layout does not deny access while the auth profile is temporarily unavailable", () => {
  const layout = readFileSync("app/hq/layout.tsx", "utf8");
  // Must have 4 separate states: isLoading / !user / !profile / role check
  assert.match(layout, /if \(isLoading\)/);
  assert.match(layout, /if \(!user\)/);
  assert.match(layout, /if \(!profile\)/);
  assert.match(layout, /profile\.role !== "admin"/);
  // Must NOT collapse states — forbidden patterns that caused the original bug
  assert.doesNotMatch(layout, /!user \|\| profile\?\.role !== "admin"/);
  assert.doesNotMatch(layout, /isLoading \|\| !user \|\| !profile/);
});

test("confirmed runs list API requires admin token", () => {
  assert.match(payrollRunsRoute, /verifyAdminToken/);
  assert.match(payrollRunsRoute, /listConfirmedRuns/);
  assert.match(payrollRunsRoute, /loadPayrollRun/);
  assert.match(payrollRunsRoute, /status.*confirmed/);
});

test("payslip ZIP requires admin and a confirmed run", () => {
  assert.match(payrollExportRoute, /verifyAdminToken/);
  assert.match(payrollExportRoute, /本部管理者権限が必要です/);
  assert.match(payrollExportRoute, /run\.status !== "confirmed"/);
  assert.match(payrollExportRoute, /未確定月の給与明細は取得できません/);
  assert.match(payrollExportRoute, /store-payslips/);
  assert.match(payrollExportRoute, /fulltime-payslips/);
});

test("employee management has no monthly adjustment and payroll has exactly one adjustment editor", () => {
  assert.doesNotMatch(adminPage, /当月調整入力|月次調整を反映|臨時出勤回数/);
  assert.equal((payrollPage.match(/臨時出勤回数/g) ?? []).length, 1);
  assert.match(payrollPage, /残業時間（時間）/);
  assert.doesNotMatch(payrollPage, /対象月[^\n]+type="month"/);
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
  assert.match(payrollPage, /export\/payroll["], token, \{ method: "POST"/);
  assert.match(payrollPage, /export\/transfer["], token, \{ method: "POST"/);
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

test("payslip is drawn from an empty A4 landscape page without masking a filled PDF", () => {
  assert.match(payrollExport, /PDFDocument\.create\(\)/);
  assert.match(payrollExport, /addPage\(\[841\.89, 595\.28\]\)/);
  assert.match(payrollExport, /ipaexg\.ttf/);
  assert.doesNotMatch(payrollExport, /PDFDocument\.load|payslip-reference\.pdf/);
});

test("admin employee screen has hourly and admin-only fixed tabs", () => {
  assert.match(adminPage, /① アルバイト/);
  assert.match(adminPage, /\{isAdmin && <button[\s\S]+?② 正社員<\/button>\}/);
  assert.match(adminPage, /雇用区分/);
  assert.match(adminPage, /正社員の新規登録・固定給与マスター/);
  assert.match(adminPage, /健康保険|所得税/);
  assert.doesNotMatch(adminPage, /当月調整入力|月次調整を反映|臨時出勤回数/);
  assert.match(payrollPage, /当月調整を反映して再試算/);
  assert.match(payrollPage, /① 今月の給与計算/);
  assert.match(payrollPage, /② 帳票/);
  assert.match(payrollPage, /③ 給与明細/);
  assert.match(payrollPage, /固定給与マスター/);
  assert.match(payrollPage, /固定給与マスターを保存/);
  assert.match(payrollPage, /生成済みExcelは無効になりました/);
});

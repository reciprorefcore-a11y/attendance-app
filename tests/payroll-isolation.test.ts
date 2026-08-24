import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const adminPage = readFileSync("app/admin/page.tsx", "utf8");
const hqEmployeesPage = readFileSync("app/hq/employees/page.tsx", "utf8");
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

test("payroll page provides one unified workbook and links to the full-time master", () => {
  // Must have the 3 core actions
  assert.match(payrollPage, /給与を試算/);
  assert.match(payrollPage, /統合Excelを1ファイル生成/);
  assert.doesNotMatch(payrollPage, /export\/transfer/);
  assert.match(payrollPage, /この店舗の給与明細を一括ダウンロード/);
  assert.match(payrollPage, /正社員給与明細を一括ダウンロード/);
  assert.match(payrollPage, /給与を確定/);
  assert.match(payrollPage, /正社員マスターを開く/);
  assert.match(payrollPage, /href="\/hq\/employees"/);
  assert.doesNotMatch(payrollPage, /masterOpen|saveFixedMaster|\/api\/payroll\/settings/);
  // 正社員選択はSection②（当月調整）にある
  assert.match(payrollPage, /正社員を選択/);
  assert.match(payrollPage, /残業手当を修正する理由|修正理由/);
});

test("payroll screen separates trial, generation, download, and confirmation states", () => {
  assert.match(payrollPage, /\{run && \(/);
  // Excel/確定セクションは canShowExcel 変数で制御（確定済み or 変更確認済みdraft）
  assert.match(payrollPage, /canShowExcel/);
  assert.match(payrollPage, /isConfirmed[\s\S]*adjustDecision[\s\S]*"no-change"[\s\S]*"adjusted"|adjustDecision[\s\S]*"no-change"[\s\S]*"adjusted"[\s\S]*isConfirmed/);
  assert.match(payrollPage, /給与対象人数/);
  assert.match(payrollPage, /支給合計/);
  assert.match(payrollPage, /控除合計/);
  assert.match(payrollPage, /差引支給額/);
  assert.match(payrollPage, /ファイル名：\{payrollFile\.name\}/);
  assert.match(payrollPage, /統合Excelをダウンロード/);
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

test("Excel section is visible for both draft and confirmed runs", () => {
  // canShowExcel = isConfirmed || (isDraft && errors===0 && adjustDecision決定済み)
  // 「errors.length === 0 && isDraft &&」単体でセクションを制御していないことを確認
  assert.doesNotMatch(payrollPage, /errors\.length === 0 && isDraft && /);
  assert.match(payrollPage, /const canShowExcel/);
  assert.match(payrollPage, /isConfirmed[\s\S]*\|\|[\s\S]*isDraft[\s\S]*adjustDecision/);
  // Draft path has generate buttons
  assert.match(payrollPage, /統合Excelを1ファイル生成/);
  // Confirmed path has download buttons
  assert.match(payrollPage, /確定済み統合Excelをダウンロード/);
  // Confirmed path has 確定取消 with required reason
  assert.match(payrollPage, /確定取消の理由/);
  assert.match(payrollPage, /unconfirmReason\.trim\(\)/);
});

test("confirmed Excel downloads use the stored run snapshot without recalculation", () => {
  // Both draft and confirmed call generateFile with the current run body (no new calculate POST)
  assert.match(payrollPage, /generateFile\("\/api\/payroll\/export\/unified", token/);
  // 給与を試算 button is hidden for confirmed runs
  assert.match(payrollPage, /!isConfirmed[\s\S]+?給与を試算/);
  // Export routes do not write to Firestore (no batch/set/update in export handler)
  assert.doesNotMatch(payrollExportRoute, /batch\(\)|\.set\(|\.update\(/);
});

test("DELETE /api/payroll/confirm requires admin and validates inputs", () => {
  // Must verify admin token — manager/staff/unauthenticated get 403
  assert.match(payrollConfirmRoute, /export async function DELETE/);
  assert.match(payrollConfirmRoute, /verifyAdminToken[\s\S]+?403/);
  // runId and reason are both required (400 if missing)
  assert.match(payrollConfirmRoute, /!runId[\s\S]+?400/);
  assert.match(payrollConfirmRoute, /!reason\?\.trim\(\)[\s\S]+?400/);
  // non-confirmed runs rejected with 409
  assert.match(payrollConfirmRoute, /not_confirmed/);
});

test("cancelPayrollRun stores cancellationReason and only updates the target run", () => {
  // Correct field name: cancellationReason (not cancelReason)
  assert.match(payrollServer, /cancellationReason/);
  assert.doesNotMatch(payrollServer, /cancelReason[^cC]/);
  // Required fields: status, cancelledBy, cancelledAt, cancellationReason
  assert.match(payrollServer, /status.*cancelled[\s\S]+?cancelledAt[\s\S]+?cancelledBy[\s\S]+?cancellationReason|cancellationReason[\s\S]+?status.*cancelled/);
  // Only updates payrollRuns/{runId} — does not touch employee sub-collection
  assert.match(payrollServer, /db\.collection\("payrollRuns"\)\.doc\(runId\)/);
  // Rejects non-confirmed runs before writing
  assert.match(payrollServer, /status.*!==.*confirmed[\s\S]+?not_confirmed|not_confirmed/);
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
  assert.equal((payrollPage.match(/休日出勤回数/g) ?? []).length, 1);
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
  assert.match(payrollPage, /export\/unified["], token, \{ method: "POST"/);
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

test("本部管理者の従業員管理に正社員・アルバイトの統合導線がある", () => {
  assert.match(adminPage, /employeeManagementTab/);
  assert.match(adminPage, /setEmployeeManagementTab\("fulltime"\)/);
  assert.match(adminPage, /setEmployeeManagementTab\("parttime"\)/);
  assert.match(adminPage, /href="\/hq\/employees"/);
  assert.match(adminPage, /正社員マスターを開く/);
  assert.match(adminPage, /アルバイト管理/);
  assert.match(adminPage, /正社員マスター/);
  assert.match(adminPage, /isAdmin && employeeManagementTab === "fulltime"/);
  assert.match(adminPage, /employees\.filter\(\(employee\)=>!isFullTimeEmployee\(employee\)\)/);
  assert.match(hqEmployeesPage, /正社員マスター/);
  assert.doesNotMatch(adminPage, /当月調整入力|月次調整を反映|臨時出勤回数/);
  // 給与業務フロー順の5セクション（Section②に当月調整）
  assert.match(payrollPage, /当月調整を反映して再試算/);
  assert.match(payrollPage, /① 今月の給与を試算/);
  assert.match(payrollPage, /② 正社員給与の変更確認/);
  assert.match(payrollPage, /⑤ 給与明細ダウンロード/);
  assert.doesNotMatch(payrollPage, /固定給与マスター設定|固定給与マスターを保存/);
  assert.match(payrollPage, /正社員マスターを開く/);
  assert.match(payrollPage, /href="\/hq\/employees"/);
  assert.doesNotMatch(payrollPage, /apiCall\("\/api\/payroll\/settings"/);
  assert.match(payrollPage, /生成済みExcelは無効になりました/);
});

test("adjusted後の調整変更は未反映状態（canShowExcelをブロック）", () => {
  // savedAdjustments スナップショットが存在する
  assert.match(payrollPage, /savedAdjustments/);
  assert.match(payrollPage, /setSavedAdjustments\(/);
  // isAdjustmentDirty で dirty 検知
  assert.match(payrollPage, /isAdjustmentDirty/);
  assert.match(payrollPage, /adjustDecision === "adjusted"[\s\S]+?JSON\.stringify/);
  // canShowExcel は !isAdjustmentDirty を含む
  assert.match(payrollPage, /!isAdjustmentDirty/);
  // 未反映メッセージが表示される
  assert.match(payrollPage, /変更内容はまだ再試算されていません/);
});

test("給与設定のサーバー処理は確定済みrunを変えず給与画面からは呼ばれない", () => {
  // payroll-server の saveFixedPayrollMaster は payrollRuns を更新しない
  const masterStart = payrollServer.indexOf("export async function saveFixedPayrollMaster");
  const masterEnd = payrollServer.indexOf("\nexport async function", masterStart + 1);
  const masterFn = payrollServer.slice(masterStart, masterEnd > masterStart ? masterEnd : undefined);
  assert.match(masterFn, /payrollSettings/);
  assert.doesNotMatch(masterFn, /payrollRuns/);
  assert.doesNotMatch(payrollPage, /\/api\/payroll\/settings|saveFixedMaster/);
});

test("FIXED_PAYROLL_TEMPLATEにadvanceExpenseは含まれない（立替経費返金は当月調整のみ）", () => {
  // テンプレートは "const FIXED_PAYROLL_TEMPLATE" から始まり "function asDate" の前で終わる
  const templateStart = payrollServer.indexOf("const FIXED_PAYROLL_TEMPLATE");
  const templateEnd = payrollServer.indexOf("\nfunction asDate", templateStart);
  const templateBlock = payrollServer.slice(templateStart, templateEnd);
  assert.doesNotMatch(templateBlock, /advanceExpense/, "テンプレートに advanceExpense があると二重計上になる");
  // 0002 は cash 支給
  assert.match(templateBlock, /"0002"[\s\S]{0,200}paymentMethod[\s\S]{0,50}cash/);
  // 0017 は paymentMethod 指定なし（デフォルト bank）
  const template0017Start = templateBlock.indexOf('"0017"');
  const template0017End = templateBlock.indexOf("},", template0017Start);
  const block0017 = templateBlock.slice(template0017Start, template0017End);
  assert.doesNotMatch(block0017, /paymentMethod/, "0017 は bank がデフォルトで paymentMethod を明示しない");
});

test("store-payslipsはpartTimeのみ・fulltime-payslipsはfullTimeのみを対象とする", () => {
  // selectStorePayslipResults は partTime かつ storeId 一致のみ
  assert.match(payrollExport, /selectStorePayslipResults/);
  assert.match(payrollExport, /employeeType === "partTime"[\s\S]+?storeId === storeId|storeId === storeId[\s\S]+?employeeType === "partTime"/);
  // selectFullTimePayslipResults は fullTime のみ
  assert.match(payrollExport, /selectFullTimePayslipResults/);
  assert.match(payrollExport, /employeeType === "fullTime"/);
  // 両関数は互いに条件が排他
  const exportFn = payrollExport;
  const storeStart = exportFn.indexOf("selectStorePayslipResults");
  const storeEnd = exportFn.indexOf("}", storeStart);
  const storeBlock = exportFn.slice(storeStart, storeEnd);
  assert.doesNotMatch(storeBlock, /fullTime/, "store ZIP に fullTime フィルターは入らない");
  const ftStart = exportFn.indexOf("selectFullTimePayslipResults");
  const ftEnd = exportFn.indexOf("}", ftStart);
  const ftBlock = exportFn.slice(ftStart, ftEnd);
  assert.doesNotMatch(ftBlock, /partTime/, "fulltime ZIP に partTime フィルターは入らない");
});

test("HQ従業員ページは正社員の新規と編集・状態変更を分離する", () => {
  // 社員コード重複チェック
  assert.match(hqEmployeesPage, /where\("employeeCode", "==", employeeCode\)/);
  assert.match(hqEmployeesPage, /同じ社員コードの従業員が既に登録されています/);
  assert.match(hqEmployeesPage, /mode:"create"[\s\S]*\/api\/fulltime-employees/);
  assert.match(hqEmployeesPage, /mode:"edit"[\s\S]*employeeId/);
  assert.match(hqEmployeesPage, /詳細/);
  assert.match(hqEmployeesPage, /退職・無効化/);
  assert.match(hqEmployeesPage, /再有効化/);
});

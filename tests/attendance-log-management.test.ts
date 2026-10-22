/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { applyAttendanceLogOperation, authorizeAttendanceLog, validateAttendanceLogRequest, type AttendanceLogRequest } from "../lib/attendance-log-management.ts";
import { normalizeAttendanceHistory } from "../lib/attendance-history.ts";
import type { FirestoreRest } from "../lib/firebase-rest.ts";

const request = (action: "correct" | "delete" | "restore" = "delete"): AttendanceLogRequest => ({ action, employeeId: "employee-1", storeId: "store-1", workDate: "2026-11-10", reason: action === "correct" ? "時刻訂正" : "重複打刻", changes: [{ id: "log-1", operation: "update", type: "clock_in", ...(action === "correct" ? { timestamp: "2026-11-10T00:00:00.000Z" } : {}) }] });

test("削除理由必須・任意パスや不正IDを受け付けない", () => {
  assert.equal(validateAttendanceLogRequest({ ...request(), reason: " " }), "削除理由を入力してください");
  assert.match(validateAttendanceLogRequest({ ...request(), changes: [{ ...request().changes[0], id: "../users/admin" }] }) ?? "", /対象打刻/);
});

test("削除と削除取消はadminだけ、従来修正は担当managerも可能", () => {
  assert.equal(authorizeAttendanceLog({ role: "admin" }, "store-1", "delete"), true);
  assert.equal(authorizeAttendanceLog({ role: "manager", storeId: "store-1" }, "store-1", "delete"), false);
  assert.equal(authorizeAttendanceLog({ role: "manager", storeId: "store-1" }, "store-1", "correct"), true);
  assert.equal(authorizeAttendanceLog({ role: "manager", storeId: "store-2" }, "store-1", "correct"), false);
});

test("managerの過去月修正を一律拒否せず非機密の給与確定月索引を参照する", () => {
  const source = readFileSync("lib/attendance-log-management.ts", "utf8");
  assert.doesNotMatch(source, /closed_period_requires_admin/);
  assert.match(source, /collection\("payrollPeriodLocks"\)\.doc\(targetMonth\)/);
  assert.match(source, /payrollPeriodLocksInitialized/);
});

function fixture(options: { confirmed?: boolean; deleted?: boolean; initialized?: boolean; logType?: "clock_in" | "break_start" } = {}) {
  const writes: Array<{ kind: string; path: string; data: Record<string, unknown> }> = [];
  const docs = new Map<string, Record<string, unknown>>([
    ["employees/employee-1", { employeeCode: "1001", name: "テスト", storeId: "store-1" }],
    ["stores/store-1", { storeName: "店舗1" }],
    ["clockLogs/log-1", { employeeId: "employee-1", storeId: "store-1", type: options.logType ?? "clock_in", timestamp: new Date("2026-11-10T00:00:00Z"), ...(options.deleted ? { isDeleted: true, deletionBatchId: "batch-1" } : {}) }],
    ...(options.initialized === false ? [] : [["payrollSettings/attendanceManagementState", { payrollPeriodLocksInitialized: true }]] as [string, Record<string, unknown>][]),
    ...(options.confirmed ? [["payrollPeriodLocks/2026-11", { targetMonth: "2026-11", status: "confirmed" }]] as [string, Record<string, unknown>][] : []),
  ]);
  const ref = (path: string): any => ({ id: path.split("/").at(-1), _docPath: path, collection: (name: string) => collection(`${path}/${name}`) });
  const collection = (path: string): any => ({ _colPath: path, doc: (id = `generated-${writes.length}`) => ref(`${path}/${id}`), where: () => ({ _colPath: "query", where() { return this; }, limit() { return this; } }) });
  const db = { collection, runTransaction: async (fn: any) => fn({ get: async (target: any) => target._colPath === "query" ? { empty: !options.confirmed, docs: options.confirmed ? [{}] : [] } : { id: target.id, exists: docs.has(target._docPath), data: () => docs.get(target._docPath) ?? {} }, update: (target: any, data: Record<string, unknown>) => writes.push({ kind: "update", path: target._docPath, data }), set: (target: any, data: Record<string, unknown>) => writes.push({ kind: "set", path: target._docPath, data }) }) } as unknown as FirestoreRest;
  return { db, writes };
}

test("admin論理削除はclockLogs更新とauditLogs作成を同じtransactionで記録し物理削除しない", async () => {
  const f = fixture();
  await applyAttendanceLogOperation(f.db, { uid: "admin-1", profile: { role: "admin", name: "本部" } }, request());
  assert.equal(f.writes.some((write) => write.kind === "update" && write.path === "clockLogs/log-1" && write.data.isDeleted === true && write.data.deleteReason === "重複打刻"), true);
  assert.equal(f.writes.some((write) => write.kind === "set" && write.path.startsWith("auditLogs/") && write.data.action === "attendance_deleted"), true);
  assert.equal(f.writes.some((write) => write.kind === "delete"), false);
});

test("削除取消はisDeleted=falseへ戻し監査履歴を追加する", async () => {
  const f = fixture({ deleted: true });
  await applyAttendanceLogOperation(f.db, { uid: "admin-1", profile: { role: "admin" } }, request("restore"));
  assert.equal(f.writes.some((write) => write.kind === "update" && write.path === "clockLogs/log-1" && write.data.isDeleted === false && write.data.restoreReason === "重複打刻"), true);
  assert.equal(f.writes.some((write) => write.kind === "set" && write.path.startsWith("auditLogs/") && write.data.action === "attendance_delete_restored"), true);
  assert.equal(f.writes.some((write) => write.kind === "delete"), false);
  // pure input境界でもrestoreはcreateを許可しない。
  assert.match(validateAttendanceLogRequest({ ...request("restore"), changes: [{ id: "log-1", operation: "create", type: "clock_in" }] }) ?? "", /追加できません/);
});

test("担当managerは休憩打刻だけをサーバーAPI処理で論理削除できる", async () => {
  const f = fixture({ logType: "break_start" });
  const input: AttendanceLogRequest = { ...request("correct"), changes: [{ id: "log-1", operation: "delete", type: "break_start" }] };
  await applyAttendanceLogOperation(f.db, { uid: "manager-1", profile: { role: "manager", storeId: "store-1" } }, input);
  assert.equal(f.writes.some((write) => write.path === "clockLogs/log-1" && write.data.isDeleted === true && write.data.deletedBy === "manager-1"), true);
  assert.equal(f.writes.some((write) => write.path.startsWith("auditLogs/") && write.data.deleteReason === "時刻訂正"), true);
});

test("managerは出退勤の論理削除と削除取消を実行できない", async () => {
  const f = fixture();
  const deletion: AttendanceLogRequest = { ...request("correct"), changes: [{ id: "log-1", operation: "delete", type: "clock_in" }] };
  await assert.rejects(applyAttendanceLogOperation(f.db, { uid: "manager-1", profile: { role: "manager", storeId: "store-1" } }, deletion), /forbidden/);
  await assert.rejects(applyAttendanceLogOperation(f.db, { uid: "manager-1", profile: { role: "manager", storeId: "store-1" } }, request("restore")), /forbidden/);
  assert.equal(f.writes.length, 0);
});

test("リクエスト上の休憩種別を偽装して出勤打刻を削除できない", async () => {
  const f = fixture();
  const spoofed: AttendanceLogRequest = { ...request("correct"), changes: [{ id: "log-1", operation: "delete", type: "break_start" }] };
  await assert.rejects(applyAttendanceLogOperation(f.db, { uid: "manager-1", profile: { role: "manager", storeId: "store-1" } }, spoofed), /log_type_mismatch/);
  assert.equal(f.writes.length, 0);
});

test("初期化済みならmanagerの過去月修正を許可し、確定月だけ全roleで拒否する", async () => {
  const correction = request("correct");
  const open = fixture();
  await applyAttendanceLogOperation(open.db, { uid: "manager-1", profile: { role: "manager", storeId: "store-1" } }, correction);
  assert.equal(open.writes.some((write) => write.path === "clockLogs/log-1"), true);
  for (const profile of [{ role: "admin" }, { role: "manager", storeId: "store-1" }]) {
    const locked = fixture({ confirmed: true });
    await assert.rejects(applyAttendanceLogOperation(locked.db, { uid: "actor-1", profile }, correction), /payroll_confirmed/);
    assert.equal(locked.writes.length, 0);
  }
});

test("索引初期化前の移行区間はmanagerの過去月だけ安全停止する", async () => {
  const f = fixture({ initialized: false });
  const oldMonth = { ...request("correct"), workDate: "2026-09-10" };
  await assert.rejects(applyAttendanceLogOperation(f.db, { uid: "manager-1", profile: { role: "manager", storeId: "store-1" } }, oldMonth), /payroll_lock_index_pending/);
  assert.equal(f.writes.length, 0);
});

test("clockLogs論理削除は給与・現行admin勤怠Excelの入力から除外され物理削除しない", () => {
  const payroll = readFileSync("lib/payroll-server.ts", "utf8");
  const admin = readFileSync("app/admin/page.tsx", "utf8");
  assert.match(payroll, /data\.isDeleted !== true/);
  assert.match(admin, /row\.isDeleted/);
  assert.doesNotMatch(readFileSync("app/api/attendance/clock-logs/route.ts", "utf8"), /deleteDoc|\.delete\(/);
  const adminPage = readFileSync("app/admin/page.tsx", "utf8");
  const correctionSave = adminPage.slice(adminPage.indexOf("const saveEdit"), adminPage.indexOf("const downloadExcel"));
  assert.match(correctionSave, /fetch\("\/api\/attendance\/clock-logs"/);
  assert.doesNotMatch(correctionSave, /updateDoc\(doc\(db,\s*"clockLogs"/);
});

test("確定済み勤務月は修正・削除を開始しない", async () => {
  const f = fixture({ confirmed: true });
  await assert.rejects(applyAttendanceLogOperation(f.db, { uid: "admin-1", profile: { role: "admin" } }, request()), /payroll_confirmed/);
  assert.equal(f.writes.length, 0);
});

test("既存auditLogsと旧理由フィールドを正規化し理由なしは理由未記録", () => {
  const current = normalizeAttendanceHistory("log-1", { timestamp: new Date("2026-11-10T00:00:00Z"), isManualEdited: true }, []);
  assert.equal(current[0].reason, "理由未記録");
  const rows = normalizeAttendanceHistory("log-1", {}, [{ id: "audit-1", data: { targetLogIds: ["log-1"], action: "attendance_deleted", before: [{ id: "log-1", timestamp: "2026-11-10T00:00:00Z" }], after: [{ id: "log-1", timestamp: "2026-11-10T00:00:00Z" }], deleteReason: "重複", performedByName: "管理者", performedAt: "2026-11-11T00:00:00Z" } }]);
  assert.equal(rows[0].reason, "重複");
  assert.equal(rows[0].performedBy, "管理者");
});

test("admin勤務セット削除は選択打刻IDだけをサーバーへ送信する", () => {
  const admin = readFileSync("app/admin/page.tsx", "utf8");
  // 旧の一括送信（prompt→workSet全打刻）が残っていない
  assert.doesNotMatch(admin, /const deleteWorkSet\s*=/);
  // モーダル state と確定関数が存在する
  assert.match(admin, /deletePunchDialog/);
  assert.match(admin, /openDeletePunchDialog/);
  // confirmDeletePunches が selectedIds だけを filter してから送信する
  const fn = admin.slice(admin.indexOf("const confirmDeletePunches"), admin.indexOf("const restoreDeletedGroup"));
  assert.match(fn, /new Set\(deletePunchDialog\.selectedIds\)/);
  assert.match(fn, /timecards\.filter\(\(item\) => selected\.has\(item\.id\)\)/);
  // 理由必須 + 1件以上
  assert.match(fn, /削除理由を入力してください/);
  assert.match(fn, /削除する打刻を1件以上選択してください/);
  // モーダルUIが出勤・退勤・休憩開始・休憩終了を個別チェックで提示する
  const modalStart = admin.indexOf("{deletePunchDialog && (() =>");
  assert.ok(modalStart > 0, "deletePunchDialogモーダルブロックが存在する");
  const modal = admin.slice(modalStart, modalStart + 4000);
  assert.match(modal, /clockInLog/);
  assert.match(modal, /clockOutLog/);
  assert.match(modal, /startLog/);
  assert.match(modal, /endLog/);
  assert.match(modal, /type="checkbox"/);
});

test("旧形式の修正履歴も打刻ごとの前後時刻へ正規化する", () => {
  const audit = { id: "audit-legacy", data: { targetLogIds: ["in", "out"], actions: [{ targetLogId: "in", type: "clock_in" }, { targetLogId: "out", type: "clock_out" }], before: { clockIn: "2026-11-10T00:00:00Z", clockOut: "2026-11-10T08:00:00Z" }, after: { clockIn: "2026-11-10T00:15:00Z", clockOut: "2026-11-10T08:15:00Z" }, correctionReason: "打刻訂正" } };
  const clockIn = normalizeAttendanceHistory("in", { type: "clock_in" }, [audit]);
  const clockOut = normalizeAttendanceHistory("out", { type: "clock_out" }, [audit]);
  assert.equal(clockIn[0].beforeTime, "2026-11-10T00:00:00Z");
  assert.equal(clockOut[0].beforeTime, "2026-11-10T08:00:00Z");
  assert.notEqual(clockIn[0].id, clockOut[0].id);
});

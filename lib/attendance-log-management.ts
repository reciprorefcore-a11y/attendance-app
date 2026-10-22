import { randomUUID } from "node:crypto";
import type { FirestoreRest, RestDocSnapshot } from "./firebase-rest.ts";
import { isValidDate } from "./payroll-api-validation.ts";

export type AttendanceLogAction = "correct" | "delete" | "restore";
export type AttendanceLogChange = {
  id: string;
  operation: "create" | "update" | "delete";
  type: "clock_in" | "clock_out" | "break_start" | "break_end";
  timestamp?: string;
};
export type AttendanceLogRequest = {
  action: AttendanceLogAction;
  employeeId: string;
  storeId: string;
  workDate: string;
  reason: string;
  changes: AttendanceLogChange[];
};

type AuthProfile = { role?: unknown; storeId?: unknown; storeIds?: unknown; name?: unknown };

const safeId = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,180}$/.test(value);
const allowedTypes = new Set(["clock_in", "clock_out", "break_start", "break_end"]);

export function validateAttendanceLogRequest(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "入力形式が不正です";
  const input = value as AttendanceLogRequest;
  if (!(["correct", "delete", "restore"] as string[]).includes(input.action)) return "操作が不正です";
  if (!safeId(input.employeeId) || !safeId(input.storeId) || !isValidDate(input.workDate)) return "従業員・店舗・勤務日を確認してください";
  if (typeof input.reason !== "string" || !input.reason.trim()) return input.action === "correct" ? "修正理由を入力してください" : "削除理由を入力してください";
  if (!Array.isArray(input.changes) || input.changes.length === 0 || input.changes.length > 30) return "対象打刻を確認してください";
  const ids = new Set<string>();
  for (const change of input.changes) {
    if (!safeId(change?.id) || ids.has(change.id) || !["create", "update", "delete"].includes(change.operation) || !allowedTypes.has(change.type)) return "対象打刻が不正です";
    ids.add(change.id);
    if (input.action === "correct" && change.operation !== "delete") {
      if (typeof change.timestamp !== "string" || Number.isNaN(new Date(change.timestamp).getTime())) return "打刻日時が不正です";
    }
    if (input.action !== "correct" && change.operation === "create") return "削除・取消では打刻を追加できません";
  }
  return null;
}

export function authorizeAttendanceLog(profile: AuthProfile, storeId: string, action: AttendanceLogAction) {
  const role = String(profile.role ?? "");
  if (action === "delete" || action === "restore") return role === "admin";
  if (role === "admin") return true;
  if (role === "manager") return profile.storeId === storeId;
  if (role === "area_manager" || role === "fc_manager") return Array.isArray(profile.storeIds) && profile.storeIds.includes(storeId);
  return false;
}

export function isClosedAttendanceMonth(workDate: string, now = new Date()) {
  const tokyo = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const currentMonth = `${tokyo.getUTCFullYear()}-${String(tokyo.getUTCMonth() + 1).padStart(2, "0")}`;
  return workDate.slice(0, 7) < currentMonth;
}

function historyLog(snapshot: RestDocSnapshot | null, change: AttendanceLogChange) {
  const data = snapshot?.exists ? snapshot.data() : {};
  const timestamp = data.timestamp instanceof Date ? data.timestamp.toISOString() : data.timestamp ?? null;
  return { id: change.id, type: data.type ?? change.type, timestamp, storeId: data.storeId ?? null, employeeId: data.employeeId ?? null, isDeleted: data.isDeleted === true };
}

export async function applyAttendanceLogOperation(
  db: FirestoreRest,
  actor: { uid: string; profile: AuthProfile },
  input: AttendanceLogRequest,
) {
  const validation = validateAttendanceLogRequest(input);
  if (validation) throw new Error(`invalid:${validation}`);
  if (!authorizeAttendanceLog(actor.profile, input.storeId, input.action)) throw new Error("forbidden");
  const isAdmin = actor.profile.role === "admin";
  // payrollRuns は給与額を含みRules上admin専用。非adminへ給与データを公開せず、
  // 確定し得ない当月だけ従来の担当店舗修正を許可し、過去月はadmin操作へ限定する。
  if (!isAdmin && isClosedAttendanceMonth(input.workDate)) throw new Error("closed_period_requires_admin");
  const reason = input.reason.trim();
  const employeeRef = db.collection("employees").doc(input.employeeId);
  const storeRef = db.collection("stores").doc(input.storeId);
  const logRefs = input.changes.map((change) => db.collection("clockLogs").doc(change.id));
  const auditRef = db.collection("auditLogs").doc();
  const deletionBatchId = input.action === "delete" ? randomUUID() : null;
  const now = new Date();

  await db.runTransaction(async (transaction) => {
    const confirmedRead = isAdmin
      ? transaction.get(db.collection("payrollRuns").where("targetMonth", "==", input.workDate.slice(0, 7)).where("status", "==", "confirmed").limit(1))
      : Promise.resolve({ empty: true, docs: [] });
    const [employee, store, confirmed, ...snapshots] = await Promise.all([
      transaction.get(employeeRef),
      transaction.get(storeRef),
      confirmedRead,
      ...logRefs.map((ref) => transaction.get(ref)),
    ]);
    if (!employee.exists) throw new Error("employee_not_found");
    if (!store.exists) throw new Error("store_not_found");
    if (!confirmed.empty) throw new Error("payroll_confirmed");
    if (!authorizeAttendanceLog(actor.profile, input.storeId, input.action)) throw new Error("forbidden");

    const before = input.changes.map((change, index) => historyLog(snapshots[index], change));
    for (const [index, change] of input.changes.entries()) {
      const snapshot = snapshots[index];
      const ref = logRefs[index];
      if (change.operation === "create") {
        if (snapshot.exists) throw new Error("log_already_exists");
      } else {
        if (!snapshot.exists) throw new Error("log_not_found");
        const existing = snapshot.data();
        if (String(existing.employeeId ?? "") !== input.employeeId) throw new Error("employee_mismatch");
        if (!authorizeAttendanceLog(actor.profile, String(existing.storeId ?? ""), input.action)) throw new Error("forbidden");
      }

      if (input.action === "correct") {
        const employeeData = employee.data();
        const storeData = store.data();
        const common = {
          employeeId: input.employeeId,
          employeeCode: String(employeeData.employeeCode ?? ""),
          employeeName: String(employeeData.name ?? ""),
          storeId: input.storeId,
          workStoreId: input.storeId,
          workStoreName: String(storeData.storeName ?? storeData.name ?? input.storeId),
          homeStoreId: String(employeeData.storeId ?? ""),
          isHelp: Boolean(employeeData.storeId && employeeData.storeId !== input.storeId),
          isManualEdited: true,
          isCorrected: true,
          correctedAt: now,
          correctedBy: actor.uid,
          correctionReason: reason,
        };
        if (change.operation === "delete") transaction.update(ref, { ...common, isDeleted: true, deletedAt: now, deletedBy: actor.uid, deleteReason: reason });
        else {
          const data = { ...common, type: change.type, timestamp: new Date(change.timestamp!), ...(change.operation === "create" ? { createdAt: now, isOutsideGps: false } : {}) };
          if (change.operation === "create") transaction.set(ref, data); else transaction.update(ref, data);
        }
      } else if (input.action === "delete") {
        if (snapshot.data().isDeleted === true) throw new Error("already_deleted");
        transaction.update(ref, { isDeleted: true, deletedAt: now, deletedBy: actor.uid, deleteReason: reason, deletionBatchId });
      } else {
        if (snapshot.data().isDeleted !== true) throw new Error("not_deleted");
        transaction.update(ref, { isDeleted: false, restoredAt: now, restoredBy: actor.uid, restoreReason: reason });
      }
    }

    const after = input.changes.map((change) => ({ id: change.id, type: change.type, timestamp: change.timestamp ?? before.find((item) => item.id === change.id)?.timestamp ?? null, isDeleted: input.action === "delete" || (input.action === "correct" && change.operation === "delete") }));
    transaction.set(auditRef, {
      action: input.action === "correct" ? "attendance_corrected" : input.action === "delete" ? "attendance_deleted" : "attendance_delete_restored",
      employeeId: input.employeeId,
      storeId: input.storeId,
      workDate: input.workDate,
      targetLogIds: input.changes.map((change) => change.id),
      before,
      after,
      correctionReason: input.action === "correct" ? reason : null,
      deleteReason: input.action === "delete" ? reason : null,
      restoreReason: input.action === "restore" ? reason : null,
      deletionBatchId,
      performedBy: actor.uid,
      performedByName: String(actor.profile.name ?? ""),
      performedAt: now,
    });
  });
  return { ok: true, action: input.action, targetLogIds: input.changes.map((change) => change.id), deletionBatchId };
}

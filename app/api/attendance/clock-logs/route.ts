import { NextRequest, NextResponse } from "next/server";
import { applyAttendanceLogOperation, validateAttendanceLogRequest, type AttendanceLogRequest } from "@/lib/attendance-log-management";
import { verifyUserToken } from "@/lib/firebase-rest";

export const runtime = "nodejs";

export async function PATCH(request: NextRequest) {
  const authenticated = await verifyUserToken(request.headers.get("authorization"));
  if (!authenticated) return NextResponse.json({ error: "認証または権限を確認してください", code: "FORBIDDEN" }, { status: 403 });
  const input = await request.json().catch(() => null) as AttendanceLogRequest | null;
  const validation = validateAttendanceLogRequest(input);
  if (validation || !input) return NextResponse.json({ error: validation ?? "入力形式が不正です", code: "INVALID_INPUT" }, { status: 400 });
  try {
    return NextResponse.json(await applyAttendanceLogOperation(authenticated.db, { uid: authenticated.uid, profile: authenticated.profile }, input));
  } catch (error) {
    const internalCode = error instanceof Error ? error.message : "unknown";
    const knownCode = internalCode.startsWith("invalid:") ? "INVALID_INPUT" : ({ forbidden: "FORBIDDEN", payroll_confirmed: "PAYROLL_CONFIRMED", payroll_lock_index_pending: "PAYROLL_LOCK_INDEX_PENDING", employee_not_found: "EMPLOYEE_NOT_FOUND", store_not_found: "STORE_NOT_FOUND", log_not_found: "LOG_NOT_FOUND", log_already_exists: "LOG_ALREADY_EXISTS", already_deleted: "ALREADY_DELETED", not_deleted: "NOT_DELETED", employee_mismatch: "EMPLOYEE_MISMATCH", log_type_mismatch: "LOG_TYPE_MISMATCH" } as Record<string, string>)[internalCode] ?? "ATTENDANCE_OPERATION_FAILED";
    const response = internalCode === "forbidden" ? { status: 403, error: "この打刻を操作する権限がありません" }
      : internalCode === "payroll_confirmed" ? { status: 409, error: "給与確定済み期間の打刻は修正・削除できません" }
      : internalCode === "payroll_lock_index_pending" ? { status: 503, error: "給与確定状況の初期化待ちです。本部管理者が一律休憩設定を保存した後に再試行してください" }
      : internalCode === "employee_not_found" ? { status: 404, error: "従業員が見つかりません" }
      : internalCode === "store_not_found" ? { status: 404, error: "店舗が見つかりません" }
      : internalCode === "log_not_found" ? { status: 404, error: "対象打刻が見つかりません" }
      : internalCode === "log_already_exists" ? { status: 409, error: "同じIDの打刻が既に存在します。再読み込みしてください" }
      : internalCode === "already_deleted" ? { status: 409, error: "対象打刻は既に削除済みです" }
      : internalCode === "not_deleted" ? { status: 409, error: "対象打刻は削除済みではありません" }
      : internalCode === "employee_mismatch" ? { status: 409, error: "対象打刻の従業員が一致しません。再読み込みしてください" }
      : internalCode === "log_type_mismatch" ? { status: 409, error: "対象打刻の種別が一致しません。再読み込みしてください" }
      : internalCode.startsWith("invalid:") ? { status: 400, error: internalCode.slice(8) }
      : { status: 500, error: "打刻操作に失敗しました。再読み込みしてからお試しください" };
    console.error(JSON.stringify({ event: "attendance_log_operation_failed", errorCode: knownCode, action: input.action, actorUid: authenticated.uid }));
    return NextResponse.json({ error: response.error, code: knownCode }, { status: response.status });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { verifyAdminToken } from "@/lib/firebase-admin";
import { cancelPayrollRun, confirmPayrollRun, type PayrollConfirmationInput } from "@/lib/payroll-server";
import { isValidDate, isValidMonth, validateAdjustments } from "@/lib/payroll-api-validation";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const admin = await verifyAdminToken(request.headers.get("authorization"));
  if (!admin) return NextResponse.json({ error: "本部管理者権限が必要です" }, { status: 403 });
  const { run } = await request.json() as { run?: PayrollConfirmationInput & { adjustmentsSnapshot?: PayrollConfirmationInput["adjustments"] } };
  if (!run) return NextResponse.json({ error: "給与計算結果が必要です" }, { status: 400 });
  if (!isValidMonth(run.targetMonth) || !isValidMonth(run.paymentMonth) || !isValidDate(run.paymentDate) || typeof run.sourceAttendanceVersion !== "string") return NextResponse.json({ error: "対象月・支給月・支給日・勤怠バージョンを確認してください" }, { status: 400 });
  const adjustments = run.adjustmentsSnapshot ?? run.adjustments;
  const adjError = validateAdjustments(adjustments);
  if (adjError) return NextResponse.json({ error: adjError.error }, { status: adjError.status });
  try {
    return NextResponse.json(await confirmPayrollRun(admin.db, admin.uid, { targetMonth: run.targetMonth, paymentMonth: run.paymentMonth, paymentDate: run.paymentDate, sourceAttendanceVersion: run.sourceAttendanceVersion, adjustments }));
  } catch (error) {
    const message = error instanceof Error && error.message === "month_not_closed" ? "対象月は締め前のため、試算・帳票プレビューのみ可能です" : error instanceof Error && error.message === "source_changed" ? "試算後に勤怠または給与設定が変更されました。再試算してから確定してください" : error instanceof Error && error.message === "already_confirmed" ? "この対象月の給与はすでに確定されています" : error instanceof Error && error.message === "blocking_errors" ? "重大なエラーがあるため確定できません" : error instanceof Error && ["invalid_result", "report_mismatch"].includes(error.message) ? "給与計算または帳票金額に不整合があるため確定できません" : "給与確定に失敗しました";
    return NextResponse.json({ error: message }, { status: 409 });
  }
}

export async function DELETE(request: NextRequest) {
  const admin = await verifyAdminToken(request.headers.get("authorization"));
  if (!admin) return NextResponse.json({ error: "本部管理者権限が必要です" }, { status: 403 });
  const { runId, reason } = await request.json() as { runId?: string; reason?: string };
  if (!runId) return NextResponse.json({ error: "runIdが必要です" }, { status: 400 });
  if (!reason?.trim()) return NextResponse.json({ error: "確定取消の理由を入力してください" }, { status: 400 });
  try {
    await cancelPayrollRun(admin.db, runId, admin.uid, reason.trim());
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error && error.message === "not_found" ? "指定の給与データが見つかりません" : error instanceof Error && error.message === "not_confirmed" ? "確定済み給与データではありません" : "確定取消に失敗しました";
    return NextResponse.json({ error: message }, { status: 409 });
  }
}

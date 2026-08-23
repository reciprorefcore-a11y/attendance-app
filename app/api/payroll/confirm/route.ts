import { NextRequest, NextResponse } from "next/server";
import { verifyAdminToken } from "@/lib/firebase-admin";
import { cancelPayrollRun, confirmPayrollRun, createPayrollDraft } from "@/lib/payroll-server";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const admin = await verifyAdminToken(request.headers.get("authorization"));
  if (!admin) return NextResponse.json({ error: "本部管理者権限が必要です" }, { status: 403 });
  const { run } = await request.json() as { run?: Awaited<ReturnType<typeof createPayrollDraft>> };
  if (!run) return NextResponse.json({ error: "給与計算結果が必要です" }, { status: 400 });
  try {
    return NextResponse.json(await confirmPayrollRun(admin.db, admin.uid, run));
  } catch (error) {
    const message = error instanceof Error && error.message === "month_not_closed" ? "対象月は締め前のため、試算・帳票プレビューのみ可能です" : error instanceof Error && error.message === "blocking_errors" ? "重大なエラーがあるため確定できません" : error instanceof Error && ["invalid_result", "report_mismatch"].includes(error.message) ? "給与計算または帳票金額に不整合があるため確定できません" : "給与確定に失敗しました";
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

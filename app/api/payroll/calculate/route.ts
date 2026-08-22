import { NextRequest, NextResponse } from "next/server";
import { verifyAdminToken } from "@/lib/firebase-admin";
import { createPayrollDraft, loadPayrollWorkspace } from "@/lib/payroll-server";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const admin = await verifyAdminToken(request.headers.get("authorization"));
  if (!admin) return NextResponse.json({ error: "本部管理者権限が必要です" }, { status: 403 });
  const targetMonth = request.nextUrl.searchParams.get("targetMonth") ?? "";
  if (!/^\d{4}-\d{2}$/.test(targetMonth)) return NextResponse.json({ error: "対象月を確認してください" }, { status: 400 });
  try {
    return NextResponse.json(await loadPayrollWorkspace(admin.db, targetMonth));
  } catch (error) {
    console.error("payroll workspace load failed", error);
    const detail = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: `給与情報を取得できません: ${detail}` }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const admin = await verifyAdminToken(request.headers.get("authorization"));
  if (!admin) return NextResponse.json({ error: "本部管理者権限が必要です" }, { status: 403 });
  const input = await request.json() as { targetMonth?: string; paymentMonth?: string; paymentDate?: string };
  if (!/^\d{4}-\d{2}$/.test(input.targetMonth ?? "") || !/^\d{4}-\d{2}$/.test(input.paymentMonth ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(input.paymentDate ?? "")) return NextResponse.json({ error: "対象月・支給月・支給日を確認してください" }, { status: 400 });
  try {
    return NextResponse.json(await createPayrollDraft(admin.db, admin.uid, input as Required<typeof input>));
  } catch (error) {
    console.error("payroll calculation failed", error);
    if (error instanceof Error && error.message === "already_confirmed") return NextResponse.json({ error: "この対象月の給与は確定済みです。再計算する場合は先に確定取消を行ってください" }, { status: 409 });
    // 本部管理者専用APIのため、原因究明できるよう実際の例外内容を返す。
    const detail = error instanceof Error ? `${error.message}` : String(error);
    return NextResponse.json({ error: `給与計算に失敗しました: ${detail}` }, { status: 500 });
  }
}

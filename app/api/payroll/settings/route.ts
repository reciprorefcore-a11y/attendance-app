import { NextRequest, NextResponse } from "next/server";
import { verifyAdminToken } from "@/lib/firebase-admin";
import { saveFixedPayrollMaster } from "@/lib/payroll-server";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const admin = await verifyAdminToken(request.headers.get("authorization"));
  if (!admin) return NextResponse.json({ error: "本部管理者権限が必要です" }, { status: 403 });
  const { employeeId, values } = await request.json() as { employeeId?: string; values?: Record<string, unknown> };
  if (!employeeId || !values) return NextResponse.json({ error: "正社員と固定給与設定を確認してください" }, { status: 400 });
  try { return NextResponse.json(await saveFixedPayrollMaster(admin.db, employeeId, values)); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "保存に失敗しました" }, { status: 400 }); }
}

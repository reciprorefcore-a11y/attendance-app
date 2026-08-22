import { NextRequest, NextResponse } from "next/server";
import { verifyAdminToken } from "@/lib/firebase-admin";
import { listConfirmedRuns, loadPayrollRun } from "@/lib/payroll-server";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const admin = await verifyAdminToken(request.headers.get("Authorization"));
  if (!admin) return NextResponse.json({ error: "本部管理者権限が必要です" }, { status: 403 });

  const runId = request.nextUrl.searchParams.get("runId");
  if (runId) {
    const run = await loadPayrollRun(admin.db, runId);
    if (!run) return NextResponse.json({ error: "指定の給与計算データが見つかりません" }, { status: 404 });
    if (run.status !== "confirmed") return NextResponse.json({ error: "確定済みデータではありません" }, { status: 400 });
    return NextResponse.json(run);
  }

  const runs = await listConfirmedRuns(admin.db);
  return NextResponse.json({ runs });
}

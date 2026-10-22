import { NextRequest, NextResponse } from "next/server";
import { verifyAdminToken } from "@/lib/firebase-admin";
import { savePayrollBreakPolicy } from "@/lib/payroll-server";
import { validatePayrollBreakPolicy } from "@/lib/payroll";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const admin = await verifyAdminToken(request.headers.get("authorization"));
  if (!admin) return NextResponse.json({ error: "本部管理者権限が必要です" }, { status: 403 });
  const snapshot = await admin.db.collection("payrollSettings").doc("attendanceBreakPolicy").get();
  return NextResponse.json({ policy: snapshot.exists ? validatePayrollBreakPolicy(snapshot.data()) : null });
}

export async function POST(request: NextRequest) {
  const admin = await verifyAdminToken(request.headers.get("authorization"));
  if (!admin) return NextResponse.json({ error: "本部管理者権限が必要です" }, { status: 403 });
  const body = await request.json().catch(() => null) as { policy?: unknown } | null;
  try { return NextResponse.json({ policy: await savePayrollBreakPolicy(admin.db, admin.uid, body?.policy) }); }
  catch (error) {
    console.error("[break-policy] save failed:", error);
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("confirmed_month_blocked:")) {
      return NextResponse.json({ error: message.slice("confirmed_month_blocked:".length) }, { status: 400 });
    }
    const detail = message.slice(0, 160);
    return NextResponse.json({ error: `閾値・控除時間・適用開始日を確認してください${detail ? `（${detail}）` : ""}` }, { status: 400 });
  }
}

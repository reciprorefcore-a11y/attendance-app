import { NextRequest, NextResponse } from "next/server";
import { verifyAdminToken } from "@/lib/firebase-admin";
import { rejectPayrollPreviewWrite } from "@/lib/payroll-preview";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const previewRejection = rejectPayrollPreviewWrite();
  if (previewRejection) return NextResponse.json(previewRejection, { status: 403 });
  const admin = await verifyAdminToken(request.headers.get("authorization"));
  if (!admin) return NextResponse.json({ error: "本部管理者権限が必要です" }, { status: 403 });
  const { runId, reason } = await request.json() as { runId?: string; reason?: string };
  if (!runId || !reason?.trim()) return NextResponse.json({ error: "確定取消理由が必要です" }, { status: 400 });
  try {
    await admin.db.runTransaction(async (transaction) => {
      const ref = admin.db.collection("payrollRuns").doc(runId);
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists || snapshot.data()?.status !== "confirmed") throw new Error("invalid_status");
      const now = new Date();
      transaction.update(ref, { status: "cancelled", cancelledAt: now, cancelledBy: admin.uid, cancellationReason: reason.trim() });
      transaction.set(ref.collection("auditLogs").doc(), { action: "cancel_confirmation", reason: reason.trim(), performedBy: admin.uid, performedAt: now, beforeStatus: "confirmed", afterStatus: "cancelled" });
    });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "確定済み給与だけ取消できます" }, { status: 409 });
  }
}

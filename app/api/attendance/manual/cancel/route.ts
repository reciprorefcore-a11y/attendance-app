import { NextRequest, NextResponse } from "next/server";
import { verifyUserToken } from "@/lib/firebase-rest";
export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  const auth = await verifyUserToken(request.headers.get("authorization"));
  if (!auth || !["admin", "manager", "area_manager", "fc_manager"].includes(String(auth.profile.role ?? ""))) return NextResponse.json({ error: "取消権限がありません。" }, { status: 403 });
  const body = await request.json().catch(() => ({})) as { requestId?: string; cancellationReason?: string };
  if (!body.requestId || !body.cancellationReason?.trim()) return NextResponse.json({ error: "取消理由が必要です。" }, { status: 400 });
  const logs = await auth.db.collection("clockLogs").where("manualRequestId", "==", body.requestId).get();
  if (logs.empty) return NextResponse.json({ error: "手動登録記録が見つかりません。" }, { status: 404 });
  const storeId = String(logs.docs[0].data().storeId ?? "");
  const role = String(auth.profile.role ?? "");
  const permitted = role === "admin" || (role === "manager" ? auth.profile.storeId === storeId : Array.isArray(auth.profile.storeIds) && auth.profile.storeIds.includes(storeId));
  if (!permitted) return NextResponse.json({ error: "管理対象外の店舗です。" }, { status: 403 });
  const batch = auth.db.batch(); const now = new Date();
  for (const log of logs.docs) batch.update(auth.db.collection("clockLogs").doc(log.id), { isCancelled: true, cancelledBy: auth.uid, cancelledAt: now, cancellationReason: body.cancellationReason.trim(), updatedBy: auth.uid, updatedAt: now });
  await batch.commit();
  return NextResponse.json({ ok: true, requestId: body.requestId });
}

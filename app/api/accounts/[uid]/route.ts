import { NextRequest, NextResponse } from "next/server";
import { verifyUserToken } from "@/lib/firebase-rest";
import { ACCOUNT_ROLES, accountChanges, isHeadquartersAdmin, type AccountRole } from "@/lib/account-management";

export const runtime = "nodejs";

async function authorize(request: NextRequest) {
  const authenticated = await verifyUserToken(request.headers.get("authorization"));
  return authenticated && isHeadquartersAdmin(authenticated.profile) ? authenticated : null;
}

export async function GET(request: NextRequest, context: { params: Promise<{ uid: string }> }) {
  const authenticated = await authorize(request);
  if (!authenticated) return NextResponse.json({ error: "本部管理者権限が必要です。" }, { status: 403 });
  const { uid } = await context.params, ref = authenticated.db.collection("users").doc(uid), snapshot = await ref.get();
  if (!snapshot.exists) return NextResponse.json({ error: "アカウントが見つかりません。" }, { status: 404 });
  const history = await ref.collection("changeHistory").get();
  const rows = history.docs.map(doc => { const data = doc.data(); return { id: doc.id, ...data, changes: Array.isArray(data.changes) ? data.changes.filter((change: unknown) => !(change && typeof change === "object" && "field" in change && /password/i.test(String((change as { field?: unknown }).field)))) : [] }; });
  return NextResponse.json({ history: rows });
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ uid: string }> }) {
  const authenticated = await authorize(request);
  if (!authenticated) return NextResponse.json({ error: "本部管理者権限が必要です。" }, { status: 403 });
  const { uid } = await context.params, body = await request.json().catch(() => null) as Record<string, unknown> | null, reason = String(body?.reason ?? "").trim(), action = String(body?.action ?? "edit");
  if (!body || !reason || !["edit", "deactivate", "reactivate"].includes(action)) return NextResponse.json({ error: "操作内容と修正理由を確認してください。" }, { status: 400 });
  const ref = authenticated.db.collection("users").doc(uid); let rejected: { error: string; status: number } | null = null;
  await authenticated.db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref); if (!snapshot.exists) { rejected = { error: "アカウントが見つかりません。", status: 404 }; return; }
    const before = snapshot.data(), now = new Date(); let update: Record<string, unknown>;
    if (action === "edit") {
      const role = String(body.role ?? "") as AccountRole, storeIds = Array.isArray(body.storeIds) ? body.storeIds.map(String).filter(Boolean) : [];
      if (!ACCOUNT_ROLES.includes(role) || (role === "manager" && storeIds.length !== 1) || ((role === "area_manager" || role === "fc_manager") && storeIds.length === 0)) { rejected = { error: "権限と担当店舗を確認してください。", status: 400 }; return; }
      update = { name: String(body.name ?? "").trim(), role, storeId: role === "admin" ? "" : (storeIds[0] ?? ""), storeIds: role === "admin" ? [] : storeIds, status: body.status === "inactive" ? "inactive" : "active", isActive: body.status !== "inactive", updatedAt: now, updatedBy: authenticated.uid };
    } else update = action === "deactivate" ? { status: "inactive", isActive: false, deactivatedAt: now, deactivatedBy: authenticated.uid, deactivationReason: reason } : { status: "active", isActive: true, reactivatedAt: now, reactivatedBy: authenticated.uid, reactivationReason: reason };
    transaction.update(ref, update); transaction.set(ref.collection("changeHistory").doc(), { accountUid: uid, action: action === "edit" ? "編集" : action === "deactivate" ? "無効化" : "再有効化", changes: accountChanges(before, update), reason, performedBy: authenticated.uid, performedByName: String(authenticated.profile.name ?? ""), performedAt: now });
  });
  const failure = rejected as { error: string; status: number } | null;
  if (failure) return NextResponse.json({ error: failure.error }, { status: failure.status });
  return NextResponse.json({ ok: true, uid });
}

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase-admin";
import { verifyUserToken } from "@/lib/firebase-rest";
import { ACCOUNT_ROLES, accountChanges, isHeadquartersAdmin, sanitizeAccountRecord, type AccountRole } from "@/lib/account-management";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const authenticated = await verifyUserToken(request.headers.get("authorization"));
  if (!authenticated || !isHeadquartersAdmin(authenticated.profile)) return NextResponse.json({ error: "本部管理者権限が必要です。" }, { status: 403 });
  const snapshot = await authenticated.db.collection("users").get();
  return NextResponse.json({ accounts: snapshot.docs.map(doc => sanitizeAccountRecord(doc.id, doc.data())) });
}

export async function POST(request: NextRequest) {
  const authenticated = await verifyUserToken(request.headers.get("authorization"));
  if (!authenticated || !isHeadquartersAdmin(authenticated.profile)) return NextResponse.json({ error: "本部管理者権限が必要です。" }, { status: 403 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const name = String(body?.name ?? "").trim(), email = String(body?.email ?? "").trim(), password = String(body?.initialPassword ?? ""), role = String(body?.role ?? "") as AccountRole, reason = String(body?.reason ?? "").trim();
  const storeIds = Array.isArray(body?.storeIds) ? body.storeIds.map(String).filter(Boolean) : [];
  if (!name || !email || password.length < 6 || !reason || !ACCOUNT_ROLES.includes(role)) return NextResponse.json({ error: "氏名、メールアドレス、6文字以上の初期パスワード、権限、登録理由を確認してください。" }, { status: 400 });
  if (role === "manager" && storeIds.length !== 1) return NextResponse.json({ error: "店舗マネージャーは担当店舗を1店舗指定してください。" }, { status: 400 });
  if ((role === "area_manager" || role === "fc_manager") && storeIds.length === 0) return NextResponse.json({ error: "担当店舗を指定してください。" }, { status: 400 });
  if (role === "fc_manager") {
    const selectedStores = await Promise.all(storeIds.map(storeId => authenticated.db.collection("stores").doc(storeId).get()));
    if (selectedStores.some(store => !store.exists || store.data().isFc !== true)) return NextResponse.json({ error: "FCマネージャーにはFC対象店舗だけを指定してください。" }, { status: 400 });
  }
  const adminAuth = getAdminAuth();
  if (!adminAuth) return NextResponse.json({ error: "アカウント作成機能を利用できません。" }, { status: 503 });
  const created = await adminAuth.createUser({ email, password, displayName: name, disabled: false });
  try {
    const now = new Date(), data = { name, email, role, storeId: role === "admin" ? "" : (storeIds[0] ?? ""), storeIds: role === "admin" ? [] : storeIds, status: "active", isActive: true, createdAt: now, createdBy: authenticated.uid, updatedAt: now, updatedBy: authenticated.uid };
    const ref = authenticated.db.collection("users").doc(created.uid), batch = authenticated.db.batch();
    batch.create(ref, data);
    batch.create(ref.collection("changeHistory").doc(), { accountUid: created.uid, action: "新規作成", changes: accountChanges({}, data), reason, performedBy: authenticated.uid, performedByName: String(authenticated.profile.name ?? ""), performedAt: now });
    await batch.commit();
    return NextResponse.json({ ok: true, uid: created.uid }, { status: 201 });
  } catch (error) {
    await adminAuth.deleteUser(created.uid).catch(() => undefined);
    throw error;
  }
}

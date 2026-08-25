import { NextRequest, NextResponse } from "next/server";
import { verifyUserToken } from "@/lib/firebase-rest";
import { isHeadquartersAdmin } from "@/lib/account-management";

export const runtime = "nodejs";

export async function POST(request: NextRequest, context: { params: Promise<{ uid: string }> }) {
  const authenticated = await verifyUserToken(request.headers.get("authorization"));
  if (!authenticated || !isHeadquartersAdmin(authenticated.profile)) return NextResponse.json({ error: "本部管理者権限が必要です。" }, { status: 403 });
  const { uid } = await context.params, body = await request.json().catch(() => null) as Record<string, unknown> | null, reason = String(body?.reason ?? "").trim();
  if (!reason) return NextResponse.json({ error: "修正理由が必要です。" }, { status: 400 });
  const ref = authenticated.db.collection("users").doc(uid), snapshot = await ref.get();
  if (!snapshot.exists) return NextResponse.json({ error: "アカウントが見つかりません。" }, { status: 404 });
  const email = String(snapshot.data().email ?? ""); if (!email) return NextResponse.json({ error: "メールアドレスが未登録です。" }, { status: 400 });
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? ""}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestType: "PASSWORD_RESET", email }) });
  if (!response.ok) return NextResponse.json({ error: "パスワード再設定メールを送信できませんでした。" }, { status: 502 });
  const now = new Date(); await authenticated.db.runTransaction(async transaction => transaction.set(ref.collection("changeHistory").doc(), { accountUid: uid, action: "パスワード再設定", changes: [], reason, performedBy: authenticated.uid, performedByName: String(authenticated.profile.name ?? ""), performedAt: now }));
  return NextResponse.json({ ok: true });
}

import { NextRequest, NextResponse } from "next/server";
import { verifyUserToken } from "@/lib/firebase-rest";
import { getAdminAuth, getAdminDb } from "@/lib/firebase-admin";
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
  const newPassword=String(body.newPassword??""),passwordConfirmation=String(body.passwordConfirmation??"");
  if(newPassword&&(newPassword.length<6||newPassword!==passwordConfirmation))return NextResponse.json({error:"新しいパスワードは6文字以上で、確認入力と一致させてください。"},{status:400});
  if(action==="edit"&&body.role==="fc_manager"){
    const storeIds=Array.isArray(body.storeIds)?body.storeIds.map(String).filter(Boolean):[],selectedStores=await Promise.all(storeIds.map(storeId=>authenticated.db.collection("stores").doc(storeId).get()));
    if(selectedStores.some(store=>!store.exists||store.data().isFc!==true))return NextResponse.json({error:"FCマネージャーにはFC対象店舗だけを指定してください。"},{status:400});
  }
  const adminAuth=newPassword?getAdminAuth():null;if(newPassword&&!adminAuth)return NextResponse.json({error:"パスワード変更機能を利用できません。"},{status:503});
  const ref = authenticated.db.collection("users").doc(uid); let rejected: { error: string; status: number } | null = null;
  await authenticated.db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref); if (!snapshot.exists) { rejected = { error: "アカウントが見つかりません。", status: 404 }; return; }
    const before = snapshot.data(), now = new Date(); let update: Record<string, unknown>;
    if (action === "edit") {
      const role = String(body.role ?? "") as AccountRole, storeIds = Array.isArray(body.storeIds) ? body.storeIds.map(String).filter(Boolean) : [];
      if (!ACCOUNT_ROLES.includes(role) || (role === "manager" && storeIds.length !== 1) || ((role === "area_manager" || role === "fc_manager") && storeIds.length === 0)) { rejected = { error: "権限と担当店舗を確認してください。", status: 400 }; return; }
      update = { name: String(body.name ?? "").trim(), role, storeId: role === "admin" ? "" : (storeIds[0] ?? ""), storeIds: role === "admin" ? [] : storeIds, status: body.status === "inactive" ? "inactive" : "active", isActive: body.status !== "inactive", updatedAt: now, updatedBy: authenticated.uid };
    } else update = action === "deactivate" ? { status: "inactive", isActive: false, deactivatedAt: now, deactivatedBy: authenticated.uid, deactivationReason: reason } : { status: "active", isActive: true, reactivatedAt: now, reactivatedBy: authenticated.uid, reactivationReason: reason };
    transaction.update(ref, update); transaction.set(ref.collection("changeHistory").doc(), { accountUid: uid, action: action === "edit" ? (newPassword?"編集・パスワード変更":"編集") : action === "deactivate" ? "無効化" : "再有効化", changes: accountChanges(before, update), passwordChanged:newPassword.length>0, reason, performedBy: authenticated.uid, performedByName: String(authenticated.profile.name ?? ""), performedAt: now });
  });
  const failure = rejected as { error: string; status: number } | null;
  if (failure) return NextResponse.json({ error: failure.error }, { status: failure.status });
  if(newPassword)await adminAuth!.updateUser(uid,{password:newPassword});
  return NextResponse.json({ ok: true, uid });
}

export async function DELETE(request:NextRequest,context:{params:Promise<{uid:string}>}){
  const authenticated=await authorize(request);if(!authenticated)return NextResponse.json({error:"本部管理者権限が必要です。"},{status:403});
  const {uid}=await context.params,body=await request.json().catch(()=>null) as Record<string,unknown>|null,reason=String(body?.reason??"").trim(),emailConfirmation=String(body?.emailConfirmation??"").trim();
  if(!uid||uid===authenticated.uid)return NextResponse.json({error:"現在ログイン中の自分自身は削除できません。"},{status:409});
  const ref=authenticated.db.collection("users").doc(uid),snapshot=await ref.get();if(!snapshot.exists)return NextResponse.json({error:"対象UIDを確認できません。"},{status:404});
  const account=snapshot.data(),email=String(account.email??"");if(!reason||!email||emailConfirmation!==email)return NextResponse.json({error:"修正理由と削除対象メールアドレスを確認してください。"},{status:400});
  if(account.role==="admin"){const admins=await authenticated.db.collection("users").where("role","==","admin").get(),activeAdmins=admins.docs.filter(doc=>{const data=doc.data();return data.status!=="inactive"&&data.isActive!==false;});if(activeAdmins.length<=1)return NextResponse.json({error:"最後の本部管理者は削除できません。"},{status:409});}
  const adminAuth=getAdminAuth(),adminDb=getAdminDb();if(!adminAuth||!adminDb)return NextResponse.json({error:"完全削除機能を利用できません。"},{status:503});
  try{await adminAuth.updateUser(uid,{disabled:true});await adminAuth.revokeRefreshTokens(uid);}catch{return NextResponse.json({error:"認証アカウントとセッションを無効化できなかったため、削除を開始していません。"},{status:502});}
  try{await adminDb.runTransaction(async transaction=>{transaction.set(adminDb.collection("auditLogs").doc(),{targetType:"managementAccount",targetUid:uid,action:"完全削除",accountSnapshot:{name:String(account.name??""),email,role:String(account.role??""),storeId:String(account.storeId??""),storeIds:Array.isArray(account.storeIds)?account.storeIds:[]},reason,performedBy:authenticated.uid,performedByName:String(authenticated.profile.name??""),performedAt:new Date()});transaction.delete(adminDb.collection("users").doc(uid));});}catch{await adminAuth.updateUser(uid,{disabled:false}).catch(()=>undefined);return NextResponse.json({error:"管理データを削除できなかったため、認証アカウントを再有効化しました。再度実行してください。"},{status:500});}
  try{await adminAuth.deleteUser(uid);}catch{return NextResponse.json({error:"管理データは削除済みですが認証アカウントは無効状態で残っています。対象UIDを指定して認証アカウント削除を再実行してください。"},{status:500});}
  return NextResponse.json({ok:true,uid});
}

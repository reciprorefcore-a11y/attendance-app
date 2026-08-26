import { NextRequest, NextResponse } from "next/server";
import { verifyUserToken } from "@/lib/firebase-rest";
import { getAdminAuth, getAdminDb } from "@/lib/firebase-admin";
import { getAdminInitializationErrorCode } from "@/lib/firebase-admin";
import { ACCOUNT_ROLES, accountChanges, isHeadquartersAdmin, type AccountRole } from "@/lib/account-management";
import { AccountDeleteError, deleteAdministratorAccount } from "@/lib/account-deletion";

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
  const authenticated=await verifyUserToken(request.headers.get("authorization"));
  if(!authenticated)return NextResponse.json({error:"認証が必要です",code:"AUTH_REQUIRED"},{status:401});
  if(!isHeadquartersAdmin(authenticated.profile))return NextResponse.json({error:"本部管理者のみ削除できます",code:"HQ_ADMIN_REQUIRED"},{status:403});
  const {uid}=await context.params,body=await request.json().catch(()=>null) as Record<string,unknown>|null;
  const adminAuth=getAdminAuth(),adminDb=getAdminDb();
  if(!adminAuth||!adminDb){const code=getAdminInitializationErrorCode()??"ADMIN_SDK_UNAVAILABLE";console.error(JSON.stringify({event:"account_delete_failed",errorCode:code,targetUid:uid,performedBy:authenticated.uid}));return NextResponse.json({error:"削除機能のサーバー設定を確認してください",code},{status:503});}
  try{
    const result=await deleteAdministratorAccount({targetUid:uid,confirmationEmail:String(body?.confirmationEmail??""),reason:String(body?.reason??""),performedBy:authenticated.uid},{
      now:()=>new Date(),
      getAccount:async targetUid=>{const snapshot=await adminDb.collection("users").doc(targetUid).get();if(!snapshot.exists)return null;const data=snapshot.data()!;return{uid:targetUid,name:String(data.name??""),email:String(data.email??""),role:String(data.role??""),storeIds:Array.isArray(data.storeIds)?data.storeIds.map(String):data.storeId?[String(data.storeId)]:[],status:String(data.status??""),isActive:data.isActive!==false,deletionStatus:String(data.deletionStatus??"")};},
      countActiveHqAdmins:async()=>{const admins=await adminDb.collection("users").where("role","in",["admin","hq_admin"]).get();return admins.docs.filter(doc=>{const data=doc.data();return data.status!=="inactive"&&data.isActive!==false;}).length;},
      getAuthEmail:async targetUid=>{try{return(await adminAuth.getUser(targetUid)).email??null;}catch(error){if((error as {code?:string}).code==="auth/user-not-found")return null;throw error;}},
      createAudit:async record=>{const ref=adminDb.collection("auditLogs").doc();await ref.create(record);return ref.id;},
      updateAudit:async(auditId,patch)=>{await adminDb.collection("auditLogs").doc(auditId).update(patch);},
      deleteAuthUser:targetUid=>adminAuth.deleteUser(targetUid),
      completeFirestoreDeletion:async(targetUid,auditId,patch)=>{await adminDb.runTransaction(async transaction=>{transaction.delete(adminDb.collection("users").doc(targetUid));transaction.update(adminDb.collection("auditLogs").doc(auditId),patch);});},
      markUserPending:async(targetUid,patch)=>{await adminDb.collection("users").doc(targetUid).set(patch,{merge:true});},
    });
    return NextResponse.json(result);
  }catch(error){
    const known=error instanceof AccountDeleteError,errorCode=known?error.code:"ACCOUNT_DELETE_UNEXPECTED",status=known?error.status:500,message=known?error.publicMessage:"削除に失敗しました。再度お試しください";
    console.error(JSON.stringify({event:"account_delete_failed",errorCode,targetUid:uid,performedBy:authenticated.uid}));
    return NextResponse.json({error:message,code:errorCode},{status});
  }
}

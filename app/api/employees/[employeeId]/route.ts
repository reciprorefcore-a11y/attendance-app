import { NextRequest, NextResponse } from "next/server";
import { verifyUserToken } from "@/lib/firebase-rest";
import { authorizeEmployeeManagement, buildEmployeeChanges, employeeActionUpdate, formatEmployeeReason, validateEmployeeReason, type EmployeeAction } from "@/lib/employee-management";

export const runtime = "nodejs";

export async function DELETE(request: NextRequest, context: { params: Promise<{ employeeId: string }> }) {
  const authenticated = await verifyUserToken(request.headers.get("authorization"));
  if (!authenticated) return NextResponse.json({ error: "削除権限がありません。" }, { status: 403 });
  const { employeeId } = await context.params;
  if (!employeeId) return NextResponse.json({ error: "従業員IDが必要です。" }, { status: 400 });

  const body=await request.json().catch(()=>null) as Record<string,unknown>|null;
  const reasonError=validateEmployeeReason(body?.reasonType,body?.reasonDetail);if(reasonError)return NextResponse.json({error:reasonError},{status:400});
  const employeeRef = authenticated.db.collection("employees").doc(employeeId);
  const rejection = await authenticated.db.runTransaction(async (transaction): Promise<{ error: string; status: number } | null> => {
    const employee = await transaction.get(employeeRef);
    if (!employee.exists) return { error: "従業員が見つかりません。", status: 404 };
    const authorization = authorizeEmployeeManagement(authenticated.profile, employee.data());
    if (!authorization.allowed) return { error: authorization.error, status: authorization.status };
    const now=new Date(),reason=formatEmployeeReason(body?.reasonType,body?.reasonDetail),update=employeeActionUpdate("delete",authenticated.uid,reason,now);
    transaction.update(employeeRef,update);transaction.set(employeeRef.collection("changeHistory").doc(),{employeeId,storeId:employee.data().storeId??"",action:"論理削除",changes:buildEmployeeChanges(employee.data(),update),effectiveFrom:body?.effectiveFrom??now.toISOString().slice(0,10),reason,performedBy:authenticated.uid,performedByName:String(authenticated.profile.name??""),performedByRole:String(authenticated.profile.role??""),performedAt:now});
    return null;
  });
  if (rejection) return NextResponse.json({ error: rejection.error }, { status: rejection.status });
  return NextResponse.json({ ok: true, employeeId });
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ employeeId: string }> }) {
  const authenticated = await verifyUserToken(request.headers.get("authorization"));
  if (!authenticated) return NextResponse.json({ error: "編集権限がありません。" }, { status: 403 });
  const { employeeId } = await context.params; const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!employeeId || !body) return NextResponse.json({ error: "入力形式が不正です。" }, { status: 400 });
  const reasonError=validateEmployeeReason(body.reasonType,body.reasonDetail);if(reasonError)return NextResponse.json({error:reasonError},{status:400});
  const action=String(body.action??"edit") as EmployeeAction;if(!["edit","deactivate","reactivate","delete","restore"].includes(action))return NextResponse.json({error:"操作が不正です。"},{status:400});
  const ref=authenticated.db.collection("employees").doc(employeeId);let rejection:{error:string;status:number}|null=null;
  await authenticated.db.runTransaction(async tx=>{const snapshot=await tx.get(ref);if(!snapshot.exists){rejection={error:"従業員が見つかりません。",status:404};return;}const before=snapshot.data(),authorization=authorizeEmployeeManagement(authenticated.profile,before);if(!authorization.allowed){rejection={error:authorization.error,status:authorization.status};return;}const reason=formatEmployeeReason(body.reasonType,body.reasonDetail),now=new Date();let payload:Record<string,unknown>;
    if(action==="edit"){const allowed=["name","nameKana","employeeCode","storeId","baseWage","lateNightHourlyWage","status","transportationCost","transportationType","payrollEnabled","clockEnabled"];payload={...Object.fromEntries(allowed.filter(key=>key in body).map(key=>[key,body[key]])),employeeType:"partTime",employmentType:"part_time",payrollType:"hourly",updatedAt:now,updatedBy:authenticated.uid};for(const key of ["baseWage","lateNightHourlyWage","transportationCost"])if(key in payload)payload[key]=Math.max(0,Math.trunc(Number(payload[key])||0));if(authenticated.profile.role==="manager"&&payload.storeId!==before.storeId){rejection={error:"managerは所属店舗を変更できません。",status:403};return;}if(typeof payload.employeeCode==="string"&&payload.employeeCode!==before.employeeCode){const duplicates=await tx.get(authenticated.db.collection("employees").where("employeeCode","==",payload.employeeCode).limit(1));if(!duplicates.empty){rejection={error:"同じ社員コードの従業員が既に登録されています。",status:409};return;}}}
    else payload=employeeActionUpdate(action,authenticated.uid,reason,now);
    const changes=buildEmployeeChanges(before,payload);const actionLabel={edit:"編集",deactivate:"無効化",reactivate:"再有効化",delete:"論理削除",restore:"復元"}[action];tx.update(ref,payload);tx.set(ref.collection("changeHistory").doc(),{employeeId,storeId:String(before.storeId??""),action:actionLabel,changes,effectiveFrom:String(body.effectiveFrom??now.toISOString().slice(0,10)),reason,performedBy:authenticated.uid,performedByName:String(authenticated.profile.name??""),performedByRole:String(authenticated.profile.role??""),performedAt:now});});
  const failed=rejection as {error:string;status:number}|null;if(failed)return NextResponse.json({error:failed.error},{status:failed.status});return NextResponse.json({ok:true,employeeId});
}

export async function GET(request:NextRequest,context:{params:Promise<{employeeId:string}>}){const authenticated=await verifyUserToken(request.headers.get("authorization"));if(!authenticated)return NextResponse.json({error:"閲覧権限がありません。"},{status:403});const {employeeId}=await context.params,ref=authenticated.db.collection("employees").doc(employeeId),employee=await ref.get();if(!employee.exists)return NextResponse.json({error:"従業員が見つかりません。"},{status:404});const authorization=authorizeEmployeeManagement(authenticated.profile,employee.data());if(!authorization.allowed)return NextResponse.json({error:authorization.error},{status:authorization.status});const history=await ref.collection("changeHistory").get(),rows:Record<string,unknown>[] =history.docs.map(doc=>{const data=doc.data() as Record<string,unknown>,changes=Array.isArray(data.changes)?data.changes.filter(change=>!(change&&typeof change==="object"&&"field" in change&&(change as {field?:unknown}).field==="pin")):[];return {id:doc.id,...data,changes};});return NextResponse.json({employeeId,history:rows.sort((a,b)=>String(b.performedAt??"").localeCompare(String(a.performedAt??"")))});}

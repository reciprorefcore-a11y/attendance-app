export type AccountDeleteCode=
  |"ACCOUNT_NOT_FOUND"|"AUTH_ACCOUNT_NOT_FOUND"|"CONFIRMATION_EMAIL_MISMATCH"|"REASON_REQUIRED"
  |"SELF_DELETE_FORBIDDEN"|"LAST_HQ_ADMIN_FORBIDDEN"|"AUDIT_CREATE_FAILED"|"AUTH_DELETE_FAILED"
  |"FIRESTORE_DELETE_PENDING";

export class AccountDeleteError extends Error{
  readonly code:AccountDeleteCode;readonly status:number;readonly publicMessage:string;
  constructor(code:AccountDeleteCode,status:number,publicMessage:string){super(publicMessage);this.code=code;this.status=status;this.publicMessage=publicMessage;this.name="AccountDeleteError";}
}

export type DeletionAccount={uid:string;name:string;email:string;role:string;storeIds:string[];status?:string;isActive?:boolean;deletionStatus?:string};
export type AccountDeletionDeps={
  now:()=>Date;
  getAccount:(uid:string)=>Promise<DeletionAccount|null>;
  countActiveHqAdmins:()=>Promise<number>;
  getAuthEmail:(uid:string)=>Promise<string|null>;
  createAudit:(record:Record<string,unknown>)=>Promise<string>;
  updateAudit:(auditId:string,patch:Record<string,unknown>)=>Promise<void>;
  deleteAuthUser:(uid:string)=>Promise<void>;
  deleteUserRecord:(uid:string)=>Promise<void>;
  markUserPending:(uid:string,patch:Record<string,unknown>)=>Promise<void>;
};

export async function deleteAdministratorAccount(input:{targetUid:string;confirmationEmail:string;reason:string;performedBy:string},deps:AccountDeletionDeps){
  const reason=input.reason.trim();
  if(!reason)throw new AccountDeleteError("REASON_REQUIRED",400,"削除理由を入力してください");
  if(input.targetUid===input.performedBy)throw new AccountDeleteError("SELF_DELETE_FORBIDDEN",409,"現在ログイン中のアカウントは削除できません");
  const account=await deps.getAccount(input.targetUid);
  if(!account)throw new AccountDeleteError("ACCOUNT_NOT_FOUND",404,"対象アカウントが見つかりません");
  if(account.role==="admin"||account.role==="hq_admin"){
    if(await deps.countActiveHqAdmins()<=1)throw new AccountDeleteError("LAST_HQ_ADMIN_FORBIDDEN",409,"最後の本部管理者は削除できません");
  }
  const authAlreadyDeleted=account.deletionStatus==="auth_deleted_firestore_pending";
  const authEmail=authAlreadyDeleted?account.email:await deps.getAuthEmail(input.targetUid);
  if(!authEmail)throw new AccountDeleteError("AUTH_ACCOUNT_NOT_FOUND",404,"認証アカウントが見つかりません");
  if(input.confirmationEmail!==authEmail)throw new AccountDeleteError("CONFIRMATION_EMAIL_MISMATCH",400,"確認用メールアドレスが一致しません");
  const plannedAt=deps.now(),auditRecord={action:"account_deleted",status:"planned",targetUid:account.uid,targetName:account.name,targetEmail:account.email,previousRole:account.role,previousStoreIds:account.storeIds,reason,performedBy:input.performedBy,performedAt:plannedAt};
  let auditId:string;
  try{auditId=await deps.createAudit(auditRecord);}catch{throw new AccountDeleteError("AUDIT_CREATE_FAILED",500,"削除に失敗しました。再度お試しください");}
  if(!authAlreadyDeleted){
    try{await deps.deleteAuthUser(input.targetUid);await deps.updateAudit(auditId,{status:"auth_deleted",authDeletedAt:deps.now()});}
    catch{await deps.updateAudit(auditId,{status:"auth_delete_failed",errorCode:"AUTH_DELETE_FAILED",failedAt:deps.now()}).catch(()=>undefined);throw new AccountDeleteError("AUTH_DELETE_FAILED",502,"削除に失敗しました。再度お試しください");}
  }
  try{await deps.deleteUserRecord(input.targetUid);await deps.updateAudit(auditId,{status:"completed",completedAt:deps.now()});}
  catch{
    await deps.markUserPending(input.targetUid,{deletionStatus:"auth_deleted_firestore_pending",isActive:false,status:"inactive",deletionAuditId:auditId,updatedAt:deps.now()}).catch(()=>undefined);
    await deps.updateAudit(auditId,{status:"firestore_pending",errorCode:"FIRESTORE_DELETE_PENDING",failedAt:deps.now()}).catch(()=>undefined);
    throw new AccountDeleteError("FIRESTORE_DELETE_PENDING",500,"削除に失敗しました。再度お試しください");
  }
  return{ok:true,uid:input.targetUid,auditId};
}

import { isFullTimeEmployee, type EmployeeClassificationFields } from "./employee-classification.ts";

export const EMPLOYEE_REASON_OPTIONS = ["退職","長期休職","登録誤り","所属店舗変更","時給改定","交通費変更","本人申告","管理者確認","その他"] as const;
export type EmployeeAction = "edit"|"deactivate"|"reactivate"|"delete"|"restore";
export type EmployeeActor = {role?:unknown;storeId?:unknown;storeIds?:unknown;name?:unknown};
export type ManagedEmployee = EmployeeClassificationFields & {storeId?:string|null;status?:string|null;isActive?:boolean|null;[key:string]:unknown};
export type EmployeeChange = {field:string;label:string;before:unknown;after:unknown};

export function authorizeEmployeeManagement(actor:EmployeeActor,employee:ManagedEmployee){
  if(isFullTimeEmployee(employee))return {allowed:false as const,status:403,error:"正社員はアルバイト管理から操作できません。"};
  if(actor.role==="admin")return {allowed:true as const};
  const stores=actor.role==="manager"?[actor.storeId]:Array.isArray(actor.storeIds)?actor.storeIds:[];
  if(["manager","area_manager","fc_manager"].includes(String(actor.role))&&stores.includes(employee.storeId))return {allowed:true as const};
  return {allowed:false as const,status:403,error:"担当店舗以外の従業員は操作できません。"};
}

export function validateEmployeeReason(reasonType:unknown,reasonDetail:unknown){
  if(!EMPLOYEE_REASON_OPTIONS.includes(reasonType as typeof EMPLOYEE_REASON_OPTIONS[number]))return "修正理由を選択してください。";
  if(reasonType==="その他"&&!String(reasonDetail??"").trim())return "その他の理由詳細を入力してください。";
  return null;
}
export const formatEmployeeReason=(reasonType:unknown,reasonDetail:unknown)=>reasonType==="その他"?`その他：${String(reasonDetail).trim()}`:String(reasonType);

const labels:Record<string,string>={name:"氏名",nameKana:"ふりがな",employeeCode:"社員コード",storeId:"所属店舗",baseWage:"基本時給",lateNightHourlyWage:"深夜時給",transportationType:"交通費区分",transportationCost:"交通費金額",payrollEnabled:"給与対象",clockEnabled:"打刻対象",status:"status"};
export function buildEmployeeChanges(before:ManagedEmployee,after:Record<string,unknown>):EmployeeChange[]{
  return Object.entries(after).filter(([field,value])=>field!=="pin"&&before[field]!==value).map(([field,value])=>({field,label:labels[field]??field,before:before[field]??null,after:value??null}));
}
export function employeeActionUpdate(action:Exclude<EmployeeAction,"edit">,actorUid:string,reason:string,now:Date){
  if(action==="deactivate")return {status:"inactive",isActive:false,deactivatedAt:now,deactivatedBy:actorUid,deactivationReason:reason};
  if(action==="reactivate")return {status:"active",isActive:true,isDeleted:false,reactivatedAt:now,reactivatedBy:actorUid,reactivationReason:reason,employeeType:"partTime",employmentType:"part_time",payrollType:"hourly"};
  if(action==="delete")return {isDeleted:true,status:"inactive",isActive:false,deletedAt:now,deletedBy:actorUid,deletionReason:reason};
  return {isDeleted:false,status:"inactive",isActive:false,restoredAt:now,restoredBy:actorUid,restorationReason:reason,employeeType:"partTime",employmentType:"part_time",payrollType:"hourly"};
}
export function classifyPartTimeEmployee(employee:ManagedEmployee){
  if(employee.isDeleted===true)return "deleted" as const;
  if(employee.status==="inactive"||employee.isActive===false)return "inactive" as const;
  return "active" as const;
}

import { createRestorePreview, validateRestoreSelection, type BackupRecord, type BackupStatus, type ClockLogSnapshot, type RestorePreviewRequest, type RestorePreviewResult } from "./attendance-backups.ts";

export type BackupApiErrorCode = "BACKUP_SERVICE_NOT_CONFIGURED"|"PITR_NOT_ENABLED"|"BACKUP_NOT_FOUND"|"RESTORE_PRECONDITION_FAILED"|"PRE_RESTORE_BACKUP_FAILED"|"PAYROLL_PERIOD_CONFIRMED"|"FORBIDDEN";
export class BackupApiError extends Error { readonly code:BackupApiErrorCode;readonly status:number;constructor(code:BackupApiErrorCode,status:number,message:string){super(message);this.name="BackupApiError";this.code=code;this.status=status;} }
export type BackupOverview={configured:boolean;mockMode:boolean;pitr:{state:"not_configured"|"enabled"|"disabled"|"unavailable"};managedExport:{state:"not_configured"|"healthy"|"failed"|"unavailable"};lastSucceededAt:string|null;lastFailedAt:string|null;records:BackupRecord[];collection:"clockLogs"};

export const UNCONFIGURED_OVERVIEW:BackupOverview={configured:false,mockMode:false,pitr:{state:"not_configured"},managedExport:{state:"not_configured"},lastSucceededAt:null,lastFailedAt:null,records:[],collection:"clockLogs"};
export const FIXTURE_OVERVIEW:BackupOverview={configured:true,mockMode:true,pitr:{state:"enabled"},managedExport:{state:"healthy"},lastSucceededAt:"2026-08-26T18:00:00.000Z",lastFailedAt:"2026-08-20T18:00:00.000Z",collection:"clockLogs",records:[{id:"fixture-export-20260826",type:"managed_export",status:"succeeded",collection:"clockLogs",periodStart:"2026-08-25T15:00:00.000Z",periodEnd:"2026-08-26T14:59:59.999Z",count:128,destinationMasked:"gs://attendance-backups-…/clockLogs/2026-08-26",startedAt:"2026-08-26T18:00:00.000Z",completedAt:"2026-08-26T18:02:00.000Z",errorSummary:null}]};

export function backupMode(env:NodeJS.ProcessEnv=process.env){
  const production=env.NODE_ENV==="production"||env.VERCEL_ENV==="production";
  return !production&&env.ATTENDANCE_BACKUP_FIXTURE_MODE==="enabled"?"fixture" as const:"unconfigured" as const;
}
export function getBackupOverview(mode:ReturnType<typeof backupMode>):BackupOverview{return mode==="fixture"?FIXTURE_OVERVIEW:UNCONFIGURED_OVERVIEW;}
export function requestBackupRun(mode:ReturnType<typeof backupMode>){if(mode!=="fixture")throw new BackupApiError("BACKUP_SERVICE_NOT_CONFIGURED",503,"Cloud設定前のため実行できません");return {ok:true,simulated:true,status:"queued" as BackupStatus,writeCount:0};}
export function requestRestorePreview(mode:ReturnType<typeof backupMode>,request:RestorePreviewRequest){if(mode!=="fixture")throw new BackupApiError("BACKUP_SERVICE_NOT_CONFIGURED",503,"Cloud設定前のため実行できません");return createRestorePreview(request);}
export function requestRestore(mode:ReturnType<typeof backupMode>,input:{preview:RestorePreviewResult;current:ClockLogSnapshot[];selectedDocumentIds:string[];preRestoreBackupStatus:BackupStatus}){
  if(mode!=="fixture")throw new BackupApiError("BACKUP_SERVICE_NOT_CONFIGURED",503,"復元サービスが未接続です");
  const result=validateRestoreSelection(input);if(!result.ok)throw new BackupApiError(result.code,409,result.code==="PRE_RESTORE_BACKUP_FAILED"?"復元直前バックアップが完了していません":"プレビュー後に現在状態が変化したか、対象選択が不正です");
  return {ok:true,simulated:true,validatedPaths:result.documentPaths,writeCount:0,payrollRecalculation:false,auditPlanned:{collection:"auditLogs",action:"attendance_restore_planned"}};
}

export function publicBackupError(error:unknown){if(error instanceof BackupApiError)return {status:error.status,body:{error:error.message,code:error.code}};return {status:500,body:{error:"バックアップ処理に失敗しました",code:"BACKUP_SERVICE_NOT_CONFIGURED"}};}

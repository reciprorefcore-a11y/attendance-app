import {createHash} from "node:crypto";

export const BACKUP_SCHEMA_VERSION=1 as const;
export const BACKUP_COLLECTION="clockLogs" as const;
export const BACKUP_TIMEZONE="Asia/Tokyo" as const;
export const BACKUP_PAGE_SIZE=500;
const SECRET_KEY=/^(pin|password|passwordHash|token|accessToken|refreshToken|secret|privateKey)$/i;

export type SerializedTimestamp={__type:"firestore_timestamp";seconds:number;nanoseconds:number};
export type BackupDocument={id:string;data:Record<string,unknown>};
export type ClockLogBackup={schemaVersion:1;projectId:string;collection:"clockLogs";backupDate:string;timezone:"Asia/Tokyo";periodStart:string;periodEnd:string;createdAt:string;documentCount:number;documents:BackupDocument[];payloadSha256:string};
export type BackupCursor={timestamp:unknown;id:string};
export type BackupPage={documents:BackupDocument[];nextCursor:BackupCursor|null};
export type StoredObject={generation:string;size:number;sha256:string};
export type ExistingBackup={name:string;documentCount:number;generation:string}|null;
export type BackupPeriod={backupDate:string;targetMonth:string;periodStart:Date;periodEnd:Date;periodStartText:string;endExclusive:boolean;emptyIsNormal:boolean};
export type BackupDependencies={
 projectId:string;
 acquireLock:(lockKey:string,expiresAt:string)=>Promise<{generation:string}>;
 releaseLock:(lockKey:string,generation:string)=>Promise<void>;
 readPage:(input:{periodStart:Date;periodEnd:Date;endExclusive:boolean;after:BackupCursor|null;limit:number})=>Promise<BackupPage>;
 readLatestBackup:(month:string,excludeDate:string)=>Promise<ExistingBackup>;
 readFormalBackup:(name:string)=>Promise<ExistingBackup>;
 uploadTemporary:(name:string,content:Buffer,sha256:string)=>Promise<StoredObject>;
 verifyTemporary:(name:string,expected:StoredObject)=>Promise<boolean>;
 promoteTemporary:(temporaryName:string,formalName:string,formalGeneration:string|null)=>Promise<void>;
 deleteTemporary:(name:string)=>Promise<void>;
 log:(event:{status:"succeeded"|"failed"|"warning";backupDate:string;targetMonth:string;documentCount?:number;periodStart:string;periodEnd:string;code?:string})=>void;
};

function timestampParts(value:unknown):{seconds:number;nanoseconds:number}|null{
 if(value instanceof Date)return Number.isNaN(value.getTime())?null:{seconds:Math.floor(value.getTime()/1000),nanoseconds:(value.getTime()%1000)*1_000_000};
 if(!value||typeof value!=="object")return null;
 const item=value as {seconds?:unknown;nanoseconds?:unknown;_seconds?:unknown;_nanoseconds?:unknown;toDate?:()=>Date};
 const seconds=typeof item.seconds==="number"?item.seconds:item._seconds,nanos=typeof item.nanoseconds==="number"?item.nanoseconds:item._nanoseconds;
 if(typeof seconds==="number")return {seconds,nanoseconds:typeof nanos==="number"?nanos:0};
 if(typeof item.toDate==="function")return timestampParts(item.toDate());
 return null;
}

export function serializeBackupValue(value:unknown):unknown{
 const parts=timestampParts(value);if(parts)return {__type:"firestore_timestamp",...parts} satisfies SerializedTimestamp;
 if(Array.isArray(value))return value.map(serializeBackupValue);
 if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value as Record<string,unknown>).filter(([key])=>!SECRET_KEY.test(key)).map(([key,item])=>[key,serializeBackupValue(item)]));
 return value;
}

export function sanitizeBackupDocument(document:BackupDocument):BackupDocument{
 if(!document.id||document.id.includes("/")||document.id==="."||document.id==="..")throw new Error("INVALID_DOCUMENT_ID");
 return {id:document.id,data:serializeBackupValue(document.data) as Record<string,unknown>};
}

function japanParts(now:Date){const entries=new Intl.DateTimeFormat("en-CA",{timeZone:BACKUP_TIMEZONE,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(now);const part=(type:string)=>entries.find(item=>item.type===type)?.value??"";return {year:Number(part("year")),month:Number(part("month")),day:part("day")};}
function monthText(year:number,month:number){return `${year}-${String(month).padStart(2,"0")}`;}
export function backupPeriods(now:Date):BackupPeriod[]{
 const parts=japanParts(now),backupDate=`${monthText(parts.year,parts.month)}-${parts.day}`,currentMonth=monthText(parts.year,parts.month),previousDate=new Date(Date.UTC(parts.year,parts.month-2,1)),previousMonth=monthText(previousDate.getUTCFullYear(),previousDate.getUTCMonth()+1),currentStartText=`${currentMonth}-01T00:00:00+09:00`,previousStartText=`${previousMonth}-01T00:00:00+09:00`,currentStart=new Date(currentStartText);
 return [
  {backupDate,targetMonth:previousMonth,periodStart:new Date(previousStartText),periodEnd:currentStart,periodStartText:previousStartText,endExclusive:true,emptyIsNormal:false},
  {backupDate,targetMonth:currentMonth,periodStart:currentStart,periodEnd:new Date(now),periodStartText:currentStartText,endExclusive:false,emptyIsNormal:true},
 ];
}
export function backupWindow(now:Date){const current=backupPeriods(now)[1];return {...current,month:current.targetMonth};}
export function formalObjectName(targetMonth:string,backupDate?:string){const date=backupDate??targetMonth;return `attendance-backups/${targetMonth.slice(0,7)}/clockLogs-${date}.json`;}
export function temporaryObjectName(targetMonth:string,backupDate:string,executionId?:string){const id=executionId??backupDate;return `attendance-backups/.tmp/${backupDate}/${targetMonth}-clockLogs-${id}.json`;}
export function sha256(content:Buffer|string){return createHash("sha256").update(content).digest("hex");}
export function calculateBackupPayloadHash(backup:Omit<ClockLogBackup,"payloadSha256">|ClockLogBackup){const payload={...backup} as Partial<ClockLogBackup>;delete payload.payloadSha256;return sha256(JSON.stringify(payload));}

export class BackupJobError extends Error{readonly code:string;constructor(code:string){super(code);this.name="BackupJobError";this.code=code;}}

export async function runClockLogBackupPeriod(deps:BackupDependencies,period:BackupPeriod,now:Date,executionId:string){
 const periodStart=period.periodStart.toISOString(),periodEnd=period.periodEnd.toISOString(),lockKey=`${period.backupDate}-${period.targetMonth}`,lock=await deps.acquireLock(lockKey,new Date(now.getTime()+2*60*60*1000).toISOString());let temporaryName:string|null=null;
 try{
  const documents:BackupDocument[]=[];let after:BackupCursor|null=null;
  do{const page=await deps.readPage({periodStart:period.periodStart,periodEnd:period.periodEnd,endExclusive:period.endExclusive,after,limit:BACKUP_PAGE_SIZE});documents.push(...page.documents.map(sanitizeBackupDocument));after=page.nextCursor;}while(after);
  if(documents.length===0){if(period.emptyIsNormal){deps.log({status:"succeeded",backupDate:period.backupDate,targetMonth:period.targetMonth,documentCount:0,periodStart,periodEnd,code:"EMPTY_CURRENT_MONTH_SKIPPED"});return {backupDate:period.backupDate,targetMonth:period.targetMonth,documentCount:0,formalName:null,skipped:true};}throw new BackupJobError("EMPTY_BACKUP");}
  const formalName=formalObjectName(period.targetMonth,period.backupDate),previous=await deps.readLatestBackup(period.targetMonth,period.backupDate),currentFormal=await deps.readFormalBackup(formalName),comparisonCount=Math.max(previous?.documentCount??0,currentFormal?.documentCount??0);
  if(documents.length<comparisonCount)throw new BackupJobError("DOCUMENT_COUNT_DECREASED");
  const payload={schemaVersion:BACKUP_SCHEMA_VERSION,projectId:deps.projectId,collection:BACKUP_COLLECTION,backupDate:period.backupDate,timezone:BACKUP_TIMEZONE,periodStart:period.periodStartText,periodEnd,createdAt:now.toISOString(),documentCount:documents.length,documents} as const;
  const backup:ClockLogBackup={...payload,payloadSha256:calculateBackupPayloadHash(payload)},content=Buffer.from(`${JSON.stringify(backup)}\n`,"utf8"),digest=sha256(content);temporaryName=temporaryObjectName(period.targetMonth,period.backupDate,executionId);
  const stored=await deps.uploadTemporary(temporaryName,content,digest);
  if(stored.size!==content.byteLength||stored.sha256!==digest||!await deps.verifyTemporary(temporaryName,stored))throw new BackupJobError("TEMPORARY_UPLOAD_VERIFICATION_FAILED");
  await deps.promoteTemporary(temporaryName,formalName,currentFormal?.generation??null);
  await deps.deleteTemporary(temporaryName);temporaryName=null;
  deps.log({status:"succeeded",backupDate:period.backupDate,targetMonth:period.targetMonth,documentCount:documents.length,periodStart,periodEnd});
  return {backupDate:period.backupDate,targetMonth:period.targetMonth,documentCount:documents.length,formalName,skipped:false};
 }catch(error){const code=error instanceof BackupJobError?error.code:"BACKUP_FAILED";deps.log({status:code==="DOCUMENT_COUNT_DECREASED"?"warning":"failed",backupDate:period.backupDate,targetMonth:period.targetMonth,periodStart,periodEnd,code});throw error;
 }finally{await deps.releaseLock(lockKey,lock.generation);}
}

export async function runClockLogBackups(deps:BackupDependencies,now:Date,executionId:string){
 const results:Awaited<ReturnType<typeof runClockLogBackupPeriod>>[]=[],errors:unknown[]=[];
 for(const period of backupPeriods(now)){try{results.push(await runClockLogBackupPeriod(deps,period,now,executionId));}catch(error){errors.push(error);}}
 if(errors.length)throw new BackupJobError("ONE_OR_MORE_PERIODS_FAILED");
 return results;
}

export async function runClockLogBackup(deps:BackupDependencies,now:Date,executionId:string){return runClockLogBackupPeriod(deps,backupPeriods(now)[1],now,executionId);}

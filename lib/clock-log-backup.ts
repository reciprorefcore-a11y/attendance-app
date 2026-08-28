import {createHash} from "node:crypto";

export const BACKUP_SCHEMA_VERSION=1 as const;
export const BACKUP_COLLECTION="clockLogs" as const;
export const BACKUP_TIMEZONE="Asia/Tokyo" as const;
export const BACKUP_PAGE_SIZE=500;
const SECRET_KEY=/^(pin|password|passwordHash|token|accessToken|refreshToken|secret|privateKey)$/i;

export type SerializedTimestamp={__type:"firestore_timestamp";seconds:number;nanoseconds:number};
export type BackupDocument={id:string;data:Record<string,unknown>};
export type ClockLogBackup={schemaVersion:1;projectId:string;collection:"clockLogs";backupDate:string;timezone:"Asia/Tokyo";periodStart:string;periodEnd:string;createdAt:string;documentCount:number;documents:BackupDocument[]};
export type BackupCursor={timestamp:unknown;id:string};
export type BackupPage={documents:BackupDocument[];nextCursor:BackupCursor|null};
export type StoredObject={generation:string;size:number;sha256:string};
export type ExistingBackup={name:string;documentCount:number;generation:string}|null;
export type BackupDependencies={
 projectId:string;
 acquireLock:(backupDate:string,expiresAt:string)=>Promise<{generation:string}>;
 releaseLock:(backupDate:string,generation:string)=>Promise<void>;
 readPage:(input:{periodStart:Date;periodEnd:Date;after:BackupCursor|null;limit:number})=>Promise<BackupPage>;
 readLatestBackup:(month:string,excludeDate:string)=>Promise<ExistingBackup>;
 readFormalBackup:(name:string)=>Promise<ExistingBackup>;
 uploadTemporary:(name:string,content:Buffer,sha256:string)=>Promise<StoredObject>;
 verifyTemporary:(name:string,expected:StoredObject)=>Promise<boolean>;
 promoteTemporary:(temporaryName:string,formalName:string,formalGeneration:string|null)=>Promise<void>;
 deleteTemporary:(name:string)=>Promise<void>;
 log:(event:{status:"succeeded"|"failed"|"warning";backupDate:string;documentCount?:number;periodStart:string;periodEnd:string;code?:string})=>void;
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

function japanParts(now:Date){const entries=new Intl.DateTimeFormat("en-CA",{timeZone:BACKUP_TIMEZONE,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(now);const part=(type:string)=>entries.find(item=>item.type===type)?.value??"";return {year:part("year"),month:part("month"),day:part("day")};}
export function backupWindow(now:Date){const {year,month,day}=japanParts(now),backupDate=`${year}-${month}-${day}`;return {backupDate,month:`${year}-${month}`,periodStart:new Date(`${year}-${month}-01T00:00:00+09:00`),periodEnd:new Date(now),periodStartText:`${year}-${month}-01T00:00:00+09:00`};}
export function formalObjectName(backupDate:string){return `attendance-backups/${backupDate.slice(0,7)}/clockLogs-${backupDate}.json`;}
export function temporaryObjectName(backupDate:string,executionId:string){return `attendance-backups/.tmp/${backupDate}/clockLogs-${executionId}.json`;}
export function sha256(content:Buffer|string){return createHash("sha256").update(content).digest("hex");}

export class BackupJobError extends Error{readonly code:string;constructor(code:string){super(code);this.name="BackupJobError";this.code=code;}}

export async function runClockLogBackup(deps:BackupDependencies,now:Date,executionId:string){
 const window=backupWindow(now),periodStart=window.periodStart.toISOString(),periodEnd=window.periodEnd.toISOString(),lock=await deps.acquireLock(window.backupDate,new Date(now.getTime()+2*60*60*1000).toISOString());let temporaryName:string|null=null;
 try{
  const documents:BackupDocument[]=[];let after:BackupCursor|null=null;
  do{const page=await deps.readPage({periodStart:window.periodStart,periodEnd:window.periodEnd,after,limit:BACKUP_PAGE_SIZE});documents.push(...page.documents.map(sanitizeBackupDocument));after=page.nextCursor;}while(after);
  if(documents.length===0)throw new BackupJobError("EMPTY_BACKUP");
  const formalName=formalObjectName(window.backupDate),previous=await deps.readLatestBackup(window.month,window.backupDate),currentFormal=await deps.readFormalBackup(formalName),comparisonCount=Math.max(previous?.documentCount??0,currentFormal?.documentCount??0);
  if(documents.length<comparisonCount)throw new BackupJobError("DOCUMENT_COUNT_DECREASED");
  const backup:ClockLogBackup={schemaVersion:BACKUP_SCHEMA_VERSION,projectId:deps.projectId,collection:BACKUP_COLLECTION,backupDate:window.backupDate,timezone:BACKUP_TIMEZONE,periodStart:window.periodStartText,periodEnd,createdAt:now.toISOString(),documentCount:documents.length,documents};
  const content=Buffer.from(`${JSON.stringify(backup)}\n`,"utf8"),digest=sha256(content);temporaryName=temporaryObjectName(window.backupDate,executionId);
  const stored=await deps.uploadTemporary(temporaryName,content,digest);
  if(stored.size!==content.byteLength||stored.sha256!==digest||!await deps.verifyTemporary(temporaryName,stored))throw new BackupJobError("TEMPORARY_UPLOAD_VERIFICATION_FAILED");
  await deps.promoteTemporary(temporaryName,formalName,currentFormal?.generation??null);
  await deps.deleteTemporary(temporaryName);temporaryName=null;
  deps.log({status:"succeeded",backupDate:window.backupDate,documentCount:documents.length,periodStart,periodEnd});
  return {backupDate:window.backupDate,documentCount:documents.length,formalName};
 }catch(error){const code=error instanceof BackupJobError?error.code:"BACKUP_FAILED";deps.log({status:code==="DOCUMENT_COUNT_DECREASED"?"warning":"failed",backupDate:window.backupDate,periodStart,periodEnd,code});throw error;
 }finally{await deps.releaseLock(window.backupDate,lock.generation);}
}

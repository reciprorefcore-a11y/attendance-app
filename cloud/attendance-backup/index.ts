import {randomUUID} from "node:crypto";
import {applicationDefault,initializeApp} from "firebase-admin/app";
import {FieldPath,getFirestore,Timestamp} from "firebase-admin/firestore";
import {getStorage} from "firebase-admin/storage";
import {runClockLogBackups,type BackupDependencies,type BackupDocument,type BackupCursor} from "../../lib/clock-log-backup.ts";
import {validateBackupFile} from "../../lib/clock-log-restore.ts";

const projectId=process.env.GOOGLE_CLOUD_PROJECT??process.env.GCLOUD_PROJECT??"";
const bucketName=process.env.ATTENDANCE_BACKUP_BUCKET??"";
if(!projectId||!bucketName)throw new Error("BACKUP_CONFIGURATION_MISSING");
initializeApp({credential:applicationDefault(),projectId,storageBucket:bucketName});
const db=getFirestore(),bucket=getStorage().bucket();

async function objectGeneration(name:string){try{const [metadata]=await bucket.file(name).getMetadata();return String(metadata.generation??"");}catch(error){if((error as {code?:number}).code===404)return null;throw error;}}
async function deleteAtGeneration(name:string,generation:string){await bucket.file(name).delete({ifGenerationMatch:Number(generation)});}

const deps:BackupDependencies={
 projectId,
 async acquireLock(lockKey,expiresAt){const name=`attendance-backups/.locks/${lockKey}.lock`,file=bucket.file(name),content=Buffer.from(JSON.stringify({expiresAt}),"utf8");try{await file.save(content,{resumable:false,preconditionOpts:{ifGenerationMatch:0},metadata:{contentType:"application/json",cacheControl:"no-store"}});}catch(error){if((error as {code?:number}).code!==412)throw error;const [existing]=await file.download(),lock=JSON.parse(existing.toString("utf8")) as {expiresAt?:string},[metadata]=await file.getMetadata();if(!lock.expiresAt||Date.parse(lock.expiresAt)>Date.now())throw new Error("BACKUP_ALREADY_RUNNING");await deleteAtGeneration(name,String(metadata.generation));await file.save(content,{resumable:false,preconditionOpts:{ifGenerationMatch:0},metadata:{contentType:"application/json",cacheControl:"no-store"}});}const [metadata]=await file.getMetadata();return {generation:String(metadata.generation)};},
 async releaseLock(lockKey,generation){await deleteAtGeneration(`attendance-backups/.locks/${lockKey}.lock`,generation).catch(()=>undefined);},
 async readPage({periodStart,periodEnd,endExclusive,after,limit}){let query=db.collection("clockLogs").where("timestamp",">=",Timestamp.fromDate(periodStart)).where("timestamp",endExclusive?"<":"<=",Timestamp.fromDate(periodEnd)).orderBy("timestamp").orderBy(FieldPath.documentId()).limit(limit);if(after)query=query.startAfter(after.timestamp,after.id);const snapshot=await query.get(),documents:BackupDocument[]=snapshot.docs.map(document=>({id:document.id,data:document.data()})),last=snapshot.docs.at(-1);const nextCursor:BackupCursor|null=snapshot.size===limit&&last?{timestamp:last.get("timestamp"),id:last.id}:null;return {documents,nextCursor};},
 async readLatestBackup(month,excludeDate){const [files]=await bucket.getFiles({prefix:`attendance-backups/${month}/clockLogs-`});const candidates=files.filter(file=>file.name.endsWith(".json")&&!file.name.endsWith(`clockLogs-${excludeDate}.json`)).sort((a,b)=>b.name.localeCompare(a.name));if(!candidates[0])return null;const [content]=await candidates[0].download(),parsed=validateBackupFile(JSON.parse(content.toString("utf8")),projectId),[metadata]=await candidates[0].getMetadata();return {name:candidates[0].name,documentCount:parsed.documentCount,generation:String(metadata.generation)};},
 async readFormalBackup(name){const generation=await objectGeneration(name);if(!generation)return null;const [content]=await bucket.file(name).download(),parsed=validateBackupFile(JSON.parse(content.toString("utf8")),projectId);return{name,documentCount:parsed.documentCount,generation};},
 async uploadTemporary(name,content,sha256){const file=bucket.file(name);await file.save(content,{resumable:false,preconditionOpts:{ifGenerationMatch:0},metadata:{contentType:"application/json; charset=utf-8",cacheControl:"no-store",metadata:{sha256}}});const [metadata]=await file.getMetadata();return {generation:String(metadata.generation),size:Number(metadata.size),sha256:String(metadata.metadata?.sha256??"")};},
 async verifyTemporary(name,expected){const [metadata]=await bucket.file(name).getMetadata();return String(metadata.generation)===expected.generation&&Number(metadata.size)===expected.size&&String(metadata.metadata?.sha256??"")===expected.sha256;},
 async promoteTemporary(temporaryName,formalName,formalGeneration){await bucket.file(temporaryName).copy(bucket.file(formalName),{preconditionOpts:{ifGenerationMatch:formalGeneration===null?0:Number(formalGeneration)}});},
 async deleteTemporary(name){const generation=await objectGeneration(name);if(generation)await deleteAtGeneration(name,generation);},
 log(event){console.log(JSON.stringify(event));},
};

try{await runClockLogBackups(deps,new Date(),randomUUID());}catch{console.error(JSON.stringify({status:"failed",code:"JOB_EXECUTION_FAILED"}));process.exitCode=1;}

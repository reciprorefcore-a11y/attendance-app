import {readFile} from "node:fs/promises";
import {applicationDefault,initializeApp} from "firebase-admin/app";
import {getFirestore,Timestamp} from "firebase-admin/firestore";
import {buildRestoreWrites,createRestoreDiff,summarizeRestore,validateBackupFile} from "../lib/clock-log-restore.ts";
import type {BackupDocument,SerializedTimestamp} from "../lib/clock-log-backup.ts";

const args=process.argv.slice(2),filePath=args.find(value=>!value.startsWith("--")),apply=args.includes("--apply"),idsArg=args.find(value=>value.startsWith("--ids=")),currentFixtureArg=args.find(value=>value.startsWith("--current-fixture="));
const projectId=process.env.GOOGLE_CLOUD_PROJECT??process.env.GCLOUD_PROJECT??"";
if(!filePath||!projectId)throw new Error("Usage: GOOGLE_CLOUD_PROJECT=... node scripts/restore-clock-logs.ts backup.json [--apply --ids=id1,id2]");
const backup=validateBackupFile(JSON.parse(await readFile(filePath,"utf8")) as unknown,projectId);
if(currentFixtureArg&&apply)throw new Error("FIXTURE_APPLY_FORBIDDEN");
let db:ReturnType<typeof getFirestore>|null=null,current:BackupDocument[];
if(currentFixtureArg){const fixture=JSON.parse(await readFile(currentFixtureArg.slice("--current-fixture=".length),"utf8")) as {documents?:BackupDocument[]};current=fixture.documents??[];}else{initializeApp({credential:applicationDefault(),projectId});db=getFirestore();const snapshot=await db.collection("clockLogs").where("timestamp",">=",Timestamp.fromDate(new Date(backup.periodStart))).where("timestamp","<=",Timestamp.fromDate(new Date(backup.periodEnd))).get();current=snapshot.docs.map(document=>({id:document.id,data:document.data()}));}
const diff=createRestoreDiff(backup,current),summary=summarizeRestore(diff),selectedIds=(idsArg?.slice(6).split(",").filter(Boolean))??[];
console.log(JSON.stringify({...summary,mode:apply?"apply":"dry-run",payrollRecalculation:false}));
const decode=(value:unknown):unknown=>{if(Array.isArray(value))return value.map(decode);if(value&&typeof value==="object"){const item=value as Partial<SerializedTimestamp>;if(item.__type==="firestore_timestamp"&&typeof item.seconds==="number"&&typeof item.nanoseconds==="number")return new Timestamp(item.seconds,item.nanoseconds);return Object.fromEntries(Object.entries(value as Record<string,unknown>).map(([key,nested])=>[key,decode(nested)]));}return value;};
const writes=buildRestoreWrites(diff,selectedIds,apply);
if(writes.length&&!db)throw new Error("FIRESTORE_NOT_INITIALIZED");
if(writes.length>400)throw new Error("RESTORE_SELECTION_TOO_LARGE");
if(writes.length){const batch=db!.batch();for(const write of writes){const id=write.path.slice("clockLogs/".length);batch.create(db!.collection("clockLogs").doc(id),decode(write.data) as Record<string,unknown>);}await batch.commit();}
if(apply)console.log(JSON.stringify({status:"completed",writeCount:writes.length,payrollRecalculation:false}));

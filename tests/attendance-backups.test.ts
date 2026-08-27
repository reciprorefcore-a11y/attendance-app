import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {BackupApiError,backupMode,getBackupOverview,requestBackupRun,requestRestore,requestRestorePreview} from "../lib/attendance-backup-api.ts";
import {createRestorePreview,validateRestoreSelection,type ClockLogSnapshot,type RestorePreviewRequest} from "../lib/attendance-backups.ts";

const stamp=(seconds:number)=>({seconds,nanoseconds:0});
const old:ClockLogSnapshot[]=[
 {id:"missing",data:{employeeId:"e1",employeeName:"青木",storeId:"s1",storeName:"本店",type:"in",timestamp:"2026-08-01T00:00:00.000Z",updatedAt:"2026-08-01T01:00:00Z"}},
 {id:"changed",data:{employeeId:"e1",storeId:"s1",type:"out",timestamp:"2026-08-01T09:00:00.000Z",note:"before"}},
 {id:"same",data:{employeeId:"e2",storeId:"s2",type:"in",timestamp:stamp(1785542400),updatedAt:"2026-08-01T01:00:00Z"}},
 {id:"dup-old",data:{employeeId:"e3",storeId:"s1",type:"break_start",timestamp:"2026-08-02T03:00:00.000Z",pin:"9999"}},
];
const current:ClockLogSnapshot[]=[
 {id:"changed",data:{employeeId:"e1",storeId:"s1",type:"out",timestamp:new Date("2026-08-01T09:00:00.000Z"),note:"after"}},
 {id:"same",data:{employeeId:"e2",storeId:"s2",type:"in",timestamp:"2026-08-01T00:00:00.000Z",updatedAt:"2026-08-09T01:00:00Z"}},
 {id:"dup-new",data:{employeeId:"e3",storeId:"s1",type:"break_start",timestamp:"2026-08-02T03:00:30.000Z",token:"secret"}},
 {id:"current-only",data:{employeeId:"e4",storeId:"s1",type:"in",timestamp:"2026-08-03T00:00:00.000Z"}},
];
const request=(patch:Partial<RestorePreviewRequest>={}):RestorePreviewRequest=>({backupId:"fixture",historical:old,current,periodStart:"2026-08-01T00:00:00.000Z",periodEnd:"2026-08-31T23:59:59.999Z",...patch});

test("missing/changed/unchanged/duplicate/current_onlyを分類する",()=>{const result=createRestorePreview(request());const kinds=Object.fromEntries(result.candidates.map(c=>[c.documentId,c.kind]));assert.deepEqual(kinds,{changed:"changed","current-only":"current_only","dup-old":"duplicate_suspected",missing:"missing",same:"unchanged"});});
test("Timestamp・Date・ISOを正規化しupdatedAtだけの差はunchanged",()=>{const result=createRestorePreview(request());const same=result.candidates.find(c=>c.documentId==="same")!;assert.equal(same.kind,"unchanged");assert.equal(same.historical?.timestamp,"2026-08-01T00:00:00.000Z");});
test("店舗・社員・期間で絞る",()=>{const result=createRestorePreview(request({storeIds:["s2"],employeeIds:["e2"],periodEnd:"2026-08-01T23:59:59.999Z"}));assert.deepEqual(result.candidates.map(c=>c.documentId),["same"]);});
test("確定済み給与月を警告し自動選択しない",()=>{const result=createRestorePreview(request({confirmedPayrollMonths:["2026-08"]}));assert.equal(result.payrollWarnings[0].month,"2026-08");assert.ok(result.candidates.every(c=>!c.selectedByDefault));});
test("duplicate_suspectedとcurrent_onlyは復元対象外",()=>{const result=createRestorePreview(request());assert.equal(result.candidates.find(c=>c.kind==="duplicate_suspected")?.selectedByDefault,false);assert.equal(result.candidates.find(c=>c.kind==="current_only")?.eligibility,"excluded");});
test("プレビュー後の現在値変更を拒否",()=>{const preview=createRestorePreview(request());const result=validateRestoreSelection({preview,current:[...current,{id:"later",data:{employeeId:"e5",storeId:"s1",type:"in",timestamp:"2026-08-04T00:00:00Z"}}],selectedDocumentIds:["missing"],preRestoreBackupStatus:"succeeded"});assert.deepEqual(result,{ok:false,code:"RESTORE_PRECONDITION_FAILED"});});
test("復元直前バックアップ失敗時は書込み0件",()=>{const preview=createRestorePreview(request());const result=validateRestoreSelection({preview,current,selectedDocumentIds:["missing"],preRestoreBackupStatus:"failed"});assert.deepEqual(result,{ok:false,code:"PRE_RESTORE_BACKUP_FAILED"});});
test("未設定ではrun/preview/restoreが503で停止",()=>{assert.throws(()=>requestBackupRun("unconfigured"),e=>e instanceof BackupApiError&&e.status===503);assert.throws(()=>requestRestorePreview("unconfigured",request()),e=>e instanceof BackupApiError&&e.status===503);const preview=createRestorePreview(request());assert.throws(()=>requestRestore("unconfigured",{preview,current,selectedDocumentIds:["missing"],preRestoreBackupStatus:"succeeded"}),e=>e instanceof BackupApiError&&e.status===503);assert.equal(getBackupOverview("unconfigured").records.length,0);});
test("fixtureはサーバー専用設定と非Productionの両方を要求する",()=>{assert.equal(backupMode({ATTENDANCE_BACKUP_FIXTURE_MODE:"enabled",NODE_ENV:"test"}),"fixture");assert.equal(backupMode({ATTENDANCE_BACKUP_FIXTURE_MODE:"enabled",NODE_ENV:"production"}),"unconfigured");assert.equal(backupMode({ATTENDANCE_BACKUP_FIXTURE_MODE:"enabled",NODE_ENV:"test",VERCEL_ENV:"production"}),"unconfigured");assert.equal(backupMode({NODE_ENV:"test"}),"unconfigured");assert.equal(backupMode({NEXT_PUBLIC_ATTENDANCE_BACKUP_FIXTURE_MODE:"enabled",NODE_ENV:"test"}),"unconfigured");});
test("mock restoreも検証のみで書込み0・給与再計算なし",()=>{const preview=createRestorePreview(request());const result=requestRestore("fixture",{preview,current,selectedDocumentIds:["missing"],preRestoreBackupStatus:"succeeded"});assert.equal(result.writeCount,0);assert.equal(result.payrollRecalculation,false);assert.deepEqual(result.validatedPaths,["clockLogs/missing"]);});
test("document IDをパスとして解釈せず任意階層を拒否",()=>{const forged=createRestorePreview(request());forged.candidates.push({...forged.candidates[0],documentId:"../users/target",kind:"missing",eligibility:"restorable"});assert.throws(()=>requestRestore("fixture",{preview:forged,current,selectedDocumentIds:["../users/target"],preRestoreBackupStatus:"succeeded"}),e=>e instanceof BackupApiError&&e.code==="RESTORE_PRECONDITION_FAILED");});
test("秘密情報を候補・レスポンスへ含めない",()=>{const body=JSON.stringify(createRestorePreview(request()));assert.doesNotMatch(body,/9999|secret|password|token/i);});
test("APIは本部管理者以外403、任意pathを受けず業務コレクションを操作しない",()=>{const files=["route.ts","run/route.ts","restore-preview/route.ts","restore/route.ts"].map(file=>readFileSync(new URL(`../app/api/hq/attendance-backups/${file}`,import.meta.url),"utf8")).join("\n");assert.match(files,/isHeadquartersAdmin[\s\S]*FORBIDDEN[\s\S]*status:403/);assert.doesNotMatch(files,/collectionName|firestorePath|recursiveDelete/);for(const name of ["employees","users","payrollRuns","payrollSettings"])assert.doesNotMatch(files,new RegExp(`collection\\(["']${name}`));assert.doesNotMatch(files,/payroll\/calculate|fetch\([^)]*payroll/);});

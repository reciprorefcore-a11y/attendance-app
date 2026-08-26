import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {AccountDeleteError,deleteAdministratorAccount,type AccountDeletionDeps,type DeletionAccount} from "../lib/account-deletion.ts";

const fixture=(options:{target?:Partial<DeletionAccount>;activeAdmins?:number;auditCreateFails?:boolean;authDeleteFails?:boolean;firestoreDeleteFails?:boolean}={})=>{
  const target:DeletionAccount={uid:"target-uid",name:"対象 管理者",email:"target@example.com",role:"manager",storeIds:["store-1"],status:"active",isActive:true,...options.target};
  const events:string[]=[],audits:Record<string,unknown>[]=[],users=new Map([[target.uid,target]]);
  const deps:AccountDeletionDeps={
    now:()=>new Date("2026-08-25T00:00:00.000Z"),getAccount:async uid=>users.get(uid)??null,countActiveHqAdmins:async()=>options.activeAdmins??2,
    getAuthEmail:async()=>target.email,createAudit:async record=>{events.push("audit:create");if(options.auditCreateFails)throw new Error("fixture audit failure");audits.push({...record});return"audit-1";},
    updateAudit:async(_id,patch)=>{events.push(`audit:${String(patch.status)}`);audits.push({...patch});},
    deleteAuthUser:async()=>{events.push("auth:delete");if(options.authDeleteFails)throw new Error("fixture auth failure");},
    completeFirestoreDeletion:async(uid,_auditId,patch)=>{events.push("firestore:delete");if(options.firestoreDeleteFails)throw new Error("fixture firestore failure");users.delete(uid);events.push(`audit:${String(patch.status)}`);audits.push({...patch});},
    markUserPending:async(uid,patch)=>{events.push("firestore:pending");users.set(uid,{...users.get(uid)!,...patch});},
  };
  return{target,events,audits,users,deps};
};
const run=(f:ReturnType<typeof fixture>,patch:Partial<{targetUid:string;confirmationEmail:string;reason:string;performedBy:string}>={})=>deleteAdministratorAccount({targetUid:f.target.uid,confirmationEmail:f.target.email,reason:"退職のため",performedBy:"hq-uid",...patch},f.deps);
const rejectsCode=async(promise:Promise<unknown>,code:string,status:number)=>{await assert.rejects(promise,error=>error instanceof AccountDeleteError&&error.code===code&&error.status===status);};

test("hq_adminはdeletion_started監査後にAuth、usersの順で削除しaccount_deletedへ更新する",async()=>{const f=fixture();await run(f);assert.deepEqual(f.events,["audit:create","auth:delete","audit:auth_deleted","firestore:delete","audit:completed"]);assert.equal(f.users.has(f.target.uid),false);assert.equal(f.audits[0].action,"deletion_started");assert.equal(f.audits.at(-1)?.action,"account_deleted");assert.equal(f.audits[0].targetUid,f.target.uid);});
test("managerはAPIで403となる構造を保持する",()=>{const route=readFileSync(new URL("../app/api/accounts/[uid]/route.ts",import.meta.url),"utf8");assert.match(route,/isHeadquartersAdmin[\s\S]*HQ_ADMIN_REQUIRED[\s\S]*status:403/);});
test("自分自身は409",async()=>{const f=fixture();await rejectsCode(run(f,{performedBy:f.target.uid}),"SELF_DELETE_FORBIDDEN",409);});
test("最後の本部管理者は409",async()=>{const f=fixture({target:{role:"hq_admin"},activeAdmins:1});await rejectsCode(run(f),"LAST_HQ_ADMIN_FORBIDDEN",409);});
test("メール不一致は400",async()=>{const f=fixture();await rejectsCode(run(f,{confirmationEmail:"wrong@example.com"}),"CONFIRMATION_EMAIL_MISMATCH",400);});
test("理由なしは400",async()=>{const f=fixture();await rejectsCode(run(f,{reason:"   "}),"REASON_REQUIRED",400);});
test("削除理由は空白除去後2文字以上必須",async()=>{const f=fixture();await rejectsCode(run(f,{reason:" a "}),"REASON_REQUIRED",400);assert.equal(f.events.length,0);});
test("auditLogs作成失敗時はAuthとusersの削除を開始しない",async()=>{const f=fixture({auditCreateFails:true});await rejectsCode(run(f),"AUDIT_CREATE_FAILED",500);assert.deepEqual(f.events,["audit:create"]);assert.equal(f.users.has(f.target.uid),true);});
test("Auth削除失敗時はusersを残す",async()=>{const f=fixture({authDeleteFails:true});await rejectsCode(run(f),"AUTH_DELETE_FAILED",502);assert.equal(f.users.has(f.target.uid),true);assert.equal(f.events.includes("firestore:delete"),false);});
test("Firestore削除失敗時はpending状態を保持して再実行可能",async()=>{const f=fixture({firestoreDeleteFails:true});await rejectsCode(run(f),"FIRESTORE_DELETE_PENDING",500);assert.equal(f.users.get(f.target.uid)?.deletionStatus,"auth_deleted_firestore_pending");assert.equal(f.users.get(f.target.uid)?.isActive,false);});
test("監査ログにパスワード・トークンを保存しない",async()=>{const f=fixture();await run(f);const audit=JSON.stringify(f.audits);assert.doesNotMatch(audit,/password|token|secret/i);for(const key of ["targetName","targetEmail","previousRole","previousStoreIds","reason","performedBy","performedAt"])assert.ok(key in f.audits[0]);});
test("フロントは二重処理を防止し完了後に一覧からuidを除く",()=>{const page=readFileSync(new URL("../app/hq/accounts/page.tsx",import.meta.url),"utf8");assert.match(page,/if\(!action\|\|working/);assert.match(page,/setAccounts\(current=>deleting\?current\.filter\(account=>account\.uid!==action\.account\.uid\)/);assert.match(page,/confirmationEmail:action\.emailConfirmation/);});
test("削除APIはusersとauditLogs以外の業務データを削除しない",()=>{const route=readFileSync(new URL("../app/api/accounts/[uid]/route.ts",import.meta.url),"utf8"),service=readFileSync(new URL("../lib/account-deletion.ts",import.meta.url),"utf8");for(const collection of ["employees","attendance","clockLogs","payrollRuns","payrollSettings"])assert.doesNotMatch(`${route}\n${service}`,new RegExp(`collection\\(\\"${collection}\\"\\)[\\s\\S]{0,120}delete`));});
test("削除確認は空欄開始・貼付可能・完全一致・理由2文字・対象4項目を要求する",()=>{const page=readFileSync(new URL("../app/hq/accounts/page.tsx",import.meta.url),"utf8");assert.match(page,/kind:"delete",reason:"",emailConfirmation:""/);assert.doesNotMatch(page,/onPaste|onCopy|preventDefault\(\)/);assert.match(page,/emailConfirmation!==action\.account\.email/);assert.match(page,/reason\.trim\(\)\.length<2/);for(const label of ["氏名","メール","権限","担当店舗"])assert.match(page,new RegExp(`<dt>${label}<\\/dt>`));});

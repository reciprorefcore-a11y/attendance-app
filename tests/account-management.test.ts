import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { accountChanges, isHeadquartersAdmin, sanitizeAccountRecord } from "../lib/account-management.ts";

const read=(path:string)=>readFileSync(new URL(path,import.meta.url),"utf8");

test("本部管理者だけがアカウント管理を利用できる",()=>{
  assert.equal(isHeadquartersAdmin({role:"admin"}),true);
  for(const role of ["manager","area_manager","fc_manager","staff"])assert.equal(isHeadquartersAdmin({role}),false);
  const admin=read("../app/admin/page.tsx"),page=read("../app/hq/accounts/page.tsx"),api=read("../app/api/accounts/route.ts"),update=read("../app/api/accounts/[uid]/route.ts");
  assert.match(admin,/isAdmin&&tab\.id==="employees"&&<Link href="\/hq\/accounts"/);
  assert.match(page,/profile\?\.role!=="admin"[\s\S]*403/);
  assert.match(api,/isHeadquartersAdmin[\s\S]*status: 403/);
  assert.match(update,/isHeadquartersAdmin[\s\S]*status: 403/);
});

test("従業員管理から旧アカウント一覧・作成フォーム・権限変更を撤去する",()=>{
  const admin=read("../app/admin/page.tsx");
  assert.doesNotMatch(admin,/アカウント管理（エリア・FCマネージャー）|新規アカウント追加|accountMgrForm|permissionModal|createUserWithEmailAndPassword|users コレクション/);
});

test("独立画面は一覧・新規・編集・履歴・状態操作をモーダルで提供する",()=>{
  const page=read("../app/hq/accounts/page.tsx");
  for(const text of ["アカウント管理","＋ アカウントを追加","基本情報","変更履歴","パスワード再設定","無効化","再有効化","メールアドレス変更は本部管理者による別操作"])assert.match(page,new RegExp(text));
  assert.doesNotMatch(page,/usersコレクション|users コレクション/);
});

test("パスワードはレスポンス・変更履歴・通常編集へ含めない",()=>{
  const safe=sanitizeAccountRecord("u1",{name:"管理者",email:"a@example.com",role:"manager",password:"secret",initialPassword:"secret"});
  assert.doesNotMatch(JSON.stringify(safe),/secret|password/i);
  const changes=accountChanges({}, {name:"管理者",password:"secret",initialPassword:"secret"});
  assert.deepEqual(changes,[{field:"name",before:null,after:"管理者"}]);
  const page=read("../app/hq/accounts/page.tsx");
  assert.match(page,/editor\.mode==="create"&&<label[^>]*>初期パスワード/);
});

test("アカウントAPIはemployeesを変更せずusersを物理削除しない",()=>{
  const sources=[read("../app/api/accounts/route.ts"),read("../app/api/accounts/[uid]/route.ts"),read("../app/api/accounts/[uid]/password-reset/route.ts")].join("\n");
  assert.doesNotMatch(sources,/collection\("employees"\)|transaction\.delete|\.delete\(ref/);
  assert.match(sources,/changeHistory/);
});

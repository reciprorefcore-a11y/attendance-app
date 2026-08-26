import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { accountChanges, isHeadquartersAdmin, sanitizeAccountRecord } from "../lib/account-management.ts";

const read=(path:string)=>readFileSync(new URL(path,import.meta.url),"utf8");

test("本部管理者だけがアカウント管理を利用できる",()=>{
  assert.equal(isHeadquartersAdmin({role:"admin"}),true);
  assert.equal(isHeadquartersAdmin({role:"hq_admin"}),true);
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
  for(const text of ["アカウント管理","＋ アカウントを追加","基本情報","変更履歴","パスワード再設定","無効化","再有効化"])assert.match(page,new RegExp(text));
  assert.doesNotMatch(page,/usersコレクション|users コレクション/);
});

test("パスワードはレスポンス・変更履歴・通常編集へ含めない",()=>{
  const safe=sanitizeAccountRecord("u1",{name:"管理者",email:"a@example.com",role:"manager",password:"secret",initialPassword:"secret"});
  assert.doesNotMatch(JSON.stringify(safe),/secret|password/i);
  const changes=accountChanges({}, {name:"管理者",password:"secret",initialPassword:"secret"});
  assert.deepEqual(changes,[{field:"name",before:null,after:"管理者"}]);
  const page=read("../app/hq/accounts/page.tsx");
  assert.match(page,/editor\.mode==="create"&&<Field label="初期パスワード"/);
});

test("アカウントAPIはemployeesを変更せず、完全削除は監査ログを保持する",()=>{
  const sources=[read("../app/api/accounts/route.ts"),read("../app/api/accounts/[uid]/route.ts"),read("../app/api/accounts/[uid]/password-reset/route.ts")].join("\n");
  assert.doesNotMatch(sources,/collection\("employees"\)/);
  assert.match(sources,/changeHistory/);
  assert.match(sources,/collection\("auditLogs"\)/);
  assert.match(sources,/targetUid:uid[\s\S]*performedBy:authenticated\.uid/);
  assert.match(sources,/countActiveHqAdmins/);
  assert.match(sources,/deleteAdministratorAccount/);
  assert.match(sources,/deleteAuthUser:targetUid=>adminAuth\.deleteUser\(targetUid\)/);
  assert.match(sources,/completeFirestoreDeletion:[\s\S]*transaction\.delete\(adminDb\.collection\("users"\)\.doc\(targetUid\)\)/);
});

test("編集時のパスワード上書きはAdmin SDKだけを使い秘密値を履歴へ残さない",()=>{
  const page=read("../app/hq/accounts/page.tsx"),route=read("../app/api/accounts/[uid]/route.ts");
  assert.match(page,/新しいパスワード（変更する場合のみ）/);
  assert.match(page,/現在のパスワードは安全上表示できません/);
  assert.match(page,/passwordConfirmation/);
  assert.match(page,/showPassword/);
  assert.match(page,/editor\.form\.newPassword\?"変更あり":"変更なし"/);
  assert.match(page,/削除対象のメールアドレス/);
  assert.match(page,/変更前権限/);
  assert.match(page,/変更後担当店舗/);
  assert.match(route,/adminAuth!\.updateUser\(uid,\{password:newPassword\}\)/);
  const updateLiteral=route.match(/update = \{ name:[^;]+/)?.[0]??"";
  assert.doesNotMatch(updateLiteral,/password/i);
  assert.match(route,/passwordChanged:newPassword\.length>0/);
});

test("権限説明と店舗選択数を明示しmanager系からExcelを隠す",()=>{
  const page=read("../app/hq/accounts/page.tsx"),admin=read("../app/admin/page.tsx"),exportRoute=read("../app/api/payroll/export/[kind]/route.ts");
  assert.match(page,/担当する1店舗の日常管理/);
  assert.match(page,/担当する複数店舗の日常管理/);
  assert.match(page,/指定されたFC店舗を管理/);
  assert.match(page,/editor\.form\.role==="manager"\?"radio":"checkbox"/);
  assert.match(page,/店舗マネージャーは1店舗だけ選択できます/);
  assert.match(admin,/const areaManagerAllowedTabs: TabId\[\] = \["attendance", "employees", "edits"\]/);
  assert.match(admin,/const visibleTabs = isAdmin\s*\? tabs/);
  assert.match(admin,/\{isAdmin && \([\s\S]*Excel出力/);
  assert.match(exportRoute,/verifyAdminToken[\s\S]*status: 403/);
});

test("確認ボタンは無効化せずクリック時に項目別エラーを表示する",()=>{
  const page=read("../app/hq/accounts/page.tsx");
  assert.match(page,/onClick=\{openConfirmation\}/);
  assert.match(page,/disabled=\{working\}/);
  for(const message of ["修正理由を入力してください","担当店舗を選択してください","店舗マネージャーは1店舗だけ選択できます"])assert.match(page,new RegExp(message));
  assert.match(page,/errors\.stores&&/);
  assert.match(page,/label="登録・修正理由" error=\{errors\.reason\}/);
});

test("編集・削除モーダルは本文だけスクロールし固定フッターから操作する",()=>{
  const page=read("../app/hq/accounts/page.tsx");
  assert.match(page,/maxHeight:"90vh"/);
  assert.match(page,/overflowY:"auto"/);
  assert.match(page,/position:"sticky"[\s\S]*bottom:0[\s\S]*borderTop/);
  assert.match(page,/data-testid="account-modal-footer"/);
  assert.match(page,/入力内容を破棄しますか？/);
  assert.match(page,/event\.key!=="Escape"/);
});

test("店舗・理由は同じcontrolled stateを使い入力時に項目別エラーを消す",()=>{
  const page=read("../app/hq/accounts/page.tsx");
  assert.match(page,/const selectStore[\s\S]*updateForm\(\{storeIds\},\["stores"\]\)/);
  assert.match(page,/role:e\.target\.value as AccountRole,storeIds:\[\]/);
  assert.match(page,/value=\{editor\.form\.reason\}[\s\S]*updateForm\(\{reason:e\.target\.value\},\["reason"\]\)/);
  assert.doesNotMatch(page,/errors\.map/);
});

test("確認後だけ保存APIを呼び削除はメール一致とuid付きDELETEを要求する",()=>{
  const page=read("../app/hq/accounts/page.tsx");
  assert.match(page,/onClick=\{openConfirmation\}/);
  assert.match(page,/onClick=\{save\}/);
  assert.match(page,/url=reset\?`\/api\/accounts\/\$\{action\.account\.uid\}\/password-reset`:`\/api\/accounts\/\$\{action\.account\.uid\}`/);
  assert.match(page,/method:deleting\?"DELETE"/);
  assert.match(page,/emailConfirmation!==action\.account\.email/);
  assert.match(page,/確認のためメールアドレスを入力してください/);
  assert.match(page,/working\?"処理中\.\.\."/);
});

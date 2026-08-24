# 給与機能 最小構成化 指示書（attendance-app）

対象リポジトリ: `~/attendance-app`
現在のHEAD: `d3db2b7 feat: simplify payroll to 3 functions, restrict to admin only`

**この指示書はターミナルのClaude Codeにそのまま貼り付けて使う想定です。**
**デプロイは禁止。コード変更 + `npm run build` + `npm test` の確認まで。**

---

## 0. 前提（絶対に守ること）

- 既存の打刻画面 `app/clock/page.tsx` を変更しない
- 既存の勤怠一覧 `app/hq/timecards/page.tsx` を変更しない
- 既存の従業員管理 `app/admin/page.tsx` を変更しない（`/hq/payroll` へのリンク1行を除く）
- `lib/attendance.ts` / `lib/attendance-calculation.ts` / `lib/clock-punch.ts` を変更しない
- `firestore.rules` を変更しない
- 新しい権限体系・新しいダッシュボード・新しい診断APIを作らない
- 給与処理は必ず `/api/payroll/*` の中だけで完結させ、既存画面のデータ取得処理に混ぜない
- 給与処理が例外を投げても打刻・勤怠側に影響しないこと（既存の分離を維持）

---

## 1. 削除する不要機能

| 対象 | 内容 | 理由 |
|---|---|---|
| `app/api/payroll/adjust/route.ts` | ファイルごと削除 | 手動調整APIは要件外 |
| `lib/payroll.ts` の `adjustPayrollResult()` | 関数削除 | 上記APIの実装本体 |
| `app/api/payroll/cancel/route.ts` | ファイルごと削除 | 確定取消・監査ログは要件外 |
| `lib/payroll-export.ts` の `createPayslipZip()` | 関数削除 | 一括ZIPは不要 |
| `app/api/payroll/export/[kind]/route.ts` の `kind === "zip"` 分岐 | 分岐削除 | 同上 |
| `package.json` の `jszip` | 依存削除（`npm uninstall jszip`） | ZIP削除に伴い未使用 |
| `lib/payroll-server.ts` の `loadPayrollSource()` 内 `payrollSettings.history` 解決ロジック | 削除し `payrollSettings/{employeeId}` を単純に1階層マージするだけにする | 時系列の給与設定履歴は複雑な給与設定機能であり要件外 |
| `lib/payroll-server.ts` の `loadPayrollWorkspace()` が返す `payrollSettings` 配列 | 返却をやめ `{ run }` だけ返す | 画面で未使用 |
| `tests/payroll.test.ts` の adjust / zip / cancel 関連ケース | 削除 | 対象機能の削除に伴う |

**削除しないもの（残す）**
- `app/api/payroll/calculate/route.ts`（GET=既存run読込 / POST=計算）
- `app/api/payroll/confirm/route.ts`（確定。給与明細の前提になる）
- `app/api/payroll/runs/route.ts`（確定月リスト + 確定run取得）
- `app/api/payroll/export/[kind]/route.ts` の `payroll` / `transfer` / `pdf`
- `lib/tax-tables/2026.ts`（所得税計算に必須）
- `tests/payroll-isolation.test.ts`（打刻システムへの非干渉テスト。むしろ強化する）

---

## 2. 追加する機能：幹部は前月確定値を引き継ぐ（現在未実装）

`lib/payroll-server.ts` の `loadPayrollSource()` に以下を追加する。

1. `targetMonth` の**前月**を計算する（例: `2026-07` → `2026-06`）
2. `payrollRuns` から `targetMonth == 前月` かつ `status == "confirmed"` の run を1件取得
3. その run の `employees` サブコレクションを読み、`employeeId` をキーにMap化
4. `payrollType === "fixed"`（幹部）の従業員だけ、以下のフィールドを前月確定値で上書きする:

```
fixedBaseSalary        ← 前月 earnings.baseSalary
directorCompensation   ← 前月 earnings.directorCompensation
positionAllowance      ← 前月 earnings.positionAllowance
fixedOvertimeAllowance ← 前月 earnings.fixedOvertimeAllowance
holidayAllowance       ← 前月 earnings.holidayAllowance
businessAllowance      ← 前月 earnings.businessAllowance
monthlyTransportation  ← 前月 earnings.transportation
healthInsurance        ← 前月 deductions.healthInsurance
childSupportContribution ← 前月 deductions.childSupportContribution
careInsurance          ← 前月 deductions.careInsurance
employeePension        ← 前月 deductions.employeePension
employmentInsurance    ← 前月 deductions.employmentInsurance
residentTax            ← 前月 deductions.residentTax
otherDeduction         ← 前月 deductions.otherDeduction
advanceExpense         ← 前月 deductions.advanceExpense
```

5. 前月の確定runが存在しない場合、または該当従業員が前月runに居ない場合は、
   **従来どおり `employees` / `payrollSettings` の値を使う**（フォールバック）
6. 時給者（`payrollType === "hourly"`）には一切適用しない
7. 幹部の勤怠集計（出勤日数・労働時間）は現状どおり0のままでよい（添付Excelの幹部列と一致）

この処理は `loadPayrollSource()` の中だけで完結させ、他の読み込み処理に影響させないこと。

---

## 3. ボタン1「今月の給与Excelを作成」

`app/hq/payroll/page.tsx`

- ボタンラベルを **「今月の給与Excelを作成」** に変更（再実行時は「今月の給与Excelを再作成」）
- 動作は現状維持:
  1. `POST /api/payroll/calculate`（対象月 = 実行月の前月、支給日 = 実行月の25日）
  2. 成功後すぐ `GET /api/payroll/export/payroll?runId=...` をダウンロード
- 計算内容（`lib/payroll.ts` の `calculatePayrollEmployee`）は現状の
  時給 × 労働時間 / 深夜25% / 残業25% / 交通費 のままで変更不要

### 帳票レイアウトの照合（`lib/payroll-export.ts` の `createPayrollWorkbook`）

原本 `2026年8月支給給与_修正版.xlsx` と突き合わせ済み。列・行のマッピングは**正しい**ので変更不要。

- 本部 = C〜AA（25列）/ 小計 AB
- 野毛 = AC〜AF（4列）/ 小計 AG
- 幹部 = AH〜AL（5列）/ 小計 AM
- 総合計 = AN
- 行: 5基本給 / 6役員報酬 / 7職能手当 / 8残業手当 / 9休日手当 / 10業務手当 / 11非税通勤費 / 12普通残業 / 13深夜手当 / 14欠勤控除 / 15遅早控除 / 16課税支給計 / 17非税支給計 / 18支給合計 / 19〜23社保 / 24社保合計 / 25課税対象額 / 26所得税 / 27住民税 / 28年末調整 / 29その他控除 / 30立替経費 / 31控除合計 / 32その他合計 / 33差引支給額 / 34振込合計 / 35現金支給額 / 37出勤日数 / 38欠勤日数 / 39有休日数 / 40特休日数 / 41休出日数 / 42出勤時間 / 43遅早時間 / 44普通残業時間 / 45深夜時間 / 46内他店時間１

**1点だけ修正**: A1タイトル。
原本は `FUBLEV Group㈱　R８.８月支給　` のみ。
現在のコードは `periodLabel()`（対象期間・支給日）を連結しており原本と異なる。
**`periodLabel` の連結をやめ、原本と同じ `FUBLEV Group㈱　R{和暦}.{月}月支給　` にすること。**

---

## 4. ボタン2「振込一覧Excelを作成」

`app/hq/payroll/page.tsx`

- ボタンラベルを **「振込一覧Excelを作成」** に変更（現在は「振込額を確認」）
- 動作: `GET /api/payroll/export/transfer?runId=...`
- 給与Excelと**同じ runId**（＝同じ計算結果）を使うこと。再計算はしない

### 帳票レイアウトの照合（`createTransferWorkbook`）

原本 `2026年8月給与振込一覧.xlsx` と突き合わせ済み。
- A2/B2/C2 = `No.` / `氏名` / `振込金額`
- データは3行目から、`payrollTransferOrder` 昇順
- 最終行 A = `振込合計（34名）`、C = `SUM(C3:C{最終行-1})`
- 口座番号は出力しない（現状どおり出していないので変更不要）
- シート名 = `{月}月給与振込一覧`

**1点だけ修正**: A1タイトル。
原本は `2026年8月支給　給与振込一覧` のみ。
現在は `periodLabel()` が連結されているので**削除**し、原本と同じにすること。

---

## 5. 給与明細（確定後のみ）

`app/hq/payroll/page.tsx` の セクション② は要件をすでに満たしている。以下だけ確認・調整する。

- 確定月を選択 → 店舗を選択 → 従業員を選択 → 個人PDFダウンロード（現状OK）
- 確定前は表示しない（`/api/payroll/runs` が `status == "confirmed"` のみ返すのでOK）
- 一括ZIPボタンは存在しないこと（存在したら削除）
- PDFレイアウトは添付 `2026年8月給与明細_松本るぴな_従来型_本人用2.pdf` の従来型を流用（`createPayslipPdf` を現状維持）

---

## 6. 検証（デプロイはしない）

```bash
cd ~/attendance-app
npm run build
npm test
```

さらに以下を目視確認:

1. `2026-07` を対象月として計算し、出力された給与Excelを
   `2026年8月支給給与_修正版.xlsx` と列位置・行位置で照合する
2. 振込一覧Excelを `2026年8月給与振込一覧.xlsx` と照合する
3. `tests/payroll-isolation.test.ts` が通ること（打刻システム非干渉）
4. `git diff --stat` で、`app/clock/`, `app/hq/timecards/`, `lib/attendance*.ts`,
   `firestore.rules` に変更が **1行も入っていない** ことを確認する

---

## 7. 完了報告に含めること

- 削除したファイル・関数の一覧
- 幹部の前月引き継ぎの実装箇所（ファイル名と関数名）
- `npm run build` / `npm test` の結果
- `git diff --stat` の出力
- **コミットまで。push・デプロイはしない**

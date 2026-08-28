# clockLogs 日次JSONバックアップ

Cloud Run Jobとして1タスク・parallelism 1で実行する。公開HTTPエンドポイントは作らず、Cloud SchedulerからCloud Run Jobs APIをOAuth認証付きで呼び出す。

- cron: `0 1 * * *`
- timezone: `Asia/Tokyo`
- Firestore: `clockLogs` の前月全体と当月1日から実行時点までをread onlyで取得し、月別のJSONとして独立保存
- Storage: 専用非公開bucketの `attendance-backups/` prefixだけを利用
- lifecycle: `age: 35` のDelete。`.tmp` と `.locks` は短期削除ルールを追加する
- bucket: public access prevention `enforced`、uniform bucket-level access `true`
- Job: tasks 1、parallelism 1、max retries 0

## 実行時IAM

バックアップJob用サービスアカウントには、Firestoreの `datastore.entities.get` / `datastore.entities.list` を含むread-onlyカスタムロールを付与する。Firestore IAMはcollection単位に限定できないため、コードで `clockLogs` を固定する。

専用bucketだけに `storage.objects.create/get/list/delete` のカスタムロールを付与する。deleteは同日ファイルの置換、一時オブジェクト、lockの処理に必要であり、Firestore delete権限ではない。

Scheduler用の別サービスアカウントには対象Jobだけの `roles/run.invoker` を付与する。Owner、Editor、Firebase Auth管理、Firestore write/delete、Vercel上のサービスアカウントJSONは不要。

具体的な設定案は `infrastructure.example.yaml` を参照する。このファイルは設計資料でありCloudへ適用されない。

import { NextRequest, NextResponse } from "next/server";
import { verifyAdminToken } from "@/lib/firebase-admin";
import { createPayrollDraft, loadPayrollRun } from "@/lib/payroll-server";
import { isValidDate, isValidMonth, validateAdjustments } from "@/lib/payroll-api-validation";
import { createPayrollWorkbook, createTransferWorkbook, createUnifiedPayrollWorkbook, createPayslipPdf, createPayslipZip, selectFullTimePayslipResults, selectStorePayslipResults } from "@/lib/payroll-export";
import { getPayrollBlockingIssues } from "@/lib/payroll";

export const runtime = "nodejs";

type ExportRun = NonNullable<Awaited<ReturnType<typeof loadPayrollRun>>>;
type ExportableRun = Pick<ExportRun, "targetMonth" | "paymentMonth" | "paymentDate" | "status" | "results">;

function exportResponse(kind: string, run: ExportableRun, excludeZero = true) {
  const label = `${Number(run.paymentMonth.slice(0, 4))}年${Number(run.paymentMonth.slice(5))}月`;
  const draft = run.status !== "confirmed";
  let buffer: Buffer, filename: string, contentType: string;
  if (kind === "payroll") { buffer = createPayrollWorkbook(run.results, run.paymentMonth, draft, run.targetMonth, run.paymentDate); filename = `${label}支給給与${draft ? "_試算" : ""}.xlsx`; contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"; }
  else if (kind === "transfer") { buffer = createTransferWorkbook(run.results, run.paymentMonth, excludeZero, draft, run.targetMonth, run.paymentDate); filename = `${label}給与振込一覧${draft ? "_試算" : ""}.xlsx`; contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"; }
  else if (kind === "unified") { buffer = createUnifiedPayrollWorkbook(run.results,run.paymentMonth,draft); filename=`${label}給与・振込統合${draft?"_試算":""}.xlsx`; contentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"; }
  else return null;
  return new NextResponse(new Uint8Array(buffer), { headers: { "Content-Type": contentType, "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`, "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest, context: { params: Promise<{ kind: string }> }) {
  const admin = await verifyAdminToken(request.headers.get("authorization"));
  if (!admin) return NextResponse.json({ error: "本部管理者権限が必要です" }, { status: 403 });
  const input = await request.json() as { targetMonth?: string; paymentMonth?: string; paymentDate?: string; sourceAttendanceVersion?: string; adjustmentsSnapshot?: Record<string, import("@/lib/payroll").FixedPayrollAdjustment> };
  if (!isValidMonth(input.targetMonth) || !isValidMonth(input.paymentMonth) || !isValidDate(input.paymentDate) || typeof input.sourceAttendanceVersion !== "string") return NextResponse.json({ error: "給与計算条件が不正です" }, { status: 400 });
  const adjError = validateAdjustments(input.adjustmentsSnapshot);
  if (adjError) return NextResponse.json({ error: adjError.error }, { status: adjError.status });
  let run: Awaited<ReturnType<typeof createPayrollDraft>>;
  try {
    run = await createPayrollDraft(admin.db, { targetMonth: input.targetMonth, paymentMonth: input.paymentMonth, paymentDate: input.paymentDate, adjustments: input.adjustmentsSnapshot });
    if (run.sourceAttendanceVersion !== input.sourceAttendanceVersion) return NextResponse.json({ error: "試算後に勤怠または給与設定が変更されました。再試算してください" }, { status: 409 });
    const blockingIssues = getPayrollBlockingIssues(run.issues);
    if (blockingIssues.length > 0) return NextResponse.json({ error: `重大なエラーがあるためExcelを出力できません：${[...new Set(blockingIssues.map((issue) => issue.message))].join("／")}`, code: "PAYROLL_BLOCKING_ERRORS", issues: blockingIssues.map((issue) => ({ code: issue.code, message: issue.message })) }, { status: 409 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error && error.message === "already_confirmed" ? "この対象月は確定済みです。確定済みExcelを使用してください" : "給与を再計算できません" }, { status: 409 });
  }
  const { kind } = await context.params;
  return exportResponse(kind, run, request.nextUrl.searchParams.get("excludeZero") !== "false") ?? NextResponse.json({ error: "出力種別が不正です" }, { status: 400 });
}

export async function GET(request: NextRequest, context: { params: Promise<{ kind: string }> }) {
  const admin = await verifyAdminToken(request.headers.get("authorization"));
  if (!admin) return NextResponse.json({ error: "本部管理者権限が必要です" }, { status: 403 });
  const runId = request.nextUrl.searchParams.get("runId");
  if (!runId) return NextResponse.json({ error: "runIdが必要です" }, { status: 400 });
  const run = await loadPayrollRun(admin.db, runId);
  if (!run) return NextResponse.json({ error: "給与計算結果がありません" }, { status: 404 });
  const { kind } = await context.params;
  if (kind === "payroll" || kind === "transfer" || kind === "unified") return exportResponse(kind, run, request.nextUrl.searchParams.get("excludeZero") !== "false")!;
  if ((kind === "pdf" || kind === "store-payslips" || kind === "fulltime-payslips") && run.status !== "confirmed") return NextResponse.json({ error: "未確定月の給与明細は取得できません" }, { status: 409 });
  if (kind === "pdf") {
    const employeeId = request.nextUrl.searchParams.get("employeeId"); const result = run.results.find((item) => item.employeeId === employeeId);
    if (!result) return NextResponse.json({ error: "従業員が見つかりません" }, { status: 404 });
    const label = `${Number(run.paymentMonth.slice(0, 4))}年${Number(run.paymentMonth.slice(5))}月`;
    const buffer = await createPayslipPdf(result, run.targetMonth, run.paymentDate, false); const filename = `${label}給与明細_${result.employeeCode}_${result.employeeName}.pdf`; const contentType = "application/pdf";
    return new NextResponse(new Uint8Array(buffer), { headers: { "Content-Type": contentType, "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`, "Cache-Control": "no-store" } });
  }
  if (kind === "store-payslips") {
    const storeId = request.nextUrl.searchParams.get("storeId");
    if (!storeId) return NextResponse.json({ error: "storeIdが必要です" }, { status: 400 });
    const results = selectStorePayslipResults(run.results, storeId);
    if (results.length === 0) return NextResponse.json({ error: "選択店舗のアルバイト給与明細がありません" }, { status: 404 });
    const storeName = results[0].storeName || storeId;
    const buffer = await createPayslipZip(results, run.targetMonth, run.paymentMonth, run.paymentDate);
    const filename = `${Number(run.paymentMonth.slice(0, 4))}年${Number(run.paymentMonth.slice(5))}月_${storeName}_給与明細.zip`;
    return new NextResponse(new Uint8Array(buffer), { headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`, "Cache-Control": "no-store" } });
  }
  if (kind === "fulltime-payslips") {
    const results = selectFullTimePayslipResults(run.results);
    if (results.length === 0) return NextResponse.json({ error: "正社員給与明細がありません" }, { status: 404 });
    const buffer = await createPayslipZip(results, run.targetMonth, run.paymentMonth, run.paymentDate);
    const filename = `${Number(run.paymentMonth.slice(0, 4))}年${Number(run.paymentMonth.slice(5))}月_正社員_給与明細.zip`;
    return new NextResponse(new Uint8Array(buffer), { headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`, "Cache-Control": "no-store" } });
  }
  return NextResponse.json({ error: "出力種別が不正です" }, { status: 400 });
}

import { NextRequest, NextResponse } from "next/server";
import { verifyAdminToken } from "@/lib/firebase-admin";
import { loadPayrollRun } from "@/lib/payroll-server";
import { createPayrollWorkbook, createTransferWorkbook, createPayslipPdf } from "@/lib/payroll-export";

export const runtime = "nodejs";

export async function GET(request: NextRequest, context: { params: Promise<{ kind: string }> }) {
  const admin = await verifyAdminToken(request.headers.get("authorization"));
  if (!admin) return NextResponse.json({ error: "本部管理者権限が必要です" }, { status: 403 });
  const runId = request.nextUrl.searchParams.get("runId");
  if (!runId) return NextResponse.json({ error: "runIdが必要です" }, { status: 400 });
  const run = await loadPayrollRun(admin.db, runId);
  if (!run) return NextResponse.json({ error: "給与計算結果がありません" }, { status: 404 });
  const { kind } = await context.params;
  const label = `${Number(run.paymentMonth.slice(0, 4))}年${Number(run.paymentMonth.slice(5))}月`;
  let buffer: Buffer, filename: string, contentType: string;
  const draft = run.status !== "confirmed";
  if (kind === "payroll") { buffer = createPayrollWorkbook(run.results, run.paymentMonth, draft, run.targetMonth, run.paymentDate); filename = `${label}支給給与${draft ? "_試算" : ""}.xlsx`; contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"; }
  else if (kind === "transfer") { buffer = createTransferWorkbook(run.results, run.paymentMonth, request.nextUrl.searchParams.get("excludeZero") !== "false", draft, run.targetMonth, run.paymentDate); filename = `${label}給与振込一覧${draft ? "_試算" : ""}.xlsx`; contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"; }
  else if (kind === "pdf") {
    const employeeId = request.nextUrl.searchParams.get("employeeId"); const result = run.results.find((item) => item.employeeId === employeeId);
    if (!result) return NextResponse.json({ error: "従業員が見つかりません" }, { status: 404 });
    buffer = await createPayslipPdf(result, run.targetMonth, run.paymentDate, draft); filename = `${label}給与明細_${result.employeeCode}_${result.employeeName}${draft ? "_試算" : ""}.pdf`; contentType = "application/pdf";
  } else return NextResponse.json({ error: "出力種別が不正です" }, { status: 400 });
  return new NextResponse(new Uint8Array(buffer), { headers: { "Content-Type": contentType, "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`, "Cache-Control": "no-store" } });
}

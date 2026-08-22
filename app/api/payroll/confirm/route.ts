import { NextRequest, NextResponse } from "next/server";
import { verifyAdminToken } from "@/lib/firebase-admin";
import { isPayrollMonthClosed, summarizePayroll, type PayrollResult } from "@/lib/payroll";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const admin = await verifyAdminToken(request.headers.get("authorization"));
  if (!admin) return NextResponse.json({ error: "本部管理者権限が必要です" }, { status: 403 });
  const { runId } = await request.json() as { runId?: string };
  if (!runId) return NextResponse.json({ error: "runIdが必要です" }, { status: 400 });
  try {
    await admin.db.runTransaction(async (transaction) => {
      const ref = admin.db.collection("payrollRuns").doc(runId);
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists || snapshot.data()?.status !== "draft") throw new Error("invalid_status");
      if (!isPayrollMonthClosed(snapshot.data()?.targetMonth)) throw new Error("month_not_closed");
      const errors = (snapshot.data()?.issues ?? []).filter((item: { severity?: string }) => item.severity === "error");
      if (errors.length) throw new Error("blocking_errors");
      const employeeSnapshots = await transaction.get(ref.collection("employees"));
      const results = employeeSnapshots.docs.map((item) => item.data() as PayrollResult);
      const totals = summarizePayroll(results);
      if (results.some((item) => item.netPay < 0 || item.earnings.grossTotal < 0 || item.deductions.total < 0)) throw new Error("invalid_result");
      if (totals.grossTotal - totals.deductionTotal !== totals.netTotal || totals.bankTransferTotal + results.reduce((sum, item) => sum + item.cashPayment, 0) !== totals.netTotal) throw new Error("report_mismatch");
      const duplicate = await admin.db.collection("payrollRuns").where("targetMonth", "==", snapshot.data()?.targetMonth).where("status", "==", "confirmed").limit(1).get();
      if (!duplicate.empty) throw new Error("already_confirmed");
      transaction.update(ref, { status: "confirmed", confirmedAt: new Date(), confirmedBy: admin.uid });
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error && error.message === "month_not_closed" ? "対象月は締め前のため、試算・帳票プレビューのみ可能です" : error instanceof Error && error.message === "blocking_errors" ? "重大なエラーがあるため確定できません" : error instanceof Error && ["invalid_result", "report_mismatch"].includes(error.message) ? "給与計算または帳票金額に不整合があるため確定できません" : "給与確定に失敗しました";
    return NextResponse.json({ error: message }, { status: 409 });
  }
}

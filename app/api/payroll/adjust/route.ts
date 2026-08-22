import { NextRequest, NextResponse } from "next/server";
import { verifyAdminToken } from "@/lib/firebase-admin";
import { adjustPayrollResult, summarizePayroll, type PayrollResult } from "@/lib/payroll";

export async function POST(request: NextRequest) {
  const admin = await verifyAdminToken(request.headers.get("authorization"));
  if (!admin) return NextResponse.json({ error: "本部管理者権限が必要です" }, { status: 403 });
  const body = await request.json() as { runId?: string; employeeId?: string; otherTaxable?: number; otherDeduction?: number; reason?: string };
  if (!body.runId || !body.employeeId || !body.reason?.trim()) return NextResponse.json({ error: "対象従業員と修正理由が必要です" }, { status: 400 });
  const runRef = admin.db.collection("payrollRuns").doc(body.runId), employeeRef = runRef.collection("employees").doc(body.employeeId);
  const [runSnapshot, employeeSnapshot] = await Promise.all([runRef.get(), employeeRef.get()]);
  if (!runSnapshot.exists || runSnapshot.data()?.status !== "draft" || !employeeSnapshot.exists) return NextResponse.json({ error: "確定前の給与計算だけ修正できます" }, { status: 409 });
  const adjusted = adjustPayrollResult(employeeSnapshot.data() as PayrollResult, { otherTaxable: body.otherTaxable ?? 0, otherDeduction: body.otherDeduction ?? 0 }, body.reason, admin.uid);
  const snapshots = await runRef.collection("employees").get();
  const results = snapshots.docs.map((item) => item.id === body.employeeId ? adjusted.result : item.data() as PayrollResult);
  const batch = admin.db.batch(); batch.set(employeeRef, { ...adjusted.result, adjustments: [...((employeeSnapshot.data()?.adjustments as unknown[]) ?? []), adjusted.adjustment] }); batch.update(runRef, summarizePayroll(results)); await batch.commit();
  return NextResponse.json({ result: adjusted.result, totals: summarizePayroll(results) });
}

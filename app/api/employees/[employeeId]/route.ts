import { NextRequest, NextResponse } from "next/server";
import { authorizeEmployeeDeletion } from "@/lib/employee-deletion";
import { verifyUserToken } from "@/lib/firebase-rest";

export const runtime = "nodejs";

export async function DELETE(request: NextRequest, context: { params: Promise<{ employeeId: string }> }) {
  const authenticated = await verifyUserToken(request.headers.get("authorization"));
  if (!authenticated) return NextResponse.json({ error: "削除権限がありません。" }, { status: 403 });
  const { employeeId } = await context.params;
  if (!employeeId) return NextResponse.json({ error: "従業員IDが必要です。" }, { status: 400 });

  const employeeRef = authenticated.db.collection("employees").doc(employeeId);
  const rejection = await authenticated.db.runTransaction(async (transaction): Promise<{ error: string; status: number } | null> => {
    const employee = await transaction.get(employeeRef);
    if (!employee.exists) return { error: "従業員が見つかりません。", status: 404 };
    const authorization = authorizeEmployeeDeletion(authenticated.profile, employee.data());
    if (!authorization.allowed) return { error: authorization.error, status: authorization.status };
    transaction.update(employeeRef, { isDeleted: true, status: "inactive" });
    return null;
  });
  if (rejection) return NextResponse.json({ error: rejection.error }, { status: rejection.status });
  return NextResponse.json({ ok: true, employeeId });
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ employeeId: string }> }) {
  const authenticated = await verifyUserToken(request.headers.get("authorization"));
  if (!authenticated) return NextResponse.json({ error: "編集権限がありません。" }, { status: 403 });
  const { employeeId } = await context.params; const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!employeeId || !body) return NextResponse.json({ error: "入力形式が不正です。" }, { status: 400 });
  const ref = authenticated.db.collection("employees").doc(employeeId), snapshot = await ref.get();
  if (!snapshot.exists) return NextResponse.json({ error: "従業員が見つかりません。" }, { status: 404 });
  const authorization = authorizeEmployeeDeletion(authenticated.profile, snapshot.data());
  if (!authorization.allowed) return NextResponse.json({ error: authorization.error }, { status: authorization.status });
  if (body.action === "reactivate") { await authenticated.db.runTransaction(async tx => tx.update(ref, { isDeleted: false, status: "active", employeeType: "partTime", employmentType: "part_time", payrollType: "hourly" })); return NextResponse.json({ ok: true, employeeId }); }
  const allowed = ["name","nameKana","employeeCode","pin","storeId","baseWage","status","transportationCost","transportationType","payrollEnabled","clockEnabled"];
  const payload = { ...Object.fromEntries(allowed.filter(key => key in body).map(key => [key, body[key]])), employeeType: "partTime", employmentType: "part_time", payrollType: "hourly" };
  await authenticated.db.runTransaction(async tx => tx.update(ref, payload));
  return NextResponse.json({ ok: true, employeeId });
}

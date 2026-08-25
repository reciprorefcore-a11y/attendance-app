import { NextRequest, NextResponse } from "next/server";
import { verifyUserToken } from "@/lib/firebase-rest";
import { authorizeEmployeeManagement } from "@/lib/employee-management";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const authenticated = await verifyUserToken(request.headers.get("authorization"));
  if (!authenticated) return NextResponse.json({ error: "登録権限がありません。" }, { status: 403 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const employeeCode = String(body?.employeeCode ?? "").trim();
  const name = String(body?.name ?? "").trim();
  const storeId = String(body?.storeId ?? "").trim();
  if (!body || !employeeCode || !name || !storeId) return NextResponse.json({ error: "氏名、社員コード、所属店舗は必須です。" }, { status: 400 });
  const authorization = authorizeEmployeeManagement(authenticated.profile, { storeId, employeeType: "partTime", employmentType: "part_time", payrollType: "hourly" });
  if (!authorization.allowed) return NextResponse.json({ error: authorization.error }, { status: authorization.status });

  const employeeRef = authenticated.db.collection("employees").doc();
  let duplicate = false;
  await authenticated.db.runTransaction(async transaction => {
    const existing = await transaction.get(authenticated.db.collection("employees").where("employeeCode", "==", employeeCode).limit(1));
    if (!existing.empty) { duplicate = true; return; }
    const now = new Date();
    transaction.set(employeeRef, {
      name,
      nameKana: String(body.nameKana ?? "").trim(),
      employeeCode,
      storeId,
      baseWage: Math.max(0, Math.trunc(Number(body.baseWage) || 0)),
      lateNightHourlyWage: Math.max(0, Math.trunc(Number(body.lateNightHourlyWage) || 0)),
      transportationCost: Math.max(0, Math.trunc(Number(body.transportationCost) || 0)),
      transportationType: String(body.transportationType ?? "none"),
      payrollEnabled: body.payrollEnabled !== false,
      clockEnabled: body.clockEnabled !== false,
      status: body.status === "inactive" ? "inactive" : "active",
      isDeleted: false,
      employeeType: "partTime",
      employmentType: "part_time",
      payrollType: "hourly",
      createdAt: now,
      createdBy: authenticated.uid,
      updatedAt: now,
      updatedBy: authenticated.uid,
    });
  });
  if (duplicate) return NextResponse.json({ error: "同じ社員コードの従業員が既に登録されています。" }, { status: 409 });
  return NextResponse.json({ ok: true, employeeId: employeeRef.id }, { status: 201 });
}

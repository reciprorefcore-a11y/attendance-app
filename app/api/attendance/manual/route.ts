import { NextRequest, NextResponse } from "next/server";
import { authorizeManualAttendance, buildManualClockLogs, overlapsExisting, validateManualAttendance, type ManualAttendanceInput } from "@/lib/manual-attendance";
import { verifyUserToken } from "@/lib/firebase-rest";

export const runtime = "nodejs";
const asDate = (value: unknown) => { const date = value instanceof Date ? value : new Date(String(value ?? "")); return Number.isNaN(date.getTime()) ? null : date; };
const jstDate = (date: Date) => new Date(date.getTime() + 9 * 3600000).toISOString().slice(0, 10);

export async function POST(request: NextRequest) {
  const auth = await verifyUserToken(request.headers.get("authorization"));
  if (!auth) return NextResponse.json({ error: "登録権限がありません。" }, { status: 403 });
  const input = await request.json().catch(() => null) as ManualAttendanceInput | null;
  if (!input) return NextResponse.json({ error: "入力形式が不正です。" }, { status: 400 });
  const validation = validateManualAttendance(input);
  if (!validation.preview) return NextResponse.json({ error: validation.errors.join("。") }, { status: 400 });
  const employee = await auth.db.collection("employees").doc(input.employeeId).get();
  if (!employee.exists) return NextResponse.json({ error: "従業員が見つかりません。" }, { status: 404 });
  const access = authorizeManualAttendance(auth.profile, employee.data(), input.storeId);
  if (!access.allowed) return NextResponse.json({ error: access.error }, { status: access.status });
  const confirmed = await auth.db.collection("payrollRuns").where("targetMonth", "==", input.workDate.slice(0, 7)).where("status", "==", "confirmed").limit(1).get();
  if (!confirmed.empty) return NextResponse.json({ error: "給与確定済み月には登録できません。本部管理者による確定取消が必要です。" }, { status: 409 });
  const priorRequest = await auth.db.collection("clockLogs").where("manualRequestId", "==", input.requestId).get();
  if (!priorRequest.empty) return NextResponse.json({ ok: true, idempotent: true, requestId: input.requestId });
  const employeeLogs = await auth.db.collection("clockLogs").where("employeeId", "==", input.employeeId).get();
  const sameDay = employeeLogs.docs.map((doc) => ({ id: doc.id, ...doc.data() } as Record<string, unknown> & { id: string })).filter((log) => { const timestamp = asDate(log.timestamp); return timestamp && log.isDeleted !== true && log.isCancelled !== true && jstDate(timestamp) === input.workDate; });
  if (sameDay.length && !input.allowSeparateShift) return NextResponse.json({ error: "同じ勤務日に既存の打刻があります。", code: "existing_attendance", existing: sameDay.map((log) => ({ id: log.id, type: log.type, timestamp: asDate(log.timestamp)?.toISOString() })) }, { status: 409 });
  const ins = sameDay.filter((log) => log.type === "clock_in").map((log) => asDate(log.timestamp)!).sort((a, b) => a.getTime() - b.getTime());
  const outs = sameDay.filter((log) => log.type === "clock_out").map((log) => asDate(log.timestamp)!).sort((a, b) => a.getTime() - b.getTime());
  const intervals = ins.flatMap((clockIn, index) => outs[index] ? [{ clockIn, clockOut: outs[index] }] : []);
  if (input.allowSeparateShift && overlapsExisting(validation.preview, intervals)) return NextResponse.json({ error: "既存勤務と時間が重複しています。" }, { status: 409 });
  const logs = buildManualClockLogs(input, validation.preview, employee.data(), { uid: auth.uid, role: String(auth.profile.role ?? "") });
  const batch = auth.db.batch();
  for (const { id, ...data } of logs) batch.create(auth.db.collection("clockLogs").doc(id), data);
  await batch.commit();
  return NextResponse.json({ ok: true, requestId: input.requestId, workMinutes: validation.preview.workMinutes, nightMinutes: validation.preview.nightMinutes, breakMinutes: validation.preview.breakMinutes });
}

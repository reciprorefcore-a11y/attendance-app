import { calculateNightMinutes, diffMinutes } from "./attendance-calculation.ts";
import { isFullTimeEmployee, type EmployeeClassificationFields } from "./employee-classification.ts";

export type ManualBreak = { start: string; end: string };
export type ManualAttendanceInput = {
  requestId: string; employeeId: string; storeId: string; workDate: string;
  clockIn: string; clockOut: string; breaks: ManualBreak[];
  creationReason: string; reasonDetail?: string; note?: string;
  allowSeparateShift?: boolean;
};
export type ManualAttendancePreview = {
  clockIn: Date; clockOut: Date; breaks: Array<{ start: Date; end: Date }>;
  breakMinutes: number; workMinutes: number; nightMinutes: number;
};

const REASONS = new Set(["端末不具合", "PINエラー", "打刻忘れ", "通信障害", "管理者確認済み", "その他"]);
const JST_OFFSET = 9 * 60 * 60 * 1000;

export function fromJstLocal(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(`${value}:00+09:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function jstToday(now = new Date()): string {
  return new Date(now.getTime() + JST_OFFSET).toISOString().slice(0, 10);
}

export function validateManualAttendance(input: ManualAttendanceInput, now = new Date()): { errors: string[]; preview: ManualAttendancePreview | null } {
  const errors: string[] = [];
  if (!/^[A-Za-z0-9_-]{12,100}$/.test(input.requestId)) errors.push("有効なリクエストIDが必要です");
  if (!input.employeeId || !input.storeId) errors.push("店舗と従業員を選択してください");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.workDate)) errors.push("勤務日が不正です");
  if (!REASONS.has(input.creationReason)) errors.push("登録理由を選択してください");
  if (input.creationReason === "その他" && !input.reasonDetail?.trim()) errors.push("その他の理由詳細を入力してください");
  const clockIn = fromJstLocal(input.clockIn);
  let clockOut = fromJstLocal(input.clockOut);
  if (!clockIn || !clockOut) return { errors: [...errors, "出勤・退勤時刻を入力してください"], preview: null };
  if (!input.clockIn.startsWith(`${input.workDate}T`)) errors.push("出勤日は勤務日と一致させてください");
  if (clockOut.getTime() === clockIn.getTime()) errors.push("出勤と退勤を同時刻にはできません");
  if (clockOut < clockIn) clockOut = new Date(clockOut.getTime() + 24 * 60 * 60 * 1000);
  if (clockOut > now || clockIn > now) errors.push("未来日時の勤怠は登録できません");
  if (clockOut.getTime() - clockIn.getTime() > 36 * 60 * 60 * 1000) errors.push("勤務時間が36時間を超えています");
  const breaks: Array<{ start: Date; end: Date }> = [];
  for (const item of input.breaks ?? []) {
    const start = fromJstLocal(item.start);
    const end = fromJstLocal(item.end);
    if (!start || !end) { errors.push("休憩開始・終了を両方入力してください"); continue; }
    if (end <= start) errors.push("休憩終了は開始より後にしてください");
    if (start < clockIn || end > clockOut) errors.push("休憩は勤務時間内にしてください");
    breaks.push({ start, end });
  }
  const sorted = breaks.slice().sort((a, b) => a.start.getTime() - b.start.getTime());
  if (sorted.some((item, i) => i > 0 && item.start < sorted[i - 1].end)) errors.push("休憩時間が重複しています");
  if (errors.length) return { errors, preview: null };
  const breakMinutes = breaks.reduce((sum, item) => sum + diffMinutes(item.start, item.end), 0);
  return { errors: [], preview: { clockIn, clockOut, breaks, breakMinutes, workMinutes: diffMinutes(clockIn, clockOut) - breakMinutes, nightMinutes: calculateNightMinutes(clockIn, clockOut, breaks) } };
}

type Profile = { role?: unknown; storeId?: unknown; storeIds?: unknown };
type EmployeeAccess = EmployeeClassificationFields & { storeId?: unknown; clockEnabled?: unknown; status?: unknown };
export function authorizeManualAttendance(profile: Profile, employee: EmployeeAccess, storeId: string): { allowed: boolean; status: number; error?: string } {
  const role = String(profile.role ?? "");
  if (!['admin', 'manager', 'area_manager', 'fc_manager'].includes(role)) return { allowed: false, status: 403, error: "打刻漏れを登録する権限がありません。" };
  if (employee.isDeleted === true || employee.status === "inactive") return { allowed: false, status: 403, error: "削除済み・無効な従業員は登録できません。" };
  if (isFullTimeEmployee(employee) || employee.clockEnabled === false) return { allowed: false, status: 403, error: "正社員・打刻対象外の従業員は登録できません。" };
  if (String(employee.storeId ?? "") !== storeId) return { allowed: false, status: 403, error: "従業員の所属店舗と対象店舗が一致しません。" };
  const permitted = role === "admin" || (role === "manager" ? String(profile.storeId ?? "") === storeId : Array.isArray(profile.storeIds) && profile.storeIds.map(String).includes(storeId));
  return permitted ? { allowed: true, status: 200 } : { allowed: false, status: 403, error: "管理対象外の店舗です。" };
}

export function overlapsExisting(preview: ManualAttendancePreview, intervals: Array<{ clockIn: Date; clockOut: Date }>) {
  return intervals.some((item) => preview.clockIn < item.clockOut && preview.clockOut > item.clockIn);
}

export function buildManualClockLogs(input: ManualAttendanceInput, preview: ManualAttendancePreview, employee: Record<string, unknown>, actor: { uid: string; role: string }, now = new Date()) {
  const common = { employeeId: input.employeeId, employeeCode: employee.employeeCode ?? "", employeeName: employee.name ?? "", storeId: input.storeId, workStoreId: input.storeId, source: "manual", manuallyCreated: true, manualRequestId: input.requestId, createdBy: actor.uid, createdByRole: actor.role, createdAt: now, creationReason: input.creationReason, creationReasonDetail: input.reasonDetail?.trim() ?? "", note: input.note?.trim() ?? "", updatedBy: actor.uid, updatedAt: now, isCancelled: false, isOutsideGps: false };
  return [
    { id: `manual_${input.requestId}_clock_in`, ...common, type: "clock_in", timestamp: preview.clockIn },
    ...preview.breaks.flatMap((item, index) => [
      { id: `manual_${input.requestId}_break_${index}_start`, ...common, type: "break_start", timestamp: item.start },
      { id: `manual_${input.requestId}_break_${index}_end`, ...common, type: "break_end", timestamp: item.end },
    ]),
    { id: `manual_${input.requestId}_clock_out`, ...common, type: "clock_out", timestamp: preview.clockOut },
  ];
}

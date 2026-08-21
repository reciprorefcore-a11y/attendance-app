import { diffMinutes, formatWorkDate, type CalculationClockLog } from "./attendance-calculation.ts";

export type CorrectionStatus = "normal" | "missing_clock_out" | "orphan_clock_out" | "corrected" | "needs_review";

export type CorrectionWorkSet = {
  key: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  storeId: string;
  storeName: string;
  workDate: string;
  clockInLog: CalculationClockLog | null;
  clockOutLog: CalculationClockLog | null;
  clockIn: Date | null;
  clockOut: Date | null;
  workMinutes: number;
  status: CorrectionStatus;
  warnings: string[];
};

export type CorrectionEditor = {
  employeeId: string;
  storeId: string;
  workDate: string;
  clockIn: string;
  clockOut: string;
  reason: string;
};

const priority: Record<CorrectionStatus, number> = {
  missing_clock_out: 0,
  orphan_clock_out: 0,
  needs_review: 0,
  corrected: 1,
  normal: 2,
};

function corrected(log: CalculationClockLog | null) {
  return log?.isCorrected === true || log?.isManualEdited === true;
}

function makeSet(
  clockInLog: CalculationClockLog | null,
  clockOutLog: CalculationClockLog | null,
): CorrectionWorkSet {
  const source = clockInLog ?? clockOutLog!;
  const clockIn = clockInLog?.timestamp ?? null;
  const clockOut = clockOutLog?.timestamp ?? null;
  const minutes = clockIn && clockOut ? diffMinutes(clockIn, clockOut) : 0;
  const warnings: string[] = [];
  let status: CorrectionStatus = "normal";
  if (!clockIn) {
    status = "orphan_clock_out";
    warnings.push("対応する出勤がありません");
  } else if (!clockOut) {
    status = "missing_clock_out";
    warnings.push("退勤が打刻されていません");
  } else if (clockOut <= clockIn || minutes >= 24 * 60) {
    status = "needs_review";
    warnings.push(minutes >= 24 * 60 ? "24時間以上の勤務です" : "退勤が出勤以前です");
  } else if (corrected(clockInLog) || corrected(clockOutLog)) {
    status = "corrected";
  }
  return {
    key: `${clockInLog?.id ?? "missing-in"}:${clockOutLog?.id ?? "missing-out"}`,
    employeeId: source.employeeId ?? "",
    employeeCode: source.employeeCode ?? "",
    employeeName: source.employeeName ?? "",
    storeId: source.storeId,
    storeName: source.workStoreName ?? source.storeName ?? source.storeId,
    workDate: formatWorkDate(clockIn ?? clockOut!),
    clockInLog,
    clockOutLog,
    clockIn,
    clockOut,
    workMinutes: minutes,
    status,
    warnings,
  };
}

export function buildCorrectionWorkSets(logs: CalculationClockLog[]): CorrectionWorkSet[] {
  const groups = new Map<string, CalculationClockLog[]>();
  for (const log of logs) {
    if (log.type !== "clock_in" && log.type !== "clock_out") continue;
    const employeeKey = log.employeeId || log.employeeCode || log.employeeName || "unknown";
    const key = `${employeeKey}:${log.storeId}`;
    groups.set(key, [...(groups.get(key) ?? []), log]);
  }
  const result: CorrectionWorkSet[] = [];
  for (const logsInStore of groups.values()) {
    let active: CalculationClockLog | null = null;
    for (const log of logsInStore.slice().sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())) {
      if (log.type === "clock_in") {
        if (active) result.push(makeSet(active, null));
        active = log;
      } else if (active) {
        result.push(makeSet(active, log));
        active = null;
      } else {
        result.push(makeSet(null, log));
      }
    }
    if (active) result.push(makeSet(active, null));
  }

  const completed = result.filter((item) => item.clockIn && item.clockOut);
  for (const item of completed) {
    const overlaps = completed.some(
      (other) => other !== item && other.employeeId === item.employeeId && other.storeId === item.storeId &&
        other.clockIn! < item.clockOut! && other.clockOut! > item.clockIn!,
    );
    if (overlaps) {
      item.status = "needs_review";
      if (!item.warnings.includes("同じ店舗の勤務区間と重複しています")) {
        item.warnings.push("同じ店舗の勤務区間と重複しています");
      }
    }
  }
  return result.sort(
    (a, b) => priority[a.status] - priority[b.status] || b.workDate.localeCompare(a.workDate) ||
      (b.clockIn ?? b.clockOut!).getTime() - (a.clockIn ?? a.clockOut!).getTime(),
  );
}

export function toJstDateTimeInput(date: Date | null): string {
  if (!date) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

export function fromJstDateTimeInput(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(`${value}:00+09:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function openCorrectionEditor(workSet: CorrectionWorkSet): CorrectionEditor {
  return {
    employeeId: workSet.employeeId,
    storeId: workSet.storeId,
    workDate: workSet.workDate,
    clockIn: toJstDateTimeInput(workSet.clockIn),
    clockOut: toJstDateTimeInput(workSet.clockOut),
    reason: "",
  };
}

export function shiftCorrectionWorkDate(editor: CorrectionEditor, workDate: string): CorrectionEditor {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) return { ...editor, workDate };
  const previous = new Date(`${editor.workDate}T00:00:00Z`);
  const next = new Date(`${workDate}T00:00:00Z`);
  const shiftMs = next.getTime() - previous.getTime();
  const shift = (value: string) => {
    const date = fromJstDateTimeInput(value);
    return date ? toJstDateTimeInput(new Date(date.getTime() + shiftMs)) : "";
  };
  return { ...editor, workDate, clockIn: shift(editor.clockIn), clockOut: shift(editor.clockOut) };
}

export function validateCorrection(
  editor: CorrectionEditor,
  currentKey: string,
  workSets: CorrectionWorkSet[],
): string[] {
  const errors: string[] = [];
  if (!editor.employeeId) errors.push("従業員を選択してください");
  if (!editor.storeId) errors.push("勤務店舗を選択してください");
  if (!editor.workDate) errors.push("勤務日を入力してください");
  if (!editor.clockIn) errors.push("出勤日時を入力してください");
  if (!editor.clockOut) errors.push("退勤日時を入力してください");
  if (!editor.reason.trim()) errors.push("修正理由を入力してください");
  const clockIn = fromJstDateTimeInput(editor.clockIn);
  const clockOut = fromJstDateTimeInput(editor.clockOut);
  if (clockIn && clockOut) {
    if (formatWorkDate(clockIn) !== editor.workDate) errors.push("勤務日と出勤日時の日付を一致させてください");
    if (clockOut <= clockIn) errors.push("退勤日時は出勤日時より後にしてください");
    if (diffMinutes(clockIn, clockOut) >= 24 * 60) errors.push("24時間以上の勤務は保存できません。日時を確認してください");
    const overlap = workSets.some((set) => set.key !== currentKey && set.employeeId === editor.employeeId &&
      set.storeId === editor.storeId && set.clockIn && set.clockOut && set.clockIn < clockOut && set.clockOut > clockIn);
    if (overlap) errors.push("同じ従業員・店舗の既存勤務区間と重複しています");
  }
  return errors;
}

export function buildCorrectionAudit(
  workSet: CorrectionWorkSet,
  editor: CorrectionEditor,
  targetLogIds: string[],
  correctedBy: string,
) {
  const clockIn = fromJstDateTimeInput(editor.clockIn);
  const clockOut = fromJstDateTimeInput(editor.clockOut);
  return {
    targetLogIds,
    before: {
      employeeId: workSet.employeeId,
      storeId: workSet.storeId,
      workDate: workSet.workDate,
      clockIn: workSet.clockIn?.toISOString() ?? null,
      clockOut: workSet.clockOut?.toISOString() ?? null,
    },
    after: {
      employeeId: editor.employeeId,
      storeId: editor.storeId,
      workDate: editor.workDate,
      clockIn: clockIn?.toISOString() ?? null,
      clockOut: clockOut?.toISOString() ?? null,
    },
    actions: [
      { targetLogId: targetLogIds[0], action: workSet.clockInLog ? "update" : "create", type: "clock_in" },
      { targetLogId: targetLogIds[1], action: workSet.clockOutLog ? "update" : "create", type: "clock_out" },
    ],
    correctionReason: editor.reason.trim(),
    correctedBy,
  };
}

export function createCorrectionSaveGuard() {
  let locked = false;
  return async <T>(operation: () => Promise<T>) => {
    if (locked) throw new Error("correction_already_saving");
    locked = true;
    try { return await operation(); } finally { locked = false; }
  };
}

export async function commitCorrection(
  commit: () => Promise<void>,
  onSuccess: () => void,
) {
  await commit();
  onSuccess();
}

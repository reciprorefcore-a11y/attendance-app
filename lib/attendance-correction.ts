import { calculateNightMinutes, diffMinutes, formatWorkDate, type CalculationClockLog } from "./attendance-calculation.ts";

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
  breakMinutes: number;
  breaks: CorrectionBreakSet[];
  status: CorrectionStatus;
  warnings: string[];
};

export type CorrectionBreakSet = {
  key: string;
  startLog: CalculationClockLog | null;
  endLog: CalculationClockLog | null;
  start: Date | null;
  end: Date | null;
};

export type CorrectionBreakEditor = {
  key: string;
  startLogId: string | null;
  endLogId: string | null;
  start: string;
  end: string;
  isDeleted: boolean;
};

export type CorrectionEditor = {
  employeeId: string;
  storeId: string;
  workDate: string;
  clockIn: string;
  clockOut: string;
  breaks: CorrectionBreakEditor[];
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
  breaks: CorrectionBreakSet[] = [],
): CorrectionWorkSet {
  const source = clockInLog ?? clockOutLog!;
  const clockIn = clockInLog?.timestamp ?? null;
  const clockOut = clockOutLog?.timestamp ?? null;
  const breakMinutes = breaks.reduce(
    (sum, item) => sum + (item.start && item.end && item.end > item.start ? diffMinutes(item.start, item.end) : 0),
    0,
  );
  const minutes = clockIn && clockOut ? Math.max(0, diffMinutes(clockIn, clockOut) - breakMinutes) : 0;
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
  if (breaks.some((item) => !item.start || !item.end)) {
    warnings.push("休憩打刻が未完了です");
    if (status === "normal" || status === "corrected") status = "needs_review";
  }
  const completedBreaks = breaks.filter((item) => item.start && item.end).sort((a, b) => a.start!.getTime() - b.start!.getTime());
  if (completedBreaks.some((item, index) => index > 0 && item.start! < completedBreaks[index - 1].end!)) {
    warnings.push("休憩時間が重複しています");
    if (status === "normal" || status === "corrected") status = "needs_review";
  }
  if (breaks.some((item) => corrected(item.startLog) || corrected(item.endLog)) && status === "normal") status = "corrected";
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
    breakMinutes,
    breaks,
    status,
    warnings,
  };
}

export function buildCorrectionWorkSets(logs: CalculationClockLog[]): CorrectionWorkSet[] {
  const groups = new Map<string, CalculationClockLog[]>();
  for (const log of logs) {
    if (!["clock_in", "clock_out", "break_start", "break_end"].includes(log.type)) continue;
    const employeeKey = log.employeeId || log.employeeCode || log.employeeName || "unknown";
    const key = `${employeeKey}:${log.storeId}`;
    groups.set(key, [...(groups.get(key) ?? []), log]);
  }
  const result: CorrectionWorkSet[] = [];
  for (const logsInStore of groups.values()) {
    let active: { clockIn: CalculationClockLog; breaks: CorrectionBreakSet[]; breakStart: CalculationClockLog | null } | null = null;
    const finish = (clockOut: CalculationClockLog | null) => {
      if (!active) return;
      if (active.breakStart) {
        active.breaks.push({ key: `${active.breakStart.id}:missing-end`, startLog: active.breakStart, endLog: null, start: active.breakStart.timestamp, end: null });
      }
      result.push(makeSet(active.clockIn, clockOut, active.breaks));
      active = null;
    };
    for (const log of logsInStore.slice().sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())) {
      if (log.type === "clock_in") {
        finish(null);
        active = { clockIn: log, breaks: [], breakStart: null };
      } else if (log.type === "clock_out" && active) {
        finish(log);
      } else if (log.type === "clock_out") {
        result.push(makeSet(null, log));
      } else if (log.type === "break_start" && active) {
        if (active.breakStart) {
          active.breaks.push({ key: `${active.breakStart.id}:missing-end`, startLog: active.breakStart, endLog: null, start: active.breakStart.timestamp, end: null });
        }
        active.breakStart = log;
      } else if (log.type === "break_end" && active?.breakStart) {
        active.breaks.push({ key: `${active.breakStart.id}:${log.id}`, startLog: active.breakStart, endLog: log, start: active.breakStart.timestamp, end: log.timestamp });
        active.breakStart = null;
      } else if (log.type === "break_end" && active) {
        active.breaks.push({ key: `missing-start:${log.id}`, startLog: null, endLog: log, start: null, end: log.timestamp });
      }
    }
    finish(null);
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
    breaks: workSet.breaks.map((item) => ({
      key: item.key,
      startLogId: item.startLog?.id ?? null,
      endLogId: item.endLog?.id ?? null,
      start: toJstDateTimeInput(item.start),
      end: toJstDateTimeInput(item.end),
      isDeleted: false,
    })),
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
  return {
    ...editor,
    workDate,
    clockIn: shift(editor.clockIn),
    clockOut: shift(editor.clockOut),
    breaks: editor.breaks.map((item) => ({ ...item, start: shift(item.start), end: shift(item.end) })),
  };
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
  if (!editor.clockIn && !editor.clockOut) errors.push("出勤日時または退勤日時を入力してください");
  if (!editor.reason.trim()) errors.push("修正理由を入力してください");
  const clockIn = fromJstDateTimeInput(editor.clockIn);
  const clockOut = fromJstDateTimeInput(editor.clockOut);
  const current = workSets.find((set) => set.key === currentKey);
  if (current?.clockInLog && !clockIn) errors.push("既存の出勤打刻は空欄にできません");
  if (current?.clockOutLog && !clockOut) errors.push("既存の退勤打刻は空欄にできません");
  if (clockIn && formatWorkDate(clockIn) !== editor.workDate) errors.push("勤務日と出勤日時の日付を一致させてください");
  if (clockIn && clockOut) {
    if (clockOut <= clockIn) errors.push("退勤日時は出勤日時より後にしてください");
    if (diffMinutes(clockIn, clockOut) >= 24 * 60) errors.push("24時間以上の勤務は保存できません。日時を確認してください");
    const overlap = workSets.some((set) => set.key !== currentKey && set.employeeId === editor.employeeId &&
      set.storeId === editor.storeId && set.clockIn && set.clockOut && set.clockIn < clockOut && set.clockOut > clockIn);
    if (overlap) errors.push("同じ従業員・店舗の既存勤務区間と重複しています");
  }
  const breaks = editor.breaks.filter((item) => !item.isDeleted).map((item, index) => ({
    index,
    start: fromJstDateTimeInput(item.start),
    end: fromJstDateTimeInput(item.end),
  }));
  for (const item of breaks) {
    if (!item.start || !item.end) {
      errors.push(`休憩${item.index + 1}の開始日時と終了日時を入力してください`);
      continue;
    }
    if (item.end <= item.start) errors.push(`休憩${item.index + 1}の終了日時は開始日時より後にしてください`);
    if (clockIn && item.start < clockIn) errors.push(`休憩${item.index + 1}が出勤前です`);
    if (clockOut && item.end > clockOut) errors.push(`休憩${item.index + 1}が退勤後です`);
  }
  const completedBreaks = breaks.filter((item): item is { index: number; start: Date; end: Date } => Boolean(item.start && item.end))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  for (let index = 1; index < completedBreaks.length; index += 1) {
    if (completedBreaks[index].start < completedBreaks[index - 1].end) {
      errors.push("休憩時間が重複しています");
      break;
    }
  }
  if (clockIn && clockOut) {
    const totalBreak = completedBreaks.reduce((sum, item) => sum + diffMinutes(item.start, item.end), 0);
    if (totalBreak > diffMinutes(clockIn, clockOut)) errors.push("休憩時間が勤務時間を超えています");
  }
  return errors;
}

export function calculateCorrectionPreview(editor: CorrectionEditor) {
  const clockIn = fromJstDateTimeInput(editor.clockIn);
  const clockOut = fromJstDateTimeInput(editor.clockOut);
  const breaks = editor.breaks.filter((item) => !item.isDeleted).flatMap((item) => {
    const start = fromJstDateTimeInput(item.start);
    const end = fromJstDateTimeInput(item.end);
    return start && end && end > start ? [{ start, end }] : [];
  });
  const breakMinutes = breaks.reduce((sum, item) => sum + diffMinutes(item.start, item.end), 0);
  if (!clockIn || !clockOut || clockOut <= clockIn) {
    return { breakMinutes, workMinutes: null, nightMinutes: null };
  }
  return {
    breakMinutes,
    workMinutes: Math.max(0, diffMinutes(clockIn, clockOut) - breakMinutes),
    nightMinutes: calculateNightMinutes(clockIn, clockOut, breaks),
  };
}

export function buildCorrectionAudit(
  workSet: CorrectionWorkSet,
  editor: CorrectionEditor,
  targetLogIds: string[],
  correctedBy: string,
  breakActions: { targetLogId: string; action: "create" | "update" | "delete"; type: "break_start" | "break_end" }[] = [],
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
      breaks: workSet.breaks.map((item) => ({
        startLogId: item.startLog?.id ?? null,
        endLogId: item.endLog?.id ?? null,
        start: item.start?.toISOString() ?? null,
        end: item.end?.toISOString() ?? null,
      })),
    },
    after: {
      employeeId: editor.employeeId,
      storeId: editor.storeId,
      workDate: editor.workDate,
      clockIn: clockIn?.toISOString() ?? null,
      clockOut: clockOut?.toISOString() ?? null,
      breaks: editor.breaks.filter((item) => !item.isDeleted).map((item) => ({
        startLogId: item.startLogId,
        endLogId: item.endLogId,
        start: fromJstDateTimeInput(item.start)?.toISOString() ?? null,
        end: fromJstDateTimeInput(item.end)?.toISOString() ?? null,
      })),
    },
    actions: [
      ...(clockIn ? [{ targetLogId: targetLogIds[0], action: workSet.clockInLog ? "update" as const : "create" as const, type: "clock_in" as const }] : []),
      ...(clockOut ? [{ targetLogId: targetLogIds[1], action: workSet.clockOutLog ? "update" as const : "create" as const, type: "clock_out" as const }] : []),
      ...breakActions,
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

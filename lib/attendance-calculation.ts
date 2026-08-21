export type CalculationClockLog = {
  id: string;
  employeeId?: string | null;
  employeeCode?: string;
  employeeName?: string;
  storeId: string;
  storeName?: string;
  workStoreName?: string;
  type: string;
  timestamp: Date;
  isOutsideGps?: boolean;
  [key: string]: unknown;
};

export type CalculationWage = {
  hourlyWage?: unknown;
  lateNightHourlyWage?: unknown;
  dailyTransportation?: unknown;
  effectiveFrom: string;
  effectiveTo?: string | null;
};

export type WageHistoryLoadStatus = "loaded" | "failed";

export type WageDiagnosticCode =
  | "wage_history_fetch_failed"
  | "wage_history_empty"
  | "wage_history_not_applicable"
  | "wage_history_hourly_wage_invalid"
  | "clock_log_snapshot_missing"
  | "wage_missing";

export type BreakSession = {
  start: Date;
  end: Date;
};

export type WorkSession = {
  employeeKey: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  storeId: string;
  storeName: string;
  clockIn: Date;
  clockOut: Date | null;
  breaks: BreakSession[];
  logs: CalculationClockLog[];
  workMinutes: number;
  breakMinutes: number;
  nightMinutes: number;
  wageAmount: number;
  isWageMissing: boolean;
  wageSource: "wage_history" | "hourly_wage_at_work" | "hourly_wage_snapshot" | "employee_base" | null;
  wageDiagnostics: WageDiagnosticCode[];
};

export type CalculatedAttendanceRow = {
  key: string;
  date: string;
  storeId: string;
  storeName: string;
  employeeKey: string;
  employeeCode: string;
  employeeName: string;
  clockIn: Date;
  clockOut: Date | null;
  breakMinutes: number;
  workMinutes: number;
  nightMinutes: number;
  wageAmount: number;
  isWageMissing: boolean;
  isOutsideGps: boolean;
  isMissingClockOut: boolean;
  logs: CalculationClockLog[];
  sessions: WorkSession[];
  diagnostics: AttendanceDiagnostic[];
};

export type StoreLaborCost = {
  amount: number;
  missingWageEmployeeKeys: string[];
};

export type AttendanceDiagnosticCode =
  | "work_exceeds_elapsed"
  | "night_exceeds_work"
  | "work_at_least_24_hours"
  | "missing_clock_out"
  | "orphan_clock_out"
  | "overlapping_sessions";

export type AttendanceDiagnostic = {
  code: AttendanceDiagnosticCode;
  message: string;
};

export type AttendanceAuditIssue = AttendanceDiagnostic & {
  employeeKey: string;
  date: string;
  storeId?: string;
};

export function truncateToMinute(date: Date) {
  const value = new Date(date);
  value.setSeconds(0, 0);
  return value;
}

export function diffMinutes(start: Date, end: Date) {
  const from = truncateToMinute(start).getTime();
  const to = truncateToMinute(end).getTime();
  return Math.max(0, Math.floor((to - from) / 60000));
}

export function formatWorkDate(date: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function normalizedType(type: string) {
  if (type === "clockIn" || type === "in" || type === "start") return "clock_in";
  if (type === "breakStart") return "break_start";
  if (type === "breakEnd") return "break_end";
  if (type === "clockOut" || type === "out" || type === "end") return "clock_out";
  return type;
}

function overlapMinutes(start: Date, end: Date, rangeStart: Date, rangeEnd: Date) {
  const from = Math.max(truncateToMinute(start).getTime(), truncateToMinute(rangeStart).getTime());
  const to = Math.min(truncateToMinute(end).getTime(), truncateToMinute(rangeEnd).getTime());
  return Math.max(0, Math.floor((to - from) / 60000));
}

export function pairBreakSessions(
  logs: CalculationClockLog[],
  clockIn: Date,
  clockOut: Date | null,
) {
  const result: BreakSession[] = [];
  let breakStart: Date | null = null;

  for (const log of logs) {
    const type = normalizedType(log.type);
    const time = truncateToMinute(log.timestamp);
    if (time < clockIn || (clockOut && time > clockOut)) continue;
    if (type === "break_start") {
      breakStart = time;
    } else if (type === "break_end" && breakStart && time > breakStart) {
      result.push({ start: breakStart, end: time });
      breakStart = null;
    }
  }
  return result;
}

export function calculateBreakMinutes(breaks: BreakSession[]) {
  return breaks.reduce((total, item) => total + diffMinutes(item.start, item.end), 0);
}

export function calculateNightMinutes(
  start: Date,
  end: Date,
  breaks: BreakSession[] = [],
) {
  if (end <= start) return 0;
  let total = 0;
  let dateKey = addDays(formatWorkDate(start), -1);

  while (new Date(`${dateKey}T22:00:00+09:00`) < end) {
    const nightStart = new Date(`${dateKey}T22:00:00+09:00`);
    const nightEnd = new Date(`${addDays(dateKey, 1)}T05:00:00+09:00`);
    let minutes = overlapMinutes(start, end, nightStart, nightEnd);
    for (const item of breaks) {
      minutes -= overlapMinutes(item.start, item.end, nightStart, nightEnd);
    }
    total += Math.max(0, minutes);
    dateKey = addDays(dateKey, 1);
  }
  return total;
}

function addDays(dateKey: string, days: number) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function calculateWorkMinutes(
  start: Date,
  end: Date,
  breaks: BreakSession[] = [],
) {
  return Math.max(0, diffMinutes(start, end) - calculateBreakMinutes(breaks));
}

export function pairWorkSessions(logs: CalculationClockLog[]) {
  const byEmployee = new Map<string, CalculationClockLog[]>();
  for (const log of logs) {
    const employeeKey = log.employeeId || log.employeeCode || log.employeeName || "unknown";
    // A clock-out at another store must never close this store's active session.
    const pairingKey = `${employeeKey}:${log.storeId}`;
    byEmployee.set(pairingKey, [...(byEmployee.get(pairingKey) ?? []), log]);
  }

  const sessions: WorkSession[] = [];
  for (const employeeLogs of byEmployee.values()) {
    const firstLog = employeeLogs[0];
    const employeeKey = firstLog.employeeId || firstLog.employeeCode || firstLog.employeeName || "unknown";
    const sorted = employeeLogs
      .slice()
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    let active: { clockIn: CalculationClockLog; logs: CalculationClockLog[] } | null = null;

    const finish = (clockOut: CalculationClockLog | null) => {
      if (!active) return;
      const clockIn = truncateToMinute(active.clockIn.timestamp);
      const end = clockOut ? truncateToMinute(clockOut.timestamp) : null;
      const sessionLogs = clockOut ? [...active.logs, clockOut] : active.logs;
      const breaks = pairBreakSessions(sessionLogs, clockIn, end);
      sessions.push({
        employeeKey,
        employeeId: active.clockIn.employeeId ?? "",
        employeeCode: active.clockIn.employeeCode ?? "",
        employeeName: active.clockIn.employeeName ?? "",
        storeId: active.clockIn.storeId,
        storeName: active.clockIn.workStoreName ?? active.clockIn.storeName ?? "",
        clockIn,
        clockOut: end,
        breaks,
        workMinutes: end ? calculateWorkMinutes(clockIn, end, breaks) : 0,
        breakMinutes: end ? calculateBreakMinutes(breaks) : 0,
        nightMinutes: end ? calculateNightMinutes(clockIn, end, breaks) : 0,
        wageAmount: 0,
        isWageMissing: false,
        wageSource: null,
        wageDiagnostics: [],
        logs: sessionLogs,
      });
      active = null;
    };

    for (const log of sorted) {
      const type = normalizedType(log.type);
      if (type === "clock_in") {
        finish(null);
        active = { clockIn: log, logs: [log] };
      } else if (type === "clock_out" && active) {
        finish(log);
      } else if (active) {
        active.logs.push(log);
      }
    }
    finish(null);
  }

  return sessions.sort((a, b) => a.clockIn.getTime() - b.clockIn.getTime());
}

function safeNonNegativeNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function safePositiveNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function findSessionSnapshot(
  session: WorkSession,
  atWorkField: string,
  snapshotField: string,
  positiveOnly = false,
) {
  const clockInLog =
    session.logs.find((log) => normalizedType(log.type) === "clock_in") ?? session.logs[0];
  const otherLogs = session.logs.filter((log) => log !== clockInLog);
  const candidates = [
    { value: clockInLog?.[atWorkField], source: "at_work" as const },
    { value: clockInLog?.[snapshotField], source: "snapshot" as const },
    ...otherLogs.flatMap((log) => [
      { value: log[atWorkField], source: "at_work" as const },
      { value: log[snapshotField], source: "snapshot" as const },
    ]),
  ];
  const parse = positiveOnly ? safePositiveNumber : safeNonNegativeNumber;
  return candidates.find((candidate) => parse(candidate.value) !== null) ?? null;
}

export function getApplicableWage(wages: CalculationWage[], workDate: string) {
  return (
    wages
      .filter(
        (wage) =>
          wage.effectiveFrom <= workDate &&
          (wage.effectiveTo == null || workDate <= wage.effectiveTo),
      )
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0] ?? null
  );
}

export function calculateEstimatedLaborCost(
  session: Pick<WorkSession, "workMinutes" | "nightMinutes">,
  wage: CalculationWage | null,
  includeTransportation = false,
) {
  const hourlyWage = safeNonNegativeNumber(wage?.hourlyWage);
  const lateNightHourlyWage = safeNonNegativeNumber(wage?.lateNightHourlyWage);
  const transportation = safeNonNegativeNumber(wage?.dailyTransportation);
  if (!wage || hourlyWage === null || lateNightHourlyWage === null) {
    return { amount: 0, isWageMissing: true };
  }
  const normalMinutes = Math.max(0, session.workMinutes - session.nightMinutes);
  const amount =
    (normalMinutes / 60) * hourlyWage +
    (session.nightMinutes / 60) * lateNightHourlyWage +
    (includeTransportation ? (transportation ?? 0) : 0);
  return { amount, isWageMissing: false };
}

export function resolveSessionWage(
  session: WorkSession,
  wages: CalculationWage[],
  workDate: string,
  wageHistoryStatus: WageHistoryLoadStatus = "loaded",
  employeeBaseWage?: number | null,
) {
  const diagnostics: WageDiagnosticCode[] = [];
  const applicableWage = getApplicableWage(wages, workDate);

  if (wageHistoryStatus === "failed") {
    diagnostics.push("wage_history_fetch_failed");
  } else if (wages.length === 0) {
    diagnostics.push("wage_history_empty");
  } else if (!applicableWage) {
    diagnostics.push("wage_history_not_applicable");
  }

  const historyHourlyWage = safePositiveNumber(applicableWage?.hourlyWage);
  if (applicableWage && historyHourlyWage === null) {
    diagnostics.push("wage_history_hourly_wage_invalid");
  }

  const hourlySnapshot = findSessionSnapshot(
    session,
    "hourlyWageAtWork",
    "hourlyWageSnapshot",
    true,
  );
  const snapshotHourlyWage = safePositiveNumber(hourlySnapshot?.value);
  const hourlyWage = historyHourlyWage ?? snapshotHourlyWage;

  if (hourlyWage === null) {
    diagnostics.push("clock_log_snapshot_missing");
    const baseWage = safePositiveNumber(employeeBaseWage);
    if (baseWage !== null) {
      return {
        wage: {
          hourlyWage: baseWage,
          lateNightHourlyWage: baseWage * 1.25,
          dailyTransportation: 0,
          effectiveFrom: workDate,
          effectiveTo: workDate,
        } satisfies CalculationWage,
        source: "employee_base" as const,
        diagnostics,
      };
    }
    diagnostics.push("wage_missing");
    return {
      wage: null,
      source: null,
      diagnostics,
    };
  }

  const nightSnapshot = findSessionSnapshot(
    session,
    "lateNightHourlyWageAtWork",
    "lateNightHourlyWageSnapshot",
    true,
  );
  const transportationSnapshot = findSessionSnapshot(
    session,
    "dailyTransportationAtWork",
    "dailyTransportationSnapshot",
  );
  const historyNightWage = safePositiveNumber(applicableWage?.lateNightHourlyWage);
  const snapshotNightWage = safePositiveNumber(nightSnapshot?.value);
  const historyTransportation = safeNonNegativeNumber(applicableWage?.dailyTransportation);
  const snapshotTransportation = safeNonNegativeNumber(transportationSnapshot?.value);

  return {
    wage: {
      hourlyWage,
      lateNightHourlyWage: historyNightWage ?? snapshotNightWage ?? hourlyWage * 1.25,
      dailyTransportation: historyTransportation ?? snapshotTransportation ?? 0,
      effectiveFrom: workDate,
      effectiveTo: workDate,
    } satisfies CalculationWage,
    source:
      historyHourlyWage !== null
        ? ("wage_history" as const)
        : hourlySnapshot?.source === "at_work"
          ? ("hourly_wage_at_work" as const)
          : ("hourly_wage_snapshot" as const),
    diagnostics,
  };
}

export function buildAttendanceRows(
  logs: CalculationClockLog[],
  wagesByEmployee: Record<string, CalculationWage[]> = {},
  wageHistoryStatusByEmployee: Record<string, WageHistoryLoadStatus> = {},
  employeeBaseWages: Record<string, number> = {},
) {
  const sessions = pairWorkSessions(logs);
  const transportationUsed = new Set<string>();

  for (const session of sessions) {
    if (!session.clockOut) continue;
    const date = formatWorkDate(session.clockIn);
    const resolution = resolveSessionWage(
      session,
      wagesByEmployee[session.employeeId] ?? [],
      date,
      wageHistoryStatusByEmployee[session.employeeId] ?? "loaded",
      employeeBaseWages[session.employeeId],
    );
    const transportationKey = `${session.employeeKey}:${date}`;
    const includeTransportation = !transportationUsed.has(transportationKey);
    const cost = calculateEstimatedLaborCost(session, resolution.wage, includeTransportation);
    session.wageAmount = cost.amount;
    session.isWageMissing = cost.isWageMissing;
    session.wageSource = resolution.source;
    session.wageDiagnostics = resolution.diagnostics;
    if (!cost.isWageMissing && includeTransportation) transportationUsed.add(transportationKey);
  }

  const groups = new Map<string, WorkSession[]>();
  for (const session of sessions) {
    const date = formatWorkDate(session.clockIn);
    const key = `${date}:${session.employeeKey}`;
    groups.set(key, [...(groups.get(key) ?? []), session]);
  }

  return Array.from(groups.entries())
    .map(([key, grouped]) => {
      const completed = grouped.filter((session) => session.clockOut);
      const workIntervals = completed.flatMap(sessionWorkIntervals);
      const mergedWorkIntervals = mergeIntervals(workIntervals);
      const breakIntervals = mergeIntervals(completed.flatMap((session) => session.breaks));
      const workMinutes = sumIntervals(mergedWorkIntervals);
      const nightMinutes = mergedWorkIntervals.reduce(
        (sum, interval) => sum + calculateNightMinutes(interval.start, interval.end),
        0,
      );
      const breakMinutes = sumIntervals(breakIntervals);
      const diagnostics = buildAttendanceDiagnostics(grouped, workMinutes, nightMinutes);
      const storeNames = [...new Set(grouped.map((session) => session.storeName).filter(Boolean))];
      return {
        key,
        date: formatWorkDate(grouped[0].clockIn),
        storeId: grouped[0].storeId,
        storeName: storeNames.join(" / "),
        employeeKey: grouped[0].employeeKey,
        employeeCode: grouped[0].employeeCode,
        employeeName: grouped[0].employeeName,
        clockIn: grouped[0].clockIn,
        clockOut: completed.at(-1)?.clockOut ?? null,
        breakMinutes,
        workMinutes,
        nightMinutes,
        wageAmount: Math.round(completed.reduce((sum, session) => sum + session.wageAmount, 0)),
        isWageMissing: completed.some((session) => session.isWageMissing),
        isOutsideGps: grouped.some((session) =>
          session.logs.some((log) => log.isOutsideGps === true),
        ),
        isMissingClockOut: grouped.some((session) => !session.clockOut),
        logs: grouped.flatMap((session) => session.logs),
        sessions: grouped,
        diagnostics,
      } satisfies CalculatedAttendanceRow;
    })
    .sort((a, b) => b.date.localeCompare(a.date) || a.employeeName.localeCompare(b.employeeName));
}

type TimeInterval = { start: Date; end: Date };

function sessionWorkIntervals(session: WorkSession): TimeInterval[] {
  if (!session.clockOut || session.clockOut <= session.clockIn) return [];
  let intervals: TimeInterval[] = [{ start: session.clockIn, end: session.clockOut }];
  for (const item of session.breaks) {
    intervals = intervals.flatMap((interval) => {
      if (item.end <= interval.start || item.start >= interval.end) return [interval];
      const parts: TimeInterval[] = [];
      if (item.start > interval.start) parts.push({ start: interval.start, end: item.start });
      if (item.end < interval.end) parts.push({ start: item.end, end: interval.end });
      return parts;
    });
  }
  return intervals;
}

function mergeIntervals(intervals: TimeInterval[]): TimeInterval[] {
  const sorted = intervals
    .filter((item) => item.end > item.start)
    .map((item) => ({ start: truncateToMinute(item.start), end: truncateToMinute(item.end) }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged: TimeInterval[] = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (!previous || interval.start > previous.end) {
      merged.push(interval);
    } else if (interval.end > previous.end) {
      previous.end = interval.end;
    }
  }
  return merged;
}

function sumIntervals(intervals: TimeInterval[]) {
  return intervals.reduce((sum, item) => sum + diffMinutes(item.start, item.end), 0);
}

function buildAttendanceDiagnostics(
  sessions: WorkSession[],
  workMinutes: number,
  nightMinutes: number,
): AttendanceDiagnostic[] {
  const diagnostics: AttendanceDiagnostic[] = [];
  const completed = sessions.filter((session) => session.clockOut);
  const sorted = completed.slice().sort((a, b) => a.clockIn.getTime() - b.clockIn.getTime());
  const earliest = sorted[0]?.clockIn;
  const latest = sorted.reduce<Date | null>(
    (value, session) =>
      !value || (session.clockOut && session.clockOut > value) ? session.clockOut : value,
    null,
  );
  if (earliest && latest && workMinutes > diffMinutes(earliest, latest)) {
    diagnostics.push({ code: "work_exceeds_elapsed", message: "労働時間が出勤から退勤までの実時間を超えています" });
  }
  if (nightMinutes > workMinutes) {
    diagnostics.push({ code: "night_exceeds_work", message: "深夜時間が労働時間を超えています" });
  }
  if (workMinutes >= 24 * 60) {
    diagnostics.push({ code: "work_at_least_24_hours", message: "1日の労働時間が24時間以上です" });
  }
  if (sessions.some((session) => !session.clockOut)) {
    diagnostics.push({ code: "missing_clock_out", message: "退勤のない勤務区間があります" });
  }
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1].clockOut && sorted[index].clockIn < sorted[index - 1].clockOut!) {
      diagnostics.push({ code: "overlapping_sessions", message: "複数店舗の勤務区間が重複しています" });
      break;
    }
  }
  return diagnostics;
}

export function auditAttendance(
  logs: CalculationClockLog[],
  rows: CalculatedAttendanceRow[],
): AttendanceAuditIssue[] {
  const issues: AttendanceAuditIssue[] = rows.flatMap((row) =>
    row.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      employeeKey: row.employeeKey,
      date: row.date,
    })),
  );
  const groups = new Map<string, CalculationClockLog[]>();
  for (const log of logs) {
    const employeeKey = log.employeeId || log.employeeCode || log.employeeName || "unknown";
    const key = `${employeeKey}:${log.storeId}`;
    groups.set(key, [...(groups.get(key) ?? []), log]);
  }
  for (const group of groups.values()) {
    let active = false;
    for (const log of group.slice().sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())) {
      const type = normalizedType(log.type);
      if (type === "clock_in") active = true;
      if (type === "clock_out") {
        if (!active) {
          issues.push({
            code: "orphan_clock_out",
            message: "対応する出勤のない退勤があります",
            employeeKey: log.employeeId || log.employeeCode || log.employeeName || "unknown",
            date: formatWorkDate(log.timestamp),
            storeId: log.storeId,
          });
        }
        active = false;
      }
    }
  }
  return issues;
}

export function aggregateLaborCostByStore(rows: CalculatedAttendanceRow[]) {
  const totals = new Map<string, { amount: number; missing: Set<string> }>();
  for (const row of rows) {
    for (const session of row.sessions) {
      if (!session.clockOut) continue;
      const value = totals.get(session.storeId) ?? { amount: 0, missing: new Set<string>() };
      value.amount += session.wageAmount;
      if (session.isWageMissing) value.missing.add(session.employeeKey);
      totals.set(session.storeId, value);
    }
  }
  return new Map<string, StoreLaborCost>(
    Array.from(totals, ([storeId, value]) => [
      storeId,
      {
        amount: Math.round(value.amount),
        missingWageEmployeeKeys: [...value.missing],
      },
    ]),
  );
}

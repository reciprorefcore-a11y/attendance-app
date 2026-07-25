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
  hourlyWage: unknown;
  lateNightHourlyWage: unknown;
  dailyTransportation: unknown;
  effectiveFrom: string;
  effectiveTo?: string | null;
};

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
};

export type StoreLaborCost = {
  amount: number;
  missingWageEmployeeKeys: string[];
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
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
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
  const cursor = truncateToMinute(start);
  cursor.setHours(0, 0, 0, 0);
  cursor.setDate(cursor.getDate() - 1);

  while (cursor < end) {
    const nightStart = new Date(cursor);
    nightStart.setHours(22, 0, 0, 0);
    const nightEnd = new Date(cursor);
    nightEnd.setDate(nightEnd.getDate() + 1);
    nightEnd.setHours(5, 0, 0, 0);
    let minutes = overlapMinutes(start, end, nightStart, nightEnd);
    for (const item of breaks) {
      minutes -= overlapMinutes(item.start, item.end, nightStart, nightEnd);
    }
    total += Math.max(0, minutes);
    cursor.setDate(cursor.getDate() + 1);
  }
  return total;
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
    byEmployee.set(employeeKey, [...(byEmployee.get(employeeKey) ?? []), log]);
  }

  const sessions: WorkSession[] = [];
  for (const [employeeKey, employeeLogs] of byEmployee) {
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

export function buildAttendanceRows(
  logs: CalculationClockLog[],
  wagesByEmployee: Record<string, CalculationWage[]> = {},
) {
  const sessions = pairWorkSessions(logs);
  const transportationUsed = new Set<string>();

  for (const session of sessions) {
    if (!session.clockOut) continue;
    const date = formatWorkDate(session.clockIn);
    const wage = getApplicableWage(wagesByEmployee[session.employeeId] ?? [], date);
    const transportationKey = `${session.employeeKey}:${date}`;
    const includeTransportation = !transportationUsed.has(transportationKey);
    const cost = calculateEstimatedLaborCost(session, wage, includeTransportation);
    session.wageAmount = cost.amount;
    session.isWageMissing = cost.isWageMissing;
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
        breakMinutes: completed.reduce((sum, session) => sum + session.breakMinutes, 0),
        workMinutes: completed.reduce((sum, session) => sum + session.workMinutes, 0),
        nightMinutes: completed.reduce((sum, session) => sum + session.nightMinutes, 0),
        wageAmount: Math.round(completed.reduce((sum, session) => sum + session.wageAmount, 0)),
        isWageMissing: completed.some((session) => session.isWageMissing),
        isOutsideGps: grouped.some((session) =>
          session.logs.some((log) => log.isOutsideGps === true),
        ),
        isMissingClockOut: grouped.some((session) => !session.clockOut),
        logs: grouped.flatMap((session) => session.logs),
        sessions: grouped,
      } satisfies CalculatedAttendanceRow;
    })
    .sort((a, b) => b.date.localeCompare(a.date) || a.employeeName.localeCompare(b.employeeName));
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

import type { Timestamp } from "firebase/firestore";

export type EmploymentType = "part_time" | "full_time";
export type EmployeeStatus = "pending" | "active" | "rejected" | "inactive";
export type ClockType = "clock_in" | "break_start" | "break_end" | "clock_out";
export type LegacyClockType = "clockIn" | "breakStart" | "breakEnd" | "clockOut";
export type StoredClockType = ClockType | LegacyClockType;

export type Store = {
  name?: string;
  storeCode: string;
  storeName: string;
  logoUrl: string;
  latitude?: number;
  lat: number;
  longitude?: number;
  lng: number;
  gpsRadiusMeters?: number;
  radiusMeter: number;
  helpWage?: number | null;
  helpHourlyWage?: number | null;
  active?: boolean;
  isActive?: boolean;
  gpsEnabled?: boolean;
};

export type Employee = {
  employeeCode: string;
  name: string;
  nameKana: string;
  storeId: string;
  storeName: string;
  employmentType: EmploymentType;
  status: EmployeeStatus;
  createdByStoreId: string;
  approvedBy: string | null;
  approvedAt: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  baseWage?: number | null;
  baseHourlyWage?: number | null;
  pin?: string;
  phone?: string;
  memo?: string;
  isDeleted?: boolean;
  transportationCost?: number;
  transportationType?: "daily" | "monthly";
};

export type WageHistory = {
  hourlyWage: number;
  lateNightHourlyWage: number;
  dailyTransportation: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  approvedBy: string;
  approvedAt: Timestamp;
};

export type GpsResult = {
  lat: number;
  lng: number;
  accuracy: number;
  distanceMeter: number;
};

export type Timecard = {
  storeId: string;
  storeName: string;
  employeeCode: string;
  employeeId?: string;
  employeeName?: string;
  hourlyWageSnapshot?: number | null;
  hourlyWageSnapshotSource?: "store_help" | "employee_base" | "unknown";
  type: StoredClockType;
  createdAt: Timestamp;
  gps?: GpsResult;
  userAgent?: string;
  isManualEdited?: boolean;
  editedBy?: string;
  editedAt?: Timestamp;
  editReason?: string;
  manualEditReason?: string;
  manualEditedBy?: string;
  manualEditedAt?: Timestamp;
  requestedCorrectionReason?: string;
  requestedCorrectionByStoreId?: string;
  requestedCorrectionAt?: Timestamp;
};

export const employmentTypeLabels: Record<EmploymentType, string> = {
  part_time: "アルバイト",
  full_time: "社員",
};

export const statusLabels: Record<EmployeeStatus, string> = {
  pending: "承認待ち",
  active: "有効",
  rejected: "差戻し",
  inactive: "無効",
};

export const clockLabels: Record<StoredClockType, string> = {
  clock_in: "出勤",
  break_start: "休憩開始",
  break_end: "休憩終了",
  clock_out: "退勤",
  clockIn: "出勤",
  breakStart: "休憩開始",
  breakEnd: "休憩終了",
  clockOut: "退勤",
};

export const clockOptions: { value: ClockType; label: string }[] = [
  { value: "clock_in", label: "出勤" },
  { value: "break_start", label: "休憩開始" },
  { value: "break_end", label: "休憩終了" },
  { value: "clock_out", label: "退勤" },
];

export function normalizeClockType(type: StoredClockType): ClockType {
  if (type === "clockIn") return "clock_in";
  if (type === "breakStart") return "break_start";
  if (type === "breakEnd") return "break_end";
  if (type === "clockOut") return "clock_out";
  return type;
}

export function toDateTimeInputValue(date: Date) {
  const offsetDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return offsetDate.toISOString().slice(0, 16);
}

export function formatTimestamp(value: Timestamp | undefined | null) {
  if (!value) return "";

  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value.toDate());
}

export function isWageEffective(wage: WageHistory, workDate: string) {
  return (
    wage.effectiveFrom <= workDate &&
    (wage.effectiveTo === null || wage.effectiveTo >= workDate)
  );
}

export function formatDate(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatSlashDateTime(value: Date) {
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

export function formatClockTime(value: Date | null) {
  if (!value) return "";

  return new Intl.DateTimeFormat("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

export function formatHours(value: number) {
  if (!value) return "";
  return Math.round((value / 60) * 100) / 100;
}

export function getMonthDays(targetMonth: string) {
  const [year, month] = targetMonth.split("-").map(Number);
  const lastDay = new Date(year, month, 0).getDate();

  return Array.from({ length: lastDay }, (_, index) => {
    const day = String(index + 1).padStart(2, "0");
    return `${targetMonth}-${day}`;
  });
}

function overlapMinutes(
  start: Date,
  end: Date,
  rangeStart: Date,
  rangeEnd: Date,
) {
  const from = Math.max(start.getTime(), rangeStart.getTime());
  const to = Math.min(end.getTime(), rangeEnd.getTime());
  return Math.max(0, (to - from) / 60000);
}

export function calculateNightMinutes(start: Date | null, end: Date | null) {
  if (!start || !end || end <= start) return 0;

  let total = 0;
  const cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);

  while (cursor < end) {
    const nightStart = new Date(cursor);
    nightStart.setHours(22, 0, 0, 0);
    const nightEnd = new Date(cursor);
    nightEnd.setDate(nightEnd.getDate() + 1);
    nightEnd.setHours(5, 0, 0, 0);

    total += overlapMinutes(start, end, nightStart, nightEnd);
    cursor.setDate(cursor.getDate() + 1);
  }

  return total;
}

export type DailyAttendance = {
  date: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  storeId: string;
  storeName: string;
  clockIn: Date | null;
  clockOut: Date | null;
  breakMinutes: number;
  workMinutes: number;
  nightMinutes: number;
  gpsDistanceMeter: number | null;
  timecards: (Timecard & { id: string })[];
};

export function buildDailyAttendance(
  timecards: (Timecard & { id: string })[],
) {
  const groups = new Map<string, (Timecard & { id: string })[]>();

  for (const timecard of timecards) {
    if (!timecard.createdAt) continue;
    const date = formatDate(timecard.createdAt.toDate());
    const employeeKey = timecard.employeeId ?? timecard.employeeCode;
    const key = `${date}:${employeeKey}`;
    groups.set(key, [...(groups.get(key) ?? []), timecard]);
  }

  return Array.from(groups.entries()).map(([key, rows]) => {
    const sorted = rows
      .slice()
      .sort(
        (a, b) => a.createdAt.toMillis() - b.createdAt.toMillis(),
      );
    const first = sorted[0];
    const clockIn =
      sorted.find((row) => normalizeClockType(row.type) === "clock_in")?.createdAt.toDate() ??
      null;
    const clockOutRows = sorted.filter(
      (row) => normalizeClockType(row.type) === "clock_out",
    );
    const clockOut =
      clockOutRows[clockOutRows.length - 1]?.createdAt.toDate() ?? null;
    let breakMinutes = 0;
    let breakStart: Date | null = null;

    for (const row of sorted) {
      if (normalizeClockType(row.type) === "break_start") {
        breakStart = row.createdAt.toDate();
      }
      if (normalizeClockType(row.type) === "break_end" && breakStart) {
        const breakEnd = row.createdAt.toDate();
        if (breakEnd > breakStart) {
          breakMinutes += (breakEnd.getTime() - breakStart.getTime()) / 60000;
        }
        breakStart = null;
      }
    }

    const grossMinutes =
      clockIn && clockOut && clockOut > clockIn
        ? (clockOut.getTime() - clockIn.getTime()) / 60000
        : 0;
    const workMinutes = Math.max(0, grossMinutes - breakMinutes);
    const nightMinutes = calculateNightMinutes(clockIn, clockOut);

    return {
      date: key.split(":")[0],
      employeeId: first.employeeId ?? "",
      employeeCode: first.employeeCode,
      employeeName: first.employeeName ?? "",
      storeId: first.storeId,
      storeName: first.storeName,
      clockIn,
      clockOut,
      breakMinutes,
      workMinutes,
      nightMinutes,
      gpsDistanceMeter: first.gps?.distanceMeter ?? null,
      timecards: sorted,
    } satisfies DailyAttendance;
  });
}

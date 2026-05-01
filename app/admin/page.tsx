"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { signOut } from "firebase/auth";
import { auth, db, storage } from "@/lib/firebase";
import { useAuthProfile } from "@/lib/auth";
import {
  Timestamp,
  addDoc,
  collection,
  doc,
  deleteDoc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";
import type { ClockType, Employee, Store } from "@/lib/attendance";

type TabId =
  | "attendance"
  | "employees"
  | "stores"
  | "wages"
  | "edits"
  | "exports";

type TimecardRow = {
  id: string;
  storeId: string;
  storeName?: string;
  employeeCode?: string;
  employeeId?: string | null;
  employeeName?: string;
  type?: string;
  clockType?: string;
  timestamp?: Timestamp | Date | string | null;
  createdAt?: Timestamp | Date | string | null;
  hourlyWageSnapshot?: number | null;
  wageSource?: "store_help" | "employee_base";
  latitude?: number | null;
  longitude?: number | null;
  isOutsideGps?: boolean;
  isManualEdited?: boolean;
  isDeleted?: boolean;
  deletedAt?: Timestamp | null;
  deletedBy?: string | null;
};

type EmployeeRow = Employee & { id: string };
type StoreRow = Store & { id: string };

type AttendanceRow = {
  key: string;
  date: string;
  storeId: string;
  storeName: string;
  employeeKey: string;
  employeeCode: string;
  employeeName: string;
  clockIn: Date | null;
  clockOut: Date | null;
  breakMinutes: number;
  workMinutes: number;
  nightMinutes: number;
  hourlyWageSnapshot: number | null;
  wageAmount: number;
  isOutsideGps: boolean;
  isMissingClockOut: boolean;
  logs: TimecardRow[];
};

const tabs: { id: TabId; label: string }[] = [
  { id: "attendance", label: "勤怠一覧" },
  { id: "employees", label: "従業員管理" },
  { id: "stores", label: "店舗管理" },
  { id: "wages", label: "時給設定" },
  { id: "edits", label: "打刻修正" },
  { id: "exports", label: "Excel出力" },
];

const clockTypeLabels: Record<string, string> = {
  clock_in: "出勤",
  clockIn: "出勤",
  break_start: "休憩開始",
  breakStart: "休憩開始",
  break_end: "休憩終了",
  breakEnd: "休憩終了",
  clock_out: "退勤",
  clockOut: "退勤",
};
const supportedLogoTypes = ["image/png", "image/jpeg", "image/svg+xml"];
const csvEmployeeFields = ["name", "nameKana", "employeeCode", "storeId", "baseHourlyWage", "pin", "status"] as const;

type CsvEmployeeRow = Record<(typeof csvEmployeeFields)[number], string>;
type CsvEmployeeError = { rowNumber: number; message: string; values: CsvEmployeeRow | null };

function parseCsvLine(line: string) {
  const cells: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const nextChar = line[index + 1];

    if (char === '"' && inQuotes && nextChar === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
  }

  cells.push(cell.trim());
  return cells;
}

function toCsvEmployeeRow(headers: string[], values: string[]): CsvEmployeeRow {
  const row = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])) as Record<
    string,
    string
  >;
  return {
    name: row.name ?? "",
    nameKana: row.nameKana ?? "",
    employeeCode: row.employeeCode ?? "",
    storeId: row.storeId ?? "",
    baseHourlyWage: row.baseHourlyWage ?? "",
    pin: row.pin ?? "",
    status: row.status ?? "",
  };
}

function findCsvHeaderIndex(lines: string[]) {
  for (let index = 0; index < Math.min(lines.length, 3); index += 1) {
    const headers = parseCsvLine(lines[index] ?? "");
    if (csvEmployeeFields.every((field) => headers.includes(field))) {
      return { headerIndex: index, headers };
    }
  }
  return null;
}

function buildClockUrl(storeId: string, baseUrl: string) {
  if (!baseUrl) return `/clock?storeId=${encodeURIComponent(storeId)}`;
  return `${baseUrl}/clock?storeId=${encodeURIComponent(storeId)}`;
}

function buildQrImageUrl(storeId: string, baseUrl: string, size = 160) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(
    buildClockUrl(storeId, baseUrl),
  )}`;
}

const productionCheckStores = [
  ["1", { name: "焰 akari", logoUrl: "/assets/icon-akari.png", active: true }],
  ["2", { name: "串羊力", logoUrl: "/assets/icon-kushi.png", active: true }],
  ["3", { name: "Pescaria", logoUrl: "/assets/icon-pes.png", active: true }],
  ["4", { name: "Graine Marche 綱島店", logoUrl: "/assets/icon-gm.png", active: true }],
  ["5", { name: "Graine Marche 野毛店", logoUrl: "/assets/icon-gm.png", active: true }],
] as const;

const productionCheckEmployee = {
  name: "開発テストユーザー",
  nameKana: "かいはつてすとゆーざー",
  employeeCode: "0001",
  storeId: "1",
  baseWage: 1250,
  status: "active",
};

function localMonth() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function toDate(value: TimecardRow["createdAt"]) {
  if (!value) return null;
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (value instanceof Date) return value;
  if ("toDate" in value) return value.toDate();
  return null;
}

function logDate(row: TimecardRow) {
  return toDate(row.timestamp ?? row.createdAt);
}

function getStoreName(store: StoreRow) {
  return store.name || "";
}

function getStoreLogo(store: StoreRow) {
  return store.logoUrl || "";
}

function getStoreLat(store: StoreRow) {
  return store.latitude ?? "";
}

function getStoreLng(store: StoreRow) {
  return store.longitude ?? "";
}

function getStoreRadius(store: StoreRow) {
  return store.gpsRadiusMeters ?? "";
}

function getStoreHelpWage(store: StoreRow) {
  return store.helpWage ?? "";
}

function getEmployeeBaseWage(employee: EmployeeRow) {
  return employee.baseWage ?? employee.baseHourlyWage ?? "";
}

function dateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

function dateTimeInputValue(date: Date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function formatDateTime(date: Date | null) {
  if (!date) return "";
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatTime(date: Date | null) {
  if (!date) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(
    2,
    "0",
  )}`;
}

function formatMinutes(minutes: number) {
  if (minutes <= 0) return "";
  const rounded = Math.round(minutes);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}

function minutesBetween(start: Date, end: Date) {
  return Math.max(0, (end.getTime() - start.getTime()) / 60000);
}

function overlapMinutes(start: Date, end: Date, rangeStart: Date, rangeEnd: Date) {
  const from = Math.max(start.getTime(), rangeStart.getTime());
  const to = Math.min(end.getTime(), rangeEnd.getTime());
  return Math.max(0, (to - from) / 60000);
}

function normalizeClockType(row: TimecardRow) {
  const type = row.type ?? row.clockType ?? "";
  if (type === "clockIn" || type === "in" || type === "start") return "clock_in";
  if (type === "breakStart") return "break_start";
  if (type === "breakEnd") return "break_end";
  if (type === "clockOut" || type === "out" || type === "end") return "clock_out";
  return type;
}

function buildAttendanceRows(timecards: TimecardRow[]) {
  const groups = new Map<string, TimecardRow[]>();

  for (const row of timecards) {
    const date = logDate(row);
    if (!date) continue;
    const employeeKey = row.employeeId || row.employeeCode || row.employeeName || "unknown";
    const key = `${dateKey(date)}:${employeeKey}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  return Array.from(groups.entries())
    .map(([key, rows]) => {
      const sorted = rows.slice().sort((a, b) => {
        const aDate = logDate(a)?.getTime() ?? 0;
        const bDate = logDate(b)?.getTime() ?? 0;
        return aDate - bDate;
      });
      const first = sorted[0];
      const date = logDate(first);
      const clockInRow = sorted.find((row) => normalizeClockType(row) === "clock_in") ?? null;
      const clockOutRows = sorted.filter((row) => normalizeClockType(row) === "clock_out");
      const clockOutRow = clockOutRows[clockOutRows.length - 1] ?? null;
      const clockIn = clockInRow ? logDate(clockInRow) : null;
      const clockOut = clockOutRow ? logDate(clockOutRow) : null;
      const breakRanges: { start: Date; end: Date }[] = [];
      let breakStart: Date | null = null;
      let breakMinutes = 0;

      for (const row of sorted) {
        const type = normalizeClockType(row);
        const rowDate = logDate(row);
        if (!rowDate) continue;
        if (type === "break_start") breakStart = rowDate;
        if (type === "break_end" && breakStart && rowDate > breakStart) {
          breakMinutes += minutesBetween(breakStart, rowDate);
          breakRanges.push({ start: breakStart, end: rowDate });
          breakStart = null;
        }
      }

      let workMinutes = 0;
      let nightMinutes = 0;
      if (clockIn && clockOut && clockOut > clockIn) {
        workMinutes = Math.max(0, minutesBetween(clockIn, clockOut) - breakMinutes);
        const cursor = new Date(clockIn);
        cursor.setHours(0, 0, 0, 0);
        while (cursor < clockOut) {
          const nightStart = new Date(cursor);
          nightStart.setHours(22, 0, 0, 0);
          const nightEnd = new Date(cursor);
          nightEnd.setDate(nightEnd.getDate() + 1);
          nightEnd.setHours(5, 0, 0, 0);
          nightMinutes += overlapMinutes(clockIn, clockOut, nightStart, nightEnd);
          for (const range of breakRanges) {
            nightMinutes -= overlapMinutes(range.start, range.end, nightStart, nightEnd);
          }
          cursor.setDate(cursor.getDate() + 1);
        }
        nightMinutes = Math.max(0, nightMinutes);
      }

      const wageSource = sorted.find((row) => typeof row.hourlyWageSnapshot === "number");
      const hourlyWageSnapshot = wageSource?.hourlyWageSnapshot ?? null;
      const wageAmount =
        typeof hourlyWageSnapshot === "number"
          ? Math.round((workMinutes / 60) * hourlyWageSnapshot)
          : 0;

      return {
        key,
        date: date ? dateKey(date) : "",
        storeId: first.storeId,
        storeName: first.storeId,
        employeeKey: first.employeeId || first.employeeCode || first.employeeName || "",
        employeeCode: first.employeeCode || "",
        employeeName: first.employeeName || "",
        clockIn,
        clockOut,
        breakMinutes,
        workMinutes,
        nightMinutes,
        hourlyWageSnapshot,
        wageAmount,
        isOutsideGps: sorted.some((row) => row.isOutsideGps),
        isMissingClockOut: Boolean(clockIn && !clockOut),
        logs: sorted,
      } satisfies AttendanceRow;
    })
    .sort((a, b) => b.date.localeCompare(a.date) || a.employeeName.localeCompare(b.employeeName));
}

function buildMonthlyRows(
  rows: AttendanceRow[],
  targetMonth: string,
  employees: EmployeeRow[],
  stores: StoreRow[],
  storeFilter: string,
) {
  const [year, month] = targetMonth.split("-").map(Number);
  const lastDay = new Date(year, month, 0).getDate();
  const outputEmployees = employees.filter(
    (employee) => employee.isDeleted !== true && (storeFilter === "all" || employee.storeId === storeFilter),
  );

  const newMonthlyHeaders = [
    "所属店舗ｺｰﾄﾞ", "所属店舗名", "社員ｺｰﾄﾞ", "氏名", "日付",
    "出勤", "退勤", "労働時間", "加算帯1", "加算帯2", "加算帯3", "超過時間",
    "深夜時間", "休憩時間", "ﾍﾙﾌﾟ時間", "休出時間", "勤務区分", "時間手当",
    "その他手当1", "その他手当2", "日交通費", "定期代", "食事代", "靴代",
    "駐車場代", "ユニフォーム", "その他",
  ];

  const bodyRows: (string | number)[][] = [];

  for (const employee of outputEmployees) {
    const store = stores.find((item) => item.id === employee.storeId) ?? null;
    // Find rows for this employee STRICTLY by employeeId
    const employeeRows = rows.filter((r) => r.employeeKey === employee.id);

    let totalWork = 0, totalNight = 0, totalBreak = 0, totalWage = 0;

    for (let day = 1; day <= lastDay; day += 1) {
      const date = `${targetMonth}-${String(day).padStart(2, "0")}`;
      const row = employeeRows.find((r) => r.date === date) ?? null;

      if (row) {
        totalWork += row.workMinutes;
        totalNight += row.nightMinutes;
        totalBreak += row.breakMinutes;
        totalWage += row.wageAmount;
      }

      const dailyCost = employee.transportationType === "daily" ? (employee.transportationCost ?? 0) : 0;
      const monthlyCost = employee.transportationType === "monthly" ? (employee.transportationCost ?? 0) : 0;

      bodyRows.push([
        employee.storeId,
        store ? getStoreName(store) : employee.storeId,
        employee.employeeCode,
        employee.name,
        date.replaceAll("-", "/"),
        row ? formatTime(row.clockIn) : "",
        row ? formatTime(row.clockOut) : "",
        row ? formatMinutes(row.workMinutes) : "",
        "", "", "", "",
        row ? formatMinutes(row.nightMinutes) : "",
        row ? formatMinutes(row.breakMinutes) : "",
        "", "",
        row && row.workMinutes > 0 ? "通常" : "",
        row?.wageAmount || "",
        "", "",
        row && dailyCost > 0 ? dailyCost : "",
        day === 1 && monthlyCost > 0 ? monthlyCost : "",
        "", "", "", "", "",
      ]);
    }

    // "合 計" row for this employee
    bodyRows.push([
      "", "", "", "合 計", "", "", "",
      formatMinutes(totalWork),
      "", "", "", "",
      formatMinutes(totalNight),
      formatMinutes(totalBreak),
      "", "", "",
      totalWage || "",
      "", "", "", "", "", "", "", "", "",
    ]);
  }

  return [
    [`対象年月：${year}年${String(month).padStart(2, "0")}月`],
    newMonthlyHeaders,
    ...bodyRows,
  ];
}

export default function AdminPage() {
  const router = useRouter();
  const { user, profile, isLoading: isAuthLoading, error: authError } = useAuthProfile();
  const [timecards, setTimecards] = useState<TimecardRow[]>([]);
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [stores, setStores] = useState<StoreRow[]>([]);
  const [targetMonth, setTargetMonth] = useState(localMonth());
  const [storeFilter, setStoreFilter] = useState("all");
  const [activeTab, setActiveTab] = useState<TabId>("attendance");
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [editId, setEditId] = useState("");
  const [editForm, setEditForm] = useState({
    type: "clock_in" as ClockType,
    createdAt: "",
    reason: "",
  });
  const [message, setMessage] = useState("");
  const [employeeEditingId, setEmployeeEditingId] = useState("");
  const [employeeForm, setEmployeeForm] = useState({
    name: "",
    nameKana: "",
    employeeCode: "",
    pin: "",
    storeId: "",
    baseWage: "",
    status: "active",
    transportationCost: "",
    transportationType: "daily" as "daily" | "monthly",
  });
  const [storeEditingId, setStoreEditingId] = useState("");
  const [storeForm, setStoreForm] = useState({
    id: "",
    name: "",
    logoUrl: "",
    latitude: "",
    longitude: "",
    gpsRadiusMeters: "100",
    helpWage: "",
    active: true,
    gpsEnabled: true,
  });
  const [logoUploadState, setLogoUploadState] = useState<{
    isUploading: boolean;
    message: string;
    error: string;
  }>({
    isUploading: false,
    message: "",
    error: "",
  });
  const [csvImportErrors, setCsvImportErrors] = useState<CsvEmployeeError[]>([]);
  const [csvImportSummary, setCsvImportSummary] = useState("");
  const [csvImporting, setCsvImporting] = useState(false);

  const isAdmin = profile?.role === "admin";
  const managerStoreId = profile?.role === "manager" ? profile.storeId : "";
  const visibleTabs = isAdmin ? tabs : tabs.filter((tab) => tab.id !== "wages");
  const [appBaseUrl, setAppBaseUrl] = useState(
    process.env.NEXT_PUBLIC_APP_URL ??
      (typeof window !== "undefined" ? window.location.origin : ""),
  );

  const load = async () => {
    if (!profile || (profile.role !== "admin" && profile.role !== "manager")) return;
    setIsLoading(true);
    setErrorMessage("");
    try {
      const [timecardSnapshot, employeeSnapshot, storeSnapshot] = await Promise.all([
        getDocs(query(collection(db, "clockLogs"), orderBy("timestamp", "desc"))),
        getDocs(query(collection(db, "employees"), orderBy("employeeCode"))),
        getDocs(collection(db, "stores")),
      ]);
      const nextTimecards = timecardSnapshot.docs.map((timecardDoc) => ({
          id: timecardDoc.id,
          ...(timecardDoc.data() as Omit<TimecardRow, "id">),
      }));
      const nextEmployees = employeeSnapshot.docs.map((employeeDoc) => ({
          id: employeeDoc.id,
          ...(employeeDoc.data() as Employee),
      }));
      const nextStores = storeSnapshot.docs.map((storeDoc) => ({
          id: storeDoc.id,
          ...(storeDoc.data() as Store),
      }));
      const scopedStoreId = profile.role === "manager" ? profile.storeId : "";

      setTimecards(scopedStoreId ? nextTimecards.filter((row) => row.storeId === scopedStoreId) : nextTimecards);
      setEmployees(scopedStoreId ? nextEmployees.filter((employee) => employee.storeId === scopedStoreId) : nextEmployees);
      setStores(scopedStoreId ? nextStores.filter((store) => store.id === scopedStoreId) : nextStores);
      if (scopedStoreId) setStoreFilter(scopedStoreId);
    } catch (error) {
      console.error("admin dashboard fetch failed", error);
      setErrorMessage("管理画面データの取得に失敗しました。Firebase設定または権限を確認してください。");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isAuthLoading) return;
    if (!user) {
      router.replace("/login");
      return;
    }
    if (!profile) return;
    if (profile.role === "staff") {
      router.replace("/clock");
      return;
    }
    if (profile.role === "manager" && !profile.storeId) {
      return;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthLoading, profile, router, user]);

  useEffect(() => {
    if (appBaseUrl) return;
    if (typeof window === "undefined") return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAppBaseUrl(window.location.origin);
  }, [appBaseUrl]);

  const filteredTimecards = useMemo(
    () =>
      timecards.filter((row) => {
        if (row.isDeleted) return false;
        const date = logDate(row);
        if (!date || !dateKey(date).startsWith(targetMonth)) return false;
        return storeFilter === "all" || row.storeId === storeFilter;
      }),
    [storeFilter, targetMonth, timecards],
  );
  const hasProductionCheckStores = productionCheckStores.every(([storeId]) =>
    stores.some((store) => store.id === storeId && store.active !== false),
  );
  const hasProductionCheckEmployee = employees.some(
    (employee) =>
      employee.id === "dev-user" &&
      employee.storeId === "1" &&
      employee.status === "active",
  );
  const needsProductionCheckData = !hasProductionCheckStores || !hasProductionCheckEmployee;
  const attendanceRows = useMemo(() => buildAttendanceRows(filteredTimecards), [filteredTimecards]);
  const todayKey = dateKey(new Date());
  const summary = useMemo(() => {
    const todayPunches = timecards.filter((row) => {
      const date = logDate(row);
      return date && dateKey(date) === todayKey;
    }).length;
    const notClockedOut = attendanceRows.filter((row) => row.clockIn && !row.clockOut).length;
    const workMinutes = attendanceRows.reduce((sum, row) => sum + row.workMinutes, 0);
    const wageAmount = attendanceRows.reduce((sum, row) => sum + row.wageAmount, 0);
    return { todayPunches, notClockedOut, workMinutes, wageAmount };
  }, [attendanceRows, timecards, todayKey]);
  const editTarget = timecards.find((row) => row.id === editId) ?? null;
  const storeNameById = (storeId: string) =>
    getStoreName(stores.find((store) => store.id === storeId) ?? ({ id: storeId } as StoreRow)) ||
    storeId;

  const startEdit = (row: TimecardRow) => {
    const date = logDate(row) ?? new Date();
    setEditId(row.id);
    setEditForm({
      type: normalizeClockType(row) as ClockType,
      createdAt: dateTimeInputValue(date),
      reason: "",
    });
    setMessage("");
    setActiveTab("edits");
  };

  const saveEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editTarget) return;
    if (!editForm.reason.trim()) {
      setMessage("修正理由を入力してください。");
      return;
    }

    const before = {
      type: normalizeClockType(editTarget),
      timestamp: logDate(editTarget)?.toISOString() ?? "",
    };
    const after = {
      type: editForm.type,
      timestamp: new Date(editForm.createdAt).toISOString(),
    };

    try {
      await updateDoc(doc(db, "clockLogs", editTarget.id), {
        type: editForm.type,
        timestamp: Timestamp.fromDate(new Date(editForm.createdAt)),
        isManualEdited: true,
        updatedAt: serverTimestamp(),
        updatedBy: "admin",
        editReason: editForm.reason.trim(),
      });
      await addDoc(collection(db, "auditLogs"), {
        targetLogId: editTarget.id,
        before,
        after,
        reason: editForm.reason.trim(),
        updatedAt: serverTimestamp(),
        updatedBy: "admin",
      });
      setMessage("打刻を修正しました。");
      setEditId("");
      await load();
    } catch (error) {
      console.error("timecard edit failed", error);
      setMessage("打刻修正に失敗しました。");
    }
  };

  const deleteTimecard = async (row: TimecardRow) => {
    const confirmed = window.confirm("この打刻を削除しますか？");
    if (!confirmed) return;
    try {
      await updateDoc(doc(db, "clockLogs", row.id), {
        isDeleted: true,
        deletedAt: serverTimestamp(),
        deletedBy: user?.uid ?? "admin",
      });
      setMessage("打刻を削除しました。");
      await load();
    } catch (error) {
      console.error("timecard delete failed", error);
      setMessage("打刻の削除に失敗しました。");
    }
  };

  const downloadExcel = async () => {
    const XLSX = await import("xlsx");
    const rows = buildMonthlyRows(attendanceRows, targetMonth, employees, stores, storeFilter);
    const worksheet = XLSX.utils.aoa_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "temp");
    const buffer = XLSX.write(workbook, { bookType: "xlsx", type: "array" });
    const blob = new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `attendance_${targetMonth}.xlsx`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const createProductionCheckData = async () => {
    try {
      await Promise.all([
        ...productionCheckStores.map(([storeId, store]) =>
          setDoc(doc(db, "stores", storeId), store, { merge: true }),
        ),
        setDoc(doc(db, "employees", "dev-user"), productionCheckEmployee, { merge: true }),
      ]);
      setMessage("確認用の店舗と従業員を作成しました。");
      await load();
      setActiveTab("stores");
    } catch (error) {
      console.error("production check seed failed", error);
      setMessage("確認用データの作成に失敗しました。Firestore rules またはFirebase設定を確認してください。");
    }
  };

  const saveEmployee = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextStoreId = managerStoreId || employeeForm.storeId;
    if (!employeeForm.name.trim() || !employeeForm.employeeCode.trim() || !nextStoreId) {
      setMessage("従業員の氏名、社員コード、所属店舗を入力してください。");
      return;
    }
    if (!/^\d{4}$/.test(employeeForm.pin.trim())) {
      setMessage("PINは4桁の数字で入力してください。");
      return;
    }
    if (managerStoreId && employeeEditingId) {
      const target = employees.find((employee) => employee.id === employeeEditingId);
      if (!target || target.storeId !== managerStoreId) {
        setMessage("自店舗以外の従業員は編集できません。");
        return;
      }
    }
    const payload = {
      name: employeeForm.name.trim(),
      nameKana: employeeForm.nameKana.trim(),
      employeeCode: employeeForm.employeeCode.trim(),
      pin: employeeForm.pin.trim(),
      storeId: nextStoreId,
      baseWage: Number(employeeForm.baseWage) || 0,
      status: employeeForm.status as "active" | "inactive",
      transportationCost: Number(employeeForm.transportationCost) || 0,
      transportationType: employeeForm.transportationType,
    };
    try {
      if (employeeEditingId) {
        await updateDoc(doc(db, "employees", employeeEditingId), payload);
      } else {
        await addDoc(collection(db, "employees"), payload);
      }
      setEmployeeEditingId("");
      setEmployeeForm({ name: "", nameKana: "", employeeCode: "", pin: "", storeId: "", baseWage: "", status: "active", transportationCost: "", transportationType: "daily" });
      setMessage("従業員を保存しました。");
      await load();
    } catch (error) {
      console.error("employee save failed", error);
      setMessage("従業員の保存に失敗しました。");
    }
  };

  const editEmployee = (employee: EmployeeRow) => {
    setEmployeeEditingId(employee.id);
    setEmployeeForm({
      name: employee.name,
      nameKana: employee.nameKana,
      employeeCode: employee.employeeCode,
      pin: employee.pin ?? "",
      storeId: employee.storeId,
      baseWage: String(getEmployeeBaseWage(employee) || ""),
      status: employee.status === "inactive" ? "inactive" : "active",
      transportationCost: String(employee.transportationCost || ""),
      transportationType: employee.transportationType ?? "daily",
    });
    setActiveTab("employees");
  };

  const deleteEmployee = async (employee: EmployeeRow) => {
    const confirmed = window.confirm(`${employee.name} を削除しますか？この操作は取り消せません。`);
    if (!confirmed) return;
    try {
      await updateDoc(doc(db, "employees", employee.id), { isDeleted: true });
      setMessage("従業員を削除しました。");
      await load();
    } catch (error) {
      console.error("employee delete failed", error);
      setMessage("従業員の削除に失敗しました。");
    }
  };

  const saveStore = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextStoreId = managerStoreId || storeForm.id.trim();
    if (!nextStoreId || !storeForm.name.trim()) {
      setMessage("店舗IDと店舗名を入力してください。");
      return;
    }
    if (managerStoreId && nextStoreId !== managerStoreId) {
      setMessage("自店舗以外の店舗は編集できません。");
      return;
    }
    const payload = {
      name: storeForm.name.trim(),
      logoUrl: storeForm.logoUrl.trim(),
      latitude: Number(storeForm.latitude) || 0,
      longitude: Number(storeForm.longitude) || 0,
      gpsRadiusMeters: Number(storeForm.gpsRadiusMeters) || 100,
      helpWage: storeForm.helpWage ? Number(storeForm.helpWage) : null,
      active: storeForm.active,
      gpsEnabled: storeForm.gpsEnabled,
    };
    try {
      await setDoc(doc(db, "stores", nextStoreId), payload, { merge: true });
      setStoreEditingId("");
      setStoreForm({ id: "", name: "", logoUrl: "", latitude: "", longitude: "", gpsRadiusMeters: "100", helpWage: "", active: true, gpsEnabled: true });
      setMessage("店舗を保存しました。");
      await load();
    } catch (error) {
      console.error("store save failed", error);
      setMessage("店舗の保存に失敗しました。");
    }
  };

  const editStore = (store: StoreRow) => {
    setStoreEditingId(store.id);
    setLogoUploadState({ isUploading: false, message: "", error: "" });
    setStoreForm({
      id: store.id,
      name: getStoreName(store),
      logoUrl: getStoreLogo(store),
      latitude: String(getStoreLat(store) || ""),
      longitude: String(getStoreLng(store) || ""),
      gpsRadiusMeters: String(getStoreRadius(store) || "100"),
      helpWage: String(getStoreHelpWage(store) || ""),
      active: store.active !== false,
      gpsEnabled: store.gpsEnabled !== false,
    });
    setActiveTab("stores");
  };

  const uploadStoreLogo = async (file: File) => {
    const storeId = managerStoreId || storeForm.id.trim();
    if (!storeId) {
      setLogoUploadState({
        isUploading: false,
        message: "",
        error: "先にstoreIdを入力してください。",
      });
      return;
    }
    if (managerStoreId && storeId !== managerStoreId) {
      setLogoUploadState({
        isUploading: false,
        message: "",
        error: "自店舗以外のロゴは変更できません。",
      });
      return;
    }
    if (!supportedLogoTypes.includes(file.type)) {
      setLogoUploadState({
        isUploading: false,
        message: "",
        error: "png / jpg / svg の画像を選択してください。",
      });
      return;
    }

    setLogoUploadState({ isUploading: true, message: "", error: "" });
    try {
      const storageRef = ref(storage, `store-logos/${storeId}.png`);
      await uploadBytes(storageRef, file, { contentType: file.type });
      const logoUrl = await getDownloadURL(storageRef);
      await setDoc(doc(db, "stores", storeId), { logoUrl }, { merge: true });
      setStoreForm((current) => ({ ...current, logoUrl }));
      setLogoUploadState({ isUploading: false, message: "アップロード完了", error: "" });
      await load();
    } catch (error) {
      console.error("store logo upload failed", error);
      setLogoUploadState({
        isUploading: false,
        message: "",
        error: "ロゴ画像のアップロードに失敗しました。",
      });
    }
  };

  const saveCurrentLocation = () => {
    const storeId = managerStoreId || storeForm.id.trim();
    if (!storeId) {
      setMessage("先にstoreIdを入力してください。");
      return;
    }
    if (!navigator.geolocation) {
      setMessage("このブラウザでは現在地を取得できません。");
      return;
    }

    setMessage("現在地を取得しています。");
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const latitude = position.coords.latitude;
        const longitude = position.coords.longitude;
        setStoreForm((current) => ({
          ...current,
          id: storeId,
          latitude: String(latitude),
          longitude: String(longitude),
        }));
        try {
          await setDoc(doc(db, "stores", storeId), { latitude, longitude }, { merge: true });
          setMessage("現在地の緯度経度を保存しました。");
          await load();
        } catch (error) {
          console.error("store location save failed", error);
          setMessage("現在地の保存に失敗しました。");
        }
      },
      () => {
        setMessage("現在地を取得できませんでした。");
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    );
  };

  const importEmployeesFromCsv = async (file: File) => {
    setCsvImportErrors([]);
    setCsvImportSummary("");
    setCsvImporting(true);

    try {
      const text = await file.text();
      const lines = text
        .replace(/^\uFEFF/, "")
        .split(/\r?\n/)
        .filter((line) => line.trim());

      const headerInfo = findCsvHeaderIndex(lines);
      if (!headerInfo) {
        setCsvImportErrors([
          {
            rowNumber: 0,
            message: "2行目に name, nameKana, employeeCode, storeId, baseHourlyWage, pin, status のキー行が必要です。",
            values: null,
          },
        ]);
        return;
      }

      const { headerIndex, headers } = headerInfo;
      const dataLines = lines.slice(headerIndex + 1);
      const validRows: { rowNumber: number; values: CsvEmployeeRow }[] = [];
      const errors: CsvEmployeeError[] = [];

      for (const [offset, line] of dataLines.entries()) {
        const rowNumber = headerIndex + offset + 2;
        const values = toCsvEmployeeRow(headers, parseCsvLine(line));
        const rowErrors: string[] = [];

        if (!values.name.trim()) rowErrors.push("name は必須です");
        if (!values.employeeCode.trim()) rowErrors.push("employeeCode は必須です");
        if (!values.storeId.trim()) rowErrors.push("storeId は必須です");
        if (!values.pin.trim()) rowErrors.push("pin は必須です");
        if (!values.status.trim()) rowErrors.push("status は必須です");
        if (values.pin && !/^\d{4}$/.test(values.pin.trim())) rowErrors.push("pin は4桁数字のみ許可です");
        if (values.status && !["active", "inactive", "pending", "rejected"].includes(values.status.trim())) {
          rowErrors.push("status は active / inactive / pending / rejected のいずれかです");
        }
        if (values.baseHourlyWage && Number.isNaN(Number(values.baseHourlyWage))) {
          rowErrors.push("baseHourlyWage が数値ではありません");
        }

        if (rowErrors.length > 0) {
          errors.push({
            rowNumber,
            message: rowErrors.join(" / "),
            values,
          });
          continue;
        }

        validRows.push({ rowNumber, values });
      }

      for (const row of validRows) {
        await addDoc(collection(db, "employees"), {
          name: row.values.name.trim(),
          nameKana: row.values.nameKana.trim(),
          employeeCode: row.values.employeeCode.trim(),
          storeId: managerStoreId || row.values.storeId.trim(),
          baseWage: Number(row.values.baseHourlyWage) || 0,
          pin: row.values.pin.trim(),
          status: row.values.status.trim(),
        });
      }

      setCsvImportErrors(errors);
      setCsvImportSummary(
        `${validRows.length}件を登録しました。${errors.length > 0 ? `${errors.length}件はスキップしました。` : ""}`,
      );
      await load();
      setMessage("CSV取込が完了しました。");
    } catch (error) {
      console.error("employee csv import failed", error);
      setCsvImportErrors([
        {
          rowNumber: 0,
          message: "CSV読込に失敗しました。",
          values: null,
        },
      ]);
    } finally {
      setCsvImporting(false);
    }
  };

  const deleteStore = async (store: StoreRow) => {
    const confirmed = window.confirm("本当に削除しますか？");
    if (!confirmed) return;
    try {
      await deleteDoc(doc(db, "stores", store.id));
      setMessage("店舗を削除しました。");
      await load();
    } catch (error) {
      console.error("store delete failed", error);
      setMessage("店舗の削除に失敗しました。");
    }
  };

  if (isAuthLoading) {
    return <main style={styles.page}><p style={styles.panel}>ログイン確認中</p></main>;
  }

  if (authError) {
    return <main style={styles.page}><p style={styles.error}>{authError}</p></main>;
  }

  if (!profile || (profile.role !== "admin" && profile.role !== "manager")) {
    return <main style={styles.page}><p style={styles.panel}>権限を確認しています</p></main>;
  }

  if (profile.role === "manager" && !profile.storeId) {
    return <main style={styles.page}><p style={styles.error}>店長アカウントに storeId が設定されていません。</p></main>;
  }

  return (
    <main style={styles.page}>
      <style>{`
        @media (max-width: 860px) {
          .admin-layout {
            grid-template-columns: 1fr !important;
          }
          .admin-sidebar {
            position: static !important;
            min-height: auto !important;
          }
          .admin-side-nav {
            display: none !important;
          }
          .admin-mobile-nav {
            display: flex !important;
          }
          .admin-header {
            align-items: stretch !important;
          }
          .admin-controls {
            width: 100% !important;
          }
          .admin-controls > label,
          .admin-controls > button {
            flex: 1 1 180px !important;
          }
          .admin-summary-grid {
            grid-template-columns: 1fr !important;
          }
          .admin-main-tabs {
            display: none !important;
          }
        }
      `}</style>
      <div className="admin-layout" style={styles.layout}>
        <aside className="admin-sidebar" style={styles.sidebar}>
          <div>
            <p style={styles.sidebarEyebrow}>{isAdmin ? "本部管理" : "店舗管理"}</p>
            <h2 style={styles.sidebarTitle}>勤怠ダッシュボード</h2>
          </div>
          <nav className="admin-side-nav" style={styles.sideNav}>
            {visibleTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                style={activeTab === tab.id ? styles.activeSideNavButton : styles.sideNavButton}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        </aside>

        <div style={styles.shell}>
        <header className="admin-header" style={styles.header}>
          <div style={styles.brandBlock}>
            <div style={styles.logoFrame}>
              <Image
                src="/assets/logo.png"
                alt="FUBLEV"
                width={140}
                height={40}
                priority
                style={styles.headerLogo}
              />
            </div>
            <div>
              <p style={styles.headerEyebrow}>Headquarters</p>
              <h1 style={styles.title}>本部管理画面</h1>
            </div>
          </div>
          <div className="admin-controls" style={styles.controls}>
            <label style={styles.label}>
              対象年月
              <input
                type="month"
                value={targetMonth}
                onChange={(event) => setTargetMonth(event.target.value)}
                style={styles.input}
              />
            </label>
            <label style={styles.label}>
              店舗
              <select
                value={storeFilter}
                onChange={(event) => setStoreFilter(isAdmin ? event.target.value : managerStoreId)}
                disabled={!isAdmin}
                style={styles.input}
              >
                {isAdmin && <option value="all">全店舗</option>}
                {stores.map((store) => (
                  <option key={store.id} value={store.id}>
                    {getStoreName(store)}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" onClick={downloadExcel} style={styles.button}>
              Excel出力
            </button>
            <button
              type="button"
              onClick={async () => {
                await signOut(auth);
                router.replace("/login");
              }}
              style={styles.secondaryButton}
            >
              ログアウト
            </button>
          </div>
        </header>

        <nav className="admin-mobile-nav" style={styles.mobileTabs}>
          {visibleTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              style={activeTab === tab.id ? styles.activeTab : styles.tab}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        {errorMessage && <p style={styles.error}>{errorMessage}</p>}
        {isLoading && <p style={styles.panel}>読み込み中</p>}

        <section className="admin-summary-grid" style={styles.summaryGrid}>
          <SummaryCard label="本日打刻数" value={`${summary.todayPunches}件`} />
          <SummaryCard label="未退勤人数" value={`${summary.notClockedOut}人`} />
          <SummaryCard label="今月総労働時間" value={formatMinutes(summary.workMinutes) || "0:00"} />
          <SummaryCard label="今月概算人件費" value={`${summary.wageAmount.toLocaleString()}円`} />
        </section>

        <section style={styles.mainCard}>
          <nav className="admin-main-tabs" style={styles.tabs}>
            {visibleTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                style={activeTab === tab.id ? styles.activeTab : styles.tab}
              >
                {tab.label}
              </button>
            ))}
          </nav>

        {activeTab === "attendance" && (
          <section style={styles.tabPanel}>
            <h2 style={styles.sectionTitle}>勤怠一覧</h2>
            <DataTable
              headers={[
                "日付",
                "店舗名",
                "従業員名",
                "出勤",
                "退勤",
                "休憩",
                "労働時間",
                "深夜時間",
                "適用時給",
                "概算給与",
                "GPS範囲外",
                "操作",
              ]}
            >
              {attendanceRows.map((row) => (
                <tr key={row.key} style={row.isOutsideGps ? styles.warningRow : undefined}>
                  <td style={styles.td}>{row.date}</td>
                  <td style={styles.td}>{storeNameById(row.storeId)}</td>
                  <td style={row.isMissingClockOut ? styles.dangerTd : styles.td}>
                    {row.employeeName || row.employeeKey}
                    {row.isMissingClockOut && <span style={styles.dangerBadge}>未退勤</span>}
                  </td>
                  <td style={styles.td}>{formatTime(row.clockIn)}</td>
                  <td style={styles.td}>{formatTime(row.clockOut)}</td>
                  <td style={styles.td}>{formatMinutes(row.breakMinutes)}</td>
                  <td style={styles.td}>{formatMinutes(row.workMinutes)}</td>
                  <td style={styles.td}>{formatMinutes(row.nightMinutes)}</td>
                  <td style={styles.td}>{row.hourlyWageSnapshot ?? ""}</td>
                  <td style={styles.td}>{row.wageAmount ? row.wageAmount.toLocaleString() : ""}</td>
                  <td style={styles.td}>{row.isOutsideGps ? "範囲外" : ""}</td>
                  <td style={styles.td}>
                    {row.logs[0] && (
                      <button type="button" onClick={() => startEdit(row.logs[0])} style={styles.linkButton}>
                        修正
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </DataTable>
            {attendanceRows.length === 0 && <p style={styles.empty}>データがありません</p>}
          </section>
        )}

        {activeTab === "employees" && (
          <section style={styles.tabPanel}>
            <div style={styles.panelHeader}>
              <h2 style={styles.sectionTitle}>従業員管理</h2>
              <div style={styles.inlineActions}>
                <button
                  type="button"
                  onClick={() => {
                    setEmployeeEditingId("");
                    setEmployeeForm({ name: "", nameKana: "", employeeCode: "", pin: "", storeId: "", baseWage: "", status: "active", transportationCost: "", transportationType: "daily" });
                  }}
                  style={styles.secondaryButton}
                >
                  新規登録
                </button>
                <label style={styles.secondaryButton}>
                  {csvImporting ? "CSV取込中..." : "CSV一括登録"}
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    disabled={csvImporting}
                    style={{ display: "none" }}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (!file) return;
                      event.target.value = "";
                      void importEmployeesFromCsv(file);
                    }}
                  />
                </label>
              </div>
            </div>
            {csvImportSummary && <p style={styles.message}>{csvImportSummary}</p>}
            {csvImportErrors.length > 0 && (
              <section style={styles.tabPanel}>
                <h3 style={styles.subTitle}>CSVエラー一覧</h3>
                <DataTable headers={["行", "エラー", "name", "employeeCode", "storeId", "pin", "status"]}>
                  {csvImportErrors.map((error) => (
                    <tr key={`${error.rowNumber}-${error.message}`}>
                      <td style={styles.td}>{error.rowNumber || "-"}</td>
                      <td style={styles.dangerTd}>{error.message}</td>
                      <td style={styles.td}>{error.values?.name ?? ""}</td>
                      <td style={styles.td}>{error.values?.employeeCode ?? ""}</td>
                      <td style={styles.td}>{error.values?.storeId ?? ""}</td>
                      <td style={styles.td}>{error.values?.pin ?? ""}</td>
                      <td style={styles.td}>{error.values?.status ?? ""}</td>
                    </tr>
                  ))}
                </DataTable>
              </section>
            )}
            <form onSubmit={saveEmployee} style={styles.editForm}>
              <label style={styles.label}>氏名<input value={employeeForm.name} onChange={(e) => setEmployeeForm({ ...employeeForm, name: e.target.value })} style={styles.input} /></label>
              <label style={styles.label}>ひらがな<input value={employeeForm.nameKana} onChange={(e) => setEmployeeForm({ ...employeeForm, nameKana: e.target.value })} style={styles.input} /></label>
              <label style={styles.label}>社員コード<input value={employeeForm.employeeCode} onChange={(e) => setEmployeeForm({ ...employeeForm, employeeCode: e.target.value })} style={styles.input} /></label>
              <label style={styles.label}>PIN（4桁）<input inputMode="numeric" maxLength={4} pattern="[0-9]{4}" value={employeeForm.pin} onChange={(e) => setEmployeeForm({ ...employeeForm, pin: e.target.value.replace(/\D/g, "").slice(0, 4) })} style={styles.input} /></label>
              <label style={styles.label}>所属店舗
                <select
                  value={managerStoreId || employeeForm.storeId}
                  disabled={Boolean(managerStoreId)}
                  onChange={(e) => setEmployeeForm({ ...employeeForm, storeId: e.target.value })}
                  style={styles.input}
                >
                  <option value="">選択</option>
                  {stores.map((store) => <option key={store.id} value={store.id}>{getStoreName(store)}</option>)}
                </select>
              </label>
              <label style={styles.label}>基本時給<input type="number" value={employeeForm.baseWage} onChange={(e) => setEmployeeForm({ ...employeeForm, baseWage: e.target.value })} style={styles.input} /></label>
              <label style={styles.label}>status
                <select value={employeeForm.status} onChange={(e) => setEmployeeForm({ ...employeeForm, status: e.target.value })} style={styles.input}>
                  <option value="active">active</option>
                  <option value="inactive">inactive</option>
                </select>
              </label>
              <label style={styles.label}>交通費（円）<input type="number" value={employeeForm.transportationCost} onChange={(e) => setEmployeeForm({ ...employeeForm, transportationCost: e.target.value })} style={styles.input} /></label>
              <label style={styles.label}>交通費種別
                <select value={employeeForm.transportationType} onChange={(e) => setEmployeeForm({ ...employeeForm, transportationType: e.target.value as "daily" | "monthly" })} style={styles.input}>
                  <option value="daily">日割り</option>
                  <option value="monthly">定期代</option>
                </select>
              </label>
              <button type="submit" style={styles.button}>{employeeEditingId ? "更新" : "登録"}</button>
            </form>
            <DataTable headers={["社員コード", "氏名", "ひらがな", "所属店舗", "状態", "基本時給", "交通費", "操作"]}>
              {employees.filter(e => e.isDeleted !== true).map((employee) => (
                <tr key={employee.id}>
                  <td style={styles.td}>{employee.employeeCode}</td>
                  <td style={styles.td}>{employee.name}</td>
                  <td style={styles.td}>{employee.nameKana}</td>
                  <td style={styles.td}>{storeNameById(employee.storeId)}</td>
                  <td style={styles.td}><span style={employee.status === "active" ? styles.activeBadge : styles.inactiveBadge}>{employee.status === "active" ? "有効" : "無効"}</span></td>
                  <td style={styles.td}>{getEmployeeBaseWage(employee)}</td>
                  <td style={styles.td}>{employee.transportationCost ? `${employee.transportationCost}円/${employee.transportationType === "monthly" ? "月" : "日"}` : ""}</td>
                  <td style={styles.td}>
                    <button type="button" onClick={() => editEmployee(employee)} style={styles.linkButton}>編集</button>
                    <button type="button" onClick={async () => { await updateDoc(doc(db, "employees", employee.id), { status: "inactive" }); await load(); }} style={styles.linkButton}>無効化</button>
                    <button type="button" onClick={() => deleteEmployee(employee)} style={{...styles.linkButton, color: "#B91C1C", borderColor: "#FCA5A5", background: "#FEF2F2"}}>削除</button>
                  </td>
                </tr>
              ))}
            </DataTable>
          </section>
        )}

        {activeTab === "stores" && (
          <section style={styles.tabPanel}>
            <div style={styles.panelHeader}>
              <h2 style={styles.sectionTitle}>店舗管理</h2>
              {isAdmin && needsProductionCheckData && (
                <button type="button" onClick={createProductionCheckData} style={styles.secondaryButton}>
                  確認用店舗データ作成
                </button>
              )}
            </div>
            {isAdmin && needsProductionCheckData && (
              <p style={styles.helpText}>
                /clock?storeId=1〜5 の確認に必要な stores/1〜5 と employees/dev-user を作成できます。
              </p>
            )}
            <form onSubmit={saveStore} style={styles.editForm}>
              <label style={styles.label}>storeId<input value={managerStoreId || storeForm.id} disabled={Boolean(storeEditingId) || Boolean(managerStoreId)} onChange={(e) => setStoreForm({ ...storeForm, id: e.target.value })} style={styles.input} /></label>
              <label style={styles.label}>店舗名<input value={storeForm.name} onChange={(e) => setStoreForm({ ...storeForm, name: e.target.value })} style={styles.input} /></label>
              <div style={styles.logoUploadBox}>
                <span style={styles.labelText}>ロゴ画像</span>
                {storeForm.logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={storeForm.logoUrl} alt={storeForm.name || "店舗ロゴ"} style={styles.logoPreviewLarge} />
                ) : (
                  <div style={styles.logoPlaceholder}>ロゴ未登録</div>
                )}
                <label style={styles.uploadButton}>
                  {logoUploadState.isUploading ? "アップロード中..." : "ロゴ画像アップロード"}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/svg+xml"
                    disabled={logoUploadState.isUploading}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      if (file) uploadStoreLogo(file);
                    }}
                    style={styles.fileInput}
                  />
                </label>
                {logoUploadState.message && <span style={styles.uploadSuccess}>{logoUploadState.message}</span>}
                {logoUploadState.error && <span style={styles.uploadError}>{logoUploadState.error}</span>}
              </div>
              <label style={styles.label}>緯度<input type="number" step="any" value={storeForm.latitude} onChange={(e) => setStoreForm({ ...storeForm, latitude: e.target.value })} style={styles.input} /></label>
              <label style={styles.label}>経度<input type="number" step="any" value={storeForm.longitude} onChange={(e) => setStoreForm({ ...storeForm, longitude: e.target.value })} style={styles.input} /></label>
              <button type="button" onClick={saveCurrentLocation} style={styles.secondaryButton}>現在地取得</button>
              <label style={styles.label}>GPS半径<input type="number" value={storeForm.gpsRadiusMeters} onChange={(e) => setStoreForm({ ...storeForm, gpsRadiusMeters: e.target.value })} style={styles.input} /></label>
              <label style={styles.label}>ヘルプ時給<input type="number" value={storeForm.helpWage} onChange={(e) => setStoreForm({ ...storeForm, helpWage: e.target.value })} style={styles.input} /></label>
              <label style={styles.label}>active
                <select value={storeForm.active ? "true" : "false"} onChange={(e) => setStoreForm({ ...storeForm, active: e.target.value === "true" })} style={styles.input}>
                  <option value="true">active</option>
                  <option value="false">inactive</option>
                </select>
              </label>
              <label style={styles.label}>GPS打刻チェック
                <select value={storeForm.gpsEnabled ? "true" : "false"} onChange={(e) => setStoreForm({ ...storeForm, gpsEnabled: e.target.value === "true" })} style={styles.input}>
                  <option value="true">ON（GPS確認あり）</option>
                  <option value="false">OFF（GPS確認なし）</option>
                </select>
              </label>
              <button type="submit" style={styles.button}>{storeEditingId ? "更新" : "登録"}</button>
            </form>
            <DataTable
              headers={[
                "店舗名",
                "storeId",
                "緯度経度",
                "GPS許可半径",
                "GPS",
                "ロゴ",
                "QR打刻URL",
                "QRコード",
                "QR画像",
                "操作",
              ]}
            >
              {stores.map((store) => {
                const qrUrl = buildClockUrl(store.id, appBaseUrl);
                const qrImageUrl = buildQrImageUrl(store.id, appBaseUrl, 180);
                return (
                  <tr key={store.id}>
                    <td style={styles.td}>{getStoreName(store)}</td>
                    <td style={styles.td}>{store.id}</td>
                    <td style={styles.td}>{getStoreLat(store)}, {getStoreLng(store)}</td>
                    <td style={styles.td}>{getStoreRadius(store)}m</td>
                    <td style={styles.td}><span style={store.gpsEnabled === false ? styles.inactiveBadge : styles.activeBadge}>{store.gpsEnabled === false ? "GPS無効" : "GPS有効"}</span></td>
                    <td style={styles.td}>
                      {store.logoUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={store.logoUrl} alt={getStoreName(store)} style={styles.logoPreview} />
                      ) : (
                        <span style={styles.logoPlaceholderSmall}>未登録</span>
                      )}
                    </td>
                    <td style={styles.td}>{qrUrl}</td>
                    <td style={styles.td}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={qrImageUrl} alt={`${getStoreName(store)} QRコード`} style={styles.qrImage} />
                    </td>
                    <td style={styles.td}>
                      <button
                        type="button"
                        onClick={() => navigator.clipboard?.writeText(qrUrl)}
                        style={styles.linkButton}
                      >
                        コピー
                      </button>
                      <a href={buildQrImageUrl(store.id, appBaseUrl, 640)} download={`clock-store-${store.id}.png`} style={styles.linkAnchor}>
                        ダウンロード
                      </a>
                    </td>
                    <td style={styles.td}>
                      <button type="button" onClick={() => editStore(store)} style={styles.linkButton}>編集</button>
                      <button type="button" onClick={() => deleteStore(store)} style={styles.linkButton}>削除</button>
                    </td>
                  </tr>
                );
              })}
            </DataTable>
          </section>
        )}

        {activeTab === "wages" && (
          <section style={styles.tabPanel}>
            <h2 style={styles.sectionTitle}>時給設定</h2>
            <p style={styles.helpText}>
              従業員ごとの基本時給と店舗別ヘルプ時給を確認します。例：A店1250円、C店勤務時1300円。打刻時は適用時給を hourlyWageSnapshot に保存します。
            </p>
            <div style={styles.twoColumns}>
              <div>
                <h3 style={styles.subTitle}>従業員 基本時給</h3>
                <DataTable headers={["社員コード", "氏名", "基本時給"]}>
                  {employees.map((employee) => (
                    <tr key={employee.id}>
                      <td style={styles.td}>{employee.employeeCode}</td>
                      <td style={styles.td}>{employee.name}</td>
                      <td style={styles.td}>{getEmployeeBaseWage(employee)}</td>
                    </tr>
                  ))}
                </DataTable>
              </div>
              <div>
                <h3 style={styles.subTitle}>店舗 ヘルプ時給</h3>
                <DataTable headers={["店舗名", "ヘルプ時給"]}>
                  {stores.map((store) => (
                    <tr key={store.id}>
                      <td style={styles.td}>{getStoreName(store)}</td>
                      <td style={styles.td}>{getStoreHelpWage(store)}</td>
                    </tr>
                  ))}
                </DataTable>
              </div>
            </div>
          </section>
        )}

        {activeTab === "edits" && (
          <section style={styles.tabPanel}>
            <h2 style={styles.sectionTitle}>打刻修正</h2>
            <DataTable headers={["日時", "従業員", "店舗", "種別", "操作"]}>
              {filteredTimecards.slice(0, 80).map((row) => (
                <tr key={row.id}>
                  <td style={styles.td}>{formatDateTime(logDate(row))}</td>
                  <td style={styles.td}>{row.employeeName || row.employeeId || row.employeeCode}</td>
                  <td style={styles.td}>{storeNameById(row.storeId)}</td>
                  <td style={styles.td}>{clockTypeLabels[normalizeClockType(row)] ?? normalizeClockType(row)}</td>
                  <td style={styles.td}>
                    <button type="button" onClick={() => startEdit(row)} style={styles.linkButton}>修正</button>
                    <button type="button" onClick={() => deleteTimecard(row)} style={{...styles.linkButton, marginLeft: 8, color: "#B91C1C", borderColor: "#FCA5A5", background: "#FEF2F2"}}>削除</button>
                  </td>
                </tr>
              ))}
            </DataTable>
            {editTarget && (
              <form onSubmit={saveEdit} style={styles.editForm}>
                <h3 style={styles.subTitle}>選択中の打刻を修正</h3>
                <label style={styles.label}>
                  種別
                  <select
                    value={editForm.type}
                    onChange={(event) => setEditForm({ ...editForm, type: event.target.value as ClockType })}
                    style={styles.input}
                  >
                    <option value="clock_in">出勤</option>
                    <option value="break_start">休憩開始</option>
                    <option value="break_end">休憩終了</option>
                    <option value="clock_out">退勤</option>
                  </select>
                </label>
                <label style={styles.label}>
                  日時
                  <input
                    type="datetime-local"
                    value={editForm.createdAt}
                    onChange={(event) => setEditForm({ ...editForm, createdAt: event.target.value })}
                    style={styles.input}
                  />
                </label>
                <label style={styles.label}>
                  修正理由
                  <input
                    required
                    value={editForm.reason}
                    onChange={(event) => setEditForm({ ...editForm, reason: event.target.value })}
                    style={styles.input}
                  />
                </label>
                <button type="submit" style={styles.button}>修正して auditLogs に保存</button>
              </form>
            )}
            {message && <p style={styles.message}>{message}</p>}
          </section>
        )}

        {activeTab === "exports" && (
          <section style={styles.tabPanel}>
            <h2 style={styles.sectionTitle}>出力履歴</h2>
            <p style={styles.helpText}>
              福田勤怠形式の月次Excelを上部のExcel出力ボタンから出力できます。店舗フィルターを全店舗または店舗別に切り替えて出力してください。
            </p>
            <DataTable headers={["対象年月", "店舗", "形式", "内容"]}>
              <tr>
                <td style={styles.td}>{targetMonth}</td>
                <td style={styles.td}>
                  {storeFilter === "all"
                    ? "全店舗"
                    : getStoreName(stores.find((store) => store.id === storeFilter) ?? ({ id: storeFilter } as StoreRow))}
                </td>
                <td style={styles.td}>Excel</td>
                <td style={styles.td}>hourlyWageSnapshot を使って給与計算、労働時間・休憩・深夜・概算給与を反映</td>
              </tr>
            </DataTable>
          </section>
        )}
        </section>
        </div>
      </div>
    </main>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.summaryCard}>
      <p style={styles.summaryLabel}>{label}</p>
      <p style={styles.summaryValue}>{value}</p>
    </div>
  );
}

function DataTable({
  headers,
  children,
}: {
  headers: string[];
  children: React.ReactNode;
}) {
  return (
    <div style={styles.tableWrap}>
      <table style={styles.table}>
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header} style={styles.th}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100svh",
    padding: 24,
    background: "#F6F8FB",
    color: "#363A3D",
  },
  layout: {
    display: "grid",
    gridTemplateColumns: "260px minmax(0, 1fr)",
    gap: 24,
    width: "100%",
    maxWidth: 1480,
    margin: "0 auto",
  },
  sidebar: {
    position: "sticky",
    top: 24,
    minHeight: "calc(100svh - 48px)",
    background: "#363A3D",
    color: "#ffffff",
    borderRadius: 16,
    padding: 22,
    display: "flex",
    flexDirection: "column",
    gap: 24,
    boxShadow: "0 18px 45px rgba(15, 23, 42, 0.18)",
  },
  sidebarEyebrow: {
    margin: 0,
    color: "#53C1ED",
    fontSize: 12,
    fontWeight: 700,
  },
  sidebarTitle: {
    margin: "8px 0 0",
    fontSize: 20,
    lineHeight: 1.35,
    fontWeight: 800,
  },
  sideNav: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  sideNavButton: {
    width: "100%",
    minHeight: 44,
    border: 0,
    borderRadius: 12,
    padding: "0 14px",
    background: "transparent",
    color: "#CBD5E1",
    textAlign: "left",
    fontWeight: 700,
  },
  activeSideNavButton: {
    width: "100%",
    minHeight: 44,
    border: 0,
    borderRadius: 12,
    padding: "0 14px",
    background: "#53C1ED",
    color: "#ffffff",
    textAlign: "left",
    fontWeight: 800,
  },
  shell: {
    width: "100%",
    display: "flex",
    flexDirection: "column",
    gap: 24,
    minWidth: 0,
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-end",
    gap: 20,
    flexWrap: "wrap",
    background: "#ffffff",
    borderRadius: 16,
    padding: 24,
    boxShadow: "0 10px 30px rgba(15, 23, 42, 0.06)",
  },
  brandBlock: {
    display: "flex",
    alignItems: "center",
    gap: 16,
  },
  logoFrame: {
    width: 156,
    height: 48,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    background: "#ffffff",
  },
  headerLogo: {
    width: 140,
    height: "auto",
    objectFit: "contain",
  },
  headerEyebrow: {
    margin: "0 0 6px",
    color: "#53C1ED",
    fontSize: 12,
    fontWeight: 800,
  },
  title: {
    margin: 0,
    fontSize: 28,
    lineHeight: 1.2,
    fontWeight: 800,
    color: "#363A3D",
  },
  controls: {
    display: "flex",
    alignItems: "flex-end",
    gap: 12,
    flexWrap: "wrap",
  },
  label: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    fontSize: 13,
    fontWeight: 800,
    color: "#334155",
  },
  input: {
    minHeight: 44,
    border: "1px solid #D7DEE8",
    borderRadius: 12,
    padding: "0 12px",
    background: "#ffffff",
    fontSize: 14,
    color: "#363A3D",
  },
  button: {
    minHeight: 44,
    border: 0,
    borderRadius: 12,
    padding: "0 18px",
    background: "#53C1ED",
    color: "#ffffff",
    fontWeight: 800,
    boxShadow: "0 10px 20px rgba(83, 193, 237, 0.28)",
  },
  secondaryButton: {
    minHeight: 42,
    border: "1px solid #D7DEE8",
    borderRadius: 12,
    padding: "0 14px",
    background: "#ffffff",
    color: "#53C1ED",
    fontWeight: 800,
  },
  summaryGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    gap: 16,
  },
  summaryCard: {
    background: "#ffffff",
    border: "1px solid #E8EDF4",
    borderRadius: 16,
    padding: 22,
    boxShadow: "0 10px 30px rgba(15, 23, 42, 0.06)",
  },
  summaryLabel: {
    margin: 0,
    color: "#64748B",
    fontSize: 13,
    fontWeight: 700,
  },
  summaryValue: {
    margin: "10px 0 0",
    fontSize: 28,
    fontWeight: 800,
    color: "#363A3D",
  },
  mainCard: {
    background: "#ffffff",
    border: "1px solid #E8EDF4",
    borderRadius: 16,
    padding: 20,
    boxShadow: "0 10px 30px rgba(15, 23, 42, 0.06)",
    minWidth: 0,
  },
  tabs: {
    display: "flex",
    gap: 10,
    overflowX: "auto",
    paddingBottom: 14,
    borderBottom: "1px solid #E8EDF4",
  },
  mobileTabs: {
    display: "none",
    gap: 10,
    overflowX: "auto",
    background: "#ffffff",
    borderRadius: 16,
    padding: 12,
    boxShadow: "0 10px 30px rgba(15, 23, 42, 0.06)",
  },
  tab: {
    minHeight: 40,
    border: "1px solid #D7DEE8",
    borderRadius: 999,
    padding: "0 16px",
    background: "#F8FAFC",
    color: "#334155",
    whiteSpace: "nowrap",
    fontWeight: 800,
  },
  activeTab: {
    minHeight: 40,
    border: "1px solid #53C1ED",
    borderRadius: 999,
    padding: "0 16px",
    background: "#53C1ED",
    color: "#ffffff",
    whiteSpace: "nowrap",
    fontWeight: 800,
  },
  panel: {
    background: "#ffffff",
    border: "1px solid #E8EDF4",
    borderRadius: 16,
    padding: 22,
    boxShadow: "0 10px 30px rgba(15, 23, 42, 0.06)",
  },
  tabPanel: {
    paddingTop: 20,
  },
  panelHeader: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    alignItems: "center",
    flexWrap: "wrap",
  },
  sectionTitle: {
    margin: "0 0 18px",
    fontSize: 20,
    fontWeight: 800,
    color: "#363A3D",
  },
  subTitle: {
    margin: "0 0 12px",
    fontSize: 16,
    fontWeight: 800,
    color: "#363A3D",
  },
  inlineActions: {
    display: "flex",
    gap: 10,
    flexWrap: "wrap",
  },
  twoColumns: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
    gap: 18,
  },
  tableWrap: {
    overflowX: "auto",
    border: "1px solid #E8EDF4",
    borderRadius: 16,
    background: "#ffffff",
  },
  table: {
    width: "100%",
    borderCollapse: "separate",
    borderSpacing: 0,
    fontSize: 14,
  },
  th: {
    textAlign: "left",
    padding: "14px 16px",
    borderBottom: "1px solid #E2E8F0",
    background: "#F8FAFC",
    whiteSpace: "nowrap",
    color: "#475569",
    fontSize: 12,
    fontWeight: 800,
  },
  td: {
    padding: "16px",
    borderBottom: "1px solid #EEF2F7",
    whiteSpace: "nowrap",
    verticalAlign: "top",
    color: "#363A3D",
  },
  dangerTd: {
    padding: "16px",
    borderBottom: "1px solid #EEF2F7",
    whiteSpace: "nowrap",
    verticalAlign: "top",
    color: "#B91C1C",
    fontWeight: 800,
  },
  warningRow: {
    background: "#FFFBEB",
  },
  dangerBadge: {
    display: "inline-flex",
    marginLeft: 8,
    padding: "3px 8px",
    borderRadius: 999,
    background: "#FEE2E2",
    color: "#B91C1C",
    fontSize: 12,
    fontWeight: 800,
  },
  logoPreview: {
    width: 52,
    height: 32,
    objectFit: "contain",
    borderRadius: 8,
    background: "#F8FAFC",
    border: "1px solid #E2E8F0",
  },
  logoPreviewLarge: {
    width: 120,
    height: 72,
    objectFit: "contain",
    borderRadius: 12,
    background: "#F8FAFC",
    border: "1px solid #E2E8F0",
  },
  logoUploadBox: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  labelText: {
    fontSize: 13,
    fontWeight: 800,
    color: "#334155",
  },
  uploadButton: {
    minHeight: 42,
    border: "1px solid #BDEBFA",
    borderRadius: 12,
    padding: "0 14px",
    background: "#F0FBFE",
    color: "#3BAED6",
    fontWeight: 800,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
  },
  fileInput: {
    display: "none",
  },
  logoPlaceholder: {
    width: 120,
    height: 72,
    borderRadius: 12,
    border: "1px dashed #CBD5E1",
    background: "#F8FAFC",
    color: "#64748B",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 13,
    fontWeight: 700,
  },
  logoPlaceholderSmall: {
    color: "#64748B",
    fontSize: 13,
    fontWeight: 700,
  },
  uploadSuccess: {
    color: "#047857",
    fontSize: 13,
    fontWeight: 800,
  },
  uploadError: {
    color: "#B91C1C",
    fontSize: 13,
    fontWeight: 800,
  },
  linkButton: {
    border: "1px solid #BDEBFA",
    borderRadius: 12,
    padding: "8px 12px",
    background: "#F0FBFE",
    color: "#3BAED6",
    fontWeight: 800,
  },
  linkAnchor: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 8,
    border: "1px solid #BDEBFA",
    borderRadius: 12,
    padding: "8px 12px",
    background: "#F0FBFE",
    color: "#3BAED6",
    fontWeight: 800,
    textDecoration: "none",
  },
  qrImage: {
    width: 96,
    height: 96,
    border: "1px solid #E2E8F0",
    borderRadius: 8,
    background: "#ffffff",
  },
  editForm: {
    marginTop: 20,
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: 16,
    alignItems: "end",
    background: "#F8FAFC",
    borderRadius: 16,
    padding: 18,
  },
  helpText: {
    margin: "0 0 18px",
    color: "#64748B",
    lineHeight: 1.6,
  },
  error: {
    margin: 0,
    border: "1px solid #FCA5A5",
    borderRadius: 16,
    padding: 14,
    background: "#fef2f2",
    color: "#991b1b",
  },
  message: {
    margin: "12px 0 0",
    border: "1px solid #BDEBFA",
    borderRadius: 16,
    padding: 14,
    background: "#F0FBFE",
    color: "#1E3A8A",
  },
  empty: {
    margin: "16px 0 0",
    color: "#64748B",
  },
  activeBadge: {
    display: "inline-flex",
    padding: "2px 8px",
    borderRadius: 999,
    background: "#DCFCE7",
    color: "#166534",
    fontSize: 12,
    fontWeight: 800,
  },
  inactiveBadge: {
    display: "inline-flex",
    padding: "2px 8px",
    borderRadius: 999,
    background: "#F1F5F9",
    color: "#64748B",
    fontSize: 12,
    fontWeight: 800,
  },
} satisfies Record<string, React.CSSProperties>;

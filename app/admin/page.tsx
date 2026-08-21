"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { signOut, getAuth, createUserWithEmailAndPassword } from "firebase/auth";
import { initializeApp, deleteApp } from "firebase/app";
import { auth, db, firebaseConfig } from "@/lib/firebase";
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
  where,
  writeBatch,
} from "firebase/firestore";
import type { Employee, Store } from "@/lib/attendance";
import {
  aggregateLaborCostByStore,
  auditAttendance,
  buildAttendanceRows,
  type CalculatedAttendanceRow,
  type CalculationClockLog,
  type CalculationWage,
  type WageHistoryLoadStatus,
} from "@/lib/attendance-calculation";
import {
  buildCorrectionWorkSets,
  buildCorrectionAudit,
  calculateCorrectionPreview,
  fromJstDateTimeInput,
  openCorrectionEditor,
  shiftCorrectionWorkDate,
  validateCorrection,
  type CorrectionEditor,
  type CorrectionStatus,
  type CorrectionWorkSet,
} from "@/lib/attendance-correction";

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
  workStoreId?: string;
  workStoreName?: string;
  employeeCode?: string;
  employeeId?: string | null;
  employeeName?: string;
  type?: string;
  clockType?: string;
  timestamp?: Timestamp | Date | string | null;
  createdAt?: Timestamp | Date | string | null;
  hourlyWageAtWork?: number | null;
  hourlyWageSnapshot?: number | null;
  lateNightHourlyWageAtWork?: number | null;
  lateNightHourlyWageSnapshot?: number | null;
  dailyTransportationAtWork?: number | null;
  dailyTransportationSnapshot?: number | null;
  wageSource?: "store_help" | "employee_base";
  latitude?: number | null;
  longitude?: number | null;
  isOutsideGps?: boolean;
  isManualEdited?: boolean;
  isDeleted?: boolean;
  deletedAt?: Timestamp | null;
  deletedBy?: string | null;
  isCorrected?: boolean;
  correctedAt?: Timestamp | null;
  correctedBy?: string | null;
  correctionReason?: string | null;
};

type EmployeeRow = Employee & { id: string; hourlyWage?: number | null; hasManagerAccount?: boolean; managerUid?: string | null; accountRole?: "manager" | "area_manager" | "fc_manager" | null; accountStoreIds?: string[] };
type StoreRow = Store & { id: string };
type AccountManagerRow = { uid: string; name?: string; email?: string; role: "area_manager" | "fc_manager"; storeId?: string; storeIds?: string[] };

type AttendanceRow = CalculatedAttendanceRow;

const tabs: { id: TabId; label: string }[] = [
  { id: "attendance", label: "勤怠一覧" },
  { id: "employees", label: "従業員管理" },
  { id: "stores", label: "店舗管理" },
  { id: "wages", label: "時給設定" },
  { id: "edits", label: "打刻修正" },
  { id: "exports", label: "Excel出力" },
];

const correctionStatusLabels: Record<CorrectionStatus, string> = {
  normal: "正常",
  missing_clock_out: "未退勤",
  orphan_clock_out: "孤立退勤",
  corrected: "修正済み",
  needs_review: "要確認",
};
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
  return store.helpHourlyWage ?? store.helpWage ?? "";
}

function getEmployeeBaseWage(employee: EmployeeRow) {
  return employee.hourlyWage ?? employee.baseWage ?? employee.baseHourlyWage ?? 0;
}

function dateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

function formatTime(date: Date | null) {
  if (!date) return "";
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = parts.find((part) => part.type === "hour")?.value ?? "00";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
  return `${hour}:${minute}`;
}

function formatMinutes(minutes: number) {
  if (minutes <= 0) return "";
  const rounded = Math.round(minutes);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}

function formatMinutesZero(minutes: number) {
  const rounded = Math.round(Math.max(0, minutes));
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}

function normalizeClockType(row: TimecardRow) {
  const type = row.type ?? row.clockType ?? "";
  if (type === "clockIn" || type === "in" || type === "start") return "clock_in";
  if (type === "breakStart") return "break_start";
  if (type === "breakEnd") return "break_end";
  if (type === "clockOut" || type === "out" || type === "end") return "clock_out";
  return type;
}

function toCalculationLogs(rows: TimecardRow[]) {
  return rows.flatMap((row) => {
    const timestamp = logDate(row);
    if (!timestamp || row.isDeleted) return [];
    return [
      {
        ...row,
        type: normalizeClockType(row),
        timestamp,
      } as CalculationClockLog,
    ];
  });
}

function buildMonthlyRows(
  rows: AttendanceRow[],
  targetMonth: string,
  employees: EmployeeRow[],
  stores: StoreRow[],
  selectedStoreIds: string[],
) {
  const [year, month] = targetMonth.split("-").map(Number);
  const lastDay = new Date(year, month, 0).getDate();
  const outputEmployees = employees.filter(
    (employee) => employee.isDeleted !== true && selectedStoreIds.includes(employee.storeId),
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

    let totalWork = 0, totalNight = 0, totalBreak = 0, totalHelp = 0;

    for (let day = 1; day <= lastDay; day += 1) {
      const date = `${targetMonth}-${String(day).padStart(2, "0")}`;
      const row = employeeRows.find((r) => r.date === date) ?? null;

      if (row) {
        totalWork += row.workMinutes;
        totalNight += row.nightMinutes;
        totalBreak += row.breakMinutes;
        totalHelp += row.helpMinutes;
      }

      const dailyCost = employee.transportationType === "daily" ? (employee.transportationCost ?? 0) : 0;
      const monthlyCost = employee.transportationType === "monthly" ? (employee.transportationCost ?? 0) : 0;

      bodyRows.push([
        row?.storeId ?? employee.storeId,
        row?.storeName || (store ? getStoreName(store) : employee.storeId),
        employee.employeeCode,
        employee.name,
        date.replaceAll("-", "/"),
        row ? formatTime(row.clockIn) : "",
        row ? formatTime(row.clockOut) : "",
        row ? formatMinutes(row.workMinutes) : "",
        row ? "0:00" : "", row ? "0:00" : "", row ? "0:00" : "", row ? formatMinutesZero(row.overtimeMinutes) : "",
        row ? formatMinutesZero(row.nightMinutes) : "",
        row ? formatMinutesZero(row.breakMinutes) : "",
        row ? formatMinutesZero(row.helpMinutes) : "", "",
        row && row.workMinutes > 0 ? "通常" : "",
        "",
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
      formatMinutes(totalHelp), "", "",
      "",
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
  const [wagesByEmployee, setWagesByEmployee] = useState<Record<string, CalculationWage[]>>({});
  const [wageHistoryStatusByEmployee, setWageHistoryStatusByEmployee] = useState<
    Record<string, WageHistoryLoadStatus>
  >({});
  const [stores, setStores] = useState<StoreRow[]>([]);
  const [targetMonth, setTargetMonth] = useState(localMonth());
  const [storeFilter, setStoreFilter] = useState("all");
  const [activeTab, setActiveTab] = useState<TabId>("attendance");
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [editWorkSet, setEditWorkSet] = useState<CorrectionWorkSet | null>(null);
  const [editForm, setEditForm] = useState<CorrectionEditor | null>(null);
  const [isSavingCorrection, setIsSavingCorrection] = useState(false);
  const [correctionError, setCorrectionError] = useState("");
  const correctionSaveLock = useRef(false);
  const correctionPreview = useMemo(
    () => editForm ? calculateCorrectionPreview(editForm) : null,
    [editForm],
  );
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
    isFc: false,
  });
  const [accountManagers, setAccountManagers] = useState<AccountManagerRow[]>([]);
  const [accountMgrForm, setAccountMgrForm] = useState({
    name: "",
    email: "",
    password: "",
    role: "area_manager" as "area_manager" | "fc_manager",
    storeIds: [] as string[],
  });
  const [accountMgrMsg, setAccountMgrMsg] = useState("");
  const [accountMgrWorking, setAccountMgrWorking] = useState(false);
  const [accountMgrEditUid, setAccountMgrEditUid] = useState<string | null>(null);
  const [accountMgrEditStoreIds, setAccountMgrEditStoreIds] = useState<string[]>([]);
  const [employeeFormError, setEmployeeFormError] = useState("");
  const [csvImportErrors, setCsvImportErrors] = useState<CsvEmployeeError[]>([]);
  const [csvImportSummary, setCsvImportSummary] = useState("");
  const [csvImporting, setCsvImporting] = useState(false);
  const [wageEmpEditId, setWageEmpEditId] = useState("");
  const [wageEmpInput, setWageEmpInput] = useState("");
  const [wageStoreEditId, setWageStoreEditId] = useState("");
  const [wageStoreInput, setWageStoreInput] = useState("");
  const [permissionModal, setPermissionModal] = useState<{
    empId: string;
    role: "manager" | "area_manager" | "fc_manager" | "";
    storeId: string;
    storeIds: string[];
    email: string;
    password: string;
  } | null>(null);
  const [permissionMsg, setPermissionMsg] = useState("");
  const [permissionWorking, setPermissionWorking] = useState(false);
  const [selectedExportStoreIds, setSelectedExportStoreIds] = useState<string[]>([]);

  const isAdmin = !isAuthLoading && profile?.role === "admin";
  const isFcManager = !isAuthLoading && profile?.role === "fc_manager";
  const isAreaManager = !isAuthLoading && profile?.role === "area_manager";
  const isManager = !isAuthLoading && profile?.role === "manager";
  const managerStoreId = isManager ? (profile?.storeId ?? "") : "";
  const myStoreIds = (isFcManager || isAreaManager) ? (profile?.storeIds ?? []) : [];
  const isReadOnlyStore = isFcManager;
  const canChangeStoreFilter = isAdmin || isFcManager || isAreaManager;
  const areaManagerAllowedTabs: TabId[] = ["attendance", "employees", "edits", "exports"];
  const managerAllowedTabs: TabId[] = ["attendance", "employees", "edits"];
  const visibleTabs = isAdmin || isFcManager
    ? tabs
    : isAreaManager
      ? tabs.filter((tab) => areaManagerAllowedTabs.includes(tab.id))
      : tabs.filter((tab) => managerAllowedTabs.includes(tab.id));
  const [appBaseUrl, setAppBaseUrl] = useState(
    process.env.NEXT_PUBLIC_APP_URL ??
      (typeof window !== "undefined" ? window.location.origin : ""),
  );

  const load = async () => {
    if (!profile) return;
    if (!isAdmin && !isFcManager && !isAreaManager && !isManager) return;
    setIsLoading(true);
    setErrorMessage("");

    // ── Phase 1: stores / employees（allow read: if true → 必ず成功）────────
    try {
      const [employeeSnapshot, storeSnapshot] = await Promise.all([
        getDocs(query(collection(db, "employees"), orderBy("employeeCode"))),
        getDocs(collection(db, "stores")),
      ]);
      const nextEmployees = employeeSnapshot.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Employee),
      }));
      const nextStores = storeSnapshot.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Store),
      }));
      const wageEntries = isAdmin
        ? await Promise.all(
            nextEmployees.map(async (employee) => {
              try {
                const snapshot = await getDocs(
                  query(
                    collection(db, "employees", employee.id, "wageHistory"),
                    orderBy("effectiveFrom", "desc"),
                  ),
                );
                return {
                  employeeId: employee.id,
                  wages: snapshot.docs.map((wageDoc) => wageDoc.data() as CalculationWage),
                  status: "loaded" as const,
                };
              } catch (error) {
                if (process.env.NODE_ENV !== "production") {
                  console.warn("[attendance] wageHistory fetch failed", error);
                }
                return {
                  employeeId: employee.id,
                  wages: [],
                  status: "failed" as const,
                };
              }
            }),
          )
        : [];
      setWagesByEmployee(
        Object.fromEntries(wageEntries.map((entry) => [entry.employeeId, entry.wages])),
      );
      setWageHistoryStatusByEmployee(
        Object.fromEntries(wageEntries.map((entry) => [entry.employeeId, entry.status])),
      );

      if (isManager) {
        setEmployees(nextEmployees.filter((emp) => emp.storeId === managerStoreId));
        setStores(nextStores.filter((store) => store.id === managerStoreId));
        setStoreFilter(managerStoreId);
        setSelectedExportStoreIds([managerStoreId]);
      } else if (isFcManager || isAreaManager) {
        setEmployees(nextEmployees.filter((emp) => myStoreIds.includes(emp.storeId)));
        setStores(nextStores.filter((store) => myStoreIds.includes(store.id)));
        setSelectedExportStoreIds(myStoreIds);
      } else {
        setEmployees(nextEmployees);
        setStores(nextStores);
        setSelectedExportStoreIds(nextStores.filter((s) => !s.isFc).map((s) => s.id));
      }
    } catch (error) {
      console.error("employees/stores fetch failed", error);
      const detail = error instanceof Error ? error.message : String(error);
      setErrorMessage(`店舗・従業員データ取得に失敗しました: ${detail}`);
      setIsLoading(false);
      return;
    }

    // ── Phase 2: clockLogs（Firestoreルールによる権限制御）──────────────────
    try {
      const clockLogsQuery = isAdmin
        ? query(collection(db, "clockLogs"), orderBy("timestamp", "desc"))
        : (isFcManager || isAreaManager) && myStoreIds.length > 0
          ? query(collection(db, "clockLogs"), where("storeId", "in", myStoreIds))
          : query(collection(db, "clockLogs"), where("storeId", "==", managerStoreId));

      const timecardSnapshot = await getDocs(clockLogsQuery);
      const nextTimecards = timecardSnapshot.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<TimecardRow, "id">),
      }));

      if (isManager) {
        setTimecards(nextTimecards.filter((row) => row.storeId === managerStoreId));
      } else if (isFcManager || isAreaManager) {
        setTimecards(nextTimecards.filter((row) => myStoreIds.includes(row.storeId)));
      } else {
        setTimecards(nextTimecards);
      }
    } catch (error) {
      console.error("clockLogs fetch failed", error);
      const detail = error instanceof Error ? error.message : String(error);
      setErrorMessage(`打刻データ取得に失敗しました（Firestoreルールを確認してください）: ${detail}`);
    }

    // ── Phase 3: account managers（admin のみ）───────────────────────────────
    if (isAdmin) {
      try {
        const acctSnap = await getDocs(
          query(collection(db, "users"), where("role", "in", ["area_manager", "fc_manager"])),
        );
        setAccountManagers(
          acctSnap.docs.map((d) => ({ uid: d.id, ...(d.data() as Omit<AccountManagerRow, "uid">) })),
        );
      } catch (error) {
        console.error("account managers fetch failed", error);
      }
    }

    setIsLoading(false);
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
    if (profile.role === "manager" && !profile.storeId) return;
    if ((profile.role === "area_manager" || profile.role === "fc_manager") && !profile.storeIds?.length) return;
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
  const employeeBaseWages = useMemo(
    () =>
      Object.fromEntries(
        employees.flatMap((emp) => {
          const wage = getEmployeeBaseWage(emp);
          if (!wage || wage <= 0) return [];
          return [[emp.id, wage]];
        }),
      ),
    [employees],
  );
  const calculationLogs = useMemo(() => toCalculationLogs(timecards), [timecards]);
  const correctionWorkSets = useMemo(
    () => buildCorrectionWorkSets(calculationLogs),
    [calculationLogs],
  );
  const filteredCorrectionWorkSets = useMemo(
    () => correctionWorkSets.filter((set) =>
      set.workDate.startsWith(targetMonth) &&
      (storeFilter === "all" || set.storeId === storeFilter)),
    [correctionWorkSets, storeFilter, targetMonth],
  );
  const homeStoreByEmployee = useMemo(
    () => Object.fromEntries(employees.map((employee) => {
      const store = stores.find((item) => item.id === employee.storeId);
      return [employee.id, {
        storeId: employee.storeId,
        storeName: store ? getStoreName(store) : employee.storeId,
      }];
    })),
    [employees, stores],
  );
  const allAttendanceRows = useMemo(
    () =>
      buildAttendanceRows(
        calculationLogs,
        wagesByEmployee,
        wageHistoryStatusByEmployee,
        employeeBaseWages,
        homeStoreByEmployee,
      ),
    [calculationLogs, wageHistoryStatusByEmployee, wagesByEmployee, employeeBaseWages, homeStoreByEmployee],
  );
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const diagnosticCounts = new Map<string, number>();
    for (const row of allAttendanceRows) {
      for (const session of row.sessions) {
        for (const code of session.wageDiagnostics) {
          diagnosticCounts.set(code, (diagnosticCounts.get(code) ?? 0) + 1);
        }
      }
    }
    if (diagnosticCounts.size > 0) {
      console.warn(
        "[attendance] wage resolution diagnostics",
        Object.fromEntries(diagnosticCounts),
      );
    }
  }, [allAttendanceRows]);
  const allMonthAttendanceRows = useMemo(
    () => allAttendanceRows.filter((row) => row.date.startsWith(targetMonth)),
    [allAttendanceRows, targetMonth],
  );
  const attendanceAuditIssues = useMemo(
    () => auditAttendance(calculationLogs, allAttendanceRows).filter((issue) => issue.date.startsWith(targetMonth)),
    [allAttendanceRows, calculationLogs, targetMonth],
  );
  useEffect(() => {
    if (attendanceAuditIssues.length === 0) return;
    const counts = new Map<string, number>();
    for (const issue of attendanceAuditIssues) counts.set(issue.code, (counts.get(issue.code) ?? 0) + 1);
    console.warn("[attendance] calculation diagnostics", {
      targetMonth,
      total: attendanceAuditIssues.length,
      counts: Object.fromEntries(counts),
    });
  }, [attendanceAuditIssues, targetMonth]);
  const attendanceRows = useMemo(
    () =>
      allMonthAttendanceRows.filter(
        (row) =>
          storeFilter === "all" ||
          row.sessions.some((session) => session.storeId === storeFilter),
      ),
    [allMonthAttendanceRows, storeFilter],
  );
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
  const laborCostDashboard = useMemo(() => {
    const now = new Date();
    const todayStr = dateKey(now);
    const dayOfWeek = now.getDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const mondayDate = new Date(now);
    mondayDate.setDate(now.getDate() + mondayOffset);
    const mondayStr = dateKey(mondayDate);
    const jstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const monthStart = `${jstNow.getUTCFullYear()}-${String(jstNow.getUTCMonth() + 1).padStart(2, "0")}-01`;

    const todayRows = allAttendanceRows.filter((row) => row.date === todayStr);
    const weekRows = allAttendanceRows.filter(
      (row) => row.date >= mondayStr && row.date <= todayStr,
    );
    const monthRows = allAttendanceRows.filter(
      (row) => row.date >= monthStart && row.date <= todayStr,
    );

    return {
      today: aggregateLaborCostByStore(todayRows),
      week: aggregateLaborCostByStore(weekRows),
      month: aggregateLaborCostByStore(monthRows),
    };
  }, [allAttendanceRows]);

  const storeNameById = (storeId: string) =>
    getStoreName(stores.find((store) => store.id === storeId) ?? ({ id: storeId } as StoreRow)) ||
    storeId;

  const startEdit = (workSet: CorrectionWorkSet) => {
    setEditWorkSet(workSet);
    setEditForm(openCorrectionEditor(workSet));
    setCorrectionError("");
    setMessage("");
    setActiveTab("edits");
  };

  const startEditFromAttendance = (row: AttendanceRow) => {
    const ids = new Set(row.logs.map((log) => log.id));
    const workSet = correctionWorkSets.find((item) =>
      (item.clockInLog && ids.has(item.clockInLog.id)) ||
      (item.clockOutLog && ids.has(item.clockOutLog.id)),
    );
    if (workSet) startEdit(workSet);
    else setMessage("修正対象の勤務セットを特定できませんでした。再読み込みしてください。");
  };

  const saveEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editWorkSet || !editForm || correctionSaveLock.current) return;
    const errors = validateCorrection(editForm, editWorkSet.key, correctionWorkSets);
    if (errors.length > 0) {
      setCorrectionError(errors.join("。"));
      return;
    }
    const clockIn = fromJstDateTimeInput(editForm.clockIn);
    const clockOut = fromJstDateTimeInput(editForm.clockOut);
    const employee = employees.find((item) => item.id === editForm.employeeId);
    const store = stores.find((item) => item.id === editForm.storeId);
    if (!employee || !store) {
      setCorrectionError("従業員または勤務店舗が見つかりません。再読み込みしてください。");
      return;
    }
    correctionSaveLock.current = true;
    setIsSavingCorrection(true);
    setCorrectionError("");
    try {
      const batch = writeBatch(db);
      const safeKey = editWorkSet.key.replace(/[^a-zA-Z0-9_-]/g, "_");
      const inRef = editWorkSet.clockInLog
        ? doc(db, "clockLogs", editWorkSet.clockInLog.id)
        : doc(db, "clockLogs", `correction_${safeKey}_clock_in`);
      const outRef = editWorkSet.clockOutLog
        ? doc(db, "clockLogs", editWorkSet.clockOutLog.id)
        : doc(db, "clockLogs", `correction_${safeKey}_clock_out`);
      const common = {
        employeeId: employee.id,
        employeeCode: employee.employeeCode ?? "",
        employeeName: employee.name ?? "",
        storeId: store.id,
        workStoreId: store.id,
        workStoreName: getStoreName(store),
        homeStoreId: employee.storeId ?? "",
        homeStoreName: storeNameById(employee.storeId ?? ""),
        isHelp: Boolean(employee.storeId && employee.storeId !== store.id),
        isManualEdited: true,
        isCorrected: true,
        correctedAt: serverTimestamp(),
        correctedBy: user?.uid ?? profile?.uid ?? "unknown-admin",
        correctionReason: editForm.reason.trim(),
      };
      const writeLog = (
        ref: ReturnType<typeof doc>,
        existing: CalculationClockLog | null,
        type: "clock_in" | "clock_out" | "break_start" | "break_end",
        timestamp: Date,
      ) => {
        const value = { ...common, type, timestamp: Timestamp.fromDate(timestamp) };
        if (existing) batch.update(ref, value);
        else batch.set(ref, { ...value, createdAt: serverTimestamp(), isOutsideGps: false });
      };
      if (clockIn) writeLog(inRef, editWorkSet.clockInLog, "clock_in", clockIn);
      if (clockOut) writeLog(outRef, editWorkSet.clockOutLog, "clock_out", clockOut);

      const breakActions: { targetLogId: string; action: "create" | "update" | "delete"; type: "break_start" | "break_end" }[] = [];
      const breakTargetIds: string[] = [];
      for (const [index, item] of editForm.breaks.entries()) {
        const breakKey = item.key.replace(/[^a-zA-Z0-9_-]/g, "_");
        const startRef = item.startLogId
          ? doc(db, "clockLogs", item.startLogId)
          : doc(db, "clockLogs", `correction_${safeKey}_${breakKey}_${index}_break_start`);
        const endRef = item.endLogId
          ? doc(db, "clockLogs", item.endLogId)
          : doc(db, "clockLogs", `correction_${safeKey}_${breakKey}_${index}_break_end`);
        if (item.isDeleted) {
          if (item.startLogId) {
            batch.update(startRef, { ...common, isDeleted: true, deletedAt: serverTimestamp(), deletedBy: common.correctedBy });
            breakActions.push({ targetLogId: startRef.id, action: "delete", type: "break_start" });
            breakTargetIds.push(startRef.id);
          }
          if (item.endLogId) {
            batch.update(endRef, { ...common, isDeleted: true, deletedAt: serverTimestamp(), deletedBy: common.correctedBy });
            breakActions.push({ targetLogId: endRef.id, action: "delete", type: "break_end" });
            breakTargetIds.push(endRef.id);
          }
          continue;
        }
        const start = fromJstDateTimeInput(item.start)!;
        const end = fromJstDateTimeInput(item.end)!;
        writeLog(startRef, item.startLogId ? ({ id: item.startLogId } as CalculationClockLog) : null, "break_start", start);
        writeLog(endRef, item.endLogId ? ({ id: item.endLogId } as CalculationClockLog) : null, "break_end", end);
        breakActions.push({ targetLogId: startRef.id, action: item.startLogId ? "update" : "create", type: "break_start" });
        breakActions.push({ targetLogId: endRef.id, action: item.endLogId ? "update" : "create", type: "break_end" });
        breakTargetIds.push(startRef.id, endRef.id);
      }

      const editedIds = new Set([editWorkSet.clockInLog?.id, editWorkSet.clockOutLog?.id].filter(Boolean));
      const latestOtherPunch = calculationLogs
        .filter((log) => log.employeeId === editWorkSet.employeeId && !editedIds.has(log.id))
        .reduce((latest, log) => Math.max(latest, log.timestamp.getTime()), 0);
      if (clockOut && employee.id === editWorkSet.employeeId && clockOut.getTime() >= latestOtherPunch) {
        batch.set(doc(db, "clockStates", employee.id), {
          employeeId: employee.id,
          lastType: "clock_out",
          lastLogId: outRef.id,
          storeId: store.id,
          updatedAt: serverTimestamp(),
        });
      }

      const auditRef = doc(collection(db, "auditLogs"));
      batch.set(auditRef, {
        ...buildCorrectionAudit(
          editWorkSet,
          editForm,
          [inRef.id, outRef.id, ...breakTargetIds],
          user?.uid ?? profile?.uid ?? "unknown-admin",
          breakActions,
        ),
        correctedAt: serverTimestamp(),
      });
      await batch.commit();
      setMessage("打刻を修正しました。");
      setEditWorkSet(null);
      setEditForm(null);
      await load();
    } catch (error) {
      console.error("timecard edit failed", error);
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      setCorrectionError(
        code.includes("permission-denied")
          ? "権限がないため保存できません。担当店舗と管理者権限を確認してください。"
          : code.includes("unavailable") || code.includes("deadline-exceeded")
            ? "通信エラーで保存できませんでした。通信状態を確認して再試行してください。"
            : "打刻修正を保存できませんでした。入力内容を確認して再試行してください。",
      );
    } finally {
      correctionSaveLock.current = false;
      setIsSavingCorrection(false);
    }
  };

  const downloadExcel = async () => {
    if (attendanceAuditIssues.length > 0) {
      window.alert(
        `勤怠データに${attendanceAuditIssues.length}件の異常を検出しました。未退勤や対応する出勤のない退勤を確認してください。Excelは検証済みの勤務区間だけで出力します。`,
      );
    }
    const XLSX = await import("xlsx");
    const rows = buildMonthlyRows(allMonthAttendanceRows, targetMonth, employees, stores, selectedExportStoreIds);
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
    const missing: string[] = [];
    if (!employeeForm.name.trim()) missing.push("氏名");
    if (!employeeForm.employeeCode.trim()) missing.push("社員コード");
    if (!nextStoreId) missing.push("所属店舗");
    if (!employeeForm.pin.trim()) missing.push("PIN");
    else if (!/^\d{4}$/.test(employeeForm.pin.trim())) missing.push("PIN（4桁の数字）");
    if (missing.length > 0) {
      setEmployeeFormError(`未入力または不正なフィールド：${missing.join("、")}`);
      return;
    }
    if (managerStoreId && employeeEditingId) {
      const target = employees.find((employee) => employee.id === employeeEditingId);
      if (!target || target.storeId !== managerStoreId) {
        setEmployeeFormError("自店舗以外の従業員は編集できません。");
        return;
      }
    }
    setEmployeeFormError("");
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
      setEmployeeFormError("");
      setMessage("従業員を保存しました。");
      await load();
    } catch (error) {
      console.error("employee save failed", error);
      setEmployeeFormError("従業員の保存に失敗しました。");
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
    if (!storeEditingId && !isAdmin) {
      setMessage("店舗の新規作成は管理者のみ可能です。");
      return;
    }
    if (managerStoreId && nextStoreId !== managerStoreId) {
      setMessage("自店舗以外の店舗は編集できません。");
      return;
    }
    if ((isFcManager || isAreaManager) && !myStoreIds.includes(nextStoreId)) {
      setMessage("担当店舗以外の店舗は編集できません。");
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
      isFc: storeForm.isFc,
    };
    try {
      await setDoc(doc(db, "stores", nextStoreId), payload, { merge: true });
      setStoreEditingId("");
      setStoreForm({ id: "", name: "", logoUrl: "", latitude: "", longitude: "", gpsRadiusMeters: "100", helpWage: "", active: true, gpsEnabled: true, isFc: false });
      setMessage("店舗を保存しました。");
      await load();
    } catch (error) {
      console.error("store save failed", error);
      setMessage("店舗の保存に失敗しました。");
    }
  };

  const editStore = (store: StoreRow) => {
    setStoreEditingId(store.id);
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
      isFc: store.isFc === true,
    });
    setActiveTab("stores");
  };

  const saveEmployeeWage = async (employeeId: string) => {
    const wage = Number(wageEmpInput);
    if (!wageEmpInput.trim() || Number.isNaN(wage) || wage < 0) return;
    try {
      await updateDoc(doc(db, "employees", employeeId), { hourlyWage: wage });
      setWageEmpEditId("");
      setWageEmpInput("");
      setMessage("時給を保存しました。");
      await load();
    } catch (err) {
      console.error("employee wage save failed", err);
      setMessage("時給の保存に失敗しました。");
    }
  };

  const saveStoreHelpWage = async (storeId: string) => {
    const wage = Number(wageStoreInput);
    if (!wageStoreInput.trim() || Number.isNaN(wage) || wage < 0) return;
    try {
      await updateDoc(doc(db, "stores", storeId), { helpHourlyWage: wage });
      setWageStoreEditId("");
      setWageStoreInput("");
      setMessage("ヘルプ時給を保存しました。");
      await load();
    } catch (err) {
      console.error("store help wage save failed", err);
      setMessage("ヘルプ時給の保存に失敗しました。");
    }
  };

  const openPermissionModal = (employee: EmployeeRow) => {
    setPermissionMsg("");
    setPermissionModal({
      empId: employee.id,
      role: employee.accountRole ?? "",
      storeId: employee.accountRole === "manager" ? (employee.accountStoreIds?.[0] ?? employee.storeId) : employee.storeId,
      storeIds: employee.accountStoreIds ?? [],
      email: "",
      password: "",
    });
  };

  const savePermission = async (employee: EmployeeRow) => {
    if (!permissionModal) return;
    const { role, storeId, storeIds, email, password } = permissionModal;
    if (!role) { setPermissionMsg("権限を選択してください。"); return; }
    if (!email.trim() || !password.trim()) { setPermissionMsg("メールアドレスとパスワードを入力してください。"); return; }
    if (role === "manager" && !storeId) { setPermissionMsg("担当店舗を選択してください。"); return; }
    if ((role === "area_manager" || role === "fc_manager") && storeIds.length === 0) { setPermissionMsg("担当店舗を選択してください。"); return; }

    setPermissionWorking(true);
    setPermissionMsg("");
    const secondaryApp = initializeApp(firebaseConfig, `perm-setup-${Date.now()}`);
    const secondaryAuth = getAuth(secondaryApp);
    try {
      const credential = await createUserWithEmailAndPassword(secondaryAuth, email.trim(), password);
      const uid = credential.user.uid;
      await setDoc(doc(db, "users", uid), {
        name: employee.name,
        email: email.trim(),
        role,
        storeId: role === "manager" ? storeId : (storeIds[0] ?? ""),
        ...(role !== "manager" ? { storeIds } : {}),
        createdAt: serverTimestamp(),
      });
      await updateDoc(doc(db, "employees", employee.id), {
        hasManagerAccount: true,
        managerUid: uid,
        accountRole: role,
        accountStoreIds: role === "manager" ? [storeId] : storeIds,
      });
      setPermissionMsg("アカウントを作成しました。IDとパスワードを本人に渡してください。");
      await load();
    } catch (err) {
      console.error("permission account creation failed", err);
      const code = (err as { code?: string }).code;
      setPermissionMsg(
        code === "auth/email-already-in-use" ? "このメールアドレスはすでに使用されています"
        : code === "auth/weak-password" ? "パスワードは6文字以上で入力してください"
        : "アカウント作成に失敗しました",
      );
    } finally {
      await deleteApp(secondaryApp);
      setPermissionWorking(false);
    }
  };

  const createAccountManager = async () => {
    const { name, email, password, role, storeIds } = accountMgrForm;
    if (!name.trim() || !email.trim() || !password.trim() || storeIds.length === 0) {
      setAccountMgrMsg("氏名・メール・パスワード・担当店舗をすべて入力してください。");
      return;
    }
    setAccountMgrWorking(true);
    setAccountMgrMsg("");
    const secondaryApp = initializeApp(firebaseConfig, `acct-mgr-${Date.now()}`);
    const secondaryAuth = getAuth(secondaryApp);
    try {
      const credential = await createUserWithEmailAndPassword(secondaryAuth, email.trim(), password);
      const uid = credential.user.uid;
      await setDoc(doc(db, "users", uid), {
        name: name.trim(),
        email: email.trim(),
        role,
        storeId: storeIds[0] ?? "",
        storeIds,
        createdAt: serverTimestamp(),
      });
      setAccountMgrMsg("アカウントを作成しました。IDとパスワードを本人に渡してください。");
      setAccountMgrForm({ name: "", email: "", password: "", role: "area_manager", storeIds: [] });
      await load();
    } catch (err) {
      const code = (err as { code?: string }).code;
      setAccountMgrMsg(
        code === "auth/email-already-in-use" ? "このメールアドレスはすでに使用されています"
        : code === "auth/weak-password" ? "パスワードは6文字以上で入力してください"
        : "アカウント作成に失敗しました",
      );
    } finally {
      await deleteApp(secondaryApp);
      setAccountMgrWorking(false);
    }
  };

  const deleteAccountManager = async (acct: AccountManagerRow) => {
    if (!window.confirm(`${acct.name ?? acct.email} のアカウントを削除しますか？`)) return;
    setAccountMgrWorking(true);
    try {
      await deleteDoc(doc(db, "users", acct.uid));
      try {
        const idToken = await auth.currentUser?.getIdToken();
        if (idToken) {
          await fetch("/api/delete-manager", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
            body: JSON.stringify({ uid: acct.uid }),
          });
        }
      } catch (err) {
        console.error("auth delete api call failed", err);
      }
      await load();
    } catch (err) {
      console.error("account manager deletion failed", err);
      setAccountMgrMsg("削除に失敗しました。");
    } finally {
      setAccountMgrWorking(false);
    }
  };

  const saveAccountManagerStores = async (uid: string) => {
    try {
      await updateDoc(doc(db, "users", uid), {
        storeIds: accountMgrEditStoreIds,
        storeId: accountMgrEditStoreIds[0] ?? "",
      });
      setAccountMgrEditUid(null);
      await load();
    } catch (err) {
      console.error("account manager store update failed", err);
      setAccountMgrMsg("担当店舗の更新に失敗しました。");
    }
  };

  const deleteManagerAccount = async (employee: EmployeeRow) => {
    if (!window.confirm(`${employee.name} のアカウントを削除しますか？`)) return;
    setPermissionWorking(true);
    setPermissionMsg("");
    try {
      if (employee.managerUid) {
        await deleteDoc(doc(db, "users", employee.managerUid));
        try {
          const idToken = await auth.currentUser?.getIdToken();
          if (idToken) {
            const res = await fetch("/api/delete-manager", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
              body: JSON.stringify({ uid: employee.managerUid }),
            });
            if (!res.ok) {
              const data = await res.json() as { error?: string };
              if (data.error !== "ADMIN_SDK_NOT_CONFIGURED") {
                console.error("auth delete failed", data.error);
              }
            }
          }
        } catch (err) {
          console.error("auth delete api call failed", err);
        }
      }
      await updateDoc(doc(db, "employees", employee.id), { hasManagerAccount: false, managerUid: null, accountRole: null, accountStoreIds: [] });
      setPermissionMsg("アカウントを削除しました。");
      setPermissionModal(null);
      await load();
    } catch (err) {
      console.error("manager account deletion failed", err);
      setPermissionMsg("削除に失敗しました。");
    } finally {
      setPermissionWorking(false);
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

  if (!profile || !["admin", "fc_manager", "area_manager", "manager"].includes(profile.role)) {
    return <main style={styles.page}><p style={styles.panel}>権限を確認しています</p></main>;
  }

  if (profile.role === "manager" && !profile.storeId) {
    return <main style={styles.page}><p style={styles.error}>店長アカウントに storeId が設定されていません。</p></main>;
  }

  if ((profile.role === "area_manager" || profile.role === "fc_manager") && !profile.storeIds?.length) {
    return <main style={styles.page}><p style={styles.error}>アカウントに担当店舗（storeIds）が設定されていません。</p></main>;
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
            <p style={styles.sidebarEyebrow}>{isAdmin ? "本部管理" : isFcManager ? "FC管理" : isAreaManager ? "エリア管理" : "店舗管理"}</p>
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
                onChange={(event) => setStoreFilter(canChangeStoreFilter ? event.target.value : managerStoreId)}
                disabled={!canChangeStoreFilter}
                style={styles.input}
              >
                {canChangeStoreFilter && stores.length > 1 && <option value="all">全店舗</option>}
                {stores.map((store) => (
                  <option key={store.id} value={store.id}>
                    {getStoreName(store)}
                  </option>
                ))}
              </select>
            </label>
            {(isAdmin || isAreaManager || isFcManager) && (
              <button type="button" onClick={downloadExcel} style={styles.button}>
                Excel出力
              </button>
            )}
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

            <div style={{ marginBottom: 20 }}>
              <h3 style={styles.subTitle}>店舗別概算人件費</h3>
              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>店舗名</th>
                      <th style={styles.th}>今日</th>
                      <th style={styles.th}>今週（月〜日）</th>
                      <th style={styles.th}>今月（1日〜本日）</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stores.map((store) => (
                      <tr key={store.id}>
                        <td style={styles.td}>{getStoreName(store)}</td>
                        {(["today", "week", "month"] as const).map((period) => {
                          const cost = laborCostDashboard[period].get(store.id);
                          return (
                            <td key={period} style={styles.td}>
                              {(cost?.amount ?? 0).toLocaleString()}円
                              {(cost?.missingWageEmployeeKeys.length ?? 0) > 0 && (
                                <div style={{ color: "#B91C1C", fontSize: 11 }}>
                                  時給未設定: {cost?.missingWageEmployeeKeys.length}人
                                </div>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <DataTable
              headers={[
                "日付",
                "所属店舗",
                "従業員名",
                "出勤",
                "退勤",
                "休憩",
                "労働時間",
                "深夜時間",
                "ヘルプ時間",
                "店舗別内訳",
                "GPS範囲外",
                "操作",
              ]}
            >
              {attendanceRows.map((row) => (
                <tr key={row.key} style={row.isOutsideGps ? styles.warningRow : undefined}>
                  <td style={styles.td}>{row.date}</td>
                  <td style={styles.td}>{row.storeName || storeNameById(row.storeId)}</td>
                  <td style={row.isMissingClockOut ? styles.dangerTd : styles.td}>
                    {row.employeeName || row.employeeKey}
                    {row.isMissingClockOut && <span style={styles.dangerBadge}>未退勤</span>}
                    {row.isWageMissing && <span style={styles.dangerBadge}>時給未設定</span>}
                  </td>
                  <td style={styles.td}>{formatTime(row.clockIn)}</td>
                  <td style={styles.td}>{formatTime(row.clockOut)}</td>
                  <td style={styles.td}>{formatMinutes(row.breakMinutes)}</td>
                  <td style={styles.td}>{formatMinutes(row.workMinutes)}</td>
                  <td style={styles.td}>{formatMinutes(row.nightMinutes)}</td>
                  <td style={styles.td}>{formatMinutesZero(row.helpMinutes)}</td>
                  <td style={styles.td}>
                    {row.sessions.map((session) => (
                      <div key={`${session.storeId}:${session.clockIn.toISOString()}`}>
                        {session.storeName || storeNameById(session.storeId)}：{formatTime(session.clockIn)}〜{formatTime(session.clockOut)}
                        {!session.clockOut && "（未退勤）"}
                      </div>
                    ))}
                    {row.diagnostics.map((diagnostic) => (
                      <div key={diagnostic.code} style={{ color: "#B91C1C", fontSize: 11 }}>{diagnostic.message}</div>
                    ))}
                  </td>
                  <td style={styles.td}>{row.isOutsideGps ? "範囲外" : ""}</td>
                  <td style={styles.td}>
                    {row.logs[0] && (
                      <button type="button" onClick={() => startEditFromAttendance(row)} style={styles.linkButton}>
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
                {isAdmin && (
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
                )}
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
            <form onSubmit={saveEmployee} noValidate style={styles.editForm}>
              <label style={styles.label}>氏名<input value={employeeForm.name} onChange={(e) => setEmployeeForm({ ...employeeForm, name: e.target.value })} style={styles.input} /></label>
              <label style={styles.label}>ひらがな<input value={employeeForm.nameKana} onChange={(e) => setEmployeeForm({ ...employeeForm, nameKana: e.target.value })} style={styles.input} /></label>
              <label style={styles.label}>社員コード<input value={employeeForm.employeeCode} onChange={(e) => setEmployeeForm({ ...employeeForm, employeeCode: e.target.value })} style={styles.input} /></label>
              <label style={styles.label}>PIN（4桁）<input inputMode="numeric" maxLength={4} value={employeeForm.pin} onChange={(e) => setEmployeeForm({ ...employeeForm, pin: e.target.value.replace(/\D/g, "").slice(0, 4) })} style={styles.input} /></label>
              <label style={styles.label}>所属店舗
                <select
                  value={managerStoreId || employeeForm.storeId}
                  disabled={Boolean(managerStoreId)}
                  onChange={(e) => setEmployeeForm({ ...employeeForm, storeId: e.target.value })}
                  style={styles.input}
                >
                  <option value="">選択してください</option>
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
              <div style={{ gridColumn: "1 / -1", display: "flex", flexDirection: "column", gap: 8 }}>
                {employeeFormError && (
                  <p style={{ margin: 0, color: "#B91C1C", fontWeight: 700, fontSize: 13, padding: "8px 12px", background: "#FEF2F2", borderRadius: 8, border: "1px solid #FCA5A5" }}>
                    {employeeFormError}
                  </p>
                )}
                <button type="submit" style={styles.button}>{employeeEditingId ? "更新" : "登録"}</button>
              </div>
            </form>
            {isAdmin && (
              <div style={{ marginTop: 32 }}>
                <h3 style={styles.subTitle}>アカウント管理（エリア・FCマネージャー）</h3>
                <p style={styles.helpText}>users コレクションから role が area_manager / fc_manager のアカウントを管理します。</p>

                {accountManagers.length > 0 && (
                  <DataTable headers={["氏名", "メール", "権限", "担当店舗", "操作"]}>
                    {accountManagers.map((acct) => {
                      const isEditing = accountMgrEditUid === acct.uid;
                      const mgrStores = stores.filter((s) => acct.role === "fc_manager" ? s.isFc === true : true);
                      return (
                        <tr key={acct.uid}>
                          <td style={styles.td}>{acct.name ?? "—"}</td>
                          <td style={styles.td}>{acct.email ?? "—"}</td>
                          <td style={styles.td}>
                            <span style={acct.role === "fc_manager" ? styles.fcBadge : styles.chainBadge}>
                              {acct.role}
                            </span>
                          </td>
                          <td style={{ ...styles.td, minWidth: 200 }}>
                            {isEditing ? (
                              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                {mgrStores.map((s) => (
                                  <label key={s.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
                                    <input
                                      type="checkbox"
                                      checked={accountMgrEditStoreIds.includes(s.id)}
                                      onChange={(e) => {
                                        const next = e.target.checked
                                          ? [...accountMgrEditStoreIds, s.id]
                                          : accountMgrEditStoreIds.filter((id) => id !== s.id);
                                        setAccountMgrEditStoreIds(next);
                                      }}
                                    />
                                    {getStoreName(s)}{s.isFc ? " (FC)" : ""}
                                  </label>
                                ))}
                                <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                                  <button type="button" onClick={() => saveAccountManagerStores(acct.uid)} style={styles.linkButton}>保存</button>
                                  <button type="button" onClick={() => setAccountMgrEditUid(null)} style={styles.linkButton}>キャンセル</button>
                                </div>
                              </div>
                            ) : (
                              <span style={{ fontSize: 13 }}>
                                {(acct.storeIds ?? [acct.storeId ?? ""].filter(Boolean)).map((sid) => storeNameById(sid)).join("、") || "—"}
                              </span>
                            )}
                          </td>
                          <td style={styles.td}>
                            <button
                              type="button"
                              onClick={() => {
                                setAccountMgrEditUid(acct.uid);
                                setAccountMgrEditStoreIds(acct.storeIds ?? (acct.storeId ? [acct.storeId] : []));
                              }}
                              style={styles.linkButton}
                            >
                              店舗変更
                            </button>
                            <button
                              type="button"
                              disabled={accountMgrWorking}
                              onClick={() => deleteAccountManager(acct)}
                              style={{ ...styles.linkButton, color: "#B91C1C", borderColor: "#FCA5A5", background: "#FEF2F2" }}
                            >
                              削除
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </DataTable>
                )}
                {accountManagers.length === 0 && <p style={styles.empty}>アカウントなし</p>}

                <h4 style={{ margin: "20px 0 8px", fontSize: 14, fontWeight: 700 }}>新規アカウント追加</h4>
                <div style={{ ...styles.editForm, marginTop: 0 }}>
                  <label style={styles.label}>氏名<input value={accountMgrForm.name} onChange={(e) => setAccountMgrForm({ ...accountMgrForm, name: e.target.value })} style={styles.input} /></label>
                  <label style={styles.label}>メールアドレス<input type="email" value={accountMgrForm.email} onChange={(e) => setAccountMgrForm({ ...accountMgrForm, email: e.target.value })} style={styles.input} /></label>
                  <label style={styles.label}>パスワード（6文字以上）<input type="password" value={accountMgrForm.password} onChange={(e) => setAccountMgrForm({ ...accountMgrForm, password: e.target.value })} style={styles.input} /></label>
                  <label style={styles.label}>権限
                    <select value={accountMgrForm.role} onChange={(e) => setAccountMgrForm({ ...accountMgrForm, role: e.target.value as "area_manager" | "fc_manager", storeIds: [] })} style={styles.input}>
                      <option value="area_manager">エリアマネージャー（area_manager）</option>
                      <option value="fc_manager">FCマネージャー（fc_manager）</option>
                    </select>
                  </label>
                  <div style={styles.label}>
                    <span style={styles.labelText}>
                      担当店舗（複数選択）{accountMgrForm.role === "fc_manager" ? "※FC店舗のみ" : ""}
                    </span>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
                      {stores
                        .filter((s) => accountMgrForm.role === "fc_manager" ? s.isFc === true : true)
                        .map((s) => (
                          <label key={s.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
                            <input
                              type="checkbox"
                              checked={accountMgrForm.storeIds.includes(s.id)}
                              onChange={(e) => {
                                const next = e.target.checked
                                  ? [...accountMgrForm.storeIds, s.id]
                                  : accountMgrForm.storeIds.filter((id) => id !== s.id);
                                setAccountMgrForm({ ...accountMgrForm, storeIds: next });
                              }}
                            />
                            {getStoreName(s)}{s.isFc ? " (FC)" : ""}
                          </label>
                        ))}
                    </div>
                  </div>
                  {accountMgrMsg && (
                    <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: accountMgrMsg.includes("作成") || accountMgrMsg.includes("成功") ? "#047857" : "#B91C1C" }}>
                      {accountMgrMsg}
                    </p>
                  )}
                  <button type="button" disabled={accountMgrWorking} onClick={createAccountManager} style={styles.button}>
                    {accountMgrWorking ? "作成中..." : "アカウント作成"}
                  </button>
                </div>
              </div>
            )}
            <DataTable headers={["社員コード", "氏名", "ひらがな", "所属店舗", "状態", "基本時給", "交通費", "権限", "操作"]}>
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
                    {employee.hasManagerAccount ? (
                      <span style={
                        employee.accountRole === "fc_manager" ? styles.fcBadge
                        : employee.accountRole === "area_manager" ? styles.chainBadge
                        : styles.activeBadge
                      }>
                        {employee.accountRole ?? "manager"}
                      </span>
                    ) : (
                      <span style={styles.inactiveBadge}>権限なし</span>
                    )}
                  </td>
                  <td style={styles.td}>
                    {isAdmin && (
                      <button type="button" onClick={() => openPermissionModal(employee)} style={styles.linkButton}>権限設定</button>
                    )}
                    <button type="button" onClick={() => editEmployee(employee)} style={styles.linkButton}>編集</button>
                    {isAdmin && <button type="button" onClick={async () => { await updateDoc(doc(db, "employees", employee.id), { status: "inactive" }); await load(); }} style={styles.linkButton}>無効化</button>}
                    {isAdmin && <button type="button" onClick={() => deleteEmployee(employee)} style={{...styles.linkButton, color: "#B91C1C", borderColor: "#FCA5A5", background: "#FEF2F2"}}>削除</button>}
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
            {isReadOnlyStore && (
              <p style={{ padding: "10px 14px", borderRadius: 10, background: "#FFF7ED", border: "1px solid #FCD34D", color: "#92400E", fontSize: 13, fontWeight: 700, marginBottom: 8 }}>
                店舗情報の変更は本部管理者にお問い合わせください
              </p>
            )}
            <form onSubmit={saveStore} style={styles.editForm}>
              <label style={styles.label}>storeId<input value={managerStoreId || storeForm.id} disabled={Boolean(storeEditingId) || Boolean(managerStoreId) || isReadOnlyStore} onChange={(e) => setStoreForm({ ...storeForm, id: e.target.value })} style={{ ...styles.input, ...(isReadOnlyStore ? { opacity: 0.6 } : {}) }} /></label>
              <label style={styles.label}>店舗名<input value={storeForm.name} disabled={isReadOnlyStore} onChange={(e) => setStoreForm({ ...storeForm, name: e.target.value })} style={{ ...styles.input, ...(isReadOnlyStore ? { opacity: 0.6 } : {}) }} /></label>
              <label style={{ ...styles.label, gridColumn: "1 / -1" }}>
                ロゴURL
                <input
                  value={storeForm.logoUrl}
                  disabled={isReadOnlyStore}
                  placeholder="/assets/logo-store-6.png"
                  onChange={(e) => setStoreForm({ ...storeForm, logoUrl: e.target.value })}
                  style={{ ...styles.input, ...(isReadOnlyStore ? { opacity: 0.6 } : {}) }}
                />
              </label>
              {storeForm.logoUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <div style={{ gridColumn: "1 / -1" }}>
                  <img src={storeForm.logoUrl} alt={storeForm.name || "店舗ロゴ"} style={styles.logoPreviewLarge} onError={(e) => { e.currentTarget.src = "/assets/logo-placeholder.png"; }} />
                </div>
              )}
              <label style={styles.label}>緯度<input type="number" step="any" value={storeForm.latitude} disabled={isReadOnlyStore} onChange={(e) => setStoreForm({ ...storeForm, latitude: e.target.value })} style={{ ...styles.input, ...(isReadOnlyStore ? { opacity: 0.6 } : {}) }} /></label>
              <label style={styles.label}>経度<input type="number" step="any" value={storeForm.longitude} disabled={isReadOnlyStore} onChange={(e) => setStoreForm({ ...storeForm, longitude: e.target.value })} style={{ ...styles.input, ...(isReadOnlyStore ? { opacity: 0.6 } : {}) }} /></label>
              {!isReadOnlyStore && <button type="button" onClick={saveCurrentLocation} style={styles.secondaryButton}>現在地取得</button>}
              <label style={styles.label}>GPS半径<input type="number" value={storeForm.gpsRadiusMeters} disabled={isReadOnlyStore} onChange={(e) => setStoreForm({ ...storeForm, gpsRadiusMeters: e.target.value })} style={{ ...styles.input, ...(isReadOnlyStore ? { opacity: 0.6 } : {}) }} /></label>
              <label style={styles.label}>ヘルプ時給<input type="number" value={storeForm.helpWage} disabled={isReadOnlyStore} onChange={(e) => setStoreForm({ ...storeForm, helpWage: e.target.value })} style={{ ...styles.input, ...(isReadOnlyStore ? { opacity: 0.6 } : {}) }} /></label>
              <label style={styles.label}>active
                <select value={storeForm.active ? "true" : "false"} disabled={isReadOnlyStore} onChange={(e) => setStoreForm({ ...storeForm, active: e.target.value === "true" })} style={{ ...styles.input, ...(isReadOnlyStore ? { opacity: 0.6 } : {}) }}>
                  <option value="true">active</option>
                  <option value="false">inactive</option>
                </select>
              </label>
              <label style={styles.label}>GPS打刻チェック
                <select value={storeForm.gpsEnabled ? "true" : "false"} disabled={isReadOnlyStore} onChange={(e) => setStoreForm({ ...storeForm, gpsEnabled: e.target.value === "true" })} style={{ ...styles.input, ...(isReadOnlyStore ? { opacity: 0.6 } : {}) }}>
                  <option value="true">ON（GPS確認あり）</option>
                  <option value="false">OFF（GPS確認なし）</option>
                </select>
              </label>
              <label style={styles.label}>店舗種別
                <select value={storeForm.isFc ? "true" : "false"} disabled={isReadOnlyStore} onChange={(e) => setStoreForm({ ...storeForm, isFc: e.target.value === "true" })} style={{ ...styles.input, ...(isReadOnlyStore ? { opacity: 0.6 } : {}) }}>
                  <option value="false">直営</option>
                  <option value="true">FC</option>
                </select>
              </label>
              {!isReadOnlyStore && <button type="submit" style={styles.button}>{storeEditingId ? "更新" : "登録"}</button>}
            </form>
            <DataTable
              headers={[
                "店舗名",
                "種別",
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
                    <td style={styles.td}>
                      <span style={store.isFc ? styles.fcBadge : styles.chainBadge}>
                        {store.isFc ? "FC" : "直営"}
                      </span>
                    </td>
                    <td style={styles.td}>{store.id}</td>
                    <td style={styles.td}>{getStoreLat(store)}, {getStoreLng(store)}</td>
                    <td style={styles.td}>{getStoreRadius(store)}m</td>
                    <td style={styles.td}><span style={store.gpsEnabled === false ? styles.inactiveBadge : styles.activeBadge}>{store.gpsEnabled === false ? "GPS無効" : "GPS有効"}</span></td>
                    <td style={styles.td}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={store.logoUrl || "/assets/logo-placeholder.png"}
                        alt={getStoreName(store)}
                        style={styles.logoPreview}
                        onError={(e) => { e.currentTarget.src = "/assets/logo-placeholder.png"; }}
                      />
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
                <DataTable headers={["社員コード", "氏名", "基本時給", "操作"]}>
                  {employees.filter((e) => e.isDeleted !== true).map((employee) => {
                    const wage = getEmployeeBaseWage(employee);
                    const isUnset = !wage || Number(wage) === 0;
                    const isEditing = wageEmpEditId === employee.id;
                    return (
                      <tr key={employee.id}>
                        <td style={styles.td}>{employee.employeeCode}</td>
                        <td style={styles.td}>{employee.name}</td>
                        <td style={styles.td}>
                          {isEditing ? (
                            <input
                              type="number"
                              value={wageEmpInput}
                              onChange={(e) => setWageEmpInput(e.target.value)}
                              onKeyDown={(e) => { if (e.key === "Enter") saveEmployeeWage(employee.id); }}
                              style={{ ...styles.input, width: 90, minHeight: 32, padding: "2px 8px", fontSize: 14 }}
                              autoFocus
                              min={0}
                            />
                          ) : (
                            <span style={isUnset ? { color: "#B91C1C", fontWeight: 700 } : undefined}>
                              {isUnset ? "未設定" : `${wage}円`}
                            </span>
                          )}
                        </td>
                        <td style={styles.td}>
                          {isEditing ? (
                            <>
                              <button type="button" onClick={() => saveEmployeeWage(employee.id)} style={styles.linkButton}>保存</button>
                              <button type="button" onClick={() => { setWageEmpEditId(""); setWageEmpInput(""); }} style={{ ...styles.linkButton, marginLeft: 8 }}>キャンセル</button>
                            </>
                          ) : (
                            <button
                              type="button"
                              onClick={() => { setWageEmpEditId(employee.id); setWageEmpInput(isUnset ? "" : String(wage)); }}
                              style={styles.linkButton}
                            >
                              編集
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </DataTable>
              </div>
              <div>
                <h3 style={styles.subTitle}>店舗 ヘルプ時給</h3>
                <DataTable headers={["店舗名", "ヘルプ時給", "操作"]}>
                  {stores.map((store) => {
                    const wage = getStoreHelpWage(store);
                    const isEditing = wageStoreEditId === store.id;
                    return (
                      <tr key={store.id}>
                        <td style={styles.td}>{getStoreName(store)}</td>
                        <td style={styles.td}>
                          {isEditing ? (
                            <input
                              type="number"
                              value={wageStoreInput}
                              onChange={(e) => setWageStoreInput(e.target.value)}
                              onKeyDown={(e) => { if (e.key === "Enter") saveStoreHelpWage(store.id); }}
                              style={{ ...styles.input, width: 90, minHeight: 32, padding: "2px 8px", fontSize: 14 }}
                              autoFocus
                              min={0}
                            />
                          ) : (
                            <span>{wage ? `${wage}円` : "—"}</span>
                          )}
                        </td>
                        <td style={styles.td}>
                          {isEditing ? (
                            <>
                              <button type="button" onClick={() => saveStoreHelpWage(store.id)} style={styles.linkButton}>保存</button>
                              <button type="button" onClick={() => { setWageStoreEditId(""); setWageStoreInput(""); }} style={{ ...styles.linkButton, marginLeft: 8 }}>キャンセル</button>
                            </>
                          ) : (
                            <button
                              type="button"
                              onClick={() => { setWageStoreEditId(store.id); setWageStoreInput(wage ? String(wage) : ""); }}
                              style={styles.linkButton}
                            >
                              編集
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </DataTable>
              </div>
            </div>
          </section>
        )}

        {activeTab === "edits" && (
          <section style={styles.tabPanel}>
            <h2 style={styles.sectionTitle}>打刻修正</h2>
            <DataTable headers={["勤務日", "従業員名", "勤務店舗", "出勤", "退勤", "休憩", "労働時間", "状態", "操作"]}>
              {filteredCorrectionWorkSets.map((workSet) => (
                <tr key={workSet.key} style={workSet.status === "normal" ? undefined : styles.warningRow}>
                  <td style={styles.td}>{workSet.workDate}</td>
                  <td style={styles.td}>{workSet.employeeName || workSet.employeeCode || workSet.employeeId}</td>
                  <td style={styles.td}>{workSet.storeName || storeNameById(workSet.storeId)}</td>
                  <td style={styles.td}>{formatTime(workSet.clockIn)}</td>
                  <td style={styles.td}>{workSet.clockOut ? formatTime(workSet.clockOut) : "未入力"}</td>
                  <td style={styles.td}>{formatMinutesZero(workSet.breakMinutes)}</td>
                  <td style={styles.td}>{formatMinutesZero(workSet.workMinutes)}</td>
                  <td style={styles.td}>
                    <span style={workSet.status === "normal" ? styles.chainBadge : styles.dangerBadge}>
                      {correctionStatusLabels[workSet.status]}
                    </span>
                    {workSet.warnings.map((warning) => <div key={warning} style={{ color: "#B91C1C", fontSize: 11, marginTop: 4 }}>{warning}</div>)}
                  </td>
                  <td style={styles.td}>
                    <button type="button" onClick={() => startEdit(workSet)} style={styles.linkButton}>修正</button>
                  </td>
                </tr>
              ))}
            </DataTable>
            {filteredCorrectionWorkSets.length === 0 && <p style={styles.empty}>対象の勤務セットがありません</p>}
            {message && <p style={styles.message}>{message}</p>}
          </section>
        )}

        {activeTab === "exports" && (
          <section style={styles.tabPanel}>
            <h2 style={styles.sectionTitle}>Excel出力</h2>

            <div style={{ marginBottom: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <span style={{ fontWeight: 700, fontSize: 14 }}>出力対象店舗</span>
                {isAdmin && (
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      type="button"
                      onClick={() => setSelectedExportStoreIds(stores.map((s) => s.id))}
                      style={styles.secondaryButton}
                    >
                      全選択
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedExportStoreIds([])}
                      style={styles.secondaryButton}
                    >
                      全解除
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedExportStoreIds(stores.filter((s) => !s.isFc).map((s) => s.id))}
                      style={styles.secondaryButton}
                    >
                      直営のみ選択
                    </button>
                  </div>
                )}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "12px 16px", background: "#F9FAFB", borderRadius: 8, border: "1px solid #E5E7EB" }}>
                {stores.map((store) => (
                  <label
                    key={store.id}
                    style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: isAdmin ? "pointer" : "default" }}
                  >
                    <input
                      type="checkbox"
                      checked={selectedExportStoreIds.includes(store.id)}
                      disabled={!isAdmin}
                      onChange={(e) => {
                        if (!isAdmin) return;
                        setSelectedExportStoreIds(
                          e.target.checked
                            ? [...selectedExportStoreIds, store.id]
                            : selectedExportStoreIds.filter((id) => id !== store.id),
                        );
                      }}
                    />
                    <span>{getStoreName(store)}</span>
                    <span style={{
                      fontSize: 11,
                      padding: "1px 6px",
                      borderRadius: 4,
                      fontWeight: 700,
                      background: store.isFc ? "#DBEAFE" : "#D1FAE5",
                      color: store.isFc ? "#1E40AF" : "#065F46",
                    }}>
                      {store.isFc ? "FC" : "直営"}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <div style={{ marginBottom: 20 }}>
              <button
                type="button"
                onClick={downloadExcel}
                disabled={selectedExportStoreIds.length === 0}
                style={{ ...styles.button, opacity: selectedExportStoreIds.length === 0 ? 0.5 : 1 }}
              >
                Excel出力（{selectedExportStoreIds.length}店舗）
              </button>
            </div>

            <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>出力内容</h3>
            <DataTable headers={["対象年月", "店舗", "形式", "内容"]}>
              <tr>
                <td style={styles.td}>{targetMonth}</td>
                <td style={styles.td}>
                  {selectedExportStoreIds.length === 0
                    ? "（未選択）"
                    : selectedExportStoreIds.length === stores.length
                      ? "全店舗"
                      : selectedExportStoreIds
                          .map((id) => getStoreName(stores.find((s) => s.id === id) ?? ({ id } as StoreRow)))
                          .join("、")}
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

      {/* 勤務セット修正モーダル */}
      {editWorkSet && editForm && (
        <div style={styles.modalOverlay} onClick={() => { if (!isSavingCorrection) { setEditWorkSet(null); setEditForm(null); } }}>
          <form onSubmit={saveEdit} style={{ ...styles.modal, maxWidth: 620 }} onClick={(event) => event.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>勤務セットを修正</h3>
              <button type="button" disabled={isSavingCorrection} onClick={() => { setEditWorkSet(null); setEditForm(null); }} style={styles.linkButton}>✕ 閉じる</button>
            </div>
            <div style={styles.editForm}>
              <label style={styles.label}>従業員
                <select required value={editForm.employeeId} onChange={(event) => setEditForm({ ...editForm, employeeId: event.target.value })} style={styles.input}>
                  <option value="">選択してください</option>
                  {employees.filter((employee) => employee.isDeleted !== true).map((employee) => (
                    <option key={employee.id} value={employee.id}>{employee.employeeCode} {employee.name}</option>
                  ))}
                </select>
              </label>
              <label style={styles.label}>勤務店舗
                <select required value={editForm.storeId} onChange={(event) => setEditForm({ ...editForm, storeId: event.target.value })} style={styles.input}>
                  <option value="">選択してください</option>
                  {stores.filter((store) => store.active !== false).map((store) => (
                    <option key={store.id} value={store.id}>{getStoreName(store)}</option>
                  ))}
                </select>
              </label>
              <label style={styles.label}>勤務日
                <input
                  required
                  type="date"
                  value={editForm.workDate}
                  onChange={(event) => setEditForm(shiftCorrectionWorkDate(editForm, event.target.value))}
                  style={styles.input}
                />
              </label>
              <label style={styles.label}>出勤日時
                <input required type="datetime-local" value={editForm.clockIn} onChange={(event) => setEditForm({ ...editForm, clockIn: event.target.value, workDate: event.target.value.slice(0, 10) })} style={styles.input} />
              </label>
              <label style={styles.label}>退勤日時
                <input type="datetime-local" value={editForm.clockOut} onChange={(event) => setEditForm({ ...editForm, clockOut: event.target.value })} style={styles.input} />
              </label>
              <div style={{ borderTop: "1px solid #E2E8F0", paddingTop: 14 }}>
                <h4 style={{ margin: "0 0 10px", fontSize: 15 }}>休憩</h4>
                {editForm.breaks.filter((item) => !item.isDeleted).length === 0 && (
                  <p style={{ margin: "0 0 10px", color: "#64748B", fontSize: 13 }}>登録された休憩はありません</p>
                )}
                {editForm.breaks.map((item, index) => item.isDeleted ? null : (
                  <div key={item.key} style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 8, alignItems: "end", marginBottom: 10 }}>
                    <label style={styles.label}>休憩開始日時
                      <input type="datetime-local" value={item.start} onChange={(event) => setEditForm({
                        ...editForm,
                        breaks: editForm.breaks.map((value, itemIndex) => itemIndex === index ? { ...value, start: event.target.value } : value),
                      })} style={styles.input} />
                    </label>
                    <label style={styles.label}>休憩終了日時
                      <input type="datetime-local" value={item.end} onChange={(event) => setEditForm({
                        ...editForm,
                        breaks: editForm.breaks.map((value, itemIndex) => itemIndex === index ? { ...value, end: event.target.value } : value),
                      })} style={styles.input} />
                    </label>
                    <button type="button" onClick={() => setEditForm({
                      ...editForm,
                      breaks: editForm.breaks.map((value, itemIndex) => itemIndex === index ? { ...value, isDeleted: true } : value),
                    })} style={{ ...styles.linkButton, color: "#B91C1C", marginBottom: 2 }}>削除</button>
                  </div>
                ))}
                <button type="button" onClick={() => setEditForm({
                  ...editForm,
                  breaks: [...editForm.breaks, {
                    key: `new-${Date.now()}-${editForm.breaks.length}`,
                    startLogId: null,
                    endLogId: null,
                    start: "",
                    end: "",
                    isDeleted: false,
                  }],
                })} style={styles.secondaryButton}>＋休憩を追加</button>
                {editWorkSet.breaks.some((item) => !item.start || !item.end) && (
                  <p style={{ ...styles.error, marginTop: 10 }}>休憩打刻が未完了です。空欄を補完するか、不要な休憩を削除してください。</p>
                )}
                <div style={{ marginTop: 12, padding: 10, background: "#F8FAFC", borderRadius: 8, fontSize: 13 }}>
                  <div>休憩合計：{formatMinutesZero(correctionPreview?.breakMinutes ?? 0)}</div>
                  <div>修正後労働時間：{correctionPreview?.workMinutes == null ? "未確定" : formatMinutesZero(correctionPreview.workMinutes)}</div>
                  <div>修正後深夜時間：{correctionPreview?.nightMinutes == null ? "未確定" : formatMinutesZero(correctionPreview.nightMinutes)}</div>
                </div>
              </div>
              <label style={styles.label}>修正理由
                <textarea required value={editForm.reason} onChange={(event) => setEditForm({ ...editForm, reason: event.target.value })} style={{ ...styles.input, minHeight: 88, paddingTop: 10 }} />
              </label>
              {correctionError && <p style={styles.error}>{correctionError}</p>}
              <div style={styles.inlineActions}>
                <button type="submit" disabled={isSavingCorrection} style={{ ...styles.button, opacity: isSavingCorrection ? 0.5 : 1 }}>
                  {isSavingCorrection ? "保存中..." : "保存"}
                </button>
                <button type="button" disabled={isSavingCorrection} onClick={() => { setEditWorkSet(null); setEditForm(null); }} style={styles.secondaryButton}>キャンセル</button>
              </div>
            </div>
          </form>
        </div>
      )}

      {/* 権限設定モーダル */}
      {permissionModal && (() => {
        const emp = employees.find((e) => e.id === permissionModal.empId);
        if (!emp) return null;
        const fcStores = permissionModal.role === "fc_manager" ? stores.filter((s) => s.isFc === true) : stores;
        return (
          <div style={styles.modalOverlay} onClick={() => setPermissionModal(null)}>
            <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800 }}>権限設定：{emp.name}</h3>
                <button type="button" onClick={() => setPermissionModal(null)} style={{ ...styles.linkButton, fontSize: 14 }}>✕ 閉じる</button>
              </div>

              {emp.hasManagerAccount && (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, padding: "8px 12px", background: "#F0FDF4", borderRadius: 8, border: "1px solid #BBF7D0" }}>
                  <span style={{ fontSize: 13 }}>現在の権限：<strong>{emp.accountRole ?? "manager"}</strong></span>
                  <button
                    type="button"
                    disabled={permissionWorking}
                    onClick={() => deleteManagerAccount(emp)}
                    style={{ ...styles.linkButton, color: "#B91C1C", borderColor: "#FCA5A5", background: "#FEF2F2" }}
                  >
                    {permissionWorking ? "処理中..." : "アカウント削除"}
                  </button>
                </div>
              )}

              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <label style={styles.label}>権限
                  <select
                    value={permissionModal.role}
                    onChange={(e) => setPermissionModal({ ...permissionModal, role: e.target.value as "manager" | "area_manager" | "fc_manager" | "", storeIds: [] })}
                    style={styles.input}
                  >
                    <option value="">選択してください</option>
                    <option value="manager">manager（1店舗・勤怠/従業員/打刻修正）</option>
                    <option value="area_manager">area_manager（複数店舗・勤怠/従業員/打刻修正/Excel）</option>
                    <option value="fc_manager">fc_manager（FC店舗・全タブ）</option>
                  </select>
                </label>

                {permissionModal.role === "manager" && (
                  <label style={styles.label}>担当店舗
                    <select
                      value={permissionModal.storeId}
                      onChange={(e) => setPermissionModal({ ...permissionModal, storeId: e.target.value })}
                      style={styles.input}
                    >
                      <option value="">選択してください</option>
                      {stores.map((s) => <option key={s.id} value={s.id}>{getStoreName(s)}</option>)}
                    </select>
                  </label>
                )}

                {(permissionModal.role === "area_manager" || permissionModal.role === "fc_manager") && (
                  <div style={styles.label}>
                    <span style={styles.labelText}>担当店舗（複数選択可）{permissionModal.role === "fc_manager" ? "※FC店舗のみ" : ""}</span>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
                      {fcStores.map((s) => (
                        <label key={s.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
                          <input
                            type="checkbox"
                            checked={permissionModal.storeIds.includes(s.id)}
                            onChange={(e) => {
                              const next = e.target.checked
                                ? [...permissionModal.storeIds, s.id]
                                : permissionModal.storeIds.filter((id) => id !== s.id);
                              setPermissionModal({ ...permissionModal, storeIds: next });
                            }}
                          />
                          {getStoreName(s)}{s.isFc ? " (FC)" : ""}
                        </label>
                      ))}
                      {fcStores.length === 0 && <p style={{ margin: 0, fontSize: 12, color: "#B91C1C" }}>FC店舗が登録されていません。先に店舗管理でFC店舗を登録してください。</p>}
                    </div>
                  </div>
                )}

                <label style={styles.label}>メールアドレス
                  <input type="email" value={permissionModal.email} onChange={(e) => setPermissionModal({ ...permissionModal, email: e.target.value })} style={styles.input} />
                </label>
                <label style={styles.label}>パスワード（6文字以上）
                  <input type="password" value={permissionModal.password} onChange={(e) => setPermissionModal({ ...permissionModal, password: e.target.value })} style={styles.input} />
                </label>

                {permissionMsg && (
                  <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: permissionMsg.includes("作成") || permissionMsg.includes("削除") ? "#047857" : "#B91C1C" }}>
                    {permissionMsg}
                  </p>
                )}

                <button
                  type="button"
                  disabled={permissionWorking || !permissionModal.role}
                  onClick={() => savePermission(emp)}
                  style={styles.button}
                >
                  {permissionWorking ? "作成中..." : "アカウント作成"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
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
  labelText: {
    fontSize: 13,
    fontWeight: 800,
    color: "#334155",
  },
  logoPlaceholderSmall: {
    color: "#64748B",
    fontSize: 13,
    fontWeight: 700,
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
  fcBadge: {
    display: "inline-flex",
    padding: "2px 8px",
    borderRadius: 999,
    background: "#FEF3C7",
    color: "#92400E",
    fontSize: 12,
    fontWeight: 800,
  },
  chainBadge: {
    display: "inline-flex",
    padding: "2px 8px",
    borderRadius: 999,
    background: "#EFF6FF",
    color: "#1D4ED8",
    fontSize: 12,
    fontWeight: 800,
  },
  modalOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.45)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
    padding: 16,
  },
  modal: {
    background: "#ffffff",
    borderRadius: 16,
    padding: 24,
    width: "100%",
    maxWidth: 480,
    maxHeight: "90svh",
    overflowY: "auto",
    boxShadow: "0 24px 60px rgba(0,0,0,0.25)",
  },
} satisfies Record<string, React.CSSProperties>;

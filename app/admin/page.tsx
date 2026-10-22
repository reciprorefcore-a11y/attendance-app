/* eslint-disable react-hooks/refs -- submit handlers read the lock ref only after user events, never during render. */
"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signOut } from "firebase/auth";
import { auth, db } from "@/lib/firebase";
import { useAuthProfile } from "@/lib/auth";
import { BreakEditorSection } from "@/components/BreakEditorSection";
import {
  Timestamp,
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
} from "firebase/firestore";
import type { Employee, Store } from "@/lib/attendance";
import { isAdminPartTimeEmployee, isFullTimeEmployee } from "@/lib/employee-classification";
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
  calculateCorrectionPreview,
  fromJstDateTimeInput,
  openCorrectionEditor,
  shiftCorrectionWorkDate,
  validateCorrection,
  type CorrectionEditor,
  type CorrectionStatus,
  type CorrectionWorkSet,
} from "@/lib/attendance-correction";
import { validateManualAttendance, type ManualAttendanceInput } from "@/lib/manual-attendance";
import { classifyPartTimeEmployee, EMPLOYEE_REASON_OPTIONS, validateEmployeeReason, type EmployeeAction } from "@/lib/employee-management";
import { normalizeAttendanceHistory, type AttendanceHistoryRow } from "@/lib/attendance-history";

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
  isCancelled?: boolean;
  manuallyCreated?: boolean;
  manualRequestId?: string;
  deletedAt?: Timestamp | null;
  deletedBy?: string | null;
  isCorrected?: boolean;
  correctedAt?: Timestamp | null;
  correctedBy?: string | null;
  correctionReason?: string | null;
  deleteReason?: string | null;
  deletionBatchId?: string | null;
  restoredAt?: Timestamp | null;
  restoredBy?: string | null;
  restoreReason?: string | null;
  editReason?: string | null;
  manualEditReason?: string | null;
  requestedCorrectionReason?: string | null;
  creationReason?: string | null;
  cancellationReason?: string | null;
  cancelledBy?: string | null;
  cancelledAt?: Timestamp | null;
};

type EmployeeRow = Employee & { id: string; hourlyWage?: number | null; lateNightHourlyWage?:number|null; hasManagerAccount?: boolean; managerUid?: string | null; accountRole?: "manager" | "area_manager" | "fc_manager" | null; accountStoreIds?: string[] };
type EmployeeEditValue = ReturnType<typeof emptyEmployeeForm> & {lateNightHourlyWage:string;effectiveFrom:string;reasonType:string;reasonDetail:string};
type EmployeeHistoryRow={id:string;action:string;changes:Array<{field:string;label:string;before:unknown;after:unknown}>;effectiveFrom:string;reason:string;performedBy:string;performedByName:string;performedByRole:string;performedAt:string|Date};
type StoreRow = Store & { id: string };

const emptyEmployeeForm = () => ({
  name: "", nameKana: "", employeeCode: "", storeId: "", baseWage: "", status: "active",
  transportationCost: "", transportationType: "daily" as "daily" | "monthly" | "none",
  payrollEnabled: true,
  clockEnabled: true,
});
const localDate=()=>new Date(Date.now()+9*3600000).toISOString().slice(0,10);

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
const emptyManualForm = (): ManualAttendanceInput => ({ requestId: "", employeeId: "", storeId: "", workDate: "", clockIn: "", clockOut: "", breaks: [], creationReason: "", reasonDetail: "", note: "", allowSeparateShift: false });
const csvEmployeeFields = ["name", "nameKana", "employeeCode", "storeId", "baseHourlyWage", "status"] as const;

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
  const [attendanceAudits, setAttendanceAudits] = useState<Array<{ id: string; data: Record<string, unknown> }>>([]);
  const [attendanceAuditError, setAttendanceAuditError] = useState("");
  const [attendanceHistoryDialog, setAttendanceHistoryDialog] = useState<{ title: string; rows: AttendanceHistoryRow[] } | null>(null);
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [wagesByEmployee, setWagesByEmployee] = useState<Record<string, CalculationWage[]>>({});
  const [wageHistoryStatusByEmployee, setWageHistoryStatusByEmployee] = useState<
    Record<string, WageHistoryLoadStatus>
  >({});
  const [stores, setStores] = useState<StoreRow[]>([]);
  const [targetMonth, setTargetMonth] = useState(localMonth());
  const [storeFilter, setStoreFilter] = useState("all");
  const [activeTab, setActiveTab] = useState<TabId>("attendance");
  const [employeeManagementTab, setEmployeeManagementTab] = useState<"fulltime" | "parttime">("fulltime");
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [editWorkSet, setEditWorkSet] = useState<CorrectionWorkSet | null>(null);
  const [deletePunchDialog, setDeletePunchDialog] = useState<{ workSet: CorrectionWorkSet; selectedIds: string[]; reason: string } | null>(null);
  const [editForm, setEditForm] = useState<CorrectionEditor | null>(null);
  const [isSavingCorrection, setIsSavingCorrection] = useState(false);
  const [correctionError, setCorrectionError] = useState("");
  const [manualForm, setManualForm] = useState<ManualAttendanceInput | null>(null);
  const [manualConfirming, setManualConfirming] = useState(false);
  const [manualError, setManualError] = useState("");
  const [isSavingManual, setIsSavingManual] = useState(false);
  const correctionSaveLock = useRef(false);
  const correctionPreview = useMemo(
    () => editForm ? calculateCorrectionPreview(editForm) : null,
    [editForm],
  );
  const manualValidation = useMemo(() => manualForm ? validateManualAttendance(manualForm) : null, [manualForm]);
  const [message, setMessage] = useState("");
  const [employeeFilter,setEmployeeFilter]=useState<"active"|"inactive">("active");
  const [employeeEditor,setEmployeeEditor]=useState<{employee:EmployeeRow;value:EmployeeEditValue;confirming:boolean}|null>(null);
  const [employeeActionDialog,setEmployeeActionDialog]=useState<{employee:EmployeeRow;action:Exclude<EmployeeAction,"edit">;reasonType:string;reasonDetail:string;effectiveFrom:string;deletionConfirmed:boolean}|null>(null);
  const [employeeDetail,setEmployeeDetail]=useState<{employee:EmployeeRow;tab:"basic"|"history";history:EmployeeHistoryRow[];loading:boolean}|null>(null);
  const [employeeOperationError,setEmployeeOperationError]=useState("");
  const [employeeOperationPending,setEmployeeOperationPending]=useState(false);
  const employeeOperationLock=useRef(false);
  const [employeeMenuId,setEmployeeMenuId]=useState<string|null>(null);
  const [employeeTopMenuOpen,setEmployeeTopMenuOpen]=useState(false);
  const [showEmployeeCreate,setShowEmployeeCreate]=useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams(window.location.search);
      if (params.get("tab") === "employees") setActiveTab("employees");
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  const [employeeForm, setEmployeeForm] = useState(emptyEmployeeForm);
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
  const [employeeFormError, setEmployeeFormError] = useState("");
  const [csvImportErrors, setCsvImportErrors] = useState<CsvEmployeeError[]>([]);
  const [csvImportSummary, setCsvImportSummary] = useState("");
  const [csvImporting, setCsvImporting] = useState(false);
  const [wageEmpEditId, setWageEmpEditId] = useState("");
  const [wageEmpInput, setWageEmpInput] = useState("");
  const [wageStoreEditId, setWageStoreEditId] = useState("");
  const [wageStoreInput, setWageStoreInput] = useState("");
  const [selectedExportStoreIds, setSelectedExportStoreIds] = useState<string[]>([]);

  const isAdmin = !isAuthLoading && profile?.role === "admin";
  const isFcManager = !isAuthLoading && profile?.role === "fc_manager";
  const isAreaManager = !isAuthLoading && profile?.role === "area_manager";
  const isManager = !isAuthLoading && profile?.role === "manager";
  const managerStoreId = isManager ? (profile?.storeId ?? "") : "";
  const myStoreIds = (isFcManager || isAreaManager) ? (profile?.storeIds ?? []) : [];
  const isReadOnlyStore = isFcManager;
  const canChangeStoreFilter = isAdmin || isFcManager || isAreaManager;
  const areaManagerAllowedTabs: TabId[] = ["attendance", "employees", "edits"];
  const managerAllowedTabs: TabId[] = ["attendance", "employees", "edits"];
  const visibleTabs = isAdmin
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
      if (isAdmin) {
        try {
          const auditSnapshot = await getDocs(collection(db, "auditLogs"));
          setAttendanceAudits(auditSnapshot.docs.map((item) => ({ id: item.id, data: item.data() })));
          setAttendanceAuditError("");
        } catch (auditError) {
          console.error("attendance audit fetch failed", auditError);
          setAttendanceAudits([]);
          setAttendanceAuditError("監査履歴を取得できませんでした。再読み込みしてください。");
        }
      } else { setAttendanceAudits([]); setAttendanceAuditError(""); }
    } catch (error) {
      console.error("clockLogs fetch failed", error);
      const detail = error instanceof Error ? error.message : String(error);
      setErrorMessage(`打刻データ取得に失敗しました（Firestoreルールを確認してください）: ${detail}`);
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
  const calculationLogs = useMemo(() => toCalculationLogs(timecards.filter((item) => item.isCancelled !== true)), [timecards]);
  const correctionWorkSets = useMemo(
    () => buildCorrectionWorkSets(calculationLogs),
    [calculationLogs],
  );
  const deletedAttendanceGroups = useMemo(() => {
    const groups = new Map<string, TimecardRow[]>();
    for (const row of timecards.filter((item) => item.isDeleted === true)) {
      const key = row.deletionBatchId || row.id;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    return [...groups.entries()].map(([key, logs]) => ({ key, logs, source: logs[0], workDate: logs.map(logDate).filter((date): date is Date => Boolean(date)).sort((a, b) => a.getTime() - b.getTime())[0] })).filter((group) => group.workDate && dateKey(group.workDate).startsWith(targetMonth));
  }, [timecards, targetMonth]);
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

  const openManualAttendance = () => {
    const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
    const defaultStore = storeFilter !== "all" ? storeFilter : stores[0]?.id ?? "";
    setManualForm({ ...emptyManualForm(), requestId: crypto.randomUUID(), storeId: defaultStore, workDate: today, clockIn: `${today}T09:00`, clockOut: `${today}T18:00` });
    setManualConfirming(false); setManualError("");
  };

  const submitManualAttendance = async () => {
    if (!manualForm || !user || !manualValidation?.preview) { setManualError(manualValidation?.errors.join("。") || "入力内容を確認してください。"); return; }
    if (!manualConfirming) { setManualConfirming(true); return; }
    setIsSavingManual(true); setManualError("");
    try {
      const token = await user.getIdToken();
      const response = await fetch("/api/attendance/manual", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(manualForm) });
      const data = await response.json() as { error?: string; code?: string };
      if (!response.ok) {
        if (data.code === "existing_attendance") setManualError(`${data.error}「既存の打刻を修正する」か、「別勤務として追加する」を選択してください。`);
        else setManualError(data.error ?? "手動登録に失敗しました。");
        setManualConfirming(false); return;
      }
      const employee = employees.find((item) => item.id === manualForm.employeeId);
      setMessage(`${employee?.name ?? "従業員"}さんの${manualForm.workDate.replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$1年$2月$3日")}の勤怠を手動登録しました`);
      setManualForm(null); setManualConfirming(false); await load();
    } finally { setIsSavingManual(false); }
  };

  const cancelManualAttendance = async (requestId: string, employeeName: string) => {
    if (!user) return; const reason = window.prompt(`${employeeName}さんの手動登録を取り消す理由を入力してください。`); if (!reason?.trim()) return;
    const token = await user.getIdToken();
    const response = await fetch("/api/attendance/manual/cancel", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ requestId, cancellationReason: reason.trim() }) });
    const data = await response.json() as { error?: string }; if (!response.ok) { setMessage(data.error ?? "取消に失敗しました。"); return; }
    setMessage(`${employeeName}さんの手動登録を取り消しました。履歴は保持されています。`); await load();
  };

  const operationChanges = (logs: Array<TimecardRow | CalculationClockLog>) => logs.map((row) => ({ id: row.id, operation: "update" as const, type: normalizeClockType(row as TimecardRow) as "clock_in" | "clock_out" | "break_start" | "break_end" }));

  const submitAttendanceLogAction = async (action: "delete" | "restore", workDate: string, employeeId: string, storeId: string, logs: TimecardRow[], reason: string) => {
    if (!user || !reason.trim() || logs.length === 0) return false;
    setIsSavingCorrection(true); setCorrectionError("");
    try {
      const token = await user.getIdToken();
      const response = await fetch("/api/attendance/clock-logs", { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ action, employeeId, storeId, workDate, reason: reason.trim(), changes: operationChanges(logs) }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "打刻操作に失敗しました");
      setMessage(action === "delete" ? "勤務セットを論理削除しました。打刻履歴は保持されています。" : "勤務セットの削除を取り消しました。");
      await load();
      return true;
    } catch (error) { setCorrectionError(error instanceof Error ? error.message : "打刻操作に失敗しました"); return false; }
    finally { setIsSavingCorrection(false); }
  };

  const openDeletePunchDialog = (workSet: CorrectionWorkSet) => {
    setCorrectionError("");
    setDeletePunchDialog({ workSet, selectedIds: [], reason: "" });
  };

  const confirmDeletePunches = async () => {
    if (!deletePunchDialog) return;
    const reason = deletePunchDialog.reason.trim();
    if (!reason) { setCorrectionError("削除理由を入力してください"); return; }
    if (deletePunchDialog.selectedIds.length === 0) { setCorrectionError("削除する打刻を1件以上選択してください"); return; }
    const selected = new Set(deletePunchDialog.selectedIds);
    const logs = timecards.filter((item) => selected.has(item.id));
    const ok = await submitAttendanceLogAction("delete", deletePunchDialog.workSet.workDate, deletePunchDialog.workSet.employeeId, deletePunchDialog.workSet.storeId, logs, reason);
    if (ok) setDeletePunchDialog(null);
  };

  const restoreDeletedGroup = async (group: { logs: TimecardRow[]; source: TimecardRow; workDate: Date }) => {
    const reason = window.prompt("削除取消の理由を入力してください。空欄では取消できません。");
    if (!reason?.trim()) { if (reason !== null) setCorrectionError("削除取消の理由を入力してください"); return; }
    await submitAttendanceLogAction("restore", dateKey(group.workDate), group.source.employeeId ?? "", group.source.storeId, group.logs, reason);
  };

  const openAttendanceHistory = (title: string, logs: Array<TimecardRow | CalculationClockLog>) => {
    const rows = logs.flatMap((log) => normalizeAttendanceHistory(log.id, log as unknown as Record<string, unknown>, attendanceAudits));
    setAttendanceHistoryDialog({ title, rows: [...new Map(rows.map((row) => [row.id, row])).values()] });
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
      const safeKey = editWorkSet.key.replace(/[^a-zA-Z0-9_-]/g, "_");
      const inId = editWorkSet.clockInLog?.id ?? `correction_${safeKey}_clock_in`;
      const outId = editWorkSet.clockOutLog?.id ?? `correction_${safeKey}_clock_out`;
      const changes: Array<{ id: string; operation: "create" | "update" | "delete"; type: "clock_in" | "clock_out" | "break_start" | "break_end"; timestamp?: string }> = [];
      if (clockIn) changes.push({ id: inId, operation: editWorkSet.clockInLog ? "update" : "create", type: "clock_in", timestamp: clockIn.toISOString() });
      if (clockOut) changes.push({ id: outId, operation: editWorkSet.clockOutLog ? "update" : "create", type: "clock_out", timestamp: clockOut.toISOString() });
      for (const [index, item] of editForm.breaks.entries()) {
        const breakKey = item.key.replace(/[^a-zA-Z0-9_-]/g, "_");
        const startId = item.startLogId ?? `correction_${safeKey}_${breakKey}_${index}_break_start`;
        const endId = item.endLogId ?? `correction_${safeKey}_${breakKey}_${index}_break_end`;
        if (item.isDeleted) {
          if (item.startLogId) changes.push({ id: startId, operation: "delete", type: "break_start" });
          if (item.endLogId) changes.push({ id: endId, operation: "delete", type: "break_end" });
          continue;
        }
        const start = fromJstDateTimeInput(item.start)!;
        const end = fromJstDateTimeInput(item.end)!;
        changes.push({ id: startId, operation: item.startLogId ? "update" : "create", type: "break_start", timestamp: start.toISOString() });
        changes.push({ id: endId, operation: item.endLogId ? "update" : "create", type: "break_end", timestamp: end.toISOString() });
      }
      const token = await user!.getIdToken();
      const response = await fetch("/api/attendance/clock-logs", { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ action: "correct", employeeId: employee.id, storeId: store.id, workDate: editForm.workDate, reason: editForm.reason, changes }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "打刻修正に失敗しました");
      const editedIds = new Set([editWorkSet.clockInLog?.id, editWorkSet.clockOutLog?.id].filter(Boolean));
      const latestOtherPunch = calculationLogs.filter((log) => log.employeeId === editWorkSet.employeeId && !editedIds.has(log.id)).reduce((latest, log) => Math.max(latest, log.timestamp.getTime()), 0);
      if (clockOut && employee.id === editWorkSet.employeeId && clockOut.getTime() >= latestOtherPunch) await setDoc(doc(db, "clockStates", employee.id), { employeeId: employee.id, lastType: "clock_out", lastLogId: outId, storeId: store.id, updatedAt: serverTimestamp() });
      setMessage("打刻を修正しました。");
      setEditWorkSet(null);
      setEditForm(null);
      await load();
    } catch (error) {
      console.error("timecard edit failed", error);
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      setCorrectionError(
        error instanceof Error && error.message ? error.message : code.includes("permission-denied")
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
    if (missing.length > 0) {
      setEmployeeFormError(`未入力または不正なフィールド：${missing.join("、")}`);
      return;
    }
    setEmployeeFormError("");
    const payload = {
      name: employeeForm.name.trim(),
      nameKana: employeeForm.nameKana.trim(),
      employeeCode: employeeForm.employeeCode.trim(),
      storeId: nextStoreId,
      baseWage: Number(employeeForm.baseWage) || 0,
      status: employeeForm.status as "active" | "inactive",
      transportationCost: Number(employeeForm.transportationCost) || 0,
      transportationType: employeeForm.transportationType,
      payrollEnabled: employeeForm.payrollEnabled,
      employeeType: "partTime" as const,
      employmentType: "part_time" as const,
      payrollType: "hourly" as const,
      clockEnabled: employeeForm.clockEnabled,
    };
    try {
      if (!user) throw new Error("認証情報を取得できません。");
      const token = await user.getIdToken(true);
      const response = await fetch("/api/employees", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(payload) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "従業員の保存に失敗しました。");
      setEmployeeForm(emptyEmployeeForm());
      setShowEmployeeCreate(false);
      setEmployeeFormError("");
      setMessage("従業員を保存しました。");
      await load();
    } catch (error) {
      console.error("employee save failed", error);
      setEmployeeFormError("従業員の保存に失敗しました。");
    }
  };

  const editEmployee = (employee: EmployeeRow) => {
    if (isFullTimeEmployee(employee)||employee.isDeleted===true) return;
    setEmployeeOperationError("");setEmployeeEditor({employee,confirming:false,value:{
      name: employee.name,
      nameKana: employee.nameKana,
      employeeCode: employee.employeeCode,
      storeId: employee.storeId,
      baseWage: String(getEmployeeBaseWage(employee) || ""),
      status: employee.status === "inactive" ? "inactive" : "active",
      transportationCost: String(employee.transportationCost || ""),
      transportationType: employee.transportationType ?? "daily",
      payrollEnabled: employee.payrollEnabled !== false,
      clockEnabled: employee.clockEnabled !== false,
      lateNightHourlyWage:String(employee.lateNightHourlyWage??""),effectiveFrom:localDate(),reasonType:"",reasonDetail:"",
    }});
  };
  const openEmployeeAction=(employee:EmployeeRow,action:Exclude<EmployeeAction,"edit">)=>{setEmployeeOperationError("");setEmployeeActionDialog({employee,action,reasonType:"",reasonDetail:"",effectiveFrom:localDate(),deletionConfirmed:false});};
  const submitEmployeeOperation=async(employee:EmployeeRow,payload:Record<string,unknown>)=>{if(employeeOperationLock.current)return;if(!user){setEmployeeOperationError("認証情報を取得できません。再度ログインしてください。");return;}employeeOperationLock.current=true;setEmployeeOperationPending(true);setEmployeeOperationError("");try{const token=await user.getIdToken(true),response=await fetch(`/api/employees/${encodeURIComponent(employee.id)}`,{method:"PATCH",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify(payload)}),text=await response.text();let body:{error?:string;code?:string}={};try{body=text?JSON.parse(text) as {error?:string;code?:string}:{};}catch{body={};}if(!response.ok)throw new Error(body.error??`従業員操作に失敗しました（HTTP ${response.status}）。`);setEmployeeEditor(null);setEmployeeActionDialog(null);if(payload.action==="delete")setEmployees(current=>current.filter(item=>item.id!==employee.id));else await load();setMessage(`${employee.name}さんの情報を更新しました。`);}catch(error){setEmployeeOperationError(error instanceof Error?error.message:"従業員操作に失敗しました。再度お試しください。");}finally{employeeOperationLock.current=false;setEmployeeOperationPending(false);}};
  const openEmployeeDetail=async(employee:EmployeeRow)=>{setEmployeeDetail({employee,tab:"basic",history:[],loading:true});if(!user)return;const token=await user.getIdToken(true),response=await fetch(`/api/employees/${employee.id}`,{headers:{Authorization:`Bearer ${token}`}}),body=await response.json() as {history?:EmployeeHistoryRow[]};setEmployeeDetail(current=>current&&current.employee.id===employee.id?{...current,history:response.ok?(body.history??[]):[],loading:false}:current);};

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
            message: "2行目に name, nameKana, employeeCode, storeId, baseHourlyWage, status のキー行が必要です。",
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
        if (!values.status.trim()) rowErrors.push("status は必須です");
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
        if (!user) throw new Error("認証情報を取得できません。");
        const token = await user.getIdToken(true);
        const response = await fetch("/api/employees", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({
          name: row.values.name.trim(),
          nameKana: row.values.nameKana.trim(),
          employeeCode: row.values.employeeCode.trim(),
          storeId: managerStoreId || row.values.storeId.trim(),
          baseWage: Number(row.values.baseHourlyWage) || 0,
          status: row.values.status.trim(),
          employeeType: "partTime",
          employmentType: "part_time",
          payrollType: "hourly",
          clockEnabled: true,
          payrollEnabled: true,
        }) });
        if (!response.ok) {
          const result = await response.json() as { error?: string };
          errors.push({ rowNumber: row.rowNumber, message: result.error ?? "登録に失敗しました", values: row.values });
        }
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
          .correction-modal {
            padding: 18px !important;
          }
          .correction-form-grid {
            grid-template-columns: 1fr !important;
          }
          .correction-break-header,
          .correction-break-summary {
            grid-template-columns: 1fr !important;
          }
          .correction-break-header {
            align-items: flex-start !important;
          }
          .correction-break-row {
            grid-template-columns: 1fr !important;
          }
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
              <span key={tab.id} style={{display:"contents"}}><button
                type="button"
                onClick={() => setActiveTab(tab.id)}
                style={activeTab === tab.id ? styles.activeSideNavButton : styles.sideNavButton}
              >
                {tab.label}
              </button>{isAdmin&&tab.id==="employees"&&<Link href="/hq/accounts" style={{...styles.sideNavButton,textDecoration:"none"}}>アカウント管理</Link>}</span>
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
            {isAdmin && <Link href="/hq/payroll" style={styles.linkAnchor}>給与計算</Link>}
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
            {isAdmin && (
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
            <span key={tab.id} style={{display:"contents"}}><button
              type="button"
              onClick={() => setActiveTab(tab.id)}
              style={activeTab === tab.id ? styles.activeTab : styles.tab}
            >
              {tab.label}
            </button>{isAdmin&&tab.id==="employees"&&<Link href="/hq/accounts" style={{...styles.tab,textDecoration:"none"}}>アカウント管理</Link>}</span>
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
                    {row.logs.some((log) => log.isCorrected === true || log.isManualEdited === true) && <span style={styles.chainBadge}>修正あり</span>}
                    {row.logs.some((log) => log.isDeleted === true) && <span style={styles.dangerBadge}>削除あり</span>}
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
                    {row.logs.length > 0 && <button type="button" onClick={() => openAttendanceHistory(`${row.employeeName} ${row.date}`, row.logs)} style={{ ...styles.linkButton, marginLeft: 8 }}>履歴</button>}
                  </td>
                </tr>
              ))}
            </DataTable>
            {attendanceRows.length === 0 && <p style={styles.empty}>データがありません</p>}
          </section>
        )}

        {activeTab === "employees" && (
          <section style={styles.tabPanel}>
            <h2 style={styles.sectionTitle}>従業員管理</h2>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20 }} aria-label="従業員区分">
              {isAdmin && (
                <button type="button" onClick={() => setEmployeeManagementTab("fulltime")} style={employeeManagementTab === "fulltime" ? styles.button : styles.secondaryButton}>
                  正社員
                </button>
              )}
              <button type="button" onClick={() => setEmployeeManagementTab("parttime")} style={!isAdmin || employeeManagementTab === "parttime" ? styles.button : styles.secondaryButton}>
                アルバイト
              </button>
            </div>
            {isAdmin && employeeManagementTab === "fulltime" ? (
              <section style={styles.panel}>
                <div style={styles.panelHeader}>
                  <div>
                    <h3 style={styles.subTitle}>正社員マスター</h3>
                    <p style={styles.helpText}>正社員の一覧、新規登録、詳細、編集、退職・無効化、再有効化を管理します。</p>
                  </div>
                  <Link href="/hq/employees" style={styles.button}>正社員マスターを開く</Link>
                </div>
                <p style={styles.helpText}>在籍／退職・無効フィルターを含む正社員管理画面へ移動します。アルバイトは正社員マスターには表示されません。</p>
              </section>
            ) : (
            <>
            <div style={styles.panelHeader}>
              <h2 style={styles.sectionTitle}>アルバイト管理</h2>
              <div style={styles.inlineActions}>
                <button
                  type="button"
                  onClick={() => {
                    setEmployeeForm(emptyEmployeeForm());
                    setShowEmployeeCreate(true);
                  }}
                  style={styles.button}
                >
                  ＋ アルバイトを登録
                </button>
                {isAdmin && (
                  <div style={{position:"relative"}}><button type="button" aria-label="アルバイト登録メニュー" onClick={()=>setEmployeeTopMenuOpen(!employeeTopMenuOpen)} style={styles.secondaryButton}>…</button>{employeeTopMenuOpen&&<div style={{position:"absolute",right:0,top:46,zIndex:20,minWidth:220,padding:8,border:"1px solid #CBD5E1",borderRadius:12,background:"white",boxShadow:"0 12px 30px rgba(15,23,42,.15)"}}><label style={{...styles.linkButton,display:"block",marginBottom:6}}>{csvImporting?"CSV取込中...":"CSV一括登録"}<input type="file" accept=".csv,text/csv" disabled={csvImporting} style={{display:"none"}} onChange={event=>{const file=event.target.files?.[0];if(!file)return;event.target.value="";setEmployeeTopMenuOpen(false);void importEmployeesFromCsv(file);}}/></label><button type="button" onClick={()=>{const blob=new Blob(["name,nameKana,employeeCode,storeId,baseHourlyWage,status\n"],{type:"text/csv"}),url=URL.createObjectURL(blob),link=document.createElement("a");link.href=url;link.download="parttime_employee_template.csv";link.click();URL.revokeObjectURL(url);setEmployeeTopMenuOpen(false);}} style={{...styles.linkButton,width:"100%"}}>CSVテンプレートをダウンロード</button></div>}</div>
                )}
              </div>
            </div>
            {csvImportSummary && <p style={styles.message}>{csvImportSummary}</p>}
            {csvImportErrors.length > 0 && (
              <section style={styles.tabPanel}>
                <h3 style={styles.subTitle}>CSVエラー一覧</h3>
                <DataTable headers={["行", "エラー", "name", "employeeCode", "storeId", "status"]}>
                  {csvImportErrors.map((error) => (
                    <tr key={`${error.rowNumber}-${error.message}`}>
                      <td style={styles.td}>{error.rowNumber || "-"}</td>
                      <td style={styles.dangerTd}>{error.message}</td>
                      <td style={styles.td}>{error.values?.name ?? ""}</td>
                      <td style={styles.td}>{error.values?.employeeCode ?? ""}</td>
                      <td style={styles.td}>{error.values?.storeId ?? ""}</td>
                      <td style={styles.td}>{error.values?.status ?? ""}</td>
                    </tr>
                  ))}
                </DataTable>
              </section>
            )}
            {showEmployeeCreate&&<form onSubmit={saveEmployee} noValidate style={styles.editForm} aria-label="アルバイト新規登録フォーム">
              <label style={styles.label}>氏名<input value={employeeForm.name} onChange={(e) => setEmployeeForm({ ...employeeForm, name: e.target.value })} style={styles.input} /></label>
              <label style={styles.label}>ひらがな<input value={employeeForm.nameKana} onChange={(e) => setEmployeeForm({ ...employeeForm, nameKana: e.target.value })} style={styles.input} /></label>
              <label style={styles.label}>社員コード<input value={employeeForm.employeeCode} onChange={(e) => setEmployeeForm({ ...employeeForm, employeeCode: e.target.value })} style={styles.input} /></label>
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
                  <option value="active">在籍中</option>
                  <option value="inactive">無効</option>
                </select>
              </label>
              <label style={styles.label}>交通費（円）<input type="number" value={employeeForm.transportationCost} onChange={(e) => setEmployeeForm({ ...employeeForm, transportationCost: e.target.value })} style={styles.input} /></label>
              <label style={styles.label}>交通費種別
                <select value={employeeForm.transportationType} onChange={(e) => setEmployeeForm({ ...employeeForm, transportationType: e.target.value as "daily" | "monthly" | "none" })} style={styles.input}>
                  <option value="daily">日割り</option>
                  <option value="monthly">定期代</option>
                  <option value="none">なし</option>
                </select>
              </label>
              <label style={styles.label}>給与対象
                <select value={employeeForm.payrollEnabled ? "yes" : "no"} onChange={(e) => setEmployeeForm({ ...employeeForm, payrollEnabled: e.target.value === "yes" })} style={styles.input}>
                  <option value="yes">対象</option>
                  <option value="no">対象外</option>
                </select>
              </label>
              <label style={styles.label}>打刻対象
                <select value={employeeForm.clockEnabled ? "yes" : "no"} onChange={(e) => setEmployeeForm({ ...employeeForm, clockEnabled: e.target.value === "yes" })} style={styles.input}>
                  <option value="yes">対象</option><option value="no">対象外</option>
                </select>
              </label>
              <div style={{ gridColumn: "1 / -1", display: "flex", flexDirection: "column", gap: 8 }}>
                {employeeFormError && (
                  <p style={{ margin: 0, color: "#B91C1C", fontWeight: 700, fontSize: 13, padding: "8px 12px", background: "#FEF2F2", borderRadius: 8, border: "1px solid #FCA5A5" }}>
                    {employeeFormError}
                  </p>
                )}
                <button type="submit" style={styles.button}>登録</button>
                <button type="button" onClick={()=>setShowEmployeeCreate(false)} style={styles.secondaryButton}>キャンセル</button>
              </div>
            </form>}
            {(()=>{const partTimers=employees.filter(employee=>!isFullTimeEmployee(employee)&&employee.isDeleted!==true);const counts={active:partTimers.filter(e=>classifyPartTimeEmployee(e)==="active").length,inactive:partTimers.filter(e=>classifyPartTimeEmployee(e)==="inactive").length};return <div style={{display:"flex",gap:6,flexWrap:"wrap",margin:"20px 0 14px"}}>{([['active','在籍中'],['inactive','無効']] as const).map(([key,label])=><button key={key} type="button" onClick={()=>setEmployeeFilter(key)} style={{...(employeeFilter===key?styles.button:styles.secondaryButton),padding:"8px 12px",minHeight:40}}>{label} <span style={{fontSize:11,padding:"2px 7px",borderRadius:999,background:employeeFilter===key?"rgba(255,255,255,.25)":"#E2E8F0"}}>{counts[key]}</span></button>)}</div>;})()}
            <div data-testid="employee-card-list" style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(min(100%,320px),1fr))",gap:14}}>{employees.filter(employee=>!isFullTimeEmployee(employee)&&employee.isDeleted!==true&&classifyPartTimeEmployee(employee)===employeeFilter).map(employee=>{const state=classifyPartTimeEmployee(employee),menuOpen=employeeMenuId===employee.id;return <article key={employee.id} role="button" tabIndex={0} onClick={()=>openEmployeeDetail(employee)} onKeyDown={e=>{if(e.key==='Enter')void openEmployeeDetail(employee);}} style={{position:"relative",border:"1px solid #E2E8F0",borderRadius:14,padding:16,background:"#fff",cursor:"pointer",minWidth:0}}><div style={{display:"flex",alignItems:"center",gap:8}}><h3 style={{fontSize:17,margin:0,flex:1}}>{employee.name}</h3><span style={state==="active"?styles.activeBadge:{...styles.inactiveBadge,...(state==="deleted"?{background:"#FEE2E2",color:"#991B1B"}:{})}}>{state==="active"?"在籍中":state==="inactive"?"無効":"削除済み"}</span><div style={{position:"relative"}}><button type="button" aria-label={`${employee.name}の操作メニュー`} onClick={e=>{e.stopPropagation();setEmployeeMenuId(menuOpen?null:employee.id);}} style={{...styles.secondaryButton,minWidth:42,padding:"8px 12px"}}>…</button>{menuOpen&&<div onClick={e=>e.stopPropagation()} style={{position:"absolute",right:0,top:44,zIndex:20,minWidth:150,padding:8,border:"1px solid #CBD5E1",borderRadius:12,background:"white",boxShadow:"0 12px 30px rgba(15,23,42,.15)"}}>{state==="active"&&<><button type="button" onClick={()=>openEmployeeAction(employee,"deactivate")} style={{...styles.linkButton,width:"100%",marginBottom:6}}>無効化</button><button type="button" onClick={()=>openEmployeeAction(employee,"delete")} style={{...styles.linkButton,width:"100%",color:"#B91C1C"}}>削除</button></>}{state==="inactive"&&<><button type="button" onClick={()=>openEmployeeAction(employee,"reactivate")} style={{...styles.linkButton,width:"100%",marginBottom:6}}>再有効化</button><button type="button" onClick={()=>openEmployeeAction(employee,"delete")} style={{...styles.linkButton,width:"100%",color:"#B91C1C"}}>削除</button></>}</div>}</div></div><div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,margin:"12px 0",fontSize:14,color:"#475569"}}><span>社員コード {employee.employeeCode}</span><span>{storeNameById(employee.storeId)}</span><span>基本時給 {getEmployeeBaseWage(employee).toLocaleString()}円</span></div>{<button type="button" onClick={e=>{e.stopPropagation();editEmployee(employee);}} style={{...styles.secondaryButton,width:"100%",minHeight:40}}>編集</button>}</article>;})}</div>
            </>
            )}
          </section>
        )}

        {employeeEditor&&(()=>{const {employee,value,confirming}=employeeEditor;const reasonError=validateEmployeeReason(value.reasonType,value.reasonDetail);const before={name:employee.name,nameKana:employee.nameKana,employeeCode:employee.employeeCode,storeId:employee.storeId,baseWage:String(getEmployeeBaseWage(employee)||""),lateNightHourlyWage:String(employee.lateNightHourlyWage??""),transportationType:employee.transportationType??"daily",transportationCost:String(employee.transportationCost||""),payrollEnabled:employee.payrollEnabled!==false,clockEnabled:employee.clockEnabled!==false,status:employee.status==="inactive"?"inactive":"active"};const changes=Object.entries(before).filter(([key,oldValue])=>String(oldValue)!==String(value[key as keyof EmployeeEditValue])).map(([key,oldValue])=>({key,before:String(oldValue),after:String(value[key as keyof EmployeeEditValue])}));const labels:Record<string,string>={name:"氏名",nameKana:"ふりがな",employeeCode:"社員コード",storeId:"所属店舗",baseWage:"基本時給",lateNightHourlyWage:"深夜時給",transportationType:"交通費区分",transportationCost:"交通費金額",payrollEnabled:"給与対象",clockEnabled:"打刻対象",status:"status"};return <div style={styles.modalOverlay} onClick={()=>setEmployeeEditor(null)}><div style={{...styles.modal,maxWidth:760}} onClick={e=>e.stopPropagation()}><h2>{employee.name}さんを編集</h2>{confirming?<><p>アルバイト情報を変更します。この操作は履歴に記録されます。変更内容を確認してください。</p><dl style={{display:"grid",gridTemplateColumns:"150px 1fr",gap:8}}><dt>氏名</dt><dd>{value.name}</dd><dt>対象店舗</dt><dd>{storeNameById(value.storeId)}</dd><dt>適用開始日</dt><dd>{value.effectiveFrom}</dd><dt>修正理由</dt><dd>{value.reasonType}{value.reasonDetail?`：${value.reasonDetail}`:""}</dd></dl><DataTable headers={["変更項目","変更前","変更後"]}>{changes.map(change=><tr key={change.key}><td style={styles.td}>{labels[change.key]}</td><td style={styles.td}>{change.before}</td><td style={styles.td}>{change.after}</td></tr>)}</DataTable><div style={styles.inlineActions}><button type="button" onClick={()=>setEmployeeEditor({...employeeEditor,confirming:false})} style={styles.secondaryButton}>入力へ戻る</button><button type="button" disabled={Boolean(reasonError)||changes.length===0} onClick={()=>submitEmployeeOperation(employee,{action:"edit",...value})} style={styles.button}>変更を確定</button></div></>:<><div style={styles.editForm}>{([['name','氏名'],['nameKana','ふりがな'],['employeeCode','社員コード'],['baseWage','基本時給'],['lateNightHourlyWage','深夜時給'],['transportationCost','交通費金額']] as const).map(([key,label])=><label key={key} style={styles.label}>{label}<input type={['baseWage','lateNightHourlyWage','transportationCost'].includes(key)?"number":"text"} value={String(value[key])} onChange={e=>setEmployeeEditor({...employeeEditor,value:{...value,[key]:e.target.value}})} style={styles.input}/></label>)}<label style={styles.label}>所属店舗<select value={value.storeId} disabled={isManager} onChange={e=>setEmployeeEditor({...employeeEditor,value:{...value,storeId:e.target.value}})} style={styles.input}>{stores.map(store=><option key={store.id} value={store.id}>{getStoreName(store)}</option>)}</select></label><label style={styles.label}>交通費区分<select value={value.transportationType} onChange={e=>setEmployeeEditor({...employeeEditor,value:{...value,transportationType:e.target.value as "daily"|"monthly"|"none"}})} style={styles.input}><option value="daily">日額</option><option value="monthly">月額</option><option value="none">なし</option></select></label>{([['payrollEnabled','給与対象'],['clockEnabled','打刻対象']] as const).map(([key,label])=><label key={key} style={styles.label}>{label}<select value={value[key]?"yes":"no"} onChange={e=>setEmployeeEditor({...employeeEditor,value:{...value,[key]:e.target.value==='yes'}})} style={styles.input}><option value="yes">対象</option><option value="no">対象外</option></select></label>)}<label style={styles.label}>status<select value={value.status} onChange={e=>setEmployeeEditor({...employeeEditor,value:{...value,status:e.target.value}})} style={styles.input}><option value="active">active</option><option value="inactive">inactive</option></select></label><label style={styles.label}>適用開始日<input type="date" value={value.effectiveFrom} onChange={e=>setEmployeeEditor({...employeeEditor,value:{...value,effectiveFrom:e.target.value}})} style={styles.input}/></label><label style={styles.label}>修正理由<select value={value.reasonType} onChange={e=>setEmployeeEditor({...employeeEditor,value:{...value,reasonType:e.target.value}})} style={styles.input}><option value="">選択してください</option>{EMPLOYEE_REASON_OPTIONS.map(reason=><option key={reason}>{reason}</option>)}</select></label>{value.reasonType==='その他'&&<label style={styles.label}>理由詳細<input value={value.reasonDetail} onChange={e=>setEmployeeEditor({...employeeEditor,value:{...value,reasonDetail:e.target.value}})} style={styles.input}/></label>}</div>{reasonError&&<p style={styles.error}>{reasonError}</p>}{employeeOperationError&&<p style={styles.error}>{employeeOperationError}</p>}<div style={styles.inlineActions}><button type="button" onClick={()=>setEmployeeEditor(null)} style={styles.secondaryButton}>キャンセル</button><button type="button" disabled={Boolean(reasonError)||!value.effectiveFrom} onClick={()=>setEmployeeEditor({...employeeEditor,confirming:true})} style={styles.button}>変更内容を確認</button></div></>}</div></div>;})()}

        {employeeActionDialog&&(()=>{const dialog=employeeActionDialog,reasonError=validateEmployeeReason(dialog.reasonType,dialog.reasonDetail),label={deactivate:"無効化",reactivate:"再有効化",delete:"削除"}[dialog.action],danger=dialog.action==='deactivate'||dialog.action==='delete';return <div style={styles.modalOverlay} onClick={()=>{if(!employeeOperationPending)setEmployeeActionDialog(null);}}><div style={styles.modal} onClick={e=>e.stopPropagation()}><h2>{dialog.action==='delete'?`${dialog.employee.name}さんを削除しますか？`:`${dialog.employee.name}さんを${label}`}</h2><p style={styles.helpText}>{dialog.action==='delete'?"削除すると従業員管理には表示されなくなり、復元できません。過去の勤怠・確定給与・給与明細は保持されます。よろしいですか？":"この操作は変更履歴へ記録されます。"}</p><label style={styles.label}>適用開始日<input type="date" value={dialog.effectiveFrom} onChange={e=>setEmployeeActionDialog({...dialog,effectiveFrom:e.target.value})} style={styles.input}/></label><label style={styles.label}>理由<select value={dialog.reasonType} onChange={e=>setEmployeeActionDialog({...dialog,reasonType:e.target.value})} style={styles.input}><option value="">選択してください</option>{EMPLOYEE_REASON_OPTIONS.map(reason=><option key={reason}>{reason}</option>)}</select></label>{dialog.reasonType==='その他'&&<label style={styles.label}>理由詳細<input value={dialog.reasonDetail} onChange={e=>setEmployeeActionDialog({...dialog,reasonDetail:e.target.value})} style={styles.input}/></label>}{dialog.action==='delete'&&<label style={{display:"flex",gap:8,alignItems:"center",marginTop:12}}><input type="checkbox" checked={dialog.deletionConfirmed} onChange={e=>setEmployeeActionDialog({...dialog,deletionConfirmed:e.target.checked})}/>復元できないことを確認しました</label>}{reasonError&&<p style={styles.error}>{reasonError}</p>}{employeeOperationError&&<p style={styles.error}>{employeeOperationError}</p>}<div style={styles.inlineActions}><button type="button" disabled={employeeOperationPending} onClick={()=>setEmployeeActionDialog(null)} style={styles.secondaryButton}>キャンセル</button><button type="button" disabled={employeeOperationPending||Boolean(reasonError)||!dialog.effectiveFrom||(dialog.action==='delete'&&!dialog.deletionConfirmed)} onClick={()=>submitEmployeeOperation(dialog.employee,{action:dialog.action,reasonType:dialog.reasonType,reasonDetail:dialog.reasonDetail,effectiveFrom:dialog.effectiveFrom})} style={danger?styles.dangerButton:styles.button}>{employeeOperationPending?"処理中...":`${label}する`}</button></div></div></div>;})()}

        {employeeDetail&&(()=>{const employee=employeeDetail.employee,state=classifyPartTimeEmployee(employee),menuOpen=employeeMenuId===`detail-${employee.id}`;return <div style={styles.modalOverlay} onClick={()=>setEmployeeDetail(null)}><div style={{...styles.modal,maxWidth:760}} onClick={e=>e.stopPropagation()}><div style={{display:"flex",alignItems:"center",gap:8}}><h2 style={{flex:1,margin:0}}>{employee.name}さんの詳細</h2>{<button type="button" onClick={()=>{setEmployeeDetail(null);editEmployee(employee);}} style={styles.button}>編集</button>}<div style={{position:"relative"}}><button type="button" aria-label="詳細操作メニュー" onClick={()=>setEmployeeMenuId(menuOpen?null:`detail-${employee.id}`)} style={styles.secondaryButton}>…</button>{menuOpen&&<div style={{position:"absolute",right:0,top:44,zIndex:20,minWidth:150,padding:8,border:"1px solid #CBD5E1",borderRadius:12,background:"white",boxShadow:"0 12px 30px rgba(15,23,42,.15)"}}>{state==="active"&&<><button type="button" onClick={()=>openEmployeeAction(employee,"deactivate")} style={{...styles.linkButton,width:"100%",marginBottom:6}}>無効化</button><button type="button" onClick={()=>openEmployeeAction(employee,"delete")} style={{...styles.linkButton,width:"100%",color:"#B91C1C"}}>削除</button></>}{state==="inactive"&&<><button type="button" onClick={()=>openEmployeeAction(employee,"reactivate")} style={{...styles.linkButton,width:"100%",marginBottom:6}}>再有効化</button><button type="button" onClick={()=>openEmployeeAction(employee,"delete")} style={{...styles.linkButton,width:"100%",color:"#B91C1C"}}>削除</button></>}</div>}</div></div><div style={{...styles.inlineActions,marginTop:16}}><button type="button" onClick={()=>setEmployeeDetail({...employeeDetail,tab:"basic"})} style={employeeDetail.tab==='basic'?styles.button:styles.secondaryButton}>基本情報</button><button type="button" onClick={()=>setEmployeeDetail({...employeeDetail,tab:"history"})} style={employeeDetail.tab==='history'?styles.button:styles.secondaryButton}>変更履歴</button></div>{employeeDetail.tab==='basic'?<div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(220px,1fr))",gap:10,margin:"16px 0",fontSize:14}}><p>社員コード：{employee.employeeCode}</p><p>ふりがな：{employee.nameKana}</p><p>所属店舗：{storeNameById(employee.storeId)}</p><p>状態：{state==="active"?"在籍中":state==="inactive"?"無効":"削除済み"}</p><p>基本時給：{getEmployeeBaseWage(employee)}円</p><p>深夜時給：{employee.lateNightHourlyWage??0}円</p><p>交通費：{employee.transportationCost??0}円</p><p>給与対象：{employee.payrollEnabled!==false?"対象":"対象外"}</p><p>打刻対象：{employee.clockEnabled!==false?"対象":"対象外"}</p></div>:employeeDetail.loading?<p>履歴を読み込み中...</p>:employeeDetail.history.length===0?<p style={styles.empty}>変更履歴はありません</p>:<div>{employeeDetail.history.map(row=><article key={row.id} style={{borderBottom:"1px solid #E2E8F0",padding:"12px 0"}}><b>{row.action}</b><p>{new Date(row.performedAt).toLocaleString('ja-JP')}　操作者：{row.performedByName||row.performedBy}（{row.performedByRole}）</p>{row.changes?.map(change=><p key={change.field}>{change.label}：{String(change.before??'')} → {String(change.after??'')}</p>)}<p>適用開始日：{row.effectiveFrom}<br/>理由：{row.reason}<br/>操作者UID：{row.performedBy}</p></article>)}</div>}<button type="button" onClick={()=>setEmployeeDetail(null)} style={styles.secondaryButton}>閉じる</button></div></div>;})()}

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
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 16 }}>
              <h2 style={{ ...styles.sectionTitle, margin: 0 }}>打刻修正</h2>
              <button type="button" onClick={openManualAttendance} style={styles.button}>打刻漏れを新規登録</button>
            </div>
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
                    {[workSet.clockInLog, workSet.clockOutLog, ...workSet.breaks.flatMap((item) => [item.startLog, item.endLog])].some((log) => log?.isCorrected === true || log?.isManualEdited === true) && <span style={{ ...styles.chainBadge, marginLeft: 4 }}>修正あり</span>}
                    {workSet.warnings.map((warning) => <div key={warning} style={{ color: "#B91C1C", fontSize: 11, marginTop: 4 }}>{warning}</div>)}
                  </td>
                  <td style={styles.td}>
                    <button type="button" onClick={() => startEdit(workSet)} style={styles.linkButton}>修正</button>
                    <button type="button" onClick={() => openAttendanceHistory(`${workSet.employeeName} ${workSet.workDate}`, [workSet.clockInLog, workSet.clockOutLog, ...workSet.breaks.flatMap((item) => [item.startLog, item.endLog])].filter((item): item is CalculationClockLog => Boolean(item)))} style={{ ...styles.linkButton, marginLeft: 8 }}>履歴</button>
                    {isAdmin && <button type="button" disabled={isSavingCorrection} onClick={() => openDeletePunchDialog(workSet)} style={{ ...styles.linkButton, marginLeft: 8, color: "#B91C1C" }}>削除</button>}
                    {(() => { const source = timecards.find((item) => item.id === workSet.clockInLog?.id || item.id === workSet.clockOutLog?.id); return source?.manuallyCreated && source.manualRequestId ? <button type="button" onClick={() => cancelManualAttendance(source.manualRequestId!, workSet.employeeName)} style={{ ...styles.linkButton, marginLeft: 8, color: "#B91C1C" }}>手動登録を取消</button> : null; })()}
                  </td>
                </tr>
              ))}
            </DataTable>
            {filteredCorrectionWorkSets.length === 0 && <p style={styles.empty}>対象の勤務セットがありません</p>}
            {isAdmin && deletedAttendanceGroups.length > 0 && <>
              <h3 style={{ ...styles.subTitle, marginTop: 24 }}>削除済み打刻</h3>
              <DataTable headers={["勤務日", "従業員名", "勤務店舗", "状態", "理由", "操作"]}>
                {deletedAttendanceGroups.map((group) => <tr key={group.key}>
                  <td style={styles.td}>{dateKey(group.workDate)}</td>
                  <td style={styles.td}>{group.source.employeeName || group.source.employeeCode || group.source.employeeId}</td>
                  <td style={styles.td}>{group.source.workStoreName || group.source.storeName || storeNameById(group.source.storeId)}</td>
                  <td style={styles.td}><span style={styles.dangerBadge}>削除あり</span></td>
                  <td style={styles.td}>{group.source.deleteReason || "理由未記録"}</td>
                  <td style={styles.td}><button type="button" onClick={() => openAttendanceHistory(`${group.source.employeeName ?? "従業員"} ${dateKey(group.workDate)}`, group.logs)} style={styles.linkButton}>履歴</button><button type="button" disabled={isSavingCorrection} onClick={() => void restoreDeletedGroup(group)} style={{ ...styles.linkButton, marginLeft: 8 }}>削除取消</button></td>
                </tr>)}
              </DataTable>
            </>}
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
        <div style={{ ...styles.modalOverlay, padding: 24, overflowX: "hidden" }} onClick={() => { if (!isSavingCorrection) { setEditWorkSet(null); setEditForm(null); } }}>
          <form className="correction-modal" onSubmit={saveEdit} style={{ ...styles.modal, maxWidth: 900, maxHeight: "90vh", padding: 24, overflowX: "hidden" }} onClick={(event) => event.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: 27, lineHeight: 1.2, fontWeight: 800 }}>勤務セットを修正</h3>
              <button type="button" disabled={isSavingCorrection} onClick={() => { setEditWorkSet(null); setEditForm(null); }} style={{ ...styles.linkButton, flexShrink: 0, padding: "7px 11px", borderRadius: 9, fontSize: 14 }}>✕ 閉じる</button>
            </div>
            <div className="correction-form-grid" style={{ ...styles.editForm, marginTop: 0, gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 16, padding: 0, background: "transparent", alignItems: "start" }}>
              <label style={{ ...styles.label, fontSize: 15 }}>従業員
                <select required value={editForm.employeeId} onChange={(event) => setEditForm({ ...editForm, employeeId: event.target.value })} style={{ ...styles.input, minHeight: 50, fontSize: 17 }}>
                  <option value="">選択してください</option>
                  {employees.filter((employee) => employee.isDeleted !== true).map((employee) => (
                    <option key={employee.id} value={employee.id}>{employee.employeeCode} {employee.name}</option>
                  ))}
                </select>
              </label>
              <label style={{ ...styles.label, fontSize: 15 }}>勤務店舗
                <select required value={editForm.storeId} onChange={(event) => setEditForm({ ...editForm, storeId: event.target.value })} style={{ ...styles.input, minHeight: 50, fontSize: 17 }}>
                  <option value="">選択してください</option>
                  {stores.filter((store) => store.active !== false).map((store) => (
                    <option key={store.id} value={store.id}>{getStoreName(store)}</option>
                  ))}
                </select>
              </label>
              <label style={{ ...styles.label, fontSize: 15 }}>勤務日
                <input
                  required
                  type="date"
                  value={editForm.workDate}
                  onChange={(event) => setEditForm(shiftCorrectionWorkDate(editForm, event.target.value))}
                  style={{ ...styles.input, minHeight: 50, fontSize: 17 }}
                />
              </label>
              <label style={{ ...styles.label, fontSize: 15 }}>出勤日時
                <input required type="datetime-local" value={editForm.clockIn} onChange={(event) => setEditForm({ ...editForm, clockIn: event.target.value, workDate: event.target.value.slice(0, 10) })} style={{ ...styles.input, minHeight: 50, fontSize: 17 }} />
              </label>
              <label style={{ ...styles.label, fontSize: 15 }}>退勤日時
                <input type="datetime-local" value={editForm.clockOut} onChange={(event) => setEditForm({ ...editForm, clockOut: event.target.value })} style={{ ...styles.input, minHeight: 50, fontSize: 17 }} />
              </label>
              <BreakEditorSection
                editor={editForm}
                setEditor={setEditForm}
                breakMinutes={correctionPreview?.breakMinutes ?? 0}
                workMinutes={correctionPreview?.workMinutes ?? null}
                nightMinutes={correctionPreview?.nightMinutes ?? null}
                hasIncompleteBreak={editWorkSet.breaks.some((item) => !item.start || !item.end)}
                formatMinutes={formatMinutesZero}
              />
              <label style={{ ...styles.label, gridColumn: "1 / -1", fontSize: 15 }}>修正理由
                <textarea required value={editForm.reason} onChange={(event) => setEditForm({ ...editForm, reason: event.target.value })} style={{ ...styles.input, height: 88, minHeight: 88, padding: 12, fontSize: 17, resize: "vertical" }} />
              </label>
              {correctionError && <p style={{ ...styles.error, gridColumn: "1 / -1" }}>{correctionError}</p>}
              <div style={{ ...styles.inlineActions, gridColumn: "1 / -1", position: "sticky", bottom: -1, zIndex: 2, padding: "12px 0 0", background: "#ffffff" }}>
                <button type="submit" disabled={isSavingCorrection} style={{ ...styles.button, minHeight: 46, opacity: isSavingCorrection ? 0.5 : 1 }}>
                  {isSavingCorrection ? "保存中..." : "保存"}
                </button>
                <button type="button" disabled={isSavingCorrection} onClick={() => { setEditWorkSet(null); setEditForm(null); }} style={{ ...styles.secondaryButton, minHeight: 46 }}>キャンセル</button>
              </div>
            </div>
          </form>
        </div>
      )}

      {attendanceHistoryDialog && <div style={styles.modalOverlay} onClick={() => setAttendanceHistoryDialog(null)}><div style={{ ...styles.modal, maxWidth: 760, maxHeight: "90vh", overflowY: "auto" }} onClick={(event) => event.stopPropagation()}><h2>{attendanceHistoryDialog.title}の修正履歴</h2>{attendanceAuditError && <p style={styles.error}>{attendanceAuditError}</p>}{attendanceHistoryDialog.rows.length === 0 && !attendanceAuditError ? <p style={styles.empty}>修正履歴はありません</p> : attendanceHistoryDialog.rows.map((row) => <article key={row.id} style={{ borderBottom: "1px solid #E2E8F0", padding: "12px 0" }}><b>{{ attendance_corrected: "修正", attendance_deleted: "削除", attendance_delete_restored: "削除取消", attendance_cancelled: "取消", attendance_created: "手動登録" }[row.action] ?? row.action}　{({ clock_in: "出勤", clock_out: "退勤", break_start: "休憩開始", break_end: "休憩終了" } as Record<string, string>)[row.punchType] ?? row.punchType}</b><p>打刻ID：{row.logId}<br/>修正前：{row.beforeTime ? new Date(row.beforeTime).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) : "記録なし"}<br/>修正後：{row.afterTime ? new Date(row.afterTime).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) : "記録なし"}</p><p>修正者：{row.performedBy}<br/>修正日時：{row.performedAt ? new Date(row.performedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) : "記録なし"}<br/>理由：{row.reason || "理由未記録"}</p></article>)}<button type="button" onClick={() => setAttendanceHistoryDialog(null)} style={styles.secondaryButton}>閉じる</button></div></div>}
      {deletePunchDialog && (() => {
        const dialog = deletePunchDialog;
        const punches = [
          dialog.workSet.clockInLog ? { id: dialog.workSet.clockInLog.id, label: "出勤", log: dialog.workSet.clockInLog } : null,
          dialog.workSet.clockOutLog ? { id: dialog.workSet.clockOutLog.id, label: "退勤", log: dialog.workSet.clockOutLog } : null,
          ...dialog.workSet.breaks.flatMap((item) => [
            item.startLog ? { id: item.startLog.id, label: "休憩開始", log: item.startLog } : null,
            item.endLog ? { id: item.endLog.id, label: "休憩終了", log: item.endLog } : null,
          ]),
        ].filter((item): item is { id: string; label: string; log: CalculationClockLog } => Boolean(item));
        return <div style={styles.modalOverlay} onClick={() => { if (!isSavingCorrection) setDeletePunchDialog(null); }}>
          <div style={{ ...styles.modal, maxWidth: 560 }} onClick={(event) => event.stopPropagation()}>
            <h2>削除する打刻を選択</h2>
            <p style={styles.helpText}>{dialog.workSet.employeeName}・{dialog.workSet.workDate}・{dialog.workSet.storeName || storeNameById(dialog.workSet.storeId)}</p>
            <div style={{ display: "grid", gap: 8, margin: "14px 0" }}>
              {punches.map((punch) => {
                const checked = dialog.selectedIds.includes(punch.id);
                const timestamp = punch.log.timestamp instanceof Date ? punch.log.timestamp : new Date(String(punch.log.timestamp ?? ""));
                return <label key={punch.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: 10, border: "1px solid #E2E8F0", borderRadius: 8 }}>
                  <input type="checkbox" checked={checked} onChange={() => setDeletePunchDialog({ ...dialog, selectedIds: checked ? dialog.selectedIds.filter((id) => id !== punch.id) : [...dialog.selectedIds, punch.id] })} />
                  <span>{punch.label} {Number.isNaN(timestamp.getTime()) ? "" : timestamp.toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" })}</span>
                </label>;
              })}
            </div>
            <label style={styles.label}>削除理由<textarea value={dialog.reason} onChange={(event) => setDeletePunchDialog({ ...dialog, reason: event.target.value })} style={{ ...styles.input, minHeight: 80, resize: "vertical" }} rows={3} placeholder="削除理由を入力してください" /></label>
            {correctionError && <p style={styles.error}>{correctionError}</p>}
            <div style={styles.inlineActions}><button type="button" disabled={isSavingCorrection} onClick={() => setDeletePunchDialog(null)} style={styles.secondaryButton}>キャンセル</button><button type="button" disabled={isSavingCorrection || !dialog.reason.trim() || dialog.selectedIds.length === 0} onClick={() => void confirmDeletePunches()} style={styles.dangerButton}>{isSavingCorrection ? "処理中..." : "選択した打刻を削除"}</button></div>
          </div>
        </div>;
      })()}

      {manualForm && (
        <div style={{ ...styles.modalOverlay, padding: 24 }} onClick={() => { if (!isSavingManual) setManualForm(null); }}>
          <div style={{ ...styles.modal, maxWidth: 860, maxHeight: "90vh", overflowY: "auto" }} onClick={(event) => event.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>{manualConfirming ? "手動登録内容の確認" : "打刻漏れを新規登録"}</h3>
            {manualConfirming && manualValidation?.preview ? <>
              <p style={{ padding: 12, background: "#FFF7ED", border: "1px solid #FDBA74", borderRadius: 8 }}>打刻できなかった勤怠を手動登録します。この操作は履歴に記録されます。内容を確認してください。</p>
              <dl style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 8 }}>
                <dt>店舗名</dt><dd>{storeNameById(manualForm.storeId)}</dd>
                <dt>従業員名</dt><dd>{employees.find((item) => item.id === manualForm.employeeId)?.name}</dd>
                <dt>勤務日</dt><dd>{manualForm.workDate}</dd><dt>出勤</dt><dd>{manualForm.clockIn}</dd><dt>退勤</dt><dd>{manualForm.clockOut}</dd>
                <dt>休憩</dt><dd>{formatMinutesZero(manualValidation.preview.breakMinutes)}</dd><dt>実働時間</dt><dd>{formatMinutesZero(manualValidation.preview.workMinutes)}</dd><dt>深夜時間</dt><dd>{formatMinutesZero(manualValidation.preview.nightMinutes)}</dd>
                <dt>登録理由</dt><dd>{manualForm.creationReason}{manualForm.reasonDetail ? `：${manualForm.reasonDetail}` : ""}</dd>
              </dl>
            </> : <div style={{ ...styles.editForm, gridTemplateColumns: "repeat(2,minmax(0,1fr))" }}>
              <label style={styles.label}>対象店舗<select value={manualForm.storeId} onChange={(e) => setManualForm({ ...manualForm, storeId: e.target.value, employeeId: "" })} style={styles.input}><option value="">選択してください</option>{stores.filter((s) => s.active !== false).map((s) => <option key={s.id} value={s.id}>{getStoreName(s)}</option>)}</select></label>
              <label style={styles.label}>従業員<select value={manualForm.employeeId} onChange={(e) => setManualForm({ ...manualForm, employeeId: e.target.value })} style={styles.input}><option value="">選択してください</option>{employees.filter((e) => e.storeId === manualForm.storeId && isAdminPartTimeEmployee(e) && e.clockEnabled !== false && e.status !== "inactive").map((e) => <option key={e.id} value={e.id}>{e.employeeCode} {e.name}</option>)}</select></label>
              <label style={styles.label}>勤務日<input type="date" value={manualForm.workDate} onChange={(e) => setManualForm({ ...manualForm, workDate: e.target.value })} style={styles.input} /></label>
              <label style={styles.label}>出勤時刻<input type="datetime-local" value={manualForm.clockIn} onChange={(e) => setManualForm({ ...manualForm, clockIn: e.target.value, workDate: e.target.value.slice(0, 10) })} style={styles.input} /></label>
              <label style={styles.label}>退勤時刻<input type="datetime-local" value={manualForm.clockOut} onChange={(e) => setManualForm({ ...manualForm, clockOut: e.target.value })} style={styles.input} /><small>退勤が出勤より前の場合は翌日として確認します。</small></label>
              <label style={styles.label}>登録理由<select value={manualForm.creationReason} onChange={(e) => setManualForm({ ...manualForm, creationReason: e.target.value })} style={styles.input}><option value="">選択してください</option>{["端末不具合","社員コードエラー","打刻忘れ","通信障害","管理者確認済み","その他"].map((r) => <option key={r}>{r}</option>)}</select></label>
              {manualForm.creationReason === "その他" && <label style={styles.label}>理由詳細<input value={manualForm.reasonDetail} onChange={(e) => setManualForm({ ...manualForm, reasonDetail: e.target.value })} style={styles.input} /></label>}
              <label style={{ ...styles.label, gridColumn: "1 / -1" }}>備考（任意）<textarea value={manualForm.note} onChange={(e) => setManualForm({ ...manualForm, note: e.target.value })} style={styles.input} /></label>
              <div style={{ gridColumn: "1 / -1" }}><b>休憩</b>{manualForm.breaks.map((item, index) => <div key={index} style={{ display: "flex", gap: 8, marginTop: 8 }}><input type="datetime-local" value={item.start} onChange={(e) => setManualForm({ ...manualForm, breaks: manualForm.breaks.map((b,i) => i === index ? { ...b, start: e.target.value } : b) })} style={styles.input}/><input type="datetime-local" value={item.end} onChange={(e) => setManualForm({ ...manualForm, breaks: manualForm.breaks.map((b,i) => i === index ? { ...b, end: e.target.value } : b) })} style={styles.input}/><button type="button" onClick={() => setManualForm({ ...manualForm, breaks: manualForm.breaks.filter((_,i) => i !== index) })} style={styles.secondaryButton}>削除</button></div>)}<button type="button" onClick={() => setManualForm({ ...manualForm, breaks: [...manualForm.breaks, { start: "", end: "" }] })} style={{ ...styles.secondaryButton, marginTop: 8 }}>休憩を追加</button></div>
              <label style={{ ...styles.label, gridColumn: "1 / -1" }}><input type="checkbox" checked={manualForm.allowSeparateShift} onChange={(e) => setManualForm({ ...manualForm, allowSeparateShift: e.target.checked })} /> 同日の既存打刻とは別勤務として追加する</label>
            </div>}
            {manualError && <p style={styles.error}>{manualError}</p>}
            {!manualConfirming && manualValidation?.errors.length ? <p style={styles.error}>{manualValidation.errors.join("。")}</p> : null}
            <div style={{ ...styles.inlineActions, marginTop: 18 }}><button type="button" disabled={isSavingManual || (!manualConfirming && !manualValidation?.preview)} onClick={submitManualAttendance} style={{ ...styles.button, opacity: isSavingManual || (!manualConfirming && !manualValidation?.preview) ? .5 : 1 }}>{isSavingManual ? "登録中..." : manualConfirming ? "この内容で登録" : "登録内容を確認"}</button>{manualConfirming && <button type="button" onClick={() => setManualConfirming(false)} style={styles.secondaryButton}>入力へ戻る</button>}<button type="button" onClick={() => setManualForm(null)} style={styles.secondaryButton}>キャンセル</button></div>
          </div>
        </div>
      )}

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
  dangerButton: {
    minHeight: 42,
    border: "1px solid #FCA5A5",
    borderRadius: 12,
    padding: "0 14px",
    background: "#DC2626",
    color: "#ffffff",
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

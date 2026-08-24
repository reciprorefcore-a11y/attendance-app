"use client";

import { useEffect, useMemo, useState } from "react";
import { useAuthProfile } from "@/lib/auth";
import { calculateHolidayUnitPay } from "@/lib/payroll";
import type { FixedPayrollAdjustment, PayrollResult } from "@/lib/payroll";
import { adjustmentDisabledReason, holidayAllowancePreview, reimbursementPending, resolveHolidayAllowanceBasis } from "@/lib/payroll-adjustment-ui";

type PayrollIssue = { severity: "error" | "warning"; code: string; message: string; employeeId?: string };
type PayrollRun = {
  id?: string; status: "draft" | "confirmed" | "cancelled"; targetMonth: string; paymentMonth: string; paymentDate: string;
  calculatedAt?: string | { _seconds?: number }; employeeCount: number; grossTotal: number; deductionTotal: number;
  netTotal: number; bankTransferTotal: number; canConfirm?: boolean; issues: PayrollIssue[]; results: PayrollResult[];
};
type ConfirmedRunSummary = { id: string; targetMonth: string; paymentMonth: string; paymentDate: string; employeeCount: number };
type SlipRun = { id: string; targetMonth: string; paymentDate: string; status: string; results: PayrollResult[] };
type GeneratedFile = { name: string; blob: Blob };
type FixedMaster = { employeeId: string; employeeCode: string; employeeName: string; storeName: string; fixedBaseSalary: number; holidayAllowanceBaseSalary: number | null; holidayAllowanceCalculationBasis: number | null; directorCompensation: number; positionAllowance: number; businessAllowance: number; fixedOvertimeAllowance: number; healthInsurance: number | null; childSupportContribution: number | null; careInsurance: number | null; employeePension: number | null; employmentInsurance: number | null; incomeTax: number | null; residentTax: number | null; transportationType: "daily" | "monthly" | "none" };
type AppliedDiffSnapshot = { grossTotal: number; deductionsTotal: number; payrollNetPay: number; expenseReimbursement: number; netPay: number };

function tokyoYM() {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return { y: jst.getUTCFullYear(), m: jst.getUTCMonth() + 1 };
}
const thisMonth = () => { const { y, m } = tokyoYM(); return `${y}-${String(m).padStart(2, "0")}`; };
const lastMonth = () => { const { y, m } = tokyoYM(); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`; };
const nextMonthOf = (ym: string) => { const [y, m] = ym.split("-").map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`; };
const payDateOf = (ym: string) => `${nextMonthOf(ym)}-25`;
const yen = (v: number) => `${Math.trunc(v || 0).toLocaleString()}円`;
const fmtMonth = (ym: string) => { const [y, m] = ym.split("-"); return `${y}年${Number(m)}月`; };
const fmtDate = (d: string) => { const [y, m, day] = d.split("-"); return `${y}年${Number(m)}月${Number(day)}日`; };
const fixedEmployeeCandidates = [
  ["0002", "青山佳史"], ["0003", "中村鏡太郎"], ["0017", "木月徳子"], ["0064", "小林彗太"], ["0083", "佐藤雅信"],
] as const;

async function apiCall(url: string, token: string, init?: RequestInit) {
  const res = await fetch(url, { ...init, headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` } });
  const text = await res.text();
  let data: { error?: string } = {};
  try { data = JSON.parse(text) as { error?: string }; } catch { /* non-JSON */ }
  if (!res.ok) throw new Error(data.error ?? `処理に失敗しました (HTTP ${res.status}) ${text.slice(0, 200)}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return data as any;
}

async function generateFile(url: string, token: string, init?: RequestInit): Promise<GeneratedFile> {
  const res = await fetch(url, { ...init, headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` } });
  if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? "ダウンロードに失敗しました"); }
  const blob = await res.blob();
  if (blob.size === 0) throw new Error("サーバーが空のファイルを返しました");
  const disposition = res.headers.get("content-disposition") ?? "";
  const match = disposition.match(/filename\*=UTF-8''([^;]+)/);
  const name = match ? decodeURIComponent(match[1]) : "payroll-download.xlsx";
  return { name, blob };
}

async function downloadFile(url: string, token: string, init?: RequestInit) {
  const file = await generateFile(url, token, init);
  const obj = URL.createObjectURL(file.blob);
  const a = document.createElement("a");
  a.href = obj; a.download = file.name; a.rel = "noopener"; a.style.display = "none";
  document.body.appendChild(a); a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(obj); }, 60000);
  return file.name;
}

export default function PayrollPage() {
  const { user, isLoading: authLoading } = useAuthProfile();
  const [monthMode, setMonthMode] = useState<"prev" | "current">("prev");
  const targetMonth = useMemo(() => (monthMode === "prev" ? lastMonth() : thisMonth()), [monthMode]);
  const paymentMonth = useMemo(() => nextMonthOf(targetMonth), [targetMonth]);
  const paymentDate = useMemo(() => payDateOf(targetMonth), [targetMonth]);

  const [run, setRun] = useState<PayrollRun | null>(null);
  const [confirmedRuns, setConfirmedRuns] = useState<ConfirmedRunSummary[]>([]);
  const [slipMonthKey, setSlipMonthKey] = useState("");
  const [slipRun, setSlipRun] = useState<SlipRun | null>(null);
  const [slipStore, setSlipStore] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [payrollFile, setPayrollFile] = useState<GeneratedFile | null>(null);
  const [transferFile, setTransferFile] = useState<GeneratedFile | null>(null);
  const [adjustments, setAdjustments] = useState<Record<string, FixedPayrollAdjustment>>({});
  const [fixedMasters, setFixedMasters] = useState<FixedMaster[]>([]);
  const [masterEmployeeId, setMasterEmployeeId] = useState("");
  const [adjustEmployeeId, setAdjustEmployeeId] = useState("");
  const [manualHolidayOverrides, setManualHolidayOverrides] = useState<Record<string, boolean>>({});
  const [savedManualHolidayOverrides, setSavedManualHolidayOverrides] = useState<Record<string, boolean>>({});
  const [masterForms, setMasterForms] = useState<Record<string, FixedMaster>>({});
  const [masterOpen, setMasterOpen] = useState(false);
  // 正社員給与変更確認フロー: null=未選択 / no-change=変更なし / with-change=変更あり / adjusted=調整済み
  const [adjustDecision, setAdjustDecision] = useState<null | "no-change" | "with-change" | "adjusted">(null);
  // 直前の試算に反映済みの調整スナップショット（dirty検知用）
  const [savedAdjustments, setSavedAdjustments] = useState<Record<string, FixedPayrollAdjustment>>({});
  const [unconfirmReason, setUnconfirmReason] = useState("");
  const [showUnconfirmDialog, setShowUnconfirmDialog] = useState(false);
  const [appliedDiffs, setAppliedDiffs] = useState<{ employeeId: string; employeeName: string; before: AppliedDiffSnapshot; after: AppliedDiffSnapshot }[]>([]);
  const payrollFileUrl = useMemo(() => payrollFile ? URL.createObjectURL(payrollFile.blob) : "", [payrollFile]);
  const transferFileUrl = useMemo(() => transferFile ? URL.createObjectURL(transferFile.blob) : "", [transferFile]);

  useEffect(() => () => { if (payrollFileUrl) URL.revokeObjectURL(payrollFileUrl); }, [payrollFileUrl]);
  useEffect(() => () => { if (transferFileUrl) URL.revokeObjectURL(transferFileUrl); }, [transferFileUrl]);

  useEffect(() => {
    if (authLoading || !user) return;
    let active = true;
    (async () => {
      setRun(null); setPayrollFile(null); setTransferFile(null); setAdjustments({}); setSavedAdjustments({}); setAppliedDiffs([]); setManualHolidayOverrides({}); setSavedManualHolidayOverrides({}); setMessage(""); setAdjustDecision(null); setMasterOpen(false);
      try {
        const token = await user.getIdToken(true);
        const [workspace, runsData] = await Promise.all([
          apiCall(`/api/payroll/calculate?targetMonth=${targetMonth}`, token),
          apiCall("/api/payroll/runs", token),
        ]);
        if (!active) return;
        setRun(workspace.run);
        const existingAdj = Object.fromEntries((workspace.run?.results ?? []).filter((item: PayrollResult) => item.payrollType === "fixed" && item.fixedAdjustment).map((item: PayrollResult) => [item.employeeId, item.fixedAdjustment]));
        setAdjustments(existingAdj);
        const existingManualOverrides = Object.fromEntries(Object.entries(existingAdj).map(([employeeId, value]) => [employeeId, (value as FixedPayrollAdjustment).holidayAllowanceOverride != null]));
        setManualHolidayOverrides(existingManualOverrides); setSavedManualHolidayOverrides(existingManualOverrides);
        if (workspace.run?.status === "draft" && Object.keys(existingAdj).length > 0) { setAdjustDecision("adjusted"); setSavedAdjustments(existingAdj); }
        const masters: FixedMaster[] = workspace.fixedEmployees ?? [];
        setFixedMasters(masters); setMasterForms(Object.fromEntries(masters.map((item) => [item.employeeId, item])));
        setMasterEmployeeId((current) => current || masters[0]?.employeeId || "");
        setAdjustEmployeeId((current) => current || masters[0]?.employeeId || "");
        const confirmed: ConfirmedRunSummary[] = runsData.runs ?? [];
        setConfirmedRuns(confirmed);
        const others = confirmed.filter((r) => r.targetMonth !== targetMonth);
        if (others.length > 0) setSlipMonthKey(`${others[0].id}__${others[0].targetMonth}`);
      } catch (e) {
        if (active) setMessage(e instanceof Error ? e.message : "読み込みに失敗しました");
      }
    })();
    return () => { active = false; };
  }, [targetMonth, user, authLoading]);

  useEffect(() => {
    if (!slipMonthKey || !user) return;
    const runId = slipMonthKey.split("__")[0];
    let active = true;
    (async () => {
      try {
        const token = await user.getIdToken(true);
        const data = await apiCall(`/api/payroll/runs?runId=${runId}`, token);
        if (active) { setSlipRun(data as SlipRun); setSlipStore(""); }
      } catch (e) {
        if (active) setMessage(e instanceof Error ? e.message : "明細データの読み込みに失敗しました");
      }
    })();
    return () => { active = false; };
  }, [slipMonthKey, user]);

  const calculate = async () => {
    if (!user) { setMessage("ログインが必要です"); return; }
    setBusy(true); setMessage("");
    try {
      const token = await user.getIdToken(true);
      const data = await apiCall("/api/payroll/calculate", token, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetMonth, paymentMonth, paymentDate }),
      });
      setRun(data); setPayrollFile(null); setTransferFile(null); setAdjustments({}); setSavedAdjustments({}); setAppliedDiffs([]); setManualHolidayOverrides({}); setSavedManualHolidayOverrides({}); setAdjustDecision(null);
      setMessage("給与の試算が完了しました。正社員給与の変更を確認してください。");
    } catch (e) { setMessage(e instanceof Error ? e.message : "給与計算に失敗しました"); }
    finally { setBusy(false); }
  };

  const generatePayrollExcel = async () => {
    if (!run || !user) return; setBusy(true); setMessage("");
    try {
      const token = await user.getIdToken(true);
      const file = await generateFile("/api/payroll/export/unified", token, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(run) });
      setPayrollFile(file); setTransferFile(null); setMessage("給与・振込統合Excelを生成しました。下のボタンからダウンロードできます。");
    } catch (e) { setMessage(e instanceof Error ? e.message : "給与Excelの生成に失敗しました"); }
    finally { setBusy(false); }
  };

  const updateAdjustment = (employeeId: string, patch: Partial<FixedPayrollAdjustment>) =>
    setAdjustments((current) => ({ ...current, [employeeId]: { ...current[employeeId], ...patch } }));

  const saveFixedMaster = async () => {
    const values = masterForms[masterEmployeeId]; if (!values || !user) return;
    setBusy(true); setMessage("");
    try {
      const token = await user.getIdToken(true);
      await apiCall("/api/payroll/settings", token, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ employeeId: masterEmployeeId, values }) });
      setPayrollFile(null); setTransferFile(null);
      if (isConfirmed) {
        setMessage("固定給与マスターを保存しました。次回試算から反映されます。確定済みの帳票は変わりません。");
      } else {
        setRun(null); setSavedAdjustments({}); setManualHolidayOverrides({}); setSavedManualHolidayOverrides({}); setAppliedDiffs([]); setAdjustDecision(null);
        setMessage("固定給与マスターを保存しました。給与を再試算してください。");
      }
    } catch (e) { setMessage(e instanceof Error ? e.message : "固定給与マスターの保存に失敗しました"); }
    finally { setBusy(false); }
  };

  const applyAdjustments = async () => {
    if (!run || !user) return;
    for (const result of run.results.filter((item) => item.payrollType === "fixed")) {
      const adjustment = adjustments[result.employeeId] ?? {};
      const master = fixedMasters.find((item) => item.employeeId === result.employeeId);
      const validationReason = adjustmentDisabledReason({ selected: true, adjustment, holidayBasis: resolveHolidayAllowanceBasis(master ?? {}), manualHolidayOverride: manualHolidayOverrides[result.employeeId] === true, busy: false });
      if (validationReason) { setMessage(`${result.employeeCode} ${result.employeeName}：${validationReason}`); return; }
      const automatic = Math.round((Number(adjustment.overtimeMinutes) || 0) * (result.earnings.baseSalary / 160) * 1.25 / 60);
      if (adjustment.overtimeAllowanceOverride != null && adjustment.overtimeAllowanceOverride !== automatic && !adjustment.overtimeReason?.trim()) {
        setMessage(`${result.employeeCode} ${result.employeeName}：残業手当を修正する理由を入力してください。`); return;
      }
      const automaticHoliday = calculateHolidayUnitPay(result.holidayAllowanceBaseSalarySnapshot ?? result.earnings.baseSalary) * (Number(adjustment.temporaryAttendanceCount) || 0);
      if (adjustment.holidayAllowanceOverride != null && adjustment.holidayAllowanceOverride !== automaticHoliday && !adjustment.overrideReason?.trim()) {
        setMessage(`${result.employeeCode} ${result.employeeName}：休日手当を修正する理由を入力してください。`); return;
      }
    }
    const beforeResults = run.results;
    setBusy(true); setMessage("");
    try {
      const token = await user.getIdToken(true);
      const data = await apiCall("/api/payroll/calculate", token, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ targetMonth, paymentMonth, paymentDate, adjustments }) });
      const diffs = (data as PayrollRun).results
        .filter((r) => r.payrollType === "fixed" && adjustments[r.employeeId])
        .map((after) => {
          const before = beforeResults.find((r) => r.employeeId === after.employeeId);
          return {
            employeeId: after.employeeId,
            employeeName: after.employeeName,
            before: { grossTotal: before?.earnings.grossTotal ?? 0, deductionsTotal: before?.deductions.total ?? 0, payrollNetPay: before?.payrollNetPay ?? 0, expenseReimbursement: before?.reimbursements.expenseReimbursement ?? 0, netPay: before?.netPay ?? 0 },
            after: { grossTotal: after.earnings.grossTotal, deductionsTotal: after.deductions.total, payrollNetPay: after.payrollNetPay, expenseReimbursement: after.reimbursements.expenseReimbursement, netPay: after.netPay },
          };
        });
      setRun(data); setPayrollFile(null); setTransferFile(null); setSavedAdjustments({ ...adjustments }); setSavedManualHolidayOverrides({ ...manualHolidayOverrides }); setAdjustDecision("adjusted"); setAppliedDiffs(diffs);
      setMessage("当月調整を反映して全員分を再試算しました。生成済みExcelは無効になりました。");
    } catch (e) { setMessage(e instanceof Error ? e.message : "月次調整の反映に失敗しました"); }
    finally { setBusy(false); }
  };

  const confirm = async () => {
    if (!run || !user) return; setBusy(true); setMessage("");
    try {
      const token = await user.getIdToken(true);
      const confirmed = await apiCall("/api/payroll/confirm", token, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ run }) });
      setRun(confirmed);
      const runsData = await apiCall("/api/payroll/runs", token);
      setConfirmedRuns(runsData.runs ?? []);
      setMessage("給与を確定しました。店舗別または正社員の給与明細ZIPを出力できます。");
    } catch (e) { setMessage(e instanceof Error ? e.message : "確定に失敗しました"); }
    finally { setBusy(false); }
  };

  const unconfirm = async () => {
    if (!run?.id || !user) return;
    if (!unconfirmReason.trim()) { setMessage("確定取消の理由を入力してください"); return; }
    setBusy(true); setMessage("");
    try {
      const token = await user.getIdToken(true);
      await apiCall("/api/payroll/confirm", token, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId: run.id, reason: unconfirmReason }) });
      setUnconfirmReason(""); setPayrollFile(null); setTransferFile(null); setSavedAdjustments({}); setManualHolidayOverrides({}); setSavedManualHolidayOverrides({}); setAppliedDiffs([]); setAdjustDecision(null);
      const [workspace, runsData] = await Promise.all([
        apiCall(`/api/payroll/calculate?targetMonth=${targetMonth}`, token),
        apiCall("/api/payroll/runs", token),
      ]);
      setRun(workspace.run); setConfirmedRuns(runsData.runs ?? []);
      setMessage("確定を取消しました。必要に応じて再計算してください。");
    } catch (e) { setMessage(e instanceof Error ? e.message : "確定取消に失敗しました"); }
    finally { setBusy(false); }
  };

  const downloadPayslipZip = async (kind: "store-payslips" | "fulltime-payslips", runId: string, storeId = "") => {
    if (!user) return; setBusy(true); setMessage("");
    try {
      const token = await user.getIdToken(true);
      await downloadFile(`/api/payroll/export/${kind}?runId=${runId}${storeId ? `&storeId=${encodeURIComponent(storeId)}` : ""}`, token);
    } catch (e) { setMessage(e instanceof Error ? e.message : "給与明細ZIPのダウンロードに失敗しました"); }
    finally { setBusy(false); }
  };

  const errors = [...new Map((run?.issues.filter((x) => x.severity === "error") ?? []).map((item) => [`${item.code}:${item.message}`, item])).values()];
  const warnings = [...new Map((run?.issues.filter((x) => x.severity === "warning") ?? []).map((item) => [`${item.code}:${item.message}`, item])).values()];
  const warningGroups = [...new Map(warnings.map((warning) => [warning.code, warnings.filter((item) => item.code === warning.code)])).entries()];
  const fixedWarningEmployeeIds = [...new Set(warnings.filter((warning) => warning.employeeId && fixedMasters.some((employee) => employee.employeeId === warning.employeeId)).map((warning) => warning.employeeId!))];
  const isDraft = run?.status === "draft";
  const isConfirmed = run?.status === "confirmed";
  const statusLabel = !run ? "未計算" : run.status === "draft" ? "試算" : run.status === "confirmed" ? "確定済み" : "確定取消済み";
  // 反映済みスナップショットと現在値が違う場合は「未反映」状態
  const isAdjustmentDirty = adjustDecision === "adjusted" && (JSON.stringify(adjustments) !== JSON.stringify(savedAdjustments) || JSON.stringify(manualHolidayOverrides) !== JSON.stringify(savedManualHolidayOverrides));
  const selectedAdjustmentResult = run?.results.find((item) => item.employeeId === adjustEmployeeId && item.payrollType === "fixed") ?? null;
  const selectedAdjustmentMaster = fixedMasters.find((item) => item.employeeId === adjustEmployeeId) ?? null;
  const selectedAdjustment = selectedAdjustmentResult ? (adjustments[selectedAdjustmentResult.employeeId] ?? selectedAdjustmentResult.fixedAdjustment ?? {}) : {};
  const selectedHolidayPreview = holidayAllowancePreview({ holidayAllowanceBaseSalary: selectedAdjustmentMaster?.holidayAllowanceCalculationBasis, fixedBaseSalary: selectedAdjustmentMaster?.fixedBaseSalary }, Number(selectedAdjustment.temporaryAttendanceCount ?? 0));
  const selectedManualHolidayOverride = !!selectedAdjustmentResult && manualHolidayOverrides[selectedAdjustmentResult.employeeId] === true;
  const selectedAdjustmentDisabledReason = adjustmentDisabledReason({ selected: !!selectedAdjustmentResult, adjustment: selectedAdjustment, holidayBasis: selectedHolidayPreview.basis, manualHolidayOverride: selectedManualHolidayOverride, busy });
  // Excel/確定セクションは「変更なし」or「調整済み（かつ未反映でない）」を選択後、または確定済み時に表示
  const canShowExcel = !isAdjustmentDirty && (isConfirmed || (isDraft && errors.length === 0 && (adjustDecision === "no-change" || adjustDecision === "adjusted")));

  const slipStores = useMemo(() => [...new Map((slipRun?.results ?? []).filter((result) => result.employeeType === "partTime").map((result) => [result.storeId, result.storeName])).entries()].sort((a, b) => a[1].localeCompare(b[1], "ja")), [slipRun]);

  return (
    <main style={s.page}>
      <div style={s.shell}>
        <header style={s.headerRow}>
          <div><h1 style={s.title}>給与管理</h1><p style={s.eyebrow}>本部管理者専用</p></div>
          <button type="button" onClick={() => setMasterOpen(true)} style={s.settingsButton}>固定給与マスター設定</button>
        </header>

        {/* ① 今月の給与を試算 */}
        <section style={s.card}>
          <h2 style={s.h2}>① 今月の給与を試算</h2>
          <div style={s.infoRow}>
            <label style={s.inlineLbl}>対象勤怠月：<select value={monthMode} disabled={busy} onChange={(e) => setMonthMode(e.target.value as "prev" | "current")} style={s.selSm}><option value="prev">{fmtMonth(lastMonth())}（前月・通常運用）</option><option value="current">{fmtMonth(thisMonth())}（当月・試算のみ）</option></select></label>
            <span>支給日：<b>{fmtDate(paymentDate)}</b></span>
            <span style={{ ...s.badge, ...(isConfirmed ? s.badgeGreen : s.badgeYellow) }}>{statusLabel}</span>
          </div>

          {message && <p style={s.msg}>{message}</p>}

          {!isConfirmed && (
            <div style={s.actions}>
              <button disabled={busy} onClick={calculate} style={s.primary}>{busy ? "試算中…" : "給与を試算"}</button>
            </div>
          )}

          {run && (
            <>
              <div style={s.summaryGrid}>
                <div style={s.summaryItem}><span style={s.summaryLabel}>給与対象人数</span><b style={s.summaryValue}>{run.employeeCount}人</b></div>
                <div style={s.summaryItem}><span style={s.summaryLabel}>支給合計</span><b style={s.summaryValue}>{yen(run.grossTotal)}</b></div>
                <div style={s.summaryItem}><span style={s.summaryLabel}>控除合計</span><b style={s.summaryValue}>{yen(run.deductionTotal)}</b></div>
                <div style={s.summaryItem}><span style={s.summaryLabel}>差引支給額</span><b style={s.summaryValue}>{yen(run.netTotal)}</b></div>
              </div>
              <div style={s.issueSummary}><b>エラー件数：{errors.length}件</b></div>
              {errors.length > 0 && <div style={s.issueBox}>{errors.map((e, i) => <p key={i} style={s.errText}>エラー：{e.message}</p>)}</div>}
              {fixedWarningEmployeeIds.length > 0 && <button type="button" onClick={() => setMasterOpen(true)} style={s.warningButton}>正社員{fixedWarningEmployeeIds.length}名に未設定項目があります</button>}
              {warningGroups.filter(([code]) => code !== "missing_social_insurance_setting" && code !== "missing_transportation_setting").map(([code, items]) => <p key={code} style={s.warningText}>警告：{items[0].message}{items.length > 1 ? `（同種${items.length}件）` : ""}</p>)}
            </>
          )}
          {monthMode === "current" && <p style={s.hint}>※ 当月はまだ締まっていないため、試算Excelの確認のみ可能です。確定はできません。</p>}
          {monthMode === "prev" && isDraft && !run?.canConfirm && errors.length === 0 && <p style={s.hint}>※ 月が終了していないため確定できません。翌月以降に「給与を確定」してください。</p>}
        </section>

        {/* ② 正社員給与の変更確認 */}
        {run && isDraft && errors.length === 0 && (
          <section style={s.card}>
            <h2 style={s.h2}>② 正社員給与の変更確認</h2>

            {adjustDecision === null && (
              <>
                <p style={s.sub}>正社員給与に今月の変更はありますか？</p>
                <div style={s.actions}>
                  <button onClick={() => setAdjustDecision("no-change")} style={s.secondary}>変更なし</button>
                  <button onClick={() => setAdjustDecision("with-change")} style={s.secondary}>変更あり</button>
                </div>
              </>
            )}

            {adjustDecision === "no-change" && (
              <div style={s.actions}>
                <span style={{ ...s.badge, ...s.badgeGreen }}>変更なしで進みます</span>
                <button type="button" onClick={() => setAdjustDecision("with-change")} style={s.small}>やはり変更する</button>
              </div>
            )}

            {(adjustDecision === "with-change" || adjustDecision === "adjusted") && (
              <>
                {adjustDecision === "adjusted" && (isAdjustmentDirty
                  ? <p style={s.pendingMsg}>変更内容はまだ再試算されていません</p>
                  : <p style={s.msg}>当月調整を反映しました。内容を確認し、Excelを生成してください。</p>
                )}
                <div style={s.employeeButtons} aria-label="正社員を選択">
                  {fixedEmployeeCandidates.map(([code, name]) => {
                    const emp = fixedMasters.find((item) => item.employeeCode === code);
                    const selected = emp?.employeeId === adjustEmployeeId;
                    return (
                      <button key={code} type="button" disabled={!emp} onClick={() => emp && setAdjustEmployeeId(emp.employeeId)} style={{ ...s.employeeButton, ...(selected ? s.employeeButtonActive : {}) }}>
                        <span style={s.employeeCode}>{code}</span>{name}
                      </button>
                    );
                  })}
                </div>
                {(() => {
                  const result = selectedAdjustmentResult;
                  if (!result) return <p style={s.hint}>正社員を選択してください。</p>;
                  const value = selectedAdjustment;
                  const automatic = Math.floor((Number(value.overtimeMinutes) || 0) * (result.earnings.baseSalary / 160) * 1.25 / 60);
                  const appliedDiff = appliedDiffs.find((d) => d.employeeId === result.employeeId);
                  const expenseInput = Number(value.expenseReimbursement ?? 0);
                  const expenseIsPending = reimbursementPending(expenseInput, result.reimbursements.expenseReimbursement);
                  const selectedHasUnappliedInput = adjustDecision === "adjusted" ? isAdjustmentDirty : Object.keys(value).length > 0;
                  return (
                    <>
                      {adjustDecision === "with-change" && selectedHasUnappliedInput && <p style={s.pendingMsg}>変更内容はまだ再試算されていません</p>}
                      {appliedDiff && !isAdjustmentDirty && (
                        <div style={s.appliedBox}>
                          <p style={s.appliedMsg}>{appliedDiff.employeeName}さんの当月調整を反映しました</p>
                          <div style={s.diffRows}>
                            <span>給与差引額：<b>{yen(appliedDiff.before.payrollNetPay)} → {yen(appliedDiff.after.payrollNetPay)}</b></span>
                            <span>立替経費精算：<b>{yen(appliedDiff.before.expenseReimbursement)} → {yen(appliedDiff.after.expenseReimbursement)}</b></span>
                            <span>最終支給額：<b>{yen(appliedDiff.before.netPay)} → {yen(appliedDiff.after.netPay)}</b></span>
                            <span>増減：<b>{appliedDiff.after.netPay - appliedDiff.before.netPay >= 0 ? "+" : ""}{yen(appliedDiff.after.netPay - appliedDiff.before.netPay)}</b></span>
                          </div>
                        </div>
                      )}
                      <section style={s.holidaySection}>
                        <h3 style={s.h3}>休日出勤</h3>
                        <p style={s.basisText}>算定基礎となる月給：{selectedHolidayPreview.basis == null ? <b style={s.unset}>未設定</b> : <b>{yen(selectedHolidayPreview.basis)}</b>}</p>
                        <div style={s.holidayGrid}>
                          <label style={s.lbl}>休日出勤回数<input type="number" min="0" step="1" inputMode="numeric" value={value.temporaryAttendanceCount ?? 0} onChange={(e) => updateAdjustment(result.employeeId, { temporaryAttendanceCount: Number(e.target.value) })} style={s.input} /></label>
                          <div style={s.moneyCard}><span>休日出勤1回単価</span><b>{selectedHolidayPreview.unitPay == null ? "未設定" : yen(selectedHolidayPreview.unitPay)}</b></div>
                          <div style={s.moneyCard}><span>休日出勤手当</span><b>{selectedHolidayPreview.automaticAllowance == null ? "計算できません" : yen(selectedHolidayPreview.automaticAllowance)}</b></div>
                        </div>
                        {selectedHolidayPreview.basis == null && Number(value.temporaryAttendanceCount ?? 0) > 0 && <p style={s.inlineError}>固定給与マスターで休日手当算定基礎を設定してください</p>}
                        <label style={s.checkLabel}><input type="checkbox" checked={selectedManualHolidayOverride} onChange={(e) => {
                          const checked = e.target.checked;
                          setManualHolidayOverrides((current) => ({ ...current, [result.employeeId]: checked }));
                          if (!checked) updateAdjustment(result.employeeId, { holidayAllowanceOverride: null, overrideReason: "" });
                        }} />自動計算額を修正する</label>
                        {selectedManualHolidayOverride && (
                          <div style={s.manualOverrideBox}>
                            <label style={s.lbl}>休日出勤手当の修正後金額<input type="number" min="0" step="1" value={value.holidayAllowanceOverride ?? ""} onChange={(e) => updateAdjustment(result.employeeId, { holidayAllowanceOverride: e.target.value === "" ? null : Number(e.target.value) })} style={s.input} /></label>
                            <label style={s.lbl}>修正理由<input value={value.overrideReason ?? ""} onChange={(e) => updateAdjustment(result.employeeId, { overrideReason: e.target.value })} style={s.input} /></label>
                          </div>
                        )}
                      </section>
                      <div style={s.adjustGrid}>
                        <label style={s.lbl}>残業時間（時間）<input type="number" min="0" step="0.25" value={value.overtimeMinutes == null ? "" : value.overtimeMinutes / 60} onChange={(e) => updateAdjustment(result.employeeId, { overtimeMinutes: Number(e.target.value) * 60 })} style={s.input} /></label>
                        <label style={s.lbl}>自動計算した残業手当<input readOnly value={automatic} style={s.input} /></label>
                        <label style={s.lbl}>残業手当修正額<input type="number" min="0" value={value.overtimeAllowanceOverride ?? ""} onChange={(e) => updateAdjustment(result.employeeId, { overtimeAllowanceOverride: e.target.value === "" ? null : Number(e.target.value) })} style={s.input} /></label>
                        <label style={s.lbl}>修正理由<input value={value.overtimeReason ?? ""} onChange={(e) => updateAdjustment(result.employeeId, { overtimeReason: e.target.value })} style={s.input} /></label>
                        {([["transportation", "交通費"], ["otherTemporaryPayment", "その他課税支給"], ["otherDeduction", "その他控除"]] as const).map(([key, label]) => (
                          <label key={key} style={s.lbl}>{label}<input type="number" min="0" value={value[key] ?? ""} onChange={(e) => updateAdjustment(result.employeeId, { [key]: Number(e.target.value) })} style={s.input} /></label>
                        ))}
                        <label style={s.lbl}>立替経費精算（本人へ支給）<input type="number" min="0" step="1" value={value.expenseReimbursement ?? 0} onChange={(e) => updateAdjustment(result.employeeId, { expenseReimbursement: e.target.value === "" ? 0 : Number(e.target.value) })} style={s.input} /><span style={s.fieldHelp}>本人が立て替えた経費を給与と一緒に返金します。課税・社会保険・控除には含みません。</span>{expenseIsPending && <span style={s.pendingInput}>今回入力：{yen(expenseInput)}（再試算前）</span>}</label>
                        <label style={s.lbl}>備考<input value={value.note ?? ""} onChange={(e) => updateAdjustment(result.employeeId, { note: e.target.value })} style={s.input} /></label>
                      </div>
                      {!selectedHasUnappliedInput && <div style={s.adjustResult}>
                        <span>残業手当 <b>{yen(result.earnings.overtimePremium)}</b></span>
                        <span>給与支給合計 <b>{yen(result.earnings.grossTotal)}</b></span>
                        <span>控除合計 <b>{yen(result.deductions.total)}</b></span>
                        <span>給与差引額 <b>{yen(result.payrollNetPay)}</b></span>
                        <span>立替経費精算 <b>{yen(result.reimbursements.expenseReimbursement)}</b></span>
                        <span>最終支給額 <b>{yen(result.netPay)}</b></span>
                      </div>}
                    </>
                  );
                })()}
                {selectedAdjustmentDisabledReason && <p style={s.inlineError}>{selectedAdjustmentDisabledReason}</p>}
                <div style={s.actions}>
                  <button disabled={selectedAdjustmentDisabledReason != null} onClick={applyAdjustments} style={s.secondary}>当月調整を反映して再試算</button>
                  <button type="button" onClick={() => { setAdjustments({}); setSavedAdjustments({}); setManualHolidayOverrides({}); setSavedManualHolidayOverrides({}); setAppliedDiffs([]); setAdjustDecision("no-change"); }} style={s.small}>変更なしに戻る</button>
                </div>
              </>
            )}
          </section>
        )}

        {/* ③ 給与Excel・振込一覧Excel */}
        {canShowExcel && (
          <section style={s.card}>
            <h2 style={s.h2}>③ 給与・振込統合Excel</h2>
            {isDraft ? (
              <div style={s.actions}>
                <button disabled={busy} onClick={generatePayrollExcel} style={s.primary}>統合Excelを1ファイル生成</button>
              </div>
            ) : (
              <div style={s.actions}>
                <button disabled={busy} onClick={generatePayrollExcel} style={s.primary}>確定済み統合Excelをダウンロード</button>
              </div>
            )}
            {payrollFile && <div style={s.fileBox}><span>ファイル名：{payrollFile.name}</span><a href={payrollFileUrl} download={payrollFile.name} style={s.downloadButton}>統合Excelをダウンロード</a></div>}
          </section>
        )}

        {/* ④ 給与を確定 */}
        {canShowExcel && (
          <section style={s.card}>
            <h2 style={s.h2}>④ 給与を確定</h2>
            {isDraft && (
              <div style={s.actions}>
                <button disabled={busy || !run?.canConfirm} onClick={confirm} style={s.confirm}>給与を確定</button>
                {!run?.canConfirm && <p style={s.hint}>※ 月が終了していないため確定できません。翌月以降に確定してください。</p>}
              </div>
            )}
            {isConfirmed && (
              <div style={s.unconfirmArea}>
                <label style={s.lbl}>確定取消の理由<input value={unconfirmReason} onChange={(e) => setUnconfirmReason(e.target.value)} placeholder="必須" style={s.input} /></label>
                <button disabled={busy || !unconfirmReason.trim()} onClick={() => setShowUnconfirmDialog(true)} style={s.danger}>給与の確定を取り消す</button>
              </div>
            )}
          </section>
        )}

        {/* ⑤ 給与明細ダウンロード */}
        <section style={s.card}>
          <h2 style={s.h2}>⑤ 給与明細ダウンロード</h2>
          <p style={s.sub}>確定済みrunから、従業員1名につき1つの従来型PDFをZIPにまとめます。</p>
          {confirmedRuns.length === 0 ? (
            <p style={s.muted}>確定済みの給与データがありません。</p>
          ) : (
            <>
              <div style={s.selRow}>
                <label style={s.lbl}>
                  確定月を選ぶ
                  <select value={slipMonthKey} onChange={(e) => { const k = e.target.value; setSlipMonthKey(k); if (!k) setSlipRun(null); }} style={s.sel}>
                    <option value="">選択してください</option>
                    {confirmedRuns.map((r) => (
                      <option key={r.id} value={`${r.id}__${r.targetMonth}`}>{fmtMonth(r.targetMonth)} 勤怠 → {fmtDate(r.paymentDate)} 支給</option>
                    ))}
                  </select>
                </label>
                {slipRun && (
                  <label style={s.lbl}>
                    アルバイトの店舗を選ぶ
                    <select value={slipStore} onChange={(e) => setSlipStore(e.target.value)} style={s.sel}>
                      <option value="">選択してください</option>
                      {slipStores.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                    </select>
                  </label>
                )}
              </div>
              {slipRun && (
                <div style={s.payslipActions}>
                  <div style={s.payslipBox}><b>アルバイト給与明細</b><span style={s.muted}>選択店舗に所属するアルバイトのみ</span><button disabled={busy || !slipStore} onClick={() => downloadPayslipZip("store-payslips", slipRun.id, slipStore)} style={s.secondary}>この店舗の給与明細を一括ダウンロード</button></div>
                  <div style={s.payslipBox}><b>正社員給与明細</b><span style={s.muted}>店舗所属に関係なく正社員のみ</span><button disabled={busy} onClick={() => downloadPayslipZip("fulltime-payslips", slipRun.id)} style={s.secondary}>正社員給与明細を一括ダウンロード</button></div>
                </div>
              )}
            </>
          )}
        </section>

        {/* 固定給与マスター設定モーダル */}
        {masterOpen && (
          <div style={s.overlay} role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setMasterOpen(false); }}>
            <section style={s.modal} role="dialog" aria-modal="true" aria-label="固定給与マスター設定">
              <div style={s.modalHeader}>
                <h2 style={s.h2}>固定給与マスター設定</h2>
                <button type="button" onClick={() => setMasterOpen(false)} style={s.closeButton}>閉じる</button>
              </div>
              <p style={s.sub}>基本給・手当・社会保険・税設定を保存します。毎月変更しない固定項目です。</p>
              <label style={s.lbl}>
                正社員を選択
                <select value={masterEmployeeId} onChange={(e) => setMasterEmployeeId(e.target.value)} style={s.sel}>
                  <option value="">選択してください</option>
                  {fixedEmployeeCandidates.map(([code, name]) => {
                    const emp = fixedMasters.find((item) => item.employeeCode === code);
                    return <option key={code} value={emp?.employeeId ?? `unregistered:${code}`} disabled={!emp}>{code} {name}{emp ? "" : "（未登録）"}</option>;
                  })}
                </select>
              </label>
              {masterForms[masterEmployeeId] ? (
                <div style={s.masterGrid}>
                  {([["fixedBaseSalary", "基本給"], ["directorCompensation", "役員報酬"], ["positionAllowance", "職能手当"], ["businessAllowance", "業務手当"], ["fixedOvertimeAllowance", "固定手当"], ["healthInsurance", "健康保険"], ["childSupportContribution", "子育て支援金"], ["careInsurance", "介護保険"], ["employeePension", "厚生年金"], ["employmentInsurance", "雇用保険"], ["incomeTax", "所得税"], ["residentTax", "住民税"]] as const).map(([key, label]) => (
                    <label key={key} style={s.lbl}>{label}<input type="number" min="0" placeholder="未設定" value={masterForms[masterEmployeeId][key] ?? ""} onChange={(e) => setMasterForms((current) => ({ ...current, [masterEmployeeId]: { ...current[masterEmployeeId], [key]: e.target.value === "" ? null : Number(e.target.value) } }))} style={s.input} /></label>
                  ))}
                  <label style={s.lbl}>交通費区分<select value={masterForms[masterEmployeeId].transportationType ?? ""} onChange={(e) => setMasterForms((current) => ({ ...current, [masterEmployeeId]: { ...current[masterEmployeeId], transportationType: e.target.value as FixedMaster["transportationType"] } }))} style={s.input}><option value="" disabled>未設定</option><option value="none">なし</option><option value="daily">日額</option><option value="monthly">月額</option></select></label>
                </div>
              ) : <p style={s.muted}>正社員を選択してください。</p>}
              {warnings.filter((item) => item.employeeId === masterEmployeeId).map((item) => <p key={`${item.code}:${item.message}`} style={s.warningText}>{item.message}</p>)}
              <button disabled={busy || !masterEmployeeId} onClick={saveFixedMaster} style={s.primary}>固定給与マスターを保存</button>
            </section>
          </div>
        )}

        {/* 確定取消 確認ダイアログ */}
        {showUnconfirmDialog && (
          <div style={s.overlay} role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowUnconfirmDialog(false); }}>
            <section style={s.modal} role="dialog" aria-modal="true" aria-label="確定取消の確認">
              <h2 style={s.h2}>確定取消の確認</h2>
              <p style={{ fontSize: 15, margin: "0 0 20px" }}>給与の確定を取り消します。確定時の履歴は残ります。よろしいですか？</p>
              <div style={s.actions}>
                <button onClick={() => { setShowUnconfirmDialog(false); void unconfirm(); }} style={s.danger}>はい、取り消す</button>
                <button onClick={() => setShowUnconfirmDialog(false)} style={s.secondary}>いいえ、戻る</button>
              </div>
            </section>
          </div>
        )}
      </div>
    </main>
  );
}

const s: Record<string, React.CSSProperties> = {
  page: { minHeight: "100vh", background: "#F4F7FA", padding: 24, color: "#172033" },
  shell: { maxWidth: 860, margin: "0 auto" },
  headerRow: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, marginBottom: 20 },
  title: { fontSize: 28, margin: "0 0 2px" },
  eyebrow: { margin: 0, color: "#0284C7", fontSize: 12, fontWeight: 800, letterSpacing: 1 },
  card: { background: "white", borderRadius: 14, padding: 24, marginBottom: 18, boxShadow: "0 4px 16px rgba(15,23,42,.06)" },
  h2: { margin: "0 0 14px", fontSize: 18, fontWeight: 800 },
  sub: { margin: "0 0 14px", color: "#64748B", fontSize: 14 },
  infoRow: { display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap", marginBottom: 14, fontSize: 15 },
  badge: { padding: "4px 12px", borderRadius: 999, fontWeight: 800, fontSize: 13 },
  badgeGreen: { background: "#DCFCE7", color: "#166534" },
  badgeYellow: { background: "#FEF3C7", color: "#92400E" },
  msg: { padding: 11, background: "#F0F9FF", borderRadius: 9, color: "#075985", margin: "0 0 12px", fontSize: 14 },
  pendingMsg: { padding: 11, background: "#FEF9C3", borderRadius: 9, color: "#713F12", margin: "0 0 12px", fontSize: 14, fontWeight: 700 },
  issueBox: { background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 9, padding: "10px 14px", marginBottom: 12 },
  warningBox: { background: "#F8FAFC", border: "1px solid #CBD5E1", borderRadius: 9, padding: "10px 14px", marginBottom: 12 },
  errText: { margin: 0, color: "#B91C1C", fontWeight: 700, fontSize: 14 },
  warningText: { margin: 0, color: "#475569", fontWeight: 600, fontSize: 14 },
  warningButton: { border: "1px solid #F59E0B", borderRadius: 8, background: "#FFFBEB", color: "#92400E", padding: "9px 12px", fontWeight: 800, cursor: "pointer" },
  summaryGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 12 },
  summaryItem: { display: "grid", gap: 4, padding: 12, border: "1px solid #E2E8F0", borderRadius: 9, background: "#F8FAFC" },
  summaryLabel: { color: "#64748B", fontSize: 12, fontWeight: 700 },
  summaryValue: { fontSize: 18 },
  issueSummary: { display: "flex", gap: 18, marginBottom: 12, fontSize: 14 },
  adjustPanel: { margin: "16px 0", padding: 14, border: "1px solid #CBD5E1", borderRadius: 10, background: "#F8FAFC" },
  adjustTitle: { margin: "0 0 6px", fontSize: 16 },
  adjustEmployee: { marginTop: 12, paddingTop: 12, borderTop: "1px solid #E2E8F0" },
  adjustGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, margin: "10px 0" },
  masterGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, margin: "14px 0" },
  adjustResult: { display: "flex", flexWrap: "wrap", gap: "8px 16px", padding: 10, borderRadius: 8, background: "white", border: "1px solid #E2E8F0", fontSize: 13 },
  input: { height: 36, border: "1px solid #CBD5E1", borderRadius: 7, padding: "0 9px", fontSize: 14 },
  actions: { display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" },
  hint: { margin: "10px 0 0", color: "#64748B", fontSize: 13 },
  primary: { height: 44, border: 0, borderRadius: 9, padding: "0 20px", background: "#0284C7", color: "white", fontWeight: 800, cursor: "pointer", fontSize: 15 },
  secondary: { height: 42, border: "1px solid #38BDF8", borderRadius: 9, padding: "0 16px", background: "white", color: "#0369A1", fontWeight: 700, cursor: "pointer" },
  confirm: { height: 42, border: "1px solid #16A34A", borderRadius: 9, padding: "0 16px", background: "#F0FDF4", color: "#166534", fontWeight: 800, cursor: "pointer" },
  danger: { height: 42, border: "1px solid #DC2626", borderRadius: 9, padding: "0 16px", background: "#FEF2F2", color: "#DC2626", fontWeight: 800, cursor: "pointer" },
  unconfirmArea: { marginTop: 16, paddingTop: 14, borderTop: "1px solid #E2E8F0", display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" },
  fileBox: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginTop: 12, padding: 12, border: "1px solid #BAE6FD", borderRadius: 9, background: "#F0F9FF", fontSize: 14 },
  downloadButton: { display: "inline-flex", alignItems: "center", minHeight: 38, padding: "0 14px", borderRadius: 8, background: "#0369A1", color: "white", fontWeight: 800, textDecoration: "none" },
  muted: { color: "#64748B", margin: 0, fontSize: 14 },
  selRow: { display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 16 },
  lbl: { display: "grid", gap: 6, fontWeight: 700, fontSize: 14 },
  sel: { height: 40, border: "1px solid #CBD5E1", borderRadius: 8, padding: "0 10px", minWidth: 260, fontSize: 14 },
  inlineLbl: { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 15 },
  selSm: { height: 34, border: "1px solid #CBD5E1", borderRadius: 8, padding: "0 8px", fontSize: 14, fontWeight: 700 },
  table: { width: "100%", borderCollapse: "collapse", marginTop: 4 },
  th: { border: "1px solid #E2E8F0", padding: "9px 12px", background: "#F8FAFC", fontWeight: 700, textAlign: "left", fontSize: 13 },
  td: { border: "1px solid #E2E8F0", padding: "9px 12px", fontSize: 13 },
  small: { border: "1px solid #38BDF8", borderRadius: 7, padding: "5px 12px", background: "white", color: "#0369A1", fontWeight: 700, cursor: "pointer", fontSize: 13 },
  settingsButton: { border: "1px solid #0284C7", borderRadius: 8, background: "white", color: "#0369A1", minHeight: 38, padding: "0 13px", fontWeight: 800, cursor: "pointer" },
  overlay: { position: "fixed", inset: 0, zIndex: 100, display: "grid", placeItems: "center", padding: 20, background: "rgba(15,23,42,.48)" },
  modal: { width: "min(820px, 100%)", maxHeight: "90vh", overflowY: "auto", background: "white", borderRadius: 14, padding: 22, boxShadow: "0 24px 60px rgba(15,23,42,.28)" },
  modalHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 },
  closeButton: { border: "1px solid #CBD5E1", borderRadius: 7, background: "white", minHeight: 34, padding: "0 12px", cursor: "pointer", fontWeight: 700 },
  tabs: { display: "flex", gap: 6, margin: "18px 0 14px", borderBottom: "1px solid #CBD5E1" },
  tab: { border: 0, borderBottom: "3px solid transparent", background: "transparent", padding: "9px 14px", color: "#64748B", cursor: "pointer", fontWeight: 700 },
  activeTab: { border: 0, borderBottom: "3px solid #0284C7", background: "#F0F9FF", padding: "9px 14px", color: "#0369A1", cursor: "pointer", fontWeight: 800 },
  payslipActions: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 },
  payslipBox: { display: "grid", gap: 9, padding: 14, border: "1px solid #CBD5E1", borderRadius: 9, background: "#F8FAFC" },
  appliedBox: { background: "#F0FDF4", border: "1px solid #86EFAC", borderRadius: 9, padding: 14, marginBottom: 14 },
  appliedMsg: { fontSize: 14, fontWeight: 700, color: "#166534" },
  employeeButtons: { display: "flex", flexWrap: "wrap", gap: 8, margin: "12px 0 16px" },
  employeeButton: { minHeight: 42, border: "1px solid #CBD5E1", borderRadius: 999, padding: "0 15px", background: "white", color: "#334155", fontWeight: 700, cursor: "pointer" },
  employeeButtonActive: { borderColor: "#0284C7", background: "#0284C7", color: "white", boxShadow: "0 2px 8px rgba(2,132,199,.24)" },
  employeeCode: { marginRight: 6, fontSize: 11, opacity: 0.78 },
  holidaySection: { margin: "12px 0", padding: 16, border: "1px solid #BAE6FD", borderRadius: 11, background: "#F8FCFF" },
  h3: { margin: "0 0 8px", fontSize: 16 },
  basisText: { margin: "0 0 12px", color: "#475569", fontSize: 14 },
  holidayGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10 },
  moneyCard: { display: "grid", gap: 7, padding: 11, border: "1px solid #E2E8F0", borderRadius: 8, background: "white", color: "#64748B", fontSize: 13 },
  checkLabel: { display: "flex", alignItems: "center", gap: 8, marginTop: 13, color: "#0369A1", fontWeight: 700, fontSize: 14, cursor: "pointer" },
  manualOverrideBox: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10, marginTop: 12, padding: 12, border: "1px solid #FCA5A5", borderRadius: 8, background: "#FFF7F7" },
  inlineError: { margin: "10px 0", color: "#B91C1C", fontWeight: 700, fontSize: 14 },
  unset: { color: "#B45309" },
  fieldHelp: { color: "#64748B", fontWeight: 400, fontSize: 12, lineHeight: 1.5 },
  pendingInput: { color: "#92400E", background: "#FEF3C7", borderRadius: 6, padding: "6px 8px", fontWeight: 700, fontSize: 13 },
  diffRows: { display: "grid", gap: 6, marginTop: 10, fontSize: 14 },
};

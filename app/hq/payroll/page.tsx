"use client";

import { useEffect, useMemo, useState } from "react";
import { auth } from "@/lib/firebase";
import type { PayrollResult } from "@/lib/payroll";

type PayrollIssue = { severity: "error" | "warning"; code: string; message: string; employeeId?: string };
type PayrollRun = {
  id?: string; status: "draft" | "confirmed" | "cancelled"; targetMonth: string; paymentMonth: string; paymentDate: string;
  calculatedAt?: string | { _seconds?: number }; employeeCount: number; grossTotal: number; deductionTotal: number;
  netTotal: number; bankTransferTotal: number; canConfirm?: boolean; issues: PayrollIssue[]; results: PayrollResult[];
};
type ConfirmedRunSummary = { id: string; targetMonth: string; paymentMonth: string; paymentDate: string; employeeCount: number };
type SlipRun = { id: string; targetMonth: string; paymentDate: string; status: string; results: PayrollResult[] };

function tokyoYM() {
  // Intl は Safari で SyntaxError になるため使わない。
  // lib/payroll.ts の isPayrollMonthClosed と同じ UTC+9 方式に揃える。
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

async function getToken() {
  const t = await auth.currentUser?.getIdToken();
  if (!t) throw new Error("認証情報を取得できません");
  return t;
}

async function apiCall(url: string, init?: RequestInit) {
  const res = await fetch(url, { ...init, headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${await getToken()}` } });
  // エラー応答がJSONとは限らない（504のHTML等）。JSON.parseで落とさず中身を見せる。
  const text = await res.text();
  let data: { error?: string } = {};
  try { data = JSON.parse(text) as { error?: string }; } catch { /* non-JSON */ }
  if (!res.ok) throw new Error(data.error ?? `処理に失敗しました (HTTP ${res.status}) ${text.slice(0, 200)}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return data as any;
}

async function downloadFile(url: string, init?: RequestInit) {
  const res = await fetch(url, { ...init, headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${await getToken()}` } });
  if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? "ダウンロードに失敗しました"); }
  const blob = await res.blob();
  if (blob.size === 0) throw new Error("サーバーが空のファイルを返しました");
  const disposition = res.headers.get("content-disposition") ?? "";
  const match = disposition.match(/filename\*=UTF-8''([^;]+)/);
  const name = match ? decodeURIComponent(match[1]) : "payroll-download.xlsx";
  const obj = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = obj;
  a.download = name;
  a.rel = "noopener";
  a.style.display = "none";
  // Safari は document に挿入されていない <a> の click() を無視するため必ず append する。
  document.body.appendChild(a);
  a.click();
  // Safari は revoke が早すぎるとダウンロードが始まらないため十分に待ってから破棄する。
  setTimeout(() => { a.remove(); URL.revokeObjectURL(obj); }, 60000);
  return name;
}

export default function PayrollPage() {
  // 通常運用は「前月」。当月はまだ締まっていないため試算Excelのみ（確定は不可）。
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

  // Initial load: current month run + confirmed runs list
  useEffect(() => {
    let active = true;
    (async () => {
      setRun(null);
      setMessage("");
      try {
        const [workspace, runsData] = await Promise.all([
          apiCall(`/api/payroll/calculate?targetMonth=${targetMonth}`),
          apiCall("/api/payroll/runs"),
        ]);
        if (!active) return;
        setRun(workspace.run);
        const confirmed: ConfirmedRunSummary[] = runsData.runs ?? [];
        setConfirmedRuns(confirmed);
        const others = confirmed.filter((r) => r.targetMonth !== targetMonth);
        if (others.length > 0) setSlipMonthKey(`${others[0].id}__${others[0].targetMonth}`);
      } catch (e) {
        if (active) setMessage(e instanceof Error ? e.message : "読み込みに失敗しました");
      }
    })();
    return () => { active = false; };
  }, [targetMonth]);

  // Load slip run when confirmed month is selected
  useEffect(() => {
    if (!slipMonthKey) return;
    const runId = slipMonthKey.split("__")[0];
    let active = true;
    apiCall(`/api/payroll/runs?runId=${runId}`)
      .then((data) => { if (active) { setSlipRun(data as SlipRun); setSlipStore(""); } })
      .catch((e) => { if (active) setMessage(e instanceof Error ? e.message : "明細データの読み込みに失敗しました"); });
    return () => { active = false; };
  }, [slipMonthKey]);

  const calculate = async () => {
    setBusy(true); setMessage("");
    try {
      const data = await apiCall("/api/payroll/calculate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetMonth, paymentMonth, paymentDate }),
      });
      setRun(data);
      const name = await downloadFile("/api/payroll/export/payroll", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
      setMessage(`「${name}」をダウンロードしました。内容を確認してから「給与を確定」してください。`);
    } catch (e) { setMessage(e instanceof Error ? e.message : "給与計算に失敗しました"); }
    finally { setBusy(false); }
  };

  const downloadTransfer = async () => {
    if (!run) return; setBusy(true); setMessage("");
    try { const name = await downloadFile("/api/payroll/export/transfer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(run) }); setMessage(`「${name}」をダウンロードしました。`); }
    catch (e) { setMessage(e instanceof Error ? e.message : "振込確認Excelの出力に失敗しました"); }
    finally { setBusy(false); }
  };

  const confirm = async () => {
    if (!run) return; setBusy(true); setMessage("");
    try {
      const confirmed = await apiCall("/api/payroll/confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ run }) });
      setRun(confirmed);
      const runsData = await apiCall("/api/payroll/runs");
      setConfirmedRuns(runsData.runs ?? []);
      setMessage("給与を確定しました。「給与明細ダウンロード」から個人別PDFを出力できます。");
    } catch (e) { setMessage(e instanceof Error ? e.message : "確定に失敗しました"); }
    finally { setBusy(false); }
  };

  const downloadSlipPdf = async (runId: string, employeeId: string) => {
    setBusy(true); setMessage("");
    try { await downloadFile(`/api/payroll/export/pdf?runId=${runId}&employeeId=${employeeId}`); }
    catch (e) { setMessage(e instanceof Error ? e.message : "PDFのダウンロードに失敗しました"); }
    finally { setBusy(false); }
  };

  const errors = run?.issues.filter((x) => x.severity === "error") ?? [];
  const isDraft = run?.status === "draft";
  const isConfirmed = run?.status === "confirmed";
  const statusLabel = !run ? "未計算" : run.status === "draft" ? "試算" : run.status === "confirmed" ? "確定済み" : "確定取消済み";

  const slipStores = useMemo(() => [...new Set(slipRun?.results.map((r) => r.storeName) ?? [])].sort(), [slipRun]);
  const slipEmployees = useMemo(() => (slipRun?.results ?? []).filter((r) => !slipStore || r.storeName === slipStore), [slipRun, slipStore]);

  return (
    <main style={s.page}>
      <div style={s.shell}>
        <header style={s.header}>
          <h1 style={s.title}>給与管理</h1>
          <p style={s.eyebrow}>本部管理者専用</p>
        </header>

        {/* Section 1: 今月の給与計算 */}
        <section style={s.card}>
          <h2 style={s.h2}>① 今月の給与計算</h2>
          <div style={s.infoRow}>
            <label style={s.inlineLbl}>
              対象勤怠：
              <select value={monthMode} disabled={busy} onChange={(e) => setMonthMode(e.target.value as "prev" | "current")} style={s.selSm}>
                <option value="prev">{fmtMonth(lastMonth())}（前月・通常運用）</option>
                <option value="current">{fmtMonth(thisMonth())}（当月・試算のみ）</option>
              </select>
            </label>
            <span>支給日：<b>{fmtDate(paymentDate)}</b></span>
            <span style={{ ...s.badge, ...(isConfirmed ? s.badgeGreen : s.badgeYellow) }}>{statusLabel}</span>
          </div>

          {message && <p style={s.msg}>{message}</p>}

          {errors.length > 0 && (
            <div style={s.issueBox}>
              {errors.map((e, i) => <p key={i} style={s.errText}>エラー：{e.message}</p>)}
            </div>
          )}

          <div style={s.actions}>
            <button disabled={busy || isConfirmed} onClick={calculate} style={s.primary}>
              {busy ? "処理中…" : run ? "今月の給与Excelを再作成" : "今月の給与Excelを作成"}
            </button>
            <button disabled={busy || !run} onClick={downloadTransfer} style={s.secondary}>
              振込一覧Excelを作成
            </button>
            <button
              disabled={busy || !isDraft || !run?.canConfirm || errors.length > 0}
              onClick={confirm}
              style={s.confirm}
            >
              給与を確定
            </button>
          </div>
          {monthMode === "current" && (
            <p style={s.hint}>※ 当月はまだ締まっていないため、試算Excelの確認のみ可能です。確定はできません。</p>
          )}
          {monthMode === "prev" && isDraft && !run?.canConfirm && errors.length === 0 && (
            <p style={s.hint}>※ 月が終了していないため確定できません。翌月以降に「給与を確定」してください。</p>
          )}
        </section>

        {/* Section 2: 給与明細ダウンロード */}
        <section style={s.card}>
          <h2 style={s.h2}>② 給与明細ダウンロード</h2>
          <p style={s.sub}>確定済みの月を選択し、従業員ごとにPDFをダウンロードできます。</p>

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
                    店舗を選ぶ
                    <select value={slipStore} onChange={(e) => setSlipStore(e.target.value)} style={s.sel}>
                      <option value="">全店舗</option>
                      {slipStores.map((st) => <option key={st}>{st}</option>)}
                    </select>
                  </label>
                )}
              </div>

              {slipRun && slipEmployees.length > 0 && (
                <table style={s.table}>
                  <thead>
                    <tr>
                      <th style={s.th}>氏名</th>
                      <th style={s.th}>所属店舗</th>
                      <th style={s.th}>差引支給額</th>
                      <th style={s.th}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {slipEmployees.map((r) => (
                      <tr key={r.employeeId}>
                        <td style={s.td}>{r.employeeName}</td>
                        <td style={s.td}>{r.storeName}</td>
                        <td style={s.td}>{yen(r.netPay)}</td>
                        <td style={s.td}>
                          <button disabled={busy} onClick={() => downloadSlipPdf(slipRun.id, r.employeeId)} style={s.small}>
                            給与明細ダウンロード
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {slipRun && slipEmployees.length === 0 && slipStore && (
                <p style={s.muted}>この店舗に該当する従業員がいません。</p>
              )}
            </>
          )}
        </section>
      </div>
    </main>
  );
}

const s: Record<string, React.CSSProperties> = {
  page: { minHeight: "100vh", background: "#F4F7FA", padding: 24, color: "#172033" },
  shell: { maxWidth: 860, margin: "0 auto" },
  header: { marginBottom: 20 },
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
  issueBox: { background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 9, padding: "10px 14px", marginBottom: 12 },
  errText: { margin: 0, color: "#B91C1C", fontWeight: 700, fontSize: 14 },
  actions: { display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" },
  hint: { margin: "10px 0 0", color: "#64748B", fontSize: 13 },
  primary: { height: 44, border: 0, borderRadius: 9, padding: "0 20px", background: "#0284C7", color: "white", fontWeight: 800, cursor: "pointer", fontSize: 15 },
  secondary: { height: 42, border: "1px solid #38BDF8", borderRadius: 9, padding: "0 16px", background: "white", color: "#0369A1", fontWeight: 700, cursor: "pointer" },
  confirm: { height: 42, border: "1px solid #16A34A", borderRadius: 9, padding: "0 16px", background: "#F0FDF4", color: "#166534", fontWeight: 800, cursor: "pointer" },
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
};

"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuthProfile } from "@/lib/auth";
import type { PayrollBreakPolicy } from "@/lib/payroll";

const initialPolicy: PayrollBreakPolicy = { enabled: true, thresholdMinutes: 180, deductionMinutes: 15, effectiveFrom: "2026-11-01" };

export default function PayrollBreakPolicyPage() {
  const { user, isLoading } = useAuthProfile();
  const [policy, setPolicy] = useState(initialPolicy);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => { if (!user) return; void (async () => { const token = await user.getIdToken(true); const response = await fetch("/api/payroll/break-policy", { headers: { Authorization: `Bearer ${token}` } }); const body = await response.json() as { policy?: PayrollBreakPolicy | null; error?: string }; if (response.ok && body.policy) { setPolicy(body.policy); setSaved(true); } else if (!response.ok) setMessage(body.error ?? "設定を取得できませんでした"); })(); }, [user]);
  const submit = async () => { if (!user) return; setBusy(true); setMessage(""); try { const token = await user.getIdToken(true); const response = await fetch("/api/payroll/break-policy", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ policy }) }); const body = await response.json() as { policy?: PayrollBreakPolicy; error?: string }; if (!response.ok || !body.policy) throw new Error(body.error ?? "保存できませんでした"); setPolicy(body.policy); setSaved(true); setMessage("一律休憩設定を保存しました。既存の確定済み給与は変更されません。"); } catch (error) { setMessage(error instanceof Error ? error.message : "保存できませんでした"); } finally { setBusy(false); } };
  if (isLoading) return <main style={{ padding: 24 }}>読み込み中</main>;
  return <main style={{ padding: 24, maxWidth: 720, margin: "0 auto" }}><Link href="/hq/payroll">← 給与管理へ戻る</Link><h1>給与計算の一律休憩設定</h1><p>記録休憩控除後の実働が閾値以上の日に、JSTの日単位で1回だけ控除します。clockLogsと勤怠Excelは変更しません。</p><div style={{ display: "grid", gap: 16 }}><label>状態<select value={policy.enabled ? "yes" : "no"} onChange={(event) => setPolicy({ ...policy, enabled: event.target.value === "yes" })}><option value="yes">有効</option><option value="no">無効</option></select></label><label>閾値（分）<input type="number" min="1" value={policy.thresholdMinutes} onChange={(event) => setPolicy({ ...policy, thresholdMinutes: Number(event.target.value) })}/></label><label>控除時間（分）<input type="number" min="1" value={policy.deductionMinutes} onChange={(event) => setPolicy({ ...policy, deductionMinutes: Number(event.target.value) })}/></label><label>適用開始日<input type="date" value={policy.effectiveFrom} onChange={(event) => setPolicy({ ...policy, effectiveFrom: event.target.value })}/></label><p>保存状態：{saved ? "保存済み" : "未保存"}</p>{message && <p>{message}</p>}<button type="button" disabled={busy || policy.deductionMinutes >= policy.thresholdMinutes} onClick={submit}>{busy ? "保存中…" : "設定を保存"}</button></div></main>;
}

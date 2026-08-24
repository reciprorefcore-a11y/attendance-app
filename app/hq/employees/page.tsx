"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { db } from "@/lib/firebase";
import { adminStyles as styles } from "@/lib/adminStyles";
import { useAuthProfile } from "@/lib/auth";
import { isFullTimeEmployee } from "@/lib/employee-classification";
import {
  Employee,
  EmploymentType,
  Store,
  employmentTypeLabels,
  statusLabels,
} from "@/lib/attendance";
import {
  addDoc,
  collection,
  doc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";

type EmployeeRow = Employee & { id: string; fixedBaseSalary?: number | null; monthlyTransportation?: number | null; residentTax?: number | null; healthInsurance?: number | null; childSupportContribution?: number | null; careInsurance?: number | null; employeePension?: number | null; employmentInsurance?: number | null; incomeTax?: number | null };
type StoreRow = Store & { id: string };
type WageInput = {
  hourlyWage: string;
  lateNightHourlyWage: string;
  dailyTransportation: string;
};
type EmployeeMatch = {
  id: string;
  employeeCode: string;
  name: string;
  nameKana: string;
  status: string;
  matchedBy: string[];
};
type PreviewState = {
  employeeCode: string;
  isChecking: boolean;
  matches: EmployeeMatch[];
  checked: boolean;
};

const emptyForm = {
  employeeCode: "",
  name: "",
  nameKana: "",
  storeId: "",
  employmentType: "part_time" as EmploymentType,
  pin: "", hourlyWage: "", transportationCost: "", transportationType: "none" as "daily" | "monthly" | "none", payrollEnabled: true,
  paymentMethod: "bank" as "bank" | "cash",
  fixedBaseSalary: "", directorCompensation: "", positionAllowance: "", businessAllowance: "", holidayAllowance: "", fixedOvertimeAllowance: "",
  healthInsurance: "", childSupportContribution: "", careInsurance: "", employeePension: "", employmentInsurance: "", incomeTax: "", residentTax: "",
};

// Book2検算済みの初期値（固定給与テンプレートと一致）。ひらがなは入力済み。
const FIXED_EMPLOYEE_PRESETS: Record<string, Partial<typeof emptyForm>> = {
  "0002": {
    employeeCode: "0002", name: "青山佳史", nameKana: "あおやま よしふみ",
    employmentType: "full_time" as EmploymentType,
    directorCompensation: "150000", fixedBaseSalary: "0",
    healthInsurance: "7440", childSupportContribution: "172", careInsurance: "1215",
    employeePension: "13725", employmentInsurance: "0", residentTax: "12600",
    paymentMethod: "cash" as "bank" | "cash",
  },
  "0017": {
    employeeCode: "0017", name: "木月徳子", nameKana: "きづき のりこ",
    employmentType: "full_time" as EmploymentType,
    fixedBaseSalary: "200000", positionAllowance: "6000", directorCompensation: "0",
    healthInsurance: "9920", childSupportContribution: "230", careInsurance: "1620",
    employeePension: "18300", employmentInsurance: "1030", residentTax: "0",
    paymentMethod: "bank" as "bank" | "cash",
  },
};

// Book2検算済みの給与プレビュー値（テストで検証済み）
const PAYROLL_PREVIEW: Record<string, {
  basicNetPay: number;
  paymentMethod: "cash" | "bank";
  notes: string[];
}> = {
  "0002": {
    basicNetPay: 113548,
    paymentMethod: "cash",
    notes: ["振込一覧に含めない（現金支給）", "店舗別明細ZIPに含めない", "正社員明細ZIPに含める"],
  },
  "0017": {
    basicNetPay: 171490,
    paymentMethod: "bank",
    notes: ["振込一覧に含める", "店舗別明細ZIPに含めない", "正社員明細ZIPに含める"],
  },
};

const yen = (v: number) => `${Math.trunc(v || 0).toLocaleString()}円`;

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

export default function HqEmployeesPage() {
  const { user } = useAuthProfile();
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [stores, setStores] = useState<StoreRow[]>([]);
  const [wages, setWages] = useState<Record<string, WageInput>>({});
  const [message, setMessage] = useState("");
  const [form, setForm] = useState(emptyForm);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [employeeTab, setEmployeeTab] = useState<"hourly" | "fixed">("hourly");
  const [preview, setPreview] = useState<PreviewState | null>(null);

  const load = async () => {
    const [employeeSnapshot, storeSnapshot, payrollSnapshot] = await Promise.all([
      getDocs(query(collection(db, "employees"), orderBy("employeeCode"))),
      getDocs(query(collection(db, "stores"), orderBy("storeName"))),
      getDocs(collection(db, "payrollSettings")),
    ]);
    const settings = new Map(payrollSnapshot.docs.map((item) => [item.id, item.data()]));
    const rows = employeeSnapshot.docs.map((employeeDoc) => ({
      id: employeeDoc.id,
      ...(employeeDoc.data() as Employee),
      ...(settings.get(employeeDoc.id) ?? {}),
    }));

    setEmployees(rows);
    setStores(
      storeSnapshot.docs.map((storeDoc) => ({
        id: storeDoc.id,
        ...(storeDoc.data() as Store),
      })),
    );
    setWages((current) => {
      const next = { ...current };
      for (const employee of rows.filter((row) => row.status === "pending")) {
        next[employee.id] ??= {
          hourlyWage: "",
          lateNightHourlyWage: "",
          dailyTransportation: "",
        };
      }
      return next;
    });
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, []);

  const pendingEmployees = useMemo(
    () => employees.filter((employee) => employee.status === "pending"),
    [employees],
  );

  const selectedStore = stores.find((store) => store.id === form.storeId);

  const checkDuplicates = async (employeeCode: string, name: string, nameKana: string) => {
    if (!user) { setMessage("ログインが必要です"); return; }
    setPreview({ employeeCode, isChecking: true, matches: [], checked: false });
    setMessage("");
    try {
      const token = await user.getIdToken(true);
      const params = new URLSearchParams({ employeeCode, name, nameKana });
      const res = await fetch(`/api/employees/check?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json() as { results?: EmployeeMatch[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "確認に失敗しました");
      setPreview({ employeeCode, isChecking: false, matches: data.results ?? [], checked: true });
    } catch (e) {
      setPreview(null);
      setMessage(e instanceof Error ? e.message : "重複確認に失敗しました");
    }
  };

  const createEmployee = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const employeeCode = form.employeeCode.trim();
    if (!employeeCode || !form.name.trim() || !form.nameKana.trim() || (employeeTab === "hourly" && !selectedStore)) {
      setMessage(employeeTab === "hourly" ? "社員コード、氏名、ひらがな、所属店舗を入力してください。" : "社員コード、氏名、ひらがなを入力してください。");
      return;
    }

    // Block if duplicate confirmed
    if (preview?.checked && preview.matches.length > 0) {
      setMessage("重複する社員が確認されています。新規登録できません。");
      return;
    }

    setIsSubmitting(true);
    setMessage("");

    try {
      if (employeeTab === "hourly") {
        // Hourly employees: single addDoc (existing flow)
        const duplicateSnapshot = await getDocs(
          query(collection(db, "employees"), where("employeeCode", "==", employeeCode)),
        );
        if (!duplicateSnapshot.empty) {
          setMessage("同じ社員コードの従業員が既に登録されています。");
          return;
        }
        await addDoc(collection(db, "employees"), {
          employeeCode,
          name: form.name.trim(),
          nameKana: form.nameKana.trim(),
          ...(selectedStore ? { storeId: selectedStore.id, storeName: selectedStore.storeName } : {}),
          employeeType: "partTime",
          employmentType: "part_time",
          payrollType: "hourly",
          clockEnabled: true,
          pin: form.pin,
          baseWage: Number(form.hourlyWage) || 0,
          hourlyWage: Number(form.hourlyWage) || 0,
          transportationCost: Number(form.transportationCost) || 0,
          transportationType: form.transportationType,
          payrollEnabled: form.payrollEnabled,
          status: "active",
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      } else {
        // Fixed employees: atomic batch - employees + payrollSettings
        const duplicateSnapshot = await getDocs(
          query(collection(db, "employees"), where("employeeCode", "==", employeeCode)),
        );
        if (!duplicateSnapshot.empty) {
          setMessage("同じ社員コードの従業員が既に登録されています。");
          return;
        }
        const batch = writeBatch(db);
        const employeeRef = doc(collection(db, "employees"));
        batch.set(employeeRef, {
          employeeCode,
          name: form.name.trim(),
          nameKana: form.nameKana.trim(),
          employeeType: "fullTime",
          employmentType: "full_time",
          payrollType: "fixed",
          clockEnabled: false,
          payrollEnabled: form.payrollEnabled,
          status: "active",
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        const payrollSettingsRef = doc(db, "payrollSettings", employeeRef.id);
        batch.set(payrollSettingsRef, {
          fixedBaseSalary: Number(form.fixedBaseSalary) || 0,
          monthlyTransportation: Number(form.transportationCost) || 0,
          residentTax: Number(form.residentTax) || 0,
          paymentMethod: form.paymentMethod,
          updatedAt: serverTimestamp(),
        });
        await batch.commit();
      }

      setMessage("従業員を登録しました。");
      setForm(emptyForm);
      setPreview(null);
      await load();
    } finally {
      setIsSubmitting(false);
    }
  };

  const setFullTimeActive = async (employee: EmployeeRow, active: boolean) => {
    const action = active ? "再有効化" : "退職・無効化";
    if (!window.confirm(`${employee.name}さんを${action}します。よろしいですか？`)) return;
    await updateDoc(doc(db, "employees", employee.id), { isDeleted: !active, status: active ? "active" : "inactive", payrollEnabled: active, updatedAt: serverTimestamp() });
    setMessage(`${employee.name}さんを${action}しました。`); await load();
  };

  const editFullTimePayroll = async (employee: EmployeeRow) => {
    const salary = window.prompt("月給", String(employee.fixedBaseSalary ?? 0)); if (salary == null) return;
    const transportation = window.prompt("交通費（月額）", String(employee.monthlyTransportation ?? 0)); if (transportation == null) return;
    const residentTax = window.prompt("住民税", String(employee.residentTax ?? 0)); if (residentTax == null) return;
    const values = [salary, transportation, residentTax].map(Number);
    if (values.some((value) => !Number.isInteger(value) || value < 0)) { setMessage("月給・交通費・住民税は0以上の整数で入力してください。"); return; }
    await updateDoc(doc(db, "payrollSettings", employee.id), { fixedBaseSalary: values[0], monthlyTransportation: values[1], residentTax: values[2], updatedAt: serverTimestamp() });
    setMessage(`${employee.name}さんの固定給与マスターを更新しました。`); await load();
  };

  const approve = async (employee: EmployeeRow) => {
    const wage = wages[employee.id];
    const hourlyWage = Number(wage?.hourlyWage);
    const lateNightHourlyWage = Number(wage?.lateNightHourlyWage);
    const dailyTransportation = Number(wage?.dailyTransportation);

    if (!hourlyWage || !lateNightHourlyWage || Number.isNaN(dailyTransportation)) {
      setMessage("時給、深夜時給、日交通費を入力してください。");
      return;
    }

    const employeeRef = doc(db, "employees", employee.id);
    await addDoc(collection(employeeRef, "wageHistory"), {
      hourlyWage,
      lateNightHourlyWage,
      dailyTransportation,
      effectiveFrom: todayString(),
      effectiveTo: null,
      approvedAt: serverTimestamp(),
      approvedBy: "HQ",
    });
    await updateDoc(employeeRef, {
      status: "active",
      approvedAt: serverTimestamp(),
      approvedBy: "HQ",
      updatedAt: serverTimestamp(),
    });
    setMessage("承認しました。");
    await load();
  };

  const reject = async (employee: EmployeeRow) => {
    await updateDoc(doc(db, "employees", employee.id), {
      status: "rejected",
      updatedAt: serverTimestamp(),
    });
    setMessage("差戻しました。");
    await load();
  };

  const hasDuplicate = (preview?.checked && preview.matches.length > 0) ?? false;

  return (
    <main style={styles.page}>
      <div style={styles.shell}>
        <header>
          <h1 style={styles.title}>従業員管理</h1>
        </header>

        <div style={{ display: "flex", gap: 8, margin: "16px 0" }}>
          <button type="button" onClick={() => { setEmployeeTab("hourly"); setPreview(null); }} style={employeeTab === "hourly" ? styles.button : styles.secondaryButton}>① アルバイト</button>
          <button type="button" onClick={() => { setEmployeeTab("fixed"); setPreview(null); }} style={employeeTab === "fixed" ? styles.button : styles.secondaryButton}>② 正社員</button>
        </div>

        {message && <p style={styles.success}>{message}</p>}

        {employeeTab === "fixed" && (
          <section style={styles.panel}>
            <b>正社員マスター（5名）</b>
            <p style={{ margin: "8px 0" }}>0002 青山佳史／0003 中村鏡太郎／0017 木月徳子／0064 小林彗太／0083 佐藤雅信</p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
              {[{ employeeCode: "0002", name: "青山佳史" }, { employeeCode: "0017", name: "木月徳子" }]
                .filter((candidate) => !employees.some((emp) => String(emp.employeeCode).padStart(4, "0") === candidate.employeeCode))
                .map((candidate) => (
                  <button key={candidate.employeeCode} type="button"
                    disabled={preview?.isChecking}
                    onClick={async () => {
                      const preset = FIXED_EMPLOYEE_PRESETS[candidate.employeeCode];
                      setForm({ ...emptyForm, ...(preset ?? { employeeCode: candidate.employeeCode, name: candidate.name, employmentType: "full_time" }) });
                      setMessage("");
                      setEmployeeTab("fixed");
                      await checkDuplicates(
                        candidate.employeeCode,
                        candidate.name,
                        preset?.nameKana ?? "",
                      );
                    }}
                    style={styles.secondaryButton}>
                    {candidate.employeeCode} {candidate.name}を入力
                  </button>
                ))}
            </div>

            {/* 重複確認結果 */}
            {preview && (
              <div style={{ marginTop: 14, padding: "12px 16px", borderRadius: 8, border: "1px solid #CBD5E1", background: "#F8FAFC" }}>
                {preview.isChecking && <p style={{ margin: 0, color: "#64748B", fontSize: 14 }}>🔍 Firestore で重複確認中…</p>}
                {preview.checked && (
                  <>
                    {preview.matches.length === 0 ? (
                      <p style={{ margin: 0, color: "#166534", fontWeight: 700, fontSize: 14 }}>
                        ✓ {preview.employeeCode} {FIXED_EMPLOYEE_PRESETS[preview.employeeCode]?.name ?? ""}：既存登録なし・新規登録可能
                      </p>
                    ) : (
                      <div>
                        <p style={{ margin: "0 0 6px", color: "#DC2626", fontWeight: 700, fontSize: 14 }}>
                          ✗ {preview.employeeCode}：既存登録あり・新規登録不可
                        </p>
                        {preview.matches.map((m) => (
                          <p key={m.id} style={{ margin: "2px 0", fontSize: 13, color: "#475569" }}>
                            → 既存社員ID {m.id}（{m.name} / {m.nameKana}）と一致（判定: {m.matchedBy.join(", ")}）
                          </p>
                        ))}
                      </div>
                    )}
                  </>
                )}

                {/* 給与プレビュー（重複なしの場合のみ） */}
                {preview.checked && preview.matches.length === 0 && PAYROLL_PREVIEW[preview.employeeCode] && (
                  <div style={{ marginTop: 12, borderTop: "1px solid #E2E8F0", paddingTop: 10 }}>
                    <p style={{ margin: "0 0 6px", fontWeight: 700, fontSize: 13, color: "#0369A1" }}>給与試算プレビュー（Book2検算済み・登録前確認用）</p>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                      <tbody>
                        <tr>
                          <td style={{ padding: "3px 8px", color: "#64748B" }}>差引支給額（基本）</td>
                          <td style={{ padding: "3px 8px", fontWeight: 700 }}>{yen(PAYROLL_PREVIEW[preview.employeeCode].basicNetPay)}</td>
                        </tr>
                        <tr>
                          <td style={{ padding: "3px 8px", color: "#64748B" }}>支給方法</td>
                          <td style={{ padding: "3px 8px" }}>{PAYROLL_PREVIEW[preview.employeeCode].paymentMethod === "cash" ? "現金" : "振込"}</td>
                        </tr>
                        {PAYROLL_PREVIEW[preview.employeeCode].notes.map((note) => (
                          <tr key={note}>
                            <td colSpan={2} style={{ padding: "2px 8px", color: "#475569", fontSize: 12 }}>• {note}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p style={{ margin: "8px 0 0", fontSize: 12, color: "#94A3B8" }}>※ 立替経費返金は当月調整で別途入力してください。固定マスターには登録しません。</p>
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        <form style={styles.panel} onSubmit={createEmployee}>
          <h2 style={{ ...styles.title, fontSize: 18 }}>{employeeTab === "hourly" ? "アルバイト" : "正社員"}を新規登録</h2>
          {preview?.checked && preview.matches.length === 0 && employeeTab === "fixed" && (
            <p style={{ margin: "0 0 12px", padding: "8px 12px", borderRadius: 6, background: "#F0FDF4", border: "1px solid #86EFAC", fontSize: 13, fontWeight: 700, color: "#166534" }}>
              Book2検算済みの初期値（社員コード {preview.employeeCode}）を設定しました。内容を確認後「登録」してください。
            </p>
          )}
          {hasDuplicate && (
            <p style={{ margin: "0 0 12px", padding: "8px 12px", borderRadius: 6, background: "#FEF2F2", border: "1px solid #FCA5A5", fontSize: 13, fontWeight: 700, color: "#DC2626" }}>
              重複する社員が確認されているため登録できません。
            </p>
          )}
          <div style={{ ...styles.grid, marginTop: 14 }}>
            <label style={styles.label}>
              社員コード
              <input required value={form.employeeCode} onChange={(event) => setForm({ ...form, employeeCode: event.target.value })} style={styles.input} />
            </label>
            <label style={styles.label}>
              氏名
              <input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} style={styles.input} />
            </label>
            <label style={styles.label}>
              ひらがな
              <input required value={form.nameKana} onChange={(event) => setForm({ ...form, nameKana: event.target.value })} style={styles.input} />
            </label>
            {employeeTab === "hourly" && <label style={styles.label}>
              所属店舗
              <select required value={form.storeId} onChange={(event) => setForm({ ...form, storeId: event.target.value })} style={styles.input}>
                <option value="">選択してください</option>
                {stores.map((store) => (
                  <option key={store.id} value={store.id}>{store.storeName}</option>
                ))}
              </select>
            </label>}
            {employeeTab === "hourly" ? <>
              <label style={styles.label}>PIN<input value={form.pin} onChange={(e) => setForm({ ...form, pin: e.target.value.replace(/\D/g, "").slice(0, 4) })} style={styles.input} /></label>
              <label style={styles.label}>時給<input type="number" value={form.hourlyWage} onChange={(e) => setForm({ ...form, hourlyWage: e.target.value })} style={styles.input} /></label>
              <label style={styles.label}>交通費<input type="number" value={form.transportationCost} onChange={(e) => setForm({ ...form, transportationCost: e.target.value })} style={styles.input} /></label>
              <label style={styles.label}>交通費種別<select value={form.transportationType} onChange={(e) => setForm({ ...form, transportationType: e.target.value as typeof form.transportationType })} style={styles.input}><option value="none">なし</option><option value="daily">日額</option><option value="monthly">月額</option></select></label>
            </> : <>
              <label style={styles.label}>固定給区分<select value="fixed" disabled style={styles.input}><option value="fixed">固定給</option></select></label>
              <label style={styles.label}>支給方法<select value={form.paymentMethod} onChange={(e) => setForm({ ...form, paymentMethod: e.target.value as "bank" | "cash" })} style={styles.input}><option value="bank">振込</option><option value="cash">現金</option></select></label>
              {([["fixedBaseSalary","月給"],["transportationCost","交通費（月額）"],["residentTax","住民税"]] as const).map(([key, label]) => (
                <label key={key} style={styles.label}>{label}<input type="number" value={String(form[key as keyof typeof form])} onChange={(e) => setForm({ ...form, [key]: e.target.value })} style={styles.input} /></label>
              ))}
              <div style={{ gridColumn: "1 / -1", padding: 12, background: "#F8FAFC", borderRadius: 8 }}>社会保険・雇用保険・所得税は給与試算で自動計算し、ここでは読取専用で確認します。当月調整は給与管理画面で入力します。</div>
            </>}
            <label style={styles.label}>給与対象<select value={form.payrollEnabled ? "yes" : "no"} onChange={(e) => setForm({ ...form, payrollEnabled: e.target.value === "yes" })} style={styles.input}><option value="yes">対象</option><option value="no">対象外</option></select></label>
            {employeeTab === "hourly" && <label style={styles.label}>打刻対象<select value="yes" disabled style={styles.input}><option value="yes">対象</option></select></label>}
          </div>
          <button type="submit" disabled={isSubmitting || hasDuplicate} style={{ ...styles.button, marginTop: 14 }}>
            {isSubmitting ? "登録中" : "登録"}
          </button>
        </form>

        <section style={styles.panel}>
          <h2 style={{ ...styles.title, fontSize: 18, marginBottom: 14 }}>承認待ち</h2>
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>名前</th>
                  <th style={styles.th}>ひらがな</th>
                  <th style={styles.th}>社員コード</th>
                  <th style={styles.th}>所属店舗</th>
                  <th style={styles.th}>雇用区分</th>
                  <th style={styles.th}>時給</th>
                  <th style={styles.th}>深夜時給</th>
                  <th style={styles.th}>日交通費</th>
                  <th style={styles.th}>操作</th>
                </tr>
              </thead>
              <tbody>
                {pendingEmployees.map((employee) => (
                  <tr key={employee.id}>
                    <td style={styles.td}>{employee.name}</td>
                    <td style={styles.td}>{employee.nameKana}</td>
                    <td style={styles.td}>{employee.employeeCode}</td>
                    <td style={styles.td}>{employee.employeeType === "fullTime" || employee.payrollType === "fixed" ? "所属なし" : employee.storeName}</td>
                    <td style={styles.td}>{employmentTypeLabels[employee.employmentType]}</td>
                    <td style={styles.td}>
                      <input type="number" value={wages[employee.id]?.hourlyWage ?? ""} onChange={(event) => setWages({ ...wages, [employee.id]: { ...wages[employee.id], hourlyWage: event.target.value } })} style={{ ...styles.input, width: 100 }} />
                    </td>
                    <td style={styles.td}>
                      <input type="number" value={wages[employee.id]?.lateNightHourlyWage ?? ""} onChange={(event) => setWages({ ...wages, [employee.id]: { ...wages[employee.id], lateNightHourlyWage: event.target.value } })} style={{ ...styles.input, width: 100 }} />
                    </td>
                    <td style={styles.td}>
                      <input type="number" value={wages[employee.id]?.dailyTransportation ?? ""} onChange={(event) => setWages({ ...wages, [employee.id]: { ...wages[employee.id], dailyTransportation: event.target.value } })} style={{ ...styles.input, width: 100 }} />
                    </td>
                    <td style={styles.td}>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button type="button" onClick={() => approve(employee)} style={styles.secondaryButton}>承認</button>
                        <button type="button" onClick={() => reject(employee)} style={styles.dangerButton}>差戻し</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section style={styles.panel}>
          <h2 style={{ ...styles.title, fontSize: 18, marginBottom: 14 }}>登録済み従業員一覧</h2>
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>社員コード</th>
                  <th style={styles.th}>氏名</th>
                  <th style={styles.th}>ひらがな</th>
                  <th style={styles.th}>所属店舗</th>
                  <th style={styles.th}>雇用区分</th>
                  <th style={styles.th}>状態</th>{employeeTab === "fixed" && <><th style={styles.th}>月給・交通費・住民税</th><th style={styles.th}>自動控除（現行結果）</th><th style={styles.th}>操作</th></>}
                </tr>
              </thead>
              <tbody>
                {employees
                  .filter((employee) =>
                    employeeTab === "fixed"
                      ? isFullTimeEmployee(employee)
                      : employee.isDeleted !== true && !isFullTimeEmployee(employee)
                  )
                  .map((employee) => (
                    <tr key={employee.id}>
                      <td style={styles.td}>{employee.employeeCode}</td>
                      <td style={styles.td}>{employee.name}</td>
                      <td style={styles.td}>{employee.nameKana}</td>
                      <td style={styles.td}>{isFullTimeEmployee(employee) ? "所属なし" : employee.storeName}</td>
                      <td style={styles.td}>{employmentTypeLabels[employee.employmentType]}</td>
                      <td style={styles.td}>{statusLabels[employee.status]}</td>
                      {employeeTab === "fixed" && <><td style={styles.td}>{yen(employee.fixedBaseSalary ?? 0)}／{yen(employee.monthlyTransportation ?? 0)}／{yen(employee.residentTax ?? 0)}</td><td style={styles.td}>社保 {yen((employee.healthInsurance ?? 0)+(employee.childSupportContribution ?? 0)+(employee.careInsurance ?? 0)+(employee.employeePension ?? 0))}<br/>雇用 {yen(employee.employmentInsurance ?? 0)}／所得税 {yen(employee.incomeTax ?? 0)}</td><td style={styles.td}><button type="button" onClick={() => editFullTimePayroll(employee)} style={styles.secondaryButton}>編集</button> <button type="button" onClick={() => setFullTimeActive(employee, employee.isDeleted === true || employee.status === "inactive")} style={employee.isDeleted === true || employee.status === "inactive" ? styles.secondaryButton : styles.dangerButton}>{employee.isDeleted === true || employee.status === "inactive" ? "再有効化" : "退職・無効化"}</button></td></>}
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}

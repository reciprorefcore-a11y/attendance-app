"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { db } from "@/lib/firebase";
import { adminStyles as styles } from "@/lib/adminStyles";
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
} from "firebase/firestore";

type EmployeeRow = Employee & { id: string };
type StoreRow = Store & { id: string };
type WageInput = {
  hourlyWage: string;
  lateNightHourlyWage: string;
  dailyTransportation: string;
};

const emptyForm = {
  employeeCode: "",
  name: "",
  nameKana: "",
  storeId: "",
  employmentType: "part_time" as EmploymentType,
  pin: "", hourlyWage: "", transportationCost: "", transportationType: "none" as "daily" | "monthly" | "none", payrollEnabled: true,
  fixedBaseSalary: "", directorCompensation: "", positionAllowance: "", businessAllowance: "", holidayAllowance: "", fixedOvertimeAllowance: "",
  healthInsurance: "", childSupportContribution: "", careInsurance: "", employeePension: "", employmentInsurance: "", incomeTax: "", residentTax: "",
};

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

export default function HqEmployeesPage() {
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [stores, setStores] = useState<StoreRow[]>([]);
  const [wages, setWages] = useState<Record<string, WageInput>>({});
  const [message, setMessage] = useState("");
  const [form, setForm] = useState(emptyForm);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [employeeTab, setEmployeeTab] = useState<"hourly" | "fixed">("hourly");

  const load = async () => {
    const [employeeSnapshot, storeSnapshot] = await Promise.all([
      getDocs(query(collection(db, "employees"), orderBy("employeeCode"))),
      getDocs(query(collection(db, "stores"), orderBy("storeName"))),
    ]);
    const rows = employeeSnapshot.docs.map((employeeDoc) => ({
      id: employeeDoc.id,
      ...(employeeDoc.data() as Employee),
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

  const createEmployee = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const employeeCode = form.employeeCode.trim();
    if (!employeeCode || !form.name.trim() || !form.nameKana.trim() || (employeeTab === "hourly" && !selectedStore)) {
      setMessage(employeeTab === "hourly" ? "社員コード、氏名、ひらがな、所属店舗を入力してください。" : "社員コード、氏名、ひらがなを入力してください。");
      return;
    }

    setIsSubmitting(true);
    setMessage("");

    try {
      const duplicateSnapshot = await getDocs(
        query(
          collection(db, "employees"),
          where("employeeCode", "==", employeeCode),
        ),
      );
      if (!duplicateSnapshot.empty) {
        setMessage("同じ社員コードの従業員が既に登録されています。");
        return;
      }

      await addDoc(collection(db, "employees"), {
        employeeCode,
        name: form.name.trim(),
        nameKana: form.nameKana.trim(),
        ...(employeeTab === "hourly" && selectedStore ? { storeId: selectedStore.id, storeName: selectedStore.storeName } : {}),
        employeeType: employeeTab === "fixed" ? "fullTime" : "partTime",
        employmentType: employeeTab === "fixed" ? "full_time" : "part_time",
        payrollType: employeeTab,
        clockEnabled: employeeTab === "hourly",
        pin: employeeTab === "hourly" ? form.pin : "",
        baseWage: employeeTab === "hourly" ? Number(form.hourlyWage) || 0 : 0,
        hourlyWage: employeeTab === "hourly" ? Number(form.hourlyWage) || 0 : 0,
        transportationCost: Number(form.transportationCost) || 0,
        transportationType: form.transportationType,
        payrollEnabled: form.payrollEnabled,
        ...(employeeTab === "fixed" ? Object.fromEntries(["fixedBaseSalary","directorCompensation","positionAllowance","businessAllowance","holidayAllowance","fixedOvertimeAllowance","healthInsurance","childSupportContribution","careInsurance","employeePension","employmentInsurance","incomeTax","residentTax"].map((key) => [key, Number(form[key as keyof typeof form]) || 0])) : {}),
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      setMessage("従業員を登録しました。");
      setForm(emptyForm);
      await load();
    } finally {
      setIsSubmitting(false);
    }
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

  return (
    <main style={styles.page}>
      <div style={styles.shell}>
        <header>
          <h1 style={styles.title}>従業員管理</h1>
        </header>

        <div style={{ display: "flex", gap: 8, margin: "16px 0" }}>
          <button type="button" onClick={() => setEmployeeTab("hourly")} style={employeeTab === "hourly" ? styles.button : styles.secondaryButton}>① アルバイト</button>
          <button type="button" onClick={() => setEmployeeTab("fixed")} style={employeeTab === "fixed" ? styles.button : styles.secondaryButton}>② 正社員</button>
        </div>

        {message && <p style={styles.success}>{message}</p>}

        {employeeTab === "fixed" && (
          <section style={styles.panel}>
            <b>正社員マスター（5名）</b>
            <p style={{ margin: "8px 0" }}>0002 青山佳史／0003 中村鏡太郎／0017 木月徳子／0064 小林彗太／0083 佐藤雅信</p>
            {[{ employeeCode: "0002", name: "青山佳史" }, { employeeCode: "0017", name: "木月徳子" }].filter((candidate) => !employees.some((employee) => String(employee.employeeCode).padStart(4, "0") === candidate.employeeCode)).map((candidate) => (
              <button key={candidate.employeeCode} type="button" onClick={() => setForm({ ...emptyForm, employeeCode: candidate.employeeCode, name: candidate.name, employmentType: "full_time" })} style={{ ...styles.secondaryButton, marginRight: 8 }}>
                {candidate.employeeCode} {candidate.name}を重複確認して登録
              </button>
            ))}
          </section>
        )}

        <form style={styles.panel} onSubmit={createEmployee}>
          <h2 style={{ ...styles.title, fontSize: 18 }}>{employeeTab === "hourly" ? "アルバイト" : "正社員"}を新規登録</h2>
          <div style={{ ...styles.grid, marginTop: 14 }}>
            <label style={styles.label}>
              社員コード
              <input
                required
                value={form.employeeCode}
                onChange={(event) =>
                  setForm({ ...form, employeeCode: event.target.value })
                }
                style={styles.input}
              />
            </label>
            <label style={styles.label}>
              氏名
              <input
                required
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                style={styles.input}
              />
            </label>
            <label style={styles.label}>
              ひらがな
              <input
                required
                value={form.nameKana}
                onChange={(event) =>
                  setForm({ ...form, nameKana: event.target.value })
                }
                style={styles.input}
              />
            </label>
            {employeeTab === "hourly" && <label style={styles.label}>
              所属店舗
              <select
                required
                value={form.storeId}
                onChange={(event) =>
                  setForm({ ...form, storeId: event.target.value })
                }
                style={styles.input}
              >
                <option value="">選択してください</option>
                {stores.map((store) => (
                  <option key={store.id} value={store.id}>
                    {store.storeName}
                  </option>
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
              {[["fixedBaseSalary","基本給"],["directorCompensation","役員報酬"],["positionAllowance","職能手当"],["businessAllowance","業務手当"],["holidayAllowance","休日手当"],["fixedOvertimeAllowance","固定手当"],["healthInsurance","健康保険"],["childSupportContribution","子育て支援金"],["careInsurance","介護保険"],["employeePension","厚生年金"],["employmentInsurance","雇用保険"],["incomeTax","所得税"],["residentTax","住民税"]].map(([key,label]) => <label key={key} style={styles.label}>{label}<input type="number" value={String(form[key as keyof typeof form])} onChange={(e) => setForm({ ...form, [key]: e.target.value })} style={styles.input} /></label>)}
            </>}
            <label style={styles.label}>給与対象<select value={form.payrollEnabled ? "yes" : "no"} onChange={(e) => setForm({ ...form, payrollEnabled: e.target.value === "yes" })} style={styles.input}><option value="yes">対象</option><option value="no">対象外</option></select></label>
            {employeeTab === "hourly" && <label style={styles.label}>打刻対象<select value="yes" disabled style={styles.input}><option value="yes">対象</option></select></label>}
          </div>
          <button
            type="submit"
            disabled={isSubmitting}
            style={{ ...styles.button, marginTop: 14 }}
          >
            {isSubmitting ? "登録中" : "登録"}
          </button>
        </form>

        <section style={styles.panel}>
          <h2 style={{ ...styles.title, fontSize: 18, marginBottom: 14 }}>
            承認待ち
          </h2>
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
                    <td style={styles.td}>
                      {employmentTypeLabels[employee.employmentType]}
                    </td>
                    <td style={styles.td}>
                      <input
                        type="number"
                        value={wages[employee.id]?.hourlyWage ?? ""}
                        onChange={(event) =>
                          setWages({
                            ...wages,
                            [employee.id]: {
                              ...wages[employee.id],
                              hourlyWage: event.target.value,
                            },
                          })
                        }
                        style={{ ...styles.input, width: 100 }}
                      />
                    </td>
                    <td style={styles.td}>
                      <input
                        type="number"
                        value={wages[employee.id]?.lateNightHourlyWage ?? ""}
                        onChange={(event) =>
                          setWages({
                            ...wages,
                            [employee.id]: {
                              ...wages[employee.id],
                              lateNightHourlyWage: event.target.value,
                            },
                          })
                        }
                        style={{ ...styles.input, width: 100 }}
                      />
                    </td>
                    <td style={styles.td}>
                      <input
                        type="number"
                        value={wages[employee.id]?.dailyTransportation ?? ""}
                        onChange={(event) =>
                          setWages({
                            ...wages,
                            [employee.id]: {
                              ...wages[employee.id],
                              dailyTransportation: event.target.value,
                            },
                          })
                        }
                        style={{ ...styles.input, width: 100 }}
                      />
                    </td>
                    <td style={styles.td}>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          type="button"
                          onClick={() => approve(employee)}
                          style={styles.secondaryButton}
                        >
                          承認
                        </button>
                        <button
                          type="button"
                          onClick={() => reject(employee)}
                          style={styles.dangerButton}
                        >
                          差戻し
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section style={styles.panel}>
          <h2 style={{ ...styles.title, fontSize: 18, marginBottom: 14 }}>
            登録済み従業員一覧
          </h2>
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>社員コード</th>
                  <th style={styles.th}>氏名</th>
                  <th style={styles.th}>ひらがな</th>
                  <th style={styles.th}>所属店舗</th>
                  <th style={styles.th}>雇用区分</th>
                  <th style={styles.th}>状態</th>
                </tr>
              </thead>
              <tbody>
                {employees.filter((employee) => employeeTab === "fixed" ? employee.payrollType === "fixed" || ["0002","0003","0017","0064","0083"].includes(String(employee.employeeCode).padStart(4,"0")) : !(employee.payrollType === "fixed" || ["0002","0003","0017","0064","0083"].includes(String(employee.employeeCode).padStart(4,"0")))).map((employee) => (
                  <tr key={employee.id}>
                    <td style={styles.td}>{employee.employeeCode}</td>
                    <td style={styles.td}>{employee.name}</td>
                    <td style={styles.td}>{employee.nameKana}</td>
                    <td style={styles.td}>{employee.employeeType === "fullTime" || employee.payrollType === "fixed" ? "所属なし" : employee.storeName}</td>
                    <td style={styles.td}>
                      {employmentTypeLabels[employee.employmentType]}
                    </td>
                    <td style={styles.td}>{statusLabels[employee.status]}</td>
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

"use client";

import { useEffect, useMemo, useState } from "react";
import { db } from "@/lib/firebase";
import { adminStyles as styles } from "@/lib/adminStyles";
import { Employee, WageHistory, isWageEffective } from "@/lib/attendance";
import {
  addDoc,
  collection,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
} from "firebase/firestore";

type EmployeeRow = Employee & { id: string; wages: WageHistory[] };

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

export default function HqWagesPage() {
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [employeeId, setEmployeeId] = useState("");
  const [message, setMessage] = useState("");
  const [form, setForm] = useState({
    hourlyWage: "",
    lateNightHourlyWage: "",
    dailyTransportation: "",
    effectiveFrom: todayString(),
    effectiveTo: "",
    approvedBy: "HQ",
  });

  const load = async () => {
    const employeeSnapshot = await getDocs(
      query(collection(db, "employees"), orderBy("employeeCode")),
    );
    const rows = await Promise.all(
      employeeSnapshot.docs.map(async (employeeDoc) => {
        const wageSnapshot = await getDocs(
          query(
            collection(db, "employees", employeeDoc.id, "wageHistory"),
            orderBy("effectiveFrom", "desc"),
          ),
        );
        return {
          id: employeeDoc.id,
          ...(employeeDoc.data() as Employee),
          wages: wageSnapshot.docs.map((wageDoc) => wageDoc.data() as WageHistory),
        };
      }),
    );
    setEmployees(rows);
    if (!employeeId && rows[0]) setEmployeeId(rows[0].id);
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedEmployee = useMemo(
    () => employees.find((employee) => employee.id === employeeId) ?? null,
    [employeeId, employees],
  );

  const addHistory = async () => {
    if (!selectedEmployee) return;
    const hourlyWage = Number(form.hourlyWage);
    const lateNightHourlyWage = Number(form.lateNightHourlyWage);
    const dailyTransportation = Number(form.dailyTransportation);

    if (!hourlyWage || !lateNightHourlyWage || Number.isNaN(dailyTransportation)) {
      setMessage("通常時給、深夜時給、日交通費を入力してください。");
      return;
    }

    await addDoc(collection(db, "employees", selectedEmployee.id, "wageHistory"), {
      hourlyWage,
      lateNightHourlyWage,
      dailyTransportation,
      effectiveFrom: form.effectiveFrom,
      effectiveTo: form.effectiveTo || null,
      approvedAt: serverTimestamp(),
      approvedBy: form.approvedBy.trim() || "HQ",
    });

    setMessage("履歴を追加しました。");
    setForm({
      hourlyWage: "",
      lateNightHourlyWage: "",
      dailyTransportation: "",
      effectiveFrom: todayString(),
      effectiveTo: "",
      approvedBy: "HQ",
    });
    await load();
  };

  return (
    <main style={styles.page}>
      <div style={styles.shell}>
        <header>
          <h1 style={styles.title}>時給管理</h1>
        </header>

        <section style={styles.panel}>
          <label style={styles.label}>
            従業員
            <select
              value={employeeId}
              onChange={(event) => setEmployeeId(event.target.value)}
              style={styles.input}
            >
              {employees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.employeeCode} {employee.name}
                </option>
              ))}
            </select>
          </label>
        </section>

        <section style={styles.panel}>
          <h2 style={{ ...styles.title, fontSize: 18 }}>履歴追加</h2>
          <div style={{ ...styles.grid, marginTop: 14 }}>
            <label style={styles.label}>
              通常時給
              <input
                type="number"
                value={form.hourlyWage}
                onChange={(event) =>
                  setForm({ ...form, hourlyWage: event.target.value })
                }
                style={styles.input}
              />
            </label>
            <label style={styles.label}>
              深夜時給
              <input
                type="number"
                value={form.lateNightHourlyWage}
                onChange={(event) =>
                  setForm({ ...form, lateNightHourlyWage: event.target.value })
                }
                style={styles.input}
              />
            </label>
            <label style={styles.label}>
              日交通費
              <input
                type="number"
                value={form.dailyTransportation}
                onChange={(event) =>
                  setForm({ ...form, dailyTransportation: event.target.value })
                }
                style={styles.input}
              />
            </label>
            <label style={styles.label}>
              適用開始日
              <input
                type="date"
                value={form.effectiveFrom}
                onChange={(event) =>
                  setForm({ ...form, effectiveFrom: event.target.value })
                }
                style={styles.input}
              />
            </label>
            <label style={styles.label}>
              適用終了日
              <input
                type="date"
                value={form.effectiveTo}
                onChange={(event) =>
                  setForm({ ...form, effectiveTo: event.target.value })
                }
                style={styles.input}
              />
            </label>
            <label style={styles.label}>
              approvedBy
              <input
                value={form.approvedBy}
                onChange={(event) =>
                  setForm({ ...form, approvedBy: event.target.value })
                }
                style={styles.input}
              />
            </label>
          </div>
          {message && <p style={styles.success}>{message}</p>}
          <button
            type="button"
            onClick={addHistory}
            style={{ ...styles.button, marginTop: 14 }}
          >
            履歴追加
          </button>
        </section>

        {selectedEmployee && (
          <section style={styles.panel}>
            <h2 style={{ ...styles.title, fontSize: 18 }}>
              {selectedEmployee.name} 時給履歴
            </h2>
            <div style={styles.tableWrap}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>通常時給</th>
                    <th style={styles.th}>深夜時給</th>
                    <th style={styles.th}>日交通費</th>
                    <th style={styles.th}>適用開始日</th>
                    <th style={styles.th}>適用終了日</th>
                    <th style={styles.th}>状態</th>
                    <th style={styles.th}>承認者</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedEmployee.wages.map((wage, index) => (
                    <tr key={`${wage.effectiveFrom}-${index}`}>
                      <td style={styles.td}>{wage.hourlyWage}</td>
                      <td style={styles.td}>{wage.lateNightHourlyWage}</td>
                      <td style={styles.td}>{wage.dailyTransportation}</td>
                      <td style={styles.td}>{wage.effectiveFrom}</td>
                      <td style={styles.td}>{wage.effectiveTo ?? ""}</td>
                      <td style={styles.td}>
                        {isWageEffective(wage, todayString()) ? "有効" : ""}
                      </td>
                      <td style={styles.td}>{wage.approvedBy}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

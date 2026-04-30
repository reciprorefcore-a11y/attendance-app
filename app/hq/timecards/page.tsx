"use client";

import { useEffect, useMemo, useState } from "react";
import { db } from "@/lib/firebase";
import { adminStyles as styles } from "@/lib/adminStyles";
import {
  ClockType,
  Employee,
  Store,
  Timecard,
  buildDailyAttendance,
  clockOptions,
  formatClockTime,
  formatHours,
  normalizeClockType,
  toDateTimeInputValue,
} from "@/lib/attendance";
import {
  Timestamp,
  collection,
  doc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
} from "firebase/firestore";

type StoreRow = Store & { id: string };
type EmployeeRow = Employee & { id: string };
type TimecardRow = Timecard & { id: string };

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

export default function HqTimecardsPage() {
  const [stores, setStores] = useState<StoreRow[]>([]);
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [timecards, setTimecards] = useState<TimecardRow[]>([]);
  const [targetMonth, setTargetMonth] = useState(currentMonth());
  const [storeId, setStoreId] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [editId, setEditId] = useState("");
  const [message, setMessage] = useState("");
  const [editForm, setEditForm] = useState({
    type: "clock_in" as ClockType,
    createdAt: "",
    editedBy: "HQ",
    editReason: "",
  });

  const load = async () => {
    const [storeSnapshot, employeeSnapshot, timecardSnapshot] =
      await Promise.all([
        getDocs(query(collection(db, "stores"), orderBy("storeName"))),
        getDocs(query(collection(db, "employees"), orderBy("employeeCode"))),
        getDocs(query(collection(db, "timecards"), orderBy("createdAt", "desc"))),
      ]);

    setStores(
      storeSnapshot.docs.map((storeDoc) => ({
        id: storeDoc.id,
        ...(storeDoc.data() as Store),
      })),
    );
    setEmployees(
      employeeSnapshot.docs.map((employeeDoc) => ({
        id: employeeDoc.id,
        ...(employeeDoc.data() as Employee),
      })),
    );
    setTimecards(
      timecardSnapshot.docs.map((timecardDoc) => ({
        id: timecardDoc.id,
        ...(timecardDoc.data() as Timecard),
      })),
    );
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, []);

  const filteredEmployees = useMemo(
    () =>
      employees.filter((employee) => !storeId || employee.storeId === storeId),
    [employees, storeId],
  );

  const filteredTimecards = useMemo(() => {
    return timecards.filter((timecard) => {
      const date = timecard.createdAt?.toDate();
      if (!date) return false;
      if (!date.toISOString().startsWith(targetMonth)) return false;
      if (storeId && timecard.storeId !== storeId) return false;
      if (employeeId) {
        const employee = employees.find((item) => item.id === employeeId);
        if (!employee) return false;
        return (
          timecard.employeeId === employee.id ||
          timecard.employeeCode === employee.employeeCode
        );
      }
      return true;
    });
  }, [employeeId, employees, storeId, targetMonth, timecards]);

  const dailyRows = useMemo(
    () => buildDailyAttendance(filteredTimecards),
    [filteredTimecards],
  );

  const editTarget = timecards.find((timecard) => timecard.id === editId) ?? null;

  const startEdit = (timecard: TimecardRow) => {
    setEditId(timecard.id);
    setMessage("");
    setEditForm({
      type: normalizeClockType(timecard.type),
      createdAt: toDateTimeInputValue(timecard.createdAt.toDate()),
      editedBy: "HQ",
      editReason: "",
    });
  };

  const saveEdit = async () => {
    if (!editTarget) return;
    if (!editForm.editReason.trim()) {
      setMessage("修正理由を入力してください。");
      return;
    }

    await updateDoc(doc(db, "timecards", editTarget.id), {
      type: editForm.type,
      createdAt: Timestamp.fromDate(new Date(editForm.createdAt)),
      isManualEdited: true,
      editedBy: editForm.editedBy.trim() || "HQ",
      editedAt: serverTimestamp(),
      editReason: editForm.editReason.trim(),
    });
    setMessage("修正しました。");
    setEditId("");
    await load();
  };

  return (
    <main style={styles.page}>
      <div style={styles.shell}>
        <header>
          <h1 style={styles.title}>勤怠一覧・修正</h1>
        </header>

        <section style={styles.panel}>
          <div style={styles.grid}>
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
                value={storeId}
                onChange={(event) => {
                  setStoreId(event.target.value);
                  setEmployeeId("");
                }}
                style={styles.input}
              >
                <option value="">全店舗</option>
                {stores.map((store) => (
                  <option key={store.id} value={store.id}>
                    {store.storeName}
                  </option>
                ))}
              </select>
            </label>
            <label style={styles.label}>
              従業員
              <select
                value={employeeId}
                onChange={(event) => setEmployeeId(event.target.value)}
                style={styles.input}
              >
                <option value="">全従業員</option>
                {filteredEmployees.map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.employeeCode} {employee.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>

        <section style={styles.panel}>
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>日付</th>
                  <th style={styles.th}>店舗</th>
                  <th style={styles.th}>従業員</th>
                  <th style={styles.th}>出勤</th>
                  <th style={styles.th}>退勤</th>
                  <th style={styles.th}>休憩</th>
                  <th style={styles.th}>労働時間</th>
                  <th style={styles.th}>深夜時間</th>
                  <th style={styles.th}>GPS距離</th>
                  <th style={styles.th}>修正</th>
                </tr>
              </thead>
              <tbody>
                {dailyRows.map((row) => (
                  <tr key={`${row.date}-${row.employeeCode}`}>
                    <td style={styles.td}>{row.date}</td>
                    <td style={styles.td}>{row.storeName}</td>
                    <td style={styles.td}>
                      {row.employeeCode} {row.employeeName}
                    </td>
                    <td style={styles.td}>{formatClockTime(row.clockIn)}</td>
                    <td style={styles.td}>{formatClockTime(row.clockOut)}</td>
                    <td style={styles.td}>{formatHours(row.breakMinutes)}</td>
                    <td style={styles.td}>{formatHours(row.workMinutes)}</td>
                    <td style={styles.td}>{formatHours(row.nightMinutes)}</td>
                    <td style={styles.td}>
                      {row.gpsDistanceMeter === null
                        ? ""
                        : `${Math.round(row.gpsDistanceMeter)}m`}
                    </td>
                    <td style={styles.td}>
                      <button
                        type="button"
                        style={styles.secondaryButton}
                        onClick={() => startEdit(row.timecards[0])}
                      >
                        修正
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {editTarget && (
          <section style={styles.panel}>
            <h2 style={{ ...styles.title, fontSize: 18 }}>勤怠修正</h2>
            <div style={{ ...styles.grid, marginTop: 14 }}>
              <label style={styles.label}>
                打刻種別
                <select
                  value={editForm.type}
                  onChange={(event) =>
                    setEditForm({ ...editForm, type: event.target.value as ClockType })
                  }
                  style={styles.input}
                >
                  {clockOptions.map(({ value, label }) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label style={styles.label}>
                打刻日時
                <input
                  type="datetime-local"
                  value={editForm.createdAt}
                  onChange={(event) =>
                    setEditForm({ ...editForm, createdAt: event.target.value })
                  }
                  style={styles.input}
                />
              </label>
              <label style={styles.label}>
                editedBy
                <input
                  value={editForm.editedBy}
                  onChange={(event) =>
                    setEditForm({ ...editForm, editedBy: event.target.value })
                  }
                  style={styles.input}
                />
              </label>
            </div>
            <label style={{ ...styles.label, marginTop: 14 }}>
              修正理由
              <textarea
                value={editForm.editReason}
                onChange={(event) =>
                  setEditForm({ ...editForm, editReason: event.target.value })
                }
                style={styles.textarea}
              />
            </label>
            {message && <p style={styles.alert}>{message}</p>}
            <button
              type="button"
              onClick={saveEdit}
              style={{ ...styles.button, marginTop: 14 }}
            >
              保存
            </button>
          </section>
        )}
      </div>
    </main>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";
import { db } from "@/lib/firebase";
import { adminStyles as styles } from "@/lib/adminStyles";
import {
  Employee,
  Store,
  Timecard,
  WageHistory,
  buildDailyAttendance,
  formatClockTime,
  formatHours,
  getMonthDays,
  isWageEffective,
} from "@/lib/attendance";
import { collection, getDocs, orderBy, query } from "firebase/firestore";
import * as XLSX from "xlsx";

type StoreRow = Store & { id: string };
type EmployeeRow = Employee & { id: string; wages: WageHistory[] };
type TimecardRow = Timecard & { id: string };

const headers = [
  "所属店舗ｺｰﾄﾞ",
  "所属店舗名",
  "社員ｺｰﾄﾞ",
  "氏名",
  "日付",
  "出勤",
  "退勤",
  "労働時間",
  "加算帯1",
  "加算帯2",
  "加算帯3",
  "超過時間",
  "深夜時間",
  "休憩時間",
  "ﾍﾙﾌﾟ時間",
  "休出時間",
  "勤務区分",
  "時間手当",
  "その他手当1",
  "その他手当2",
  "日交通費",
  "定期代",
  "食事代",
  "靴代",
  "駐車場代",
  "ユニフォーム",
  "その他",
];

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function monthTitle(targetMonth: string) {
  const [year, month] = targetMonth.split("-");
  return `${Number(year)}.${Number(month)}`;
}

function monthLabel(targetMonth: string) {
  const [year, month] = targetMonth.split("-");
  return `${year}年${month}月`;
}

export default function HqExportPage() {
  const [stores, setStores] = useState<StoreRow[]>([]);
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [timecards, setTimecards] = useState<TimecardRow[]>([]);
  const [targetMonth, setTargetMonth] = useState(currentMonth());
  const [storeId, setStoreId] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const load = async () => {
      const [storeSnapshot, employeeSnapshot, timecardSnapshot] =
        await Promise.all([
          getDocs(query(collection(db, "stores"), orderBy("storeName"))),
          getDocs(query(collection(db, "employees"), orderBy("employeeCode"))),
          getDocs(query(collection(db, "timecards"), orderBy("createdAt"))),
        ]);

      setStores(
        storeSnapshot.docs.map((storeDoc) => ({
          id: storeDoc.id,
          ...(storeDoc.data() as Store),
        })),
      );

      const employeeRows = await Promise.all(
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
            wages: wageSnapshot.docs.map(
              (wageDoc) => wageDoc.data() as WageHistory,
            ),
          };
        }),
      );

      setEmployees(employeeRows);
      setTimecards(
        timecardSnapshot.docs.map((timecardDoc) => ({
          id: timecardDoc.id,
          ...(timecardDoc.data() as Timecard),
        })),
      );
    };

    load();
  }, []);

  const filteredEmployees = useMemo(() => {
    return employees.filter((employee) => {
      if (employee.status !== "active") return false;
      if (storeId && employee.storeId !== storeId) return false;
      if (employeeId && employee.id !== employeeId) return false;
      return true;
    });
  }, [employeeId, employees, storeId]);

  const handleExport = () => {
    if (filteredEmployees.length === 0) {
      setMessage("出力対象の従業員がいません。");
      return;
    }

    const workbook = XLSX.utils.book_new();
    const days = getMonthDays(targetMonth);

    for (const employee of filteredEmployees) {
      const store = stores.find((item) => item.id === employee.storeId);
      const employeeTimecards = timecards.filter((timecard) => {
        const createdAt = timecard.createdAt?.toDate();
        if (!createdAt) return false;
        return (
          createdAt.toISOString().startsWith(targetMonth) &&
          (timecard.employeeId === employee.id ||
            timecard.employeeCode === employee.employeeCode)
        );
      });
      const dailyRows = buildDailyAttendance(employeeTimecards);
      let totalWork = 0;
      let totalNight = 0;
      let totalBreak = 0;

      const rows: (string | number)[][] = [
        [`${monthTitle(targetMonth)} ${employee.name} 勤怠`],
        [`対象年月：${monthLabel(targetMonth)}`],
        headers,
      ];

      for (const day of days) {
        const attendance = dailyRows.find((row) => row.date === day);
        const wage =
          employee.wages.find((item) => isWageEffective(item, day)) ?? null;

        if (attendance) {
          totalWork += attendance.workMinutes;
          totalNight += attendance.nightMinutes;
          totalBreak += attendance.breakMinutes;
        }

        rows.push([
          store?.storeCode ?? "",
          employee.storeName,
          employee.employeeCode,
          employee.name,
          day.replaceAll("-", "/"),
          attendance ? formatClockTime(attendance.clockIn) : "",
          attendance ? formatClockTime(attendance.clockOut) : "",
          attendance ? formatHours(attendance.workMinutes) : "",
          "",
          "",
          "",
          "",
          attendance ? formatHours(attendance.nightMinutes) : "",
          attendance ? formatHours(attendance.breakMinutes) : "",
          attendance ? formatHours(attendance.workMinutes) : "",
          "",
          attendance ? "通常" : "",
          "",
          "",
          "",
          attendance && wage ? wage.dailyTransportation : "",
          "",
          "",
          "",
          "",
          "",
          "",
        ]);
      }

      rows.push([
        "",
        "",
        "",
        "合計",
        "",
        "",
        "",
        formatHours(totalWork),
        "",
        "",
        "",
        "",
        formatHours(totalNight),
        formatHours(totalBreak),
        formatHours(totalWork),
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
      ]);

      const worksheet = XLSX.utils.aoa_to_sheet(rows);
      worksheet["!cols"] = headers.map(() => ({ wch: 14 }));
      XLSX.utils.book_append_sheet(
        workbook,
        worksheet,
        `${employee.employeeCode}_${employee.name}`.slice(0, 31),
      );
    }

    XLSX.writeFile(workbook, `勤怠_${targetMonth}.xlsx`);
    setMessage("Excel出力しました。");
  };

  return (
    <main style={styles.page}>
      <div style={styles.shell}>
        <header>
          <h1 style={styles.title}>Excel出力</h1>
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
                {employees
                  .filter((employee) => !storeId || employee.storeId === storeId)
                  .map((employee) => (
                    <option key={employee.id} value={employee.id}>
                      {employee.employeeCode} {employee.name}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          {message && <p style={styles.success}>{message}</p>}
          <button
            type="button"
            onClick={handleExport}
            style={{ ...styles.button, marginTop: 14 }}
          >
            Excel出力
          </button>
        </section>

        <section style={styles.panel}>
          <p style={styles.subtitle}>出力対象 {filteredEmployees.length} 名</p>
        </section>
      </div>
    </main>
  );
}

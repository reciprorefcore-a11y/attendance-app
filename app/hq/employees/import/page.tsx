"use client";

import { ChangeEvent, useMemo, useState } from "react";
import { db } from "@/lib/firebase";
import { adminStyles as styles } from "@/lib/adminStyles";
import { EmploymentType, EmployeeStatus } from "@/lib/attendance";
import {
  addDoc,
  collection,
  getDocs,
  query,
  serverTimestamp,
  where,
} from "firebase/firestore";

type CsvRow = {
  employeeCode: string;
  name: string;
  nameKana: string;
  storeId: string;
  storeName: string;
  employmentType: EmploymentType | "";
  hourlyWage: string;
  lateNightHourlyWage: string;
  dailyTransportation: string;
  effectiveFrom: string;
  status: EmployeeStatus | "";
  errors: string[];
};

const requiredHeaders = [
  "employeeCode",
  "name",
  "nameKana",
  "storeId",
  "storeName",
  "employmentType",
  "hourlyWage",
  "lateNightHourlyWage",
  "dailyTransportation",
  "effectiveFrom",
  "status",
];

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

function parseCsv(text: string) {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim());
  const headers = parseCsvLine(lines[0] ?? "");
  const missingHeaders = requiredHeaders.filter(
    (header) => !headers.includes(header),
  );

  if (missingHeaders.length > 0) {
    throw new Error(`CSV列が不足しています: ${missingHeaders.join(", ")}`);
  }

  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(
      headers.map((header, index) => [header, values[index] ?? ""]),
    );
  });
}

function validateRow(row: Record<string, string>, duplicateInCsv: boolean) {
  const errors: string[] = [];
  const employmentType = row.employmentType as EmploymentType;
  const status = row.status as EmployeeStatus;

  for (const header of requiredHeaders) {
    if (!row[header]?.trim()) {
      errors.push(`${header} が空です`);
    }
  }

  if (!["part_time", "full_time"].includes(row.employmentType)) {
    errors.push("employmentType は part_time または full_time");
  }
  if (row.status !== "active") {
    errors.push("既存スタッフ取込では status は active のみ");
  }
  if (Number.isNaN(Number(row.hourlyWage)) || Number(row.hourlyWage) <= 0) {
    errors.push("hourlyWage が不正です");
  }
  if (
    Number.isNaN(Number(row.lateNightHourlyWage)) ||
    Number(row.lateNightHourlyWage) <= 0
  ) {
    errors.push("lateNightHourlyWage が不正です");
  }
  if (Number.isNaN(Number(row.dailyTransportation))) {
    errors.push("dailyTransportation が不正です");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.effectiveFrom)) {
    errors.push("effectiveFrom は YYYY-MM-DD 形式");
  }
  if (duplicateInCsv) {
    errors.push("CSV内で employeeCode が重複しています");
  }

  return {
    employeeCode: row.employeeCode,
    name: row.name,
    nameKana: row.nameKana,
    storeId: row.storeId,
    storeName: row.storeName,
    employmentType: ["part_time", "full_time"].includes(row.employmentType)
      ? employmentType
      : "",
    hourlyWage: row.hourlyWage,
    lateNightHourlyWage: row.lateNightHourlyWage,
    dailyTransportation: row.dailyTransportation,
    effectiveFrom: row.effectiveFrom,
    status: row.status === "active" ? status : "",
    errors,
  } satisfies CsvRow;
}

export default function EmployeeImportPage() {
  const [rows, setRows] = useState<CsvRow[]>([]);
  const [message, setMessage] = useState("");
  const [isImporting, setIsImporting] = useState(false);

  const hasErrors = useMemo(
    () => rows.some((row) => row.errors.length > 0),
    [rows],
  );

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setMessage("");

    try {
      const text = await file.text();
      const rawRows = parseCsv(text);
      const counts = new Map<string, number>();
      for (const row of rawRows) {
        counts.set(row.employeeCode, (counts.get(row.employeeCode) ?? 0) + 1);
      }

      const validatedRows = rawRows.map((row) =>
        validateRow(row, (counts.get(row.employeeCode) ?? 0) > 1),
      );

      const existingChecks = await Promise.all(
        validatedRows.map(async (row) => {
          if (!row.employeeCode) return false;
          const snapshot = await getDocs(
            query(
              collection(db, "employees"),
              where("employeeCode", "==", row.employeeCode),
            ),
          );
          return !snapshot.empty;
        }),
      );

      setRows(
        validatedRows.map((row, index) => ({
          ...row,
          errors: existingChecks[index]
            ? [...row.errors, "employeeCode は登録済みです"]
            : row.errors,
        })),
      );
    } catch (error) {
      setRows([]);
      setMessage(error instanceof Error ? error.message : "CSV読込に失敗しました。");
    }
  };

  const handleImport = async () => {
    if (hasErrors || rows.length === 0) return;

    setIsImporting(true);
    setMessage("");

    try {
      for (const row of rows) {
        const employeeRef = await addDoc(collection(db, "employees"), {
          employeeCode: row.employeeCode,
          name: row.name,
          nameKana: row.nameKana,
          storeId: row.storeId,
          storeName: row.storeName,
          employmentType: row.employmentType,
          status: "active",
          approvedAt: serverTimestamp(),
          approvedBy: "HQ_IMPORT",
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        await addDoc(collection(employeeRef, "wageHistory"), {
          hourlyWage: Number(row.hourlyWage),
          lateNightHourlyWage: Number(row.lateNightHourlyWage),
          dailyTransportation: Number(row.dailyTransportation),
          effectiveFrom: row.effectiveFrom,
          effectiveTo: null,
          approvedAt: serverTimestamp(),
          approvedBy: "HQ_IMPORT",
        });
      }

      setMessage(`${rows.length}件を登録しました。`);
      setRows([]);
    } catch {
      setMessage("登録に失敗しました。");
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <main style={styles.page}>
      <div style={styles.shell}>
        <header>
          <h1 style={styles.title}>既存スタッフCSV取込</h1>
        </header>

        <section style={styles.panel}>
          <label style={styles.label}>
            CSVアップロード
            <input type="file" accept=".csv,text/csv" onChange={handleFile} />
          </label>
          {message && <p style={message.includes("登録") ? styles.success : styles.alert}>{message}</p>}
          <button
            type="button"
            disabled={hasErrors || rows.length === 0 || isImporting}
            onClick={handleImport}
            style={{
              ...styles.button,
              marginTop: 14,
              background:
                hasErrors || rows.length === 0 || isImporting ? "#9ca3af" : "#53C1ED",
            }}
          >
            {isImporting ? "登録中" : "登録実行"}
          </button>
        </section>

        {rows.length > 0 && (
          <section style={styles.panel}>
            <h2 style={{ ...styles.title, fontSize: 18 }}>プレビュー</h2>
            {hasErrors && (
              <p style={styles.alert}>エラー行があります。修正後に再アップロードしてください。</p>
            )}
            <div style={styles.tableWrap}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>行</th>
                    {requiredHeaders.map((header) => (
                      <th key={header} style={styles.th}>
                        {header}
                      </th>
                    ))}
                    <th style={styles.th}>エラー</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr
                      key={`${row.employeeCode}-${index}`}
                      style={{
                        background: row.errors.length > 0 ? "#fef2f2" : "#ffffff",
                      }}
                    >
                      <td style={styles.td}>{index + 2}</td>
                      <td style={styles.td}>{row.employeeCode}</td>
                      <td style={styles.td}>{row.name}</td>
                      <td style={styles.td}>{row.nameKana}</td>
                      <td style={styles.td}>{row.storeId}</td>
                      <td style={styles.td}>{row.storeName}</td>
                      <td style={styles.td}>{row.employmentType}</td>
                      <td style={styles.td}>{row.hourlyWage}</td>
                      <td style={styles.td}>{row.lateNightHourlyWage}</td>
                      <td style={styles.td}>{row.dailyTransportation}</td>
                      <td style={styles.td}>{row.effectiveFrom}</td>
                      <td style={styles.td}>{row.status}</td>
                      <td style={styles.td}>{row.errors.join(" / ")}</td>
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

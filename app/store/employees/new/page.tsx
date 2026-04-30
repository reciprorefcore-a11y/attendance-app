"use client";

import { FormEvent, useEffect, useState } from "react";
import { db } from "@/lib/firebase";
import { adminStyles as styles } from "@/lib/adminStyles";
import { EmploymentType, Store, employmentTypeLabels } from "@/lib/attendance";
import {
  addDoc,
  collection,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
} from "firebase/firestore";

type StoreOption = Store & { id: string };

export default function StoreEmployeeNewPage() {
  const [stores, setStores] = useState<StoreOption[]>([]);
  const [message, setMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [form, setForm] = useState({
    name: "",
    nameKana: "",
    employeeCode: "",
    storeId: "",
    employmentType: "part_time" as EmploymentType,
    phone: "",
    memo: "",
  });

  useEffect(() => {
    const loadStores = async () => {
      const snapshot = await getDocs(
        query(collection(db, "stores"), orderBy("storeName")),
      );
      setStores(
        snapshot.docs.map((storeDoc) => ({
          id: storeDoc.id,
          ...(storeDoc.data() as Store),
        })),
      );
    };

    loadStores();
  }, []);

  const selectedStore = stores.find((store) => store.id === form.storeId);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedStore) return;

    setIsSubmitting(true);
    setMessage("");

    try {
      await addDoc(collection(db, "employees"), {
        employeeCode: form.employeeCode.trim(),
        name: form.name.trim(),
        nameKana: form.nameKana.trim(),
        storeId: selectedStore.id,
        storeName: selectedStore.storeName,
        employmentType: form.employmentType,
        status: "pending",
        createdByStoreId: selectedStore.id,
        approvedBy: null,
        approvedAt: null,
        phone: form.phone.trim(),
        memo: form.memo.trim(),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      setMessage("登録申請を送信しました。本部承認後に打刻できます。");
      setForm({
        name: "",
        nameKana: "",
        employeeCode: "",
        storeId: form.storeId,
        employmentType: "part_time",
        phone: "",
        memo: "",
      });
    } catch {
      setMessage("登録申請に失敗しました。");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main style={styles.page}>
      <div style={styles.shell}>
        <header>
          <h1 style={styles.title}>従業員 新規登録申請</h1>
          <p style={styles.subtitle}>
            店舗では時給を確定せず、承認待ちとして本部へ申請します。
          </p>
        </header>

        <form style={styles.panel} onSubmit={handleSubmit}>
          <div style={styles.grid}>
            <label style={styles.label}>
              名前
              <input
                required
                value={form.name}
                onChange={(event) =>
                  setForm({ ...form, name: event.target.value })
                }
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
            </label>

            <label style={styles.label}>
              雇用区分
              <select
                value={form.employmentType}
                onChange={(event) =>
                  setForm({
                    ...form,
                    employmentType: event.target.value as EmploymentType,
                  })
                }
                style={styles.input}
              >
                {Object.entries(employmentTypeLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>

            <label style={styles.label}>
              電話番号 任意
              <input
                value={form.phone}
                onChange={(event) =>
                  setForm({ ...form, phone: event.target.value })
                }
                style={styles.input}
              />
            </label>
          </div>

          <label style={{ ...styles.label, marginTop: 14 }}>
            メモ 任意
            <textarea
              value={form.memo}
              onChange={(event) =>
                setForm({ ...form, memo: event.target.value })
              }
              style={styles.textarea}
            />
          </label>

          {message && (
            <p style={message.includes("送信") ? styles.success : styles.alert}>
              {message}
            </p>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            style={{ ...styles.button, marginTop: 14 }}
          >
            {isSubmitting ? "送信中" : "登録申請"}
          </button>
        </form>
      </div>
    </main>
  );
}

"use client";

import { ChangeEvent, FormEvent, useEffect, useState } from "react";
import { db, storage } from "@/lib/firebase";
import { adminStyles as styles } from "@/lib/adminStyles";
import { Store } from "@/lib/attendance";
import {
  addDoc,
  collection,
  doc,
  getDocs,
  orderBy,
  query,
  updateDoc,
} from "firebase/firestore";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";

type StoreRow = Store & { id: string };
type UploadState = Record<string, boolean>;

const supportedImageTypes = ["image/png", "image/jpeg", "image/webp"];

const emptyForm = {
  storeCode: "",
  storeName: "",
  logoUrl: "",
  lat: "",
  lng: "",
  radiusMeter: "100",
  helpHourlyWage: "",
  isActive: true,
};

export default function HqStoresPage() {
  const [stores, setStores] = useState<StoreRow[]>([]);
  const [editingId, setEditingId] = useState("");
  const [message, setMessage] = useState("");
  const [uploading, setUploading] = useState<UploadState>({});
  const [form, setForm] = useState(emptyForm);

  const load = async () => {
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

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, []);

  const startEdit = (store: StoreRow) => {
    setEditingId(store.id);
    setMessage("");
    setForm({
      storeCode: store.storeCode,
      storeName: store.storeName,
      logoUrl: store.logoUrl ?? "",
      lat: String(store.lat),
      lng: String(store.lng),
      radiusMeter: String(store.radiusMeter),
      helpHourlyWage: store.helpHourlyWage ? String(store.helpHourlyWage) : "",
      isActive: store.isActive !== false,
    });
  };

  const reset = () => {
    setEditingId("");
    setForm(emptyForm);
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const lat = Number(form.lat);
    const lng = Number(form.lng);
    const radiusMeter = Number(form.radiusMeter);
    const helpHourlyWage = form.helpHourlyWage.trim()
      ? Number(form.helpHourlyWage)
      : null;

    if (
      !form.storeCode.trim() ||
      !form.storeName.trim() ||
      Number.isNaN(lat) ||
      Number.isNaN(lng) ||
      Number.isNaN(radiusMeter) ||
      radiusMeter <= 0 ||
      (helpHourlyWage !== null && (Number.isNaN(helpHourlyWage) || helpHourlyWage <= 0))
    ) {
      setMessage("店舗コード、店舗名、緯度、経度、GPS範囲、ヘルプ時給を正しく入力してください。");
      return;
    }

    const payload = {
      storeCode: form.storeCode.trim(),
      storeName: form.storeName.trim(),
      logoUrl: form.logoUrl.trim(),
      lat,
      lng,
      radiusMeter,
      helpHourlyWage,
      isActive: form.isActive,
    };

    if (editingId) {
      await updateDoc(doc(db, "stores", editingId), payload);
      setMessage("店舗を更新しました。");
    } else {
      await addDoc(collection(db, "stores"), payload);
      setMessage("店舗を追加しました。");
    }

    reset();
    await load();
  };

  const uploadStoreLogo = async (storeId: string, file: File) => {
    if (!file.type.startsWith("image/") || !supportedImageTypes.includes(file.type)) {
      throw new Error("png、jpg、jpeg、webp の画像ファイルを選択してください。");
    }

    if (file.size > 2 * 1024 * 1024) {
      throw new Error("画像サイズは2MB以下にしてください。");
    }

    const storageRef = ref(storage, `stores/${storeId}/logo.png`);
    await uploadBytes(storageRef, file, { contentType: file.type });
    const logoUrl = await getDownloadURL(storageRef);

    await updateDoc(doc(db, "stores", storeId), {
      logoUrl,
      updatedAt: new Date(),
    });

    return logoUrl;
  };

  const handleLogoFile = async (
    storeId: string,
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setMessage("");
    setUploading((current) => ({ ...current, [storeId]: true }));

    try {
      await uploadStoreLogo(storeId, file);
      setMessage("ロゴを更新しました。");
      await load();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "ロゴのアップロードに失敗しました。",
      );
    } finally {
      setUploading((current) => ({ ...current, [storeId]: false }));
    }
  };

  return (
    <main style={styles.page}>
      <div style={styles.shell}>
        <header>
          <h1 style={styles.title}>店舗管理</h1>
        </header>

        <form style={styles.panel} onSubmit={save}>
          <h2 style={{ ...styles.title, fontSize: 18 }}>
            {editingId ? "店舗編集" : "店舗追加"}
          </h2>
          <div style={{ ...styles.grid, marginTop: 14 }}>
            <label style={styles.label}>
              店舗コード
              <input
                required
                value={form.storeCode}
                onChange={(event) =>
                  setForm({ ...form, storeCode: event.target.value })
                }
                style={styles.input}
              />
            </label>
            <label style={styles.label}>
              店舗名
              <input
                required
                value={form.storeName}
                onChange={(event) =>
                  setForm({ ...form, storeName: event.target.value })
                }
                style={styles.input}
              />
            </label>
            <label style={styles.label}>
              ロゴURL
              <input
                value={form.logoUrl}
                onChange={(event) =>
                  setForm({ ...form, logoUrl: event.target.value })
                }
                style={styles.input}
              />
            </label>
            <label style={styles.label}>
              緯度
              <input
                required
                type="number"
                step="any"
                value={form.lat}
                onChange={(event) => setForm({ ...form, lat: event.target.value })}
                style={styles.input}
              />
            </label>
            <label style={styles.label}>
              経度
              <input
                required
                type="number"
                step="any"
                value={form.lng}
                onChange={(event) => setForm({ ...form, lng: event.target.value })}
                style={styles.input}
              />
            </label>
            <label style={styles.label}>
              GPS範囲 m
              <input
                required
                type="number"
                min="1"
                value={form.radiusMeter}
                onChange={(event) =>
                  setForm({ ...form, radiusMeter: event.target.value })
                }
                style={styles.input}
              />
            </label>
            <label style={styles.label}>
              ヘルプ時給
              <input
                type="number"
                min="1"
                value={form.helpHourlyWage}
                onChange={(event) =>
                  setForm({ ...form, helpHourlyWage: event.target.value })
                }
                placeholder="未設定"
                style={styles.input}
              />
            </label>
            <label style={{ ...styles.label, flexDirection: "row", alignItems: "center" }}>
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(event) =>
                  setForm({ ...form, isActive: event.target.checked })
                }
              />
              有効
            </label>
          </div>
          {message && (
            <p style={message.includes("正しく") ? styles.alert : styles.success}>
              {message}
            </p>
          )}
          <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
            <button type="submit" style={styles.button}>
              {editingId ? "更新" : "追加"}
            </button>
            {editingId && (
              <button type="button" onClick={reset} style={styles.secondaryButton}>
                キャンセル
              </button>
            )}
          </div>
        </form>

        <section style={styles.panel}>
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>ロゴ</th>
                  <th style={styles.th}>店舗コード</th>
                  <th style={styles.th}>店舗名</th>
                  <th style={styles.th}>緯度</th>
                  <th style={styles.th}>経度</th>
                  <th style={styles.th}>GPS範囲</th>
                  <th style={styles.th}>ヘルプ時給</th>
                  <th style={styles.th}>状態</th>
                  <th style={styles.th}>操作</th>
                </tr>
              </thead>
              <tbody>
                {stores.map((store) => (
                  <tr key={store.id}>
                    <td style={styles.td}>
                      {store.logoUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={store.logoUrl}
                          alt={`${store.storeName} ロゴ`}
                          style={logoStyles.preview}
                        />
                      ) : (
                        <span style={logoStyles.empty}>未登録</span>
                      )}
                    </td>
                    <td style={styles.td}>{store.storeCode}</td>
                    <td style={styles.td}>{store.storeName}</td>
                    <td style={styles.td}>{store.lat}</td>
                    <td style={styles.td}>{store.lng}</td>
                    <td style={styles.td}>{store.radiusMeter}m</td>
                    <td style={styles.td}>{store.helpHourlyWage ?? ""}</td>
                    <td style={styles.td}>
                      {store.isActive === false ? "無効" : "有効"}
                    </td>
                    <td style={styles.td}>
                      <div style={logoStyles.actions}>
                        <button
                          type="button"
                          onClick={() => startEdit(store)}
                          style={styles.secondaryButton}
                        >
                          編集
                        </button>
                        <label style={logoStyles.uploadButton}>
                          {uploading[store.id]
                            ? "アップロード中..."
                            : "ロゴ登録・変更"}
                          <input
                            type="file"
                            accept="image/png,image/jpeg,image/webp"
                            disabled={uploading[store.id]}
                            onChange={(event) => handleLogoFile(store.id, event)}
                            style={logoStyles.fileInput}
                          />
                        </label>
                      </div>
                    </td>
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

const logoStyles = {
  preview: {
    width: 96,
    height: "auto",
    maxHeight: 54,
    objectFit: "contain",
    display: "block",
  },
  empty: {
    color: "#6b7280",
    fontSize: 13,
  },
  actions: {
    display: "flex",
    gap: 8,
    alignItems: "center",
  },
  uploadButton: {
    minHeight: 40,
    border: "1px solid #cbd5e1",
    borderRadius: 8,
    background: "#ffffff",
    color: "#363A3D",
    fontSize: 14,
    fontWeight: 700,
    padding: "0 12px",
    display: "inline-flex",
    alignItems: "center",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  fileInput: {
    display: "none",
  },
} satisfies Record<string, React.CSSProperties>;

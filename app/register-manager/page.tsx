"use client";

import { FormEvent, useEffect, useState } from "react";
import { createUserWithEmailAndPassword } from "firebase/auth";
import { collection, doc, getDocs, orderBy, query, serverTimestamp, setDoc } from "firebase/firestore";
import { useRouter } from "next/navigation";
import { useAuthProfile } from "@/lib/auth";
import { auth, db } from "@/lib/firebase";

type StoreOption = { id: string; name: string };

export default function RegisterManagerPage() {
  const router = useRouter();
  const { profile, isLoading } = useAuthProfile();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [storeId, setStoreId] = useState("");
  const [stores, setStores] = useState<StoreOption[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");

  // admin のみアクセス可能
  useEffect(() => {
    if (isLoading) return;
    if (!profile) {
      router.replace("/login");
      return;
    }
    if (profile.role !== "admin") {
      router.replace("/admin");
    }
  }, [profile, isLoading, router]);

  // 店舗一覧取得
  useEffect(() => {
    const fetchStores = async () => {
      try {
        const snap = await getDocs(query(collection(db, "stores"), orderBy("name")));
        setStores(
          snap.docs.map((d) => ({
            id: d.id,
            name: (d.data() as { name?: string }).name ?? d.id,
          })),
        );
      } catch (err) {
        console.error("store fetch failed", err);
      }
    };
    fetchStores();
  }, []);

  const register = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!storeId) {
      setErrorMessage("店舗を選択してください");
      return;
    }
    setIsSubmitting(true);
    setErrorMessage("");
    setSuccessMessage("");

    try {
      const credential = await createUserWithEmailAndPassword(auth, email.trim(), password);
      await setDoc(doc(db, "users", credential.user.uid), {
        name: name.trim(),
        email: email.trim(),
        role: "manager",
        storeId,
        createdAt: serverTimestamp(),
      });
      setSuccessMessage(`${name.trim()} のマネージャーアカウントを作成しました`);
      setEmail("");
      setPassword("");
      setName("");
      setStoreId("");
    } catch (err) {
      console.error("manager registration failed", err);
      const code = (err as { code?: string }).code;
      if (code === "auth/email-already-in-use") {
        setErrorMessage("このメールアドレスはすでに使用されています");
      } else if (code === "auth/weak-password") {
        setErrorMessage("パスワードは6文字以上で入力してください");
      } else {
        setErrorMessage("登録に失敗しました");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading) {
    return <main style={styles.page}><p>読み込み中</p></main>;
  }

  return (
    <main style={styles.page}>
      <section style={styles.panel}>
        <h1 style={styles.title}>マネージャー登録</h1>
        <p style={styles.sub}>店長・副店長アカウントを作成します。admin のみ操作可能です。</p>
        <form onSubmit={register} style={styles.form}>
          <label style={styles.label}>
            メールアドレス
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="off"
              required
              style={styles.input}
            />
          </label>
          <label style={styles.label}>
            パスワード（6文字以上）
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              required
              minLength={6}
              style={styles.input}
            />
          </label>
          <label style={styles.label}>
            氏名
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              required
              style={styles.input}
            />
          </label>
          <label style={styles.label}>
            担当店舗
            <select
              value={storeId}
              onChange={(e) => setStoreId(e.target.value)}
              required
              style={styles.input}
            >
              <option value="">選択してください</option>
              {stores.map((store) => (
                <option key={store.id} value={store.id}>
                  {store.name}
                </option>
              ))}
            </select>
          </label>
          {errorMessage && <p style={styles.error}>{errorMessage}</p>}
          {successMessage && <p style={styles.success}>{successMessage}</p>}
          <button type="submit" disabled={isSubmitting} style={styles.button}>
            {isSubmitting ? "登録中..." : "マネージャーを登録"}
          </button>
        </form>
        <button type="button" onClick={() => router.push("/admin")} style={styles.backButton}>
          ← 管理画面に戻る
        </button>
      </section>
    </main>
  );
}

const styles = {
  page: {
    minHeight: "100svh",
    padding: 24,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#F6F8FB",
    color: "#363A3D",
  },
  panel: {
    width: "100%",
    maxWidth: 440,
    padding: 32,
    background: "#ffffff",
    border: "1px solid #E8EDF4",
    borderRadius: 12,
    boxShadow: "0 10px 30px rgba(15, 23, 42, 0.08)",
    display: "flex",
    flexDirection: "column",
    gap: 0,
  },
  title: {
    margin: 0,
    fontSize: 26,
    fontWeight: 800,
  },
  sub: {
    margin: "8px 0 0",
    fontSize: 13,
    color: "#64748B",
  },
  form: {
    marginTop: 24,
    display: "flex",
    flexDirection: "column",
    gap: 16,
  },
  label: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    fontSize: 13,
    fontWeight: 800,
  },
  input: {
    minHeight: 44,
    border: "1px solid #D7DEE8",
    borderRadius: 8,
    padding: "0 12px",
    fontSize: 15,
    background: "#ffffff",
  },
  button: {
    minHeight: 46,
    border: 0,
    borderRadius: 8,
    background: "#53C1ED",
    color: "#ffffff",
    fontWeight: 800,
    fontSize: 15,
    cursor: "pointer",
  },
  backButton: {
    marginTop: 16,
    background: "none",
    border: 0,
    color: "#64748B",
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
    padding: 0,
    textAlign: "left" as const,
  },
  error: {
    margin: 0,
    color: "#B42318",
    fontSize: 13,
    fontWeight: 700,
  },
  success: {
    margin: 0,
    borderRadius: 8,
    background: "#ECFDF5",
    color: "#047857",
    border: "1px solid #10B981",
    padding: "10px 12px",
    fontSize: 13,
    fontWeight: 700,
  },
} satisfies Record<string, React.CSSProperties>;

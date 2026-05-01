"use client";

import { FormEvent, useEffect, useState } from "react";
import { createUserWithEmailAndPassword } from "firebase/auth";
import { collection, doc, getDocs, limit, query, serverTimestamp, setDoc, where } from "firebase/firestore";
import { useRouter } from "next/navigation";
import { useAuthProfile } from "@/lib/auth";
import { auth, db } from "@/lib/firebase";

export default function RegisterAdminPage() {
  const router = useRouter();
  const { profile, isLoading } = useAuthProfile();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [isCheckingAdmin, setIsCheckingAdmin] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    if (profile?.role === "admin" || profile?.role === "manager") {
      router.replace("/admin");
    }
    if (profile?.role === "staff") {
      router.replace("/clock");
    }
  }, [profile, router]);

  useEffect(() => {
    const checkAdminExists = async () => {
      try {
        const adminSnapshot = await getDocs(
          query(collection(db, "users"), where("role", "==", "admin"), limit(1)),
        );
        if (!adminSnapshot.empty) {
          router.replace("/login");
          return;
        }
      } catch (error) {
        console.error("admin existence check failed", error);
        setErrorMessage("管理者登録の確認に失敗しました");
      } finally {
        setIsCheckingAdmin(false);
      }
    };

    checkAdminExists();
  }, [router]);

  const register = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSubmitting(true);
    setErrorMessage("");

    try {
      const credential = await createUserWithEmailAndPassword(auth, email.trim(), password);
      await setDoc(doc(db, "users", credential.user.uid), {
        name: name.trim(),
        email: email.trim(),
        role: "admin",
        storeId: null,
        createdAt: serverTimestamp(),
      });
      router.replace("/admin");
    } catch (error) {
      console.error("admin registration failed", error);
      setErrorMessage("登録に失敗しました");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main style={styles.page}>
      <section style={styles.panel}>
        <div style={styles.logoWrap}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-placeholder.png" alt="logo" style={styles.logo} />
        </div>
        <h1 style={styles.title}>初回管理者登録</h1>
        <form onSubmit={register} style={styles.form}>
          <label style={styles.label}>
            メールアドレス
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              required
              style={styles.input}
            />
          </label>
          <label style={styles.label}>
            パスワード
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              required
              style={styles.input}
            />
          </label>
          <label style={styles.label}>
            氏名
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="name"
              required
              style={styles.input}
            />
          </label>
          {errorMessage && <p style={styles.error}>{errorMessage}</p>}
          <button type="submit" disabled={isSubmitting || isLoading || isCheckingAdmin} style={styles.button}>
            {isSubmitting ? "登録中" : "登録"}
          </button>
        </form>
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
    maxWidth: 420,
    padding: 28,
    background: "#ffffff",
    border: "1px solid #E8EDF4",
    borderRadius: 12,
    boxShadow: "0 10px 30px rgba(15, 23, 42, 0.08)",
  },
  logoWrap: {
    display: "flex",
    justifyContent: "center",
    marginBottom: 24,
  },
  logo: {
    width: "min(220px, 82%)",
    height: "auto",
    objectFit: "contain",
  },
  title: {
    margin: 0,
    fontSize: 28,
    lineHeight: 1.2,
    fontWeight: 800,
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
  },
  button: {
    minHeight: 46,
    border: 0,
    borderRadius: 8,
    background: "#53C1ED",
    color: "#ffffff",
    fontWeight: 800,
  },
  error: {
    margin: 0,
    color: "#B42318",
    fontSize: 13,
    fontWeight: 700,
  },
} satisfies Record<string, React.CSSProperties>;

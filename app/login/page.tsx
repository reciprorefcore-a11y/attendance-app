"use client";

import { FormEvent, Suspense, useEffect, useState } from "react";
import { signInWithEmailAndPassword } from "firebase/auth";
import { useRouter } from "next/navigation";
import { auth } from "@/lib/firebase";
import { useAuthProfile } from "@/lib/auth";

function LoginPageContent() {
  const router = useRouter();
  const { profile, isLoading } = useAuthProfile();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    if (!profile) return;
    if (profile.role === "staff") {
      router.replace("/clock");
      return;
    }
    router.replace("/admin");
  }, [profile, router]);

  const login = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSubmitting(true);
    setErrorMessage("");
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
    } catch (error) {
      console.error("login failed", error);
      setErrorMessage("ログインに失敗しました");
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
        <h1 style={styles.title}>ログイン</h1>
        <form onSubmit={login} style={styles.form}>
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
              autoComplete="current-password"
              required
              style={styles.input}
            />
          </label>
          {errorMessage && <p style={styles.error}>{errorMessage}</p>}
          <button type="submit" disabled={isSubmitting || isLoading} style={styles.button}>
            {isSubmitting ? "ログイン中" : "ログイン"}
          </button>
        </form>
        {/* 初回管理者登録リンクはここには置かない。
            /register-admin ページ自体で「管理者がすでに存在する場合はリダイレクト」を制御すること。
            開発中のみ必要な場合は下のコメントを外して使用 */}
        {/* <div style={styles.registerLinkWrap}>
          <Link href="/register-admin" style={styles.registerLink}>
            初回管理者登録
          </Link>
        </div> */}
      </section>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<main style={styles.page}>読み込み中</main>}>
      <LoginPageContent />
    </Suspense>
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

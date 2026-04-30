import Link from "next/link";

export default function Home() {
  return (
    <main style={styles.page}>
      <section style={styles.panel}>
        <h1 style={styles.title}>勤怠管理アプリ</h1>
        <p style={styles.text}>タイムカード、従業員、勤怠一覧を管理します。</p>
        <div style={styles.links}>
          <Link href="/clock?storeId=1" style={styles.primaryLink}>
            打刻画面
          </Link>
          <Link href="/hq" style={styles.secondaryLink}>
            本部管理
          </Link>
        </div>
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
    maxWidth: 520,
    padding: 24,
    background: "#ffffff",
    borderRadius: 12,
    boxShadow: "0 10px 30px rgba(15, 23, 42, 0.08)",
  },
  title: {
    margin: 0,
    fontSize: 32,
    lineHeight: 1.2,
    fontWeight: 700,
  },
  text: {
    margin: "12px 0 0",
    fontSize: 16,
    color: "#4b5563",
  },
  links: {
    marginTop: 24,
    display: "flex",
    gap: 12,
    flexWrap: "wrap",
  },
  primaryLink: {
    minHeight: 44,
    padding: "0 18px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
    background: "#53C1ED",
    color: "#ffffff",
    fontWeight: 700,
    textDecoration: "none",
  },
  secondaryLink: {
    minHeight: 44,
    padding: "0 18px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
    border: "1px solid #d1d5db",
    color: "#363A3D",
    fontWeight: 700,
    textDecoration: "none",
  },
} satisfies Record<string, React.CSSProperties>;

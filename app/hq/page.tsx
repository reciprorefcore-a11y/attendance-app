import Link from "next/link";
import { adminStyles as styles } from "@/lib/adminStyles";

const menus = [
  { href: "/hq/employees", label: "従業員承認" },
  { href: "/hq/timecards", label: "勤怠一覧" },
  { href: "/hq/timecards", label: "勤怠修正" },
  { href: "/hq/export", label: "Excel出力" },
  { href: "/hq/stores", label: "店舗管理" },
  { href: "/hq/wages", label: "時給管理" },
  { href: "/hq/employees/import", label: "CSVスタッフ取込" },
];

export default function HqPage() {
  return (
    <main style={styles.page}>
      <div style={styles.shell}>
        <header>
          <h1 style={styles.title}>本部管理</h1>
        </header>
        <section style={{ ...styles.panel, ...styles.grid }}>
          {menus.map((menu) => (
            <Link
              key={`${menu.href}-${menu.label}`}
              href={menu.href}
              style={{
                minHeight: 72,
                borderRadius: 8,
                background: "#53C1ED",
                color: "#ffffff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 18,
                fontWeight: 700,
                textDecoration: "none",
              }}
            >
              {menu.label}
            </Link>
          ))}
        </section>
      </div>
    </main>
  );
}

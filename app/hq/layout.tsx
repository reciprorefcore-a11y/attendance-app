"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuthProfile } from "@/lib/auth";

export default function HqLayout({ children }: { children: React.ReactNode }) {
  const { user, profile, isLoading } = useAuthProfile();
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => { if (!isLoading && !user) router.replace("/login"); }, [isLoading, router, user]);
  if (isLoading) return <main style={{ padding: 24 }}>ログイン確認中</main>;
  if (!user || profile?.role !== "admin") return <main style={{ padding: 24, color: "#991B1B" }}>本部管理者権限が必要です</main>;
  return <>{pathname === "/hq/payroll" && <nav style={{ padding: "12px 24px", borderBottom: "1px solid #E2E8F0" }}><Link href="/admin">管理画面</Link>　/　給与計算</nav>}{children}</>;
}

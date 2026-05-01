"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function StoreLayout() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/admin");
  }, [router]);

  return <main style={{ padding: 24 }}>管理画面へ移動しています</main>;
}

"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { useSearchParams } from "next/navigation";
import { db } from "@/lib/firebase";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  where,
} from "firebase/firestore";

// ─── 型定義 ───────────────────────────────────────────────────────────────

type ClockType = "clock_in" | "clock_out" | "break_start" | "break_end";

type StoreDoc = {
  name?: string;
  logoUrl?: string;
  latitude?: number;
  longitude?: number;
  gpsRadiusMeters?: number;
  helpWage?: number;
  helpHourlyWage?: number;
  active?: boolean;
  gpsEnabled?: boolean;
};

type EmployeeDoc = {
  id: string;
  name: string;
  employeeCode: string;
  storeId: string;
  hourlyWage?: number;
  baseHourlyWage?: number;
  status: "active" | "inactive" | "pending" | "rejected";
};

type GpsState = {
  latitude: number | null;
  longitude: number | null;
  distanceMeters: number | null;
  isOutsideGps: boolean;
  message: string;
};

type Step = "input" | "confirm";

// ─── 打刻許可ロジック ──────────────────────────────────────────────────────────

function getAllowedActions(last: ClockType | null): ClockType[] {
  if (last === null || last === "clock_out") return ["clock_in"];
  if (last === "clock_in" || last === "break_end") return ["break_start", "clock_out"];
  if (last === "break_start") return ["break_end"];
  return [];
}

// ─── ボタン定義 ─────────────────────────────────────────────────────────────

const clockButtons: { type: ClockType; label: string; tone: "primary" | "dark" | "light" }[] = [
  { type: "clock_in", label: "出勤", tone: "primary" },
  { type: "clock_out", label: "退勤", tone: "dark" },
  { type: "break_start", label: "休憩開始", tone: "light" },
  { type: "break_end", label: "休憩終了", tone: "light" },
];

// ─── ユーティリティ ──────────────────────────────────────────────────────────

function calcDistance(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371000;
  const toRad = (v: number) => (v * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function storeLogo(store: StoreDoc | null) {
  return store?.logoUrl || "/assets/logo-placeholder.png";
}

// ─── メインコンポーネント ────────────────────────────────────────────────────

function ClockPageContent() {
  const searchParams = useSearchParams();
  const workStoreId = searchParams.get("storeId") ?? "";

  const [workStore, setWorkStore] = useState<StoreDoc | null>(null);
  const [isStoreLoading, setIsStoreLoading] = useState(true);

  const [step, setStep] = useState<Step>("input");
  const [employeeCode, setEmployeeCode] = useState("");
  const [employee, setEmployee] = useState<EmployeeDoc | null>(null);
  const [homeStoreName, setHomeStoreName] = useState("");
  const [hourlyWageAtWork, setHourlyWageAtWork] = useState(0);
  const [isHelp, setIsHelp] = useState(false);

  const [lastPunchType, setLastPunchType] = useState<ClockType | null>(null);
  const [isLastPunchLoading, setIsLastPunchLoading] = useState(false);

  const [gps, setGps] = useState<GpsState>({
    latitude: null,
    longitude: null,
    distanceMeters: null,
    isOutsideGps: false,
    message: "位置情報は未取得です",
  });

  const [isSearching, setIsSearching] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");

  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ─── 店舗データ購読 ──────────────────────────────────────────────────────

  useEffect(() => {
    if (!workStoreId) {
      setIsStoreLoading(false);
      return;
    }

    setIsStoreLoading(true);
    const unsubscribe = onSnapshot(
      doc(db, "stores", workStoreId),
      (snap) => {
        if (!snap.exists()) {
          setErrorMessage("店舗情報が見つかりません");
          setWorkStore(null);
        } else {
          const data = snap.data() as StoreDoc;
          if (data.active === false) {
            setErrorMessage("この店舗は無効です");
            setWorkStore(null);
          } else {
            setWorkStore(data);
            setErrorMessage("");
          }
        }
        setIsStoreLoading(false);
      },
      (err) => {
        console.error("clock store subscription failed", err);
        setErrorMessage("データ取得に失敗しました");
        setWorkStore(null);
        setIsStoreLoading(false);
      },
    );

    return unsubscribe;
  }, [workStoreId]);

  // ─── GPS 取得 ────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!workStore) return;
    if (workStore.gpsEnabled === false) {
      setGps({ latitude: null, longitude: null, distanceMeters: null, isOutsideGps: false, message: "GPS打刻チェック無効" });
      return;
    }
    const lat = workStore.latitude ?? null;
    const lng = workStore.longitude ?? null;
    const radius = workStore.gpsRadiusMeters ?? 0;

    if (lat === null || lng === null || !radius || !navigator.geolocation) {
      setGps((prev) => ({ ...prev, distanceMeters: null, isOutsideGps: false, message: "GPS取得不可のため位置未確認で打刻できます" }));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const dist = calcDistance(pos.coords.latitude, pos.coords.longitude, lat, lng);
        const outside = dist > radius;
        setGps({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          distanceMeters: dist,
          isOutsideGps: outside,
          message: outside ? "GPS許可範囲外です。打刻は可能です。" : "GPS確認OK",
        });
      },
      () => setGps({ latitude: null, longitude: null, distanceMeters: null, isOutsideGps: false, message: "GPS取得不可のため位置未確認で打刻できます" }),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    );
  }, [workStore]);

  // ─── タイマークリーンアップ ──────────────────────────────────────────────

  useEffect(() => {
    return () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    };
  }, []);

  // ─── リセット ─────────────────────────────────────────────────────────────

  const resetToInput = () => {
    setStep("input");
    setEmployeeCode("");
    setEmployee(null);
    setHomeStoreName("");
    setHourlyWageAtWork(0);
    setIsHelp(false);
    setLastPunchType(null);
    setErrorMessage("");
    setSuccessMessage("");
  };

  // ─── 社員番号確認 ────────────────────────────────────────────────────────

  const handleConfirm = async () => {
    const code = employeeCode.trim();
    if (!code) return;

    setIsSearching(true);
    setErrorMessage("");

    try {
      const snap = await getDocs(
        query(
          collection(db, "employees"),
          where("employeeCode", "==", code),
          where("status", "==", "active"),
          limit(1),
        ),
      );

      if (snap.empty) {
        setErrorMessage("社員番号が見つかりません");
        return;
      }

      const empDoc = snap.docs[0];
      const emp: EmployeeDoc = { id: empDoc.id, ...(empDoc.data() as Omit<EmployeeDoc, "id">) };

      const homeStoreId = emp.storeId;
      const helpFlag = !!homeStoreId && homeStoreId !== workStoreId;
      let wageAtWork = emp.hourlyWage ?? emp.baseHourlyWage ?? 0;

      if (helpFlag) {
        const homeSnap = await getDoc(doc(db, "stores", homeStoreId));
        const homeData = homeSnap.exists() ? (homeSnap.data() as StoreDoc) : null;
        setHomeStoreName(homeData?.name ?? homeStoreId);
        const helpWage = homeData?.helpHourlyWage ?? homeData?.helpWage ?? 0;
        wageAtWork = Math.max(wageAtWork, helpWage);
      } else {
        setHomeStoreName(workStore?.name ?? "");
      }

      setEmployee(emp);
      setIsHelp(helpFlag);
      setHourlyWageAtWork(wageAtWork);

      // 直前打刻を取得
      setIsLastPunchLoading(true);
      try {
        const lastSnap = await getDocs(
          query(
            collection(db, "clockLogs"),
            where("employeeId", "==", emp.id),
            orderBy("timestamp", "desc"),
            limit(1),
          ),
        );
        setLastPunchType(lastSnap.empty ? null : ((lastSnap.docs[0].data().type as ClockType) ?? null));
      } catch (err) {
        console.error("last punch fetch failed", err);
      } finally {
        setIsLastPunchLoading(false);
      }

      setStep("confirm");
    } catch (err) {
      console.error("employee search failed", err);
      setErrorMessage("検索に失敗しました。通信状態を確認してください。");
    } finally {
      setIsSearching(false);
    }
  };

  // ─── 打刻送信 ────────────────────────────────────────────────────────────

  const allowedActions = useMemo(() => getAllowedActions(lastPunchType), [lastPunchType]);

  const punch = async (type: ClockType) => {
    if (!workStoreId || !workStore || !employee) return;
    if (!allowedActions.includes(type)) {
      setErrorMessage("この操作は現在実行できません");
      return;
    }

    setIsSubmitting(true);
    setErrorMessage("");

    try {
      await addDoc(collection(db, "clockLogs"), {
        employeeId: employee.id,
        employeeCode: employee.employeeCode ?? "",
        employeeName: employee.name ?? "",
        homeStoreId: employee.storeId ?? "",
        homeStoreName: homeStoreName ?? "",
        workStoreId,
        workStoreName: workStore.name ?? "",
        isHelp: !!isHelp,
        hourlyWageAtWork: hourlyWageAtWork ?? 0,
        type,
        timestamp: serverTimestamp(),
        latitude: gps.latitude ?? null,
        longitude: gps.longitude ?? null,
        isOutsideGps: !!gps.isOutsideGps,
      });

      setLastPunchType(type);
      setSuccessMessage("打刻しました");

      resetTimerRef.current = setTimeout(resetToInput, 3000);
    } catch (err) {
      console.error("clock save failed", err);
      setErrorMessage("打刻の保存に失敗しました。通信状態を確認してください。");
    } finally {
      setIsSubmitting(false);
    }
  };

  // ─── レンダリング ─────────────────────────────────────────────────────────

  const logoSrc = storeLogo(workStore);

  return (
    <main style={styles.page}>
      <div style={styles.logoHero}>
        {logoSrc.startsWith("/") ? (
          <Image src={logoSrc} alt="店舗ロゴ" width={180} height={180} priority style={styles.heroLogo} />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoSrc} alt="店舗ロゴ" style={styles.heroLogo} />
        )}
      </div>
      <div style={styles.heroStoreName}>{workStore?.name ?? ""}</div>

      <section style={styles.card}>
        {!workStoreId && <p style={styles.error}>店舗情報が見つかりません</p>}
        {workStoreId && isStoreLoading && <p style={styles.info}>読み込み中</p>}
        {errorMessage && <p style={styles.error}>{errorMessage}</p>}
        {successMessage && <p style={styles.success}>{successMessage}</p>}

        {/* 社員番号入力 */}
        {workStore && step === "input" && (
          <div style={styles.inputBox}>
            <label style={styles.label}>
              社員番号
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={employeeCode}
                onChange={(e) => {
                  setEmployeeCode(e.target.value.replace(/\D/g, ""));
                  setErrorMessage("");
                }}
                onKeyDown={(e) => { if (e.key === "Enter" && employeeCode.trim()) handleConfirm(); }}
                style={styles.codeInput}
                placeholder="社員番号を入力"
                autoFocus
              />
            </label>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={!employeeCode.trim() || isSearching}
              style={styles.confirmButton}
            >
              {isSearching ? "検索中..." : "確認"}
            </button>
          </div>
        )}

        {/* 氏名・店舗情報・打刻ボタン */}
        {workStore && step === "confirm" && employee && (
          <>
            <div style={styles.employeeInfo}>
              <p style={styles.employeeName}>{employee.name}</p>
              <p style={styles.storeInfoRow}>
                所属：{homeStoreName}
                {isHelp && <span style={styles.helpBadge}>ヘルプ</span>}
              </p>
              {isHelp && <p style={styles.storeInfoRow}>勤務：{workStore.name}</p>}
            </div>

            {isLastPunchLoading ? (
              <p style={styles.info}>打刻状態を確認中...</p>
            ) : (
              <div style={styles.actions}>
                {clockButtons.map((btn) => {
                  const allowed = allowedActions.includes(btn.type);
                  return (
                    <button
                      key={btn.type}
                      type="button"
                      onClick={() => punch(btn.type)}
                      disabled={isSubmitting || !allowed}
                      style={{
                        ...(btn.tone === "primary"
                          ? styles.primaryButton
                          : btn.tone === "dark"
                            ? styles.darkButton
                            : styles.lightButton),
                        ...(!allowed ? styles.disabledButton : {}),
                      }}
                    >
                      {btn.label}
                    </button>
                  );
                })}
              </div>
            )}

            <button type="button" onClick={resetToInput} style={styles.backButton}>
              ← 戻る
            </button>
          </>
        )}

        {/* GPS 状態 */}
        {workStore && (
          <div style={gps.isOutsideGps ? styles.gpsWarning : styles.gpsBox}>
            <p style={styles.gpsMain}>{gps.message}</p>
            {gps.distanceMeters !== null && (
              <p style={styles.gpsSub}>
                距離 {Math.round(gps.distanceMeters)}m / 許可範囲 {workStore.gpsRadiusMeters ?? 0}m
              </p>
            )}
          </div>
        )}
      </section>
    </main>
  );
}

export default function ClockPage() {
  return (
    <Suspense fallback={<main style={styles.page}>読み込み中</main>}>
      <ClockPageContent />
    </Suspense>
  );
}

// ─── スタイル ─────────────────────────────────────────────────────────────────

const styles = {
  page: {
    minHeight: "100svh",
    background: "#F6F8FB",
    padding: "40px 16px 24px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    color: "#363A3D",
  },
  logoHero: {
    marginBottom: 18,
    width: 196,
    height: 196,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  heroLogo: {
    width: 180,
    height: 180,
    objectFit: "contain",
  },
  heroStoreName: {
    color: "#363A3D",
    fontSize: 18,
    fontWeight: 800,
    marginBottom: 24,
    textAlign: "center",
  },
  card: {
    width: "100%",
    maxWidth: 430,
    background: "#ffffff",
    borderRadius: 20,
    padding: 22,
    display: "flex",
    flexDirection: "column",
    gap: 16,
    boxShadow: "0 18px 45px rgba(15, 23, 42, 0.10)",
  },
  label: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    fontSize: 14,
    fontWeight: 800,
  },
  inputBox: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  codeInput: {
    minHeight: 56,
    borderRadius: 14,
    border: "1px solid #CBD5E1",
    padding: "0 14px",
    fontSize: 24,
    textAlign: "center",
    background: "#ffffff",
  },
  confirmButton: {
    minHeight: 52,
    border: 0,
    borderRadius: 14,
    background: "#53C1ED",
    color: "#ffffff",
    fontSize: 18,
    fontWeight: 900,
    cursor: "pointer",
  },
  employeeInfo: {
    borderRadius: 14,
    background: "#F0FBFE",
    border: "1px solid #BDEBFA",
    padding: "14px 16px",
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  employeeName: {
    margin: 0,
    fontSize: 22,
    fontWeight: 900,
  },
  storeInfoRow: {
    margin: 0,
    fontSize: 14,
    color: "#475569",
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  helpBadge: {
    display: "inline-block",
    background: "#F59E0B",
    color: "#ffffff",
    borderRadius: 6,
    padding: "1px 8px",
    fontSize: 12,
    fontWeight: 800,
  },
  actions: {
    display: "grid",
    gap: 12,
  },
  primaryButton: {
    minHeight: 72,
    border: 0,
    borderRadius: 16,
    background: "#53C1ED",
    color: "#ffffff",
    fontSize: 24,
    fontWeight: 900,
    cursor: "pointer",
  },
  darkButton: {
    minHeight: 72,
    border: 0,
    borderRadius: 16,
    background: "#3BAED6",
    color: "#ffffff",
    fontSize: 24,
    fontWeight: 900,
    cursor: "pointer",
  },
  lightButton: {
    minHeight: 58,
    border: "1px solid #CBD5E1",
    borderRadius: 16,
    background: "#ffffff",
    color: "#363A3D",
    fontSize: 18,
    fontWeight: 800,
    cursor: "pointer",
  },
  disabledButton: {
    opacity: 0.35,
    cursor: "not-allowed",
  },
  backButton: {
    background: "none",
    border: 0,
    color: "#64748B",
    fontSize: 14,
    fontWeight: 700,
    cursor: "pointer",
    padding: "4px 0",
    textAlign: "left" as const,
  },
  gpsBox: {
    borderRadius: 14,
    background: "#F8FAFC",
    border: "1px solid #E2E8F0",
    padding: 14,
  },
  gpsWarning: {
    borderRadius: 14,
    background: "#FFFBEB",
    border: "1px solid #F59E0B",
    padding: 14,
  },
  gpsMain: {
    margin: 0,
    fontWeight: 800,
  },
  gpsSub: {
    margin: "6px 0 0",
    color: "#64748B",
    fontSize: 13,
  },
  error: {
    margin: 0,
    borderRadius: 14,
    background: "#FEF2F2",
    color: "#991B1B",
    border: "1px solid #FCA5A5",
    padding: 12,
    fontWeight: 700,
  },
  success: {
    margin: 0,
    borderRadius: 16,
    background: "#ECFDF5",
    color: "#047857",
    border: "1px solid #10B981",
    padding: 16,
    textAlign: "center",
    fontSize: 24,
    fontWeight: 900,
  },
  info: {
    margin: 0,
    borderRadius: 14,
    background: "#F0FBFE",
    color: "#3BAED6",
    border: "1px solid #BDEBFA",
    padding: 12,
    fontWeight: 700,
  },
} satisfies Record<string, React.CSSProperties>;

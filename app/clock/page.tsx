"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { db } from "@/lib/firebase";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  where,
} from "firebase/firestore";
import { useSearchParams } from "next/navigation";

type ClockType = "clock_in" | "clock_out" | "break_start" | "break_end";

type StoreDoc = {
  name?: string;
  storeName?: string;
  logoUrl?: string;
  latitude?: number;
  lat?: number;
  longitude?: number;
  lng?: number;
  gpsRadiusMeters?: number;
  radiusMeter?: number;
  helpWage?: number;
  helpHourlyWage?: number;
  active?: boolean;
  isActive?: boolean;
};

type EmployeeDoc = {
  id: string;
  name: string;
  nameKana?: string;
  employeeCode: string;
  storeId: string;
  baseWage?: number;
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

const clockButtons: { type: ClockType; label: string; tone: "primary" | "dark" | "light" }[] = [
  { type: "clock_in", label: "出勤", tone: "primary" },
  { type: "clock_out", label: "退勤", tone: "dark" },
  { type: "break_start", label: "休憩開始", tone: "light" },
  { type: "break_end", label: "休憩終了", tone: "light" },
];

const storeLogos: Record<string, string> = {
  "1": "/assets/icon-akari.png",
  "2": "/assets/icon-kushi.png",
  "3": "/assets/icon-pes.png",
  "4": "/assets/icon-gm.png",
  "5": "/assets/icon-gm.png",
};

function calcDistance(lat1: number, lng1: number, lat2: number, lng2: number) {
  const radius = 6371000;
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function storeName(store: StoreDoc | null) {
  return store?.name || store?.storeName || "タイムカード";
}

function storeLatitude(store: StoreDoc | null) {
  return store?.latitude ?? store?.lat ?? null;
}

function storeLongitude(store: StoreDoc | null) {
  return store?.longitude ?? store?.lng ?? null;
}

function storeRadius(store: StoreDoc | null) {
  return store?.gpsRadiusMeters ?? store?.radiusMeter ?? 0;
}

function storeHelpWage(store: StoreDoc | null) {
  return store?.helpWage ?? store?.helpHourlyWage ?? null;
}

function storeLogo(store: StoreDoc | null, storeId: string) {
  return storeLogos[storeId] || store?.logoUrl || "/assets/logo-placeholder.png";
}

function ClockPageContent() {
  const searchParams = useSearchParams();
  const storeId = searchParams.get("storeId") ?? "";
  const [store, setStore] = useState<StoreDoc | null>(null);
  const [employees, setEmployees] = useState<EmployeeDoc[]>([]);
  const [employeeId, setEmployeeId] = useState("");
  const [gps, setGps] = useState<GpsState>({
    latitude: null,
    longitude: null,
    distanceMeters: null,
    isOutsideGps: false,
    message: "位置情報は未取得です",
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");

  useEffect(() => {
    const load = async () => {
      if (!storeId) {
        setErrorMessage("店舗情報が見つかりません");
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      setErrorMessage("");
      try {
        const storeSnap = await getDoc(doc(db, "stores", storeId));
        if (!storeSnap.exists()) {
          setErrorMessage("店舗情報が見つかりません");
          setStore(null);
          return;
        }

        const nextStore = storeSnap.data() as StoreDoc;
        if (nextStore.active === false || nextStore.isActive === false) {
          setErrorMessage("この店舗は無効です");
        }
        setStore(nextStore);

        const employeeSnapshot = await getDocs(
          query(collection(db, "employees"), where("status", "==", "active")),
        );
        const rows = employeeSnapshot.docs
          .map((employeeDoc) => ({
            id: employeeDoc.id,
            ...(employeeDoc.data() as Omit<EmployeeDoc, "id">),
          }))
          .filter((employee) => employee.status === "active");
        setEmployees(rows);
        if (rows[0]) setEmployeeId(rows[0].id);
      } catch (error) {
        console.error("clock page fetch failed", error);
        setErrorMessage("データ取得に失敗しました。通信状態またはFirebase設定を確認してください。");
      } finally {
        setIsLoading(false);
      }
    };

    load();
  }, [storeId]);

  useEffect(() => {
    if (!store) return;
    const lat = storeLatitude(store);
    const lng = storeLongitude(store);
    const radius = storeRadius(store);
    if (lat === null || lng === null || !radius || !navigator.geolocation) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setGps((current) => ({
        ...current,
        message: "GPS取得不可のため位置未確認で打刻できます",
      }));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const distance = calcDistance(
          position.coords.latitude,
          position.coords.longitude,
          lat,
          lng,
        );
        const isOutsideGps = distance > radius;
        setGps({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          distanceMeters: distance,
          isOutsideGps,
          message: isOutsideGps ? "GPS許可範囲外です。打刻は可能です。" : "GPS確認OK",
        });
      },
      () => {
        setGps({
          latitude: null,
          longitude: null,
          distanceMeters: null,
          isOutsideGps: false,
          message: "GPS取得不可のため位置未確認で打刻できます",
        });
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    );
  }, [store]);

  const selectedEmployee = useMemo(
    () => employees.find((employee) => employee.id === employeeId) ?? null,
    [employeeId, employees],
  );

  const punch = async (type: ClockType) => {
    if (!storeId || !store) {
      setErrorMessage("店舗情報が見つかりません");
      return;
    }
    if (!selectedEmployee) {
      setErrorMessage("有効な従業員がいません");
      return;
    }

    const helpWage = storeHelpWage(store);
    const baseWage = selectedEmployee.baseWage ?? selectedEmployee.baseHourlyWage ?? 0;
    const hourlyWageSnapshot =
      typeof helpWage === "number" && helpWage > 0 ? helpWage : baseWage;
    const wageSource =
      typeof helpWage === "number" && helpWage > 0 ? "store_help" : "employee_base";

    setIsSubmitting(true);
    setSuccessMessage("");
    setErrorMessage("");
    try {
      await addDoc(collection(db, "clockLogs"), {
        employeeId: selectedEmployee.id,
        employeeName: selectedEmployee.name,
        employeeCode: selectedEmployee.employeeCode,
        storeId,
        storeName: storeName(store),
        type,
        timestamp: serverTimestamp(),
        hourlyWageSnapshot,
        wageSource,
        latitude: gps.latitude,
        longitude: gps.longitude,
        isOutsideGps: gps.isOutsideGps,
        createdAt: serverTimestamp(),
      });
      setSuccessMessage("打刻しました");
    } catch (error) {
      console.error("clock save failed", error);
      setErrorMessage("打刻の保存に失敗しました。通信状態またはFirebase設定を確認してください。");
    } finally {
      setIsSubmitting(false);
    }
  };

  const logoSrc = storeLogo(store, storeId);

  return (
    <main style={styles.page}>
      <div style={styles.logoHero}>
        {logoSrc.startsWith("/") ? (
          <Image
            src={logoSrc}
            alt="店舗ロゴ"
            width={140}
            height={140}
            priority
            style={styles.heroLogo}
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoSrc} alt="店舗ロゴ" style={styles.heroLogo} />
        )}
      </div>
      <div style={styles.heroStoreName}>{storeName(store)}</div>

      <section style={styles.card}>
        <p style={styles.subtitle}>QR打刻</p>

        {isLoading && <p style={styles.info}>読み込み中</p>}
        {errorMessage && <p style={styles.error}>{errorMessage}</p>}
        {employees.length === 0 && !isLoading && !errorMessage && (
          <p style={styles.error}>有効な従業員がいません</p>
        )}
        {successMessage && <p style={styles.success}>{successMessage}</p>}

        <label style={styles.label}>
          従業員
          <select
            value={employeeId}
            onChange={(event) => {
              setEmployeeId(event.target.value);
              setSuccessMessage("");
            }}
            style={styles.select}
          >
            {employees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.employeeCode} {employee.name}
              </option>
            ))}
          </select>
        </label>

        <div style={gps.isOutsideGps ? styles.gpsWarning : styles.gpsBox}>
          <p style={styles.gpsMain}>{gps.message}</p>
          {gps.distanceMeters !== null && (
            <p style={styles.gpsSub}>
              距離 {Math.round(gps.distanceMeters)}m / 許可範囲 {storeRadius(store)}m
            </p>
          )}
        </div>

        <div style={styles.actions}>
          {clockButtons.map((button) => (
            <button
              key={button.type}
              type="button"
              onClick={() => punch(button.type)}
              disabled={isSubmitting || !selectedEmployee || !store}
              style={
                button.tone === "primary"
                  ? styles.primaryButton
                  : button.tone === "dark"
                    ? styles.darkButton
                    : styles.lightButton
              }
            >
              {button.label}
            </button>
          ))}
        </div>
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
    width: 156,
    height: 156,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  heroLogo: {
    width: 140,
    height: 140,
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
  subtitle: {
    margin: 0,
    textAlign: "center",
    color: "#64748B",
    fontWeight: 700,
  },
  label: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    fontSize: 14,
    fontWeight: 800,
  },
  select: {
    minHeight: 56,
    borderRadius: 14,
    border: "1px solid #CBD5E1",
    padding: "0 14px",
    fontSize: 18,
    background: "#ffffff",
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
  },
  darkButton: {
    minHeight: 72,
    border: 0,
    borderRadius: 16,
    background: "#3BAED6",
    color: "#ffffff",
    fontSize: 24,
    fontWeight: 900,
  },
  lightButton: {
    minHeight: 58,
    border: "1px solid #CBD5E1",
    borderRadius: 16,
    background: "#ffffff",
    color: "#363A3D",
    fontSize: 18,
    fontWeight: 800,
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

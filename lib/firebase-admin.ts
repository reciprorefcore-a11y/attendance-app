import * as adminSdk from "firebase-admin";

let initialized = false;

export function getAdminAuth(): adminSdk.auth.Auth | null {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) return null;

  if (!initialized) {
    try {
      const serviceAccount = JSON.parse(serviceAccountJson) as adminSdk.ServiceAccount;
      if (!adminSdk.apps.length) {
        adminSdk.initializeApp({ credential: adminSdk.credential.cert(serviceAccount) });
      }
      initialized = true;
    } catch (err) {
      console.error("Firebase Admin init failed", err);
      return null;
    }
  }

  return adminSdk.auth();
}

export function getAdminDb(): adminSdk.firestore.Firestore | null {
  if (!getAdminAuth()) return null;
  return adminSdk.firestore();
}

export async function verifyAdminToken(authorization: string | null) {
  const auth = getAdminAuth();
  const db = getAdminDb();
  if (!auth || !db || !authorization?.startsWith("Bearer ")) return null;
  try {
    const decoded = await auth.verifyIdToken(authorization.slice(7));
    const profile = await db.collection("users").doc(decoded.uid).get();
    if (profile.data()?.role !== "admin") return null;
    return { uid: decoded.uid, db };
  } catch {
    return null;
  }
}

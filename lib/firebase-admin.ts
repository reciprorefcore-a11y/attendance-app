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

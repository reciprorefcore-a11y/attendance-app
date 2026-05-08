import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const serviceAccount = require("../service-account.json");
initializeApp({ credential: cert(serviceAccount) });

const db = getFirestore();
db.collection("stores").doc("6").update({
  logoUrl: "/assets/logo-store-6.png"
}).then(() => {
  console.log("stores/6 の logoUrl を更新しました");
  process.exit(0);
});

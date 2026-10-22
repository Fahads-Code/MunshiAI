import admin from "firebase-admin";

export const projectId = process.env.FIREBASE_PROJECT_ID || "munshi-ai-fab19";

function readServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed.private_key === "string") {
        parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
      }
      if (parsed.project_id && !parsed.projectId) parsed.projectId = parsed.project_id;
      return parsed;
    } catch (err) {
      console.error(
        "FIREBASE_SERVICE_ACCOUNT JSON parse nahi hua:",
        err?.message || err,
      );
    }
  }

  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;
  if (clientEmail && privateKey) {
    return {
      projectId,
      clientEmail,
      private_key: privateKey.replace(/\\n/g, "\n"),
    };
  }

  return null;
}

const serviceAccount = readServiceAccount();

/**
 * Firestore ko admin access tabhi milega jab service account configured ho.
 * Warna backend user ke ID token se Firestore REST use karta hai,
 * jis par wahi security rules lagte hain jo app par lagte hain.
 */
export const hasAdminCredential = Boolean(
  serviceAccount || process.env.GOOGLE_APPLICATION_CREDENTIALS,
);

if (!admin.apps.length) {
  admin.initializeApp({
    projectId,
    ...(serviceAccount ? { credential: admin.credential.cert(serviceAccount) } : {}),
  });
}

export default admin;

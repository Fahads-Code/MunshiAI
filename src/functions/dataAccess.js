// Live Firestore read layer.
//
// Do tareeqay:
//  1. Admin (service account) — jab FIREBASE_SERVICE_ACCOUNT / ADC configured ho.
//  2. User ID token + Firestore REST — default. Is par wahi security rules
//     lagte hain jo app ke client par lagte hain, is liye user sirf apna data parh sakta hai.
import admin, { hasAdminCredential, projectId } from "../firebaseAdmin.js";
import { DataAccessError } from "./errors.js";

const REST_URL = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`;
const FETCH_TIMEOUT_MS = 8000;

const COLLECTION_LIMITS = {
  customers: 2000,
  transactions: 10000,
  expenses: 5000,
};

/* ------------------------------------------------------------------ */
/* Firestore REST value decoding                                       */
/* ------------------------------------------------------------------ */

export function decodeFirestoreValue(value) {
  if (!value || typeof value !== "object") return null;
  if ("nullValue" in value) return null;
  if ("booleanValue" in value) return Boolean(value.booleanValue);
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("timestampValue" in value) return value.timestampValue;
  if ("stringValue" in value) return value.stringValue;
  if ("referenceValue" in value) return value.referenceValue;
  if ("bytesValue" in value) return value.bytesValue;
  if ("arrayValue" in value) {
    return (value.arrayValue?.values || []).map(decodeFirestoreValue);
  }
  if ("mapValue" in value) {
    return decodeFirestoreFields(value.mapValue?.fields);
  }
  return null;
}

export function decodeFirestoreFields(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields || {})) {
    out[key] = decodeFirestoreValue(value);
  }
  return out;
}

export function decodeFirestoreDocument(document) {
  if (!document) return null;
  const name = String(document.name || "");
  return {
    id: name.split("/").pop() || "",
    ...decodeFirestoreFields(document.fields),
  };
}

/* ------------------------------------------------------------------ */
/* Readers                                                             */
/* ------------------------------------------------------------------ */

function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  if (typeof AbortController !== "undefined") {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    // Timer ko unref karo taake test process latke na.
    if (typeof timer.unref === "function") timer.unref();
    return controller.signal;
  }
  return undefined;
}

async function readCollectionViaRest({ collectionId, uid, idToken, fetchImpl = fetch }) {
  const runQuery = async (limit) => {
    const body = {
      structuredQuery: {
        from: [{ collectionId }],
        where: {
          fieldFilter: {
            field: { fieldPath: "userId" },
            op: "EQUAL",
            value: { stringValue: uid },
          },
        },
        ...(limit ? { limit } : {}),
      },
    };

    let response;
    try {
      response = await fetchImpl(REST_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify(body),
        signal: timeoutSignal(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      throw new DataAccessError(
        `Firestore (${collectionId}) se rabta nahi ho saka: ${err?.message || err}`,
        "firestore_unreachable",
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new DataAccessError(
        `Firestore (${collectionId}) read fail hua (${response.status}): ${text.slice(0, 200)}`,
        "firestore_read_failed",
      );
    }

    const rows = await response.json().catch(() => []);
    if (!Array.isArray(rows)) {
      throw new DataAccessError(
        `Firestore (${collectionId}) ka jawab samajh nahi aaya.`,
        "firestore_bad_response",
      );
    }

    return rows
      .filter((row) => row && row.document)
      .map((row) => decodeFirestoreDocument(row.document))
      .filter(Boolean);
  };

  const limit = COLLECTION_LIMITS[collectionId];
  const docs = await runQuery(limit);

  // Agar limit tak pahunch gaye to data mukammal nahi ho sakta.
  // Aise mein bina limit ke dobara parho taake purani entries na chhooten.
  if (docs.length >= limit) {
    console.warn(`${collectionId}: limit ${limit} hit, full collection parh rahe hain.`);
    return runQuery(null);
  }
  return docs;
}

async function readCollectionViaAdmin({ collectionId, uid }) {
  const base = () =>
    admin.firestore().collection(collectionId).where("userId", "==", uid);
  const limit = COLLECTION_LIMITS[collectionId];

  try {
    const snapshot = await base().limit(limit).get();
    if (snapshot.size >= limit) {
      const full = await base().get();
      return full.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    }
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  } catch (err) {
    throw new DataAccessError(
      `Firestore admin read fail (${collectionId}): ${err?.message || err}`,
      "firestore_read_failed",
    );
  }
}

async function readCollection({ collectionId, uid, idToken, fetchImpl }) {
  if (hasAdminCredential) {
    return readCollectionViaAdmin({ collectionId, uid });
  }
  return readCollectionViaRest({ collectionId, uid, idToken, fetchImpl });
}

/**
 * Poora shop data (customers, transactions, expenses) load karta hai.
 * Sirf usi user ka jo ID token se verify hua hai.
 */
export async function loadShopData(ctx = {}, { fetchImpl = fetch } = {}) {
  const uid = ctx.uid;
  if (!uid) {
    throw new DataAccessError("User verify nahi hua.", "unauthorized", 401);
  }
  if (!hasAdminCredential && !ctx.idToken) {
    throw new DataAccessError(
      "Live data ke liye login token zaroori hai.",
      "unauthorized",
      401,
    );
  }

  const read = (collectionId) =>
    readCollection({ collectionId, uid, idToken: ctx.idToken, fetchImpl });

  // Expenses collection kuch users ke rules mein block ho sakti hai;
  // us surat mein baqi data phir bhi chalta rahe.
  const [customers, transactions, expenses] = await Promise.all([
    read("customers"),
    read("transactions"),
    read("expenses").catch((err) => {
      console.warn("Expenses read skip:", err?.message || err);
      return [];
    }),
  ]);

  return {
    customers,
    transactions,
    expenses,
    meta: {
      uid,
      source: hasAdminCredential ? "admin" : "user-token",
      loadedAt: new Date().toISOString(),
    },
  };
}

/**
 * Ek hi HTTP request ke andar multiple tool calls ke liye cache.
 * Har request ka apna loader hota hai, is liye data leak nahi hota.
 */
export function createShopDataLoader(ctx, options = {}) {
  let cache = null;
  let pending = null;

  return async function load() {
    if (cache) return cache;
    if (!pending) {
      pending = loadShopData(ctx, options)
        .then((data) => {
          cache = data;
          return data;
        })
        .finally(() => {
          pending = null;
        });
    }
    return pending;
  };
}

export { hasAdminCredential };

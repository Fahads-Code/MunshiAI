import test from "node:test";
import assert from "node:assert/strict";
import {
  createShopDataLoader,
  decodeFirestoreDocument,
  decodeFirestoreValue,
  hasAdminCredential,
  loadShopData,
} from "../src/functions/dataAccess.js";
import { DataAccessError } from "../src/functions/errors.js";
import { UID } from "./fixtures.js";

test("decodeFirestoreValue: har type", () => {
  assert.equal(decodeFirestoreValue({ stringValue: "Ali" }), "Ali");
  assert.equal(decodeFirestoreValue({ integerValue: "1500" }), 1500);
  assert.equal(decodeFirestoreValue({ doubleValue: 12.5 }), 12.5);
  assert.equal(decodeFirestoreValue({ booleanValue: true }), true);
  assert.equal(decodeFirestoreValue({ nullValue: null }), null);
  assert.equal(
    decodeFirestoreValue({ timestampValue: "2026-10-22T04:30:00.000Z" }),
    "2026-10-22T04:30:00.000Z",
  );
  assert.deepEqual(
    decodeFirestoreValue({
      arrayValue: {
        values: [
          { stringValue: "a" },
          { mapValue: { fields: { qty: { integerValue: "2" } } } },
        ],
      },
    }),
    ["a", { qty: 2 }],
  );
});

test("decodeFirestoreDocument: id nikalta hai", () => {
  const doc = decodeFirestoreDocument({
    name: "projects/p/databases/(default)/documents/customers/c1",
    fields: {
      name: { stringValue: "Ali Khan" },
      totalBalance: { integerValue: "1500" },
      items: { arrayValue: { values: [] } },
    },
  });
  assert.deepEqual(doc, { id: "c1", name: "Ali Khan", totalBalance: 1500, items: [] });
});

test("loadShopData: uid ke baghair unauthorized", async () => {
  await assert.rejects(() => loadShopData({}), DataAccessError);
});

test("loadShopData: REST mode mein ID token zaroori hai", async (t) => {
  if (hasAdminCredential) return t.skip("admin credentials configured");
  await assert.rejects(
    () => loadShopData({ uid: UID }, { fetchImpl: async () => ({ ok: true, json: async () => [] }) }),
    (err) => err instanceof DataAccessError && err.code === "unauthorized",
  );
});

test("createShopDataLoader: ek request mein sirf ek dafa reads", async (t) => {
  if (hasAdminCredential) return t.skip("admin credentials configured");

  const calls = [];
  const rows = {
    customers: [
      {
        document: {
          name: "projects/p/databases/(default)/documents/customers/c1",
          fields: { userId: { stringValue: UID }, name: { stringValue: "Ali" } },
        },
      },
    ],
    transactions: [],
    expenses: [{ readTime: "2026-10-22T00:00:00Z" }],
  };

  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    const collectionId = body.structuredQuery.from[0].collectionId;
    calls.push(collectionId);
    assert.equal(body.structuredQuery.where.fieldFilter.value.stringValue, UID);
    return { ok: true, json: async () => rows[collectionId] };
  };

  const loader = createShopDataLoader({ uid: UID, idToken: "token" }, { fetchImpl });
  const first = await loader();
  const second = await loader();

  assert.equal(first, second);
  assert.deepEqual(calls.sort(), ["customers", "expenses", "transactions"]);
  assert.equal(first.customers[0].id, "c1");
  assert.equal(first.customers[0].name, "Ali");
  assert.equal(first.meta.source, "user-token");
});

test("loadShopData: limit hit hone par poora collection dobara parha jata hai", async (t) => {
  if (hasAdminCredential) return t.skip("admin credentials configured");

  const makeDoc = (i) => ({
    document: {
      name: `projects/p/databases/(default)/documents/customers/c${i}`,
      fields: { userId: { stringValue: UID }, name: { stringValue: `C${i}` } },
    },
  });
  const full = Array.from({ length: 2000 }, (_, i) => makeDoc(i));

  const calls = { customers: 0 };
  const fetchImpl = async (_url, options) => {
    const { from, limit } = JSON.parse(options.body).structuredQuery;
    const { collectionId } = from[0];
    if (collectionId === "customers") {
      calls.customers += 1;
      if (limit !== undefined) assert.equal(limit, 2000);
    }
    if (collectionId !== "customers") return { ok: true, json: async () => [] };
    return { ok: true, json: async () => full };
  };

  const data = await loadShopData({ uid: UID, idToken: "token" }, { fetchImpl });
  assert.equal(data.customers.length, 2000);
  // Pehli limited query + doosri unlimited query
  assert.equal(calls.customers, 2);
});

test("loadShopData: Firestore error saaf code ke saath", async (t) => {
  if (hasAdminCredential) return t.skip("admin credentials configured");

  const fetchImpl = async () => ({
    ok: false,
    status: 403,
    text: async () => "Missing or insufficient permissions.",
  });

  await assert.rejects(
    () => loadShopData({ uid: UID, idToken: "token" }, { fetchImpl }),
    (err) => err instanceof DataAccessError && err.code === "firestore_read_failed",
  );
});

test("loadShopData: expenses block hon to baqi data chalta hai", async (t) => {
  if (hasAdminCredential) return t.skip("admin credentials configured");

  const fetchImpl = async (_url, options) => {
    const { collectionId } = JSON.parse(options.body).structuredQuery.from[0];
    if (collectionId === "expenses") {
      return { ok: false, status: 403, text: async () => "denied" };
    }
    return { ok: true, json: async () => [] };
  };

  const data = await loadShopData({ uid: UID, idToken: "token" }, { fetchImpl });
  assert.deepEqual(data.customers, []);
  assert.deepEqual(data.expenses, []);
});

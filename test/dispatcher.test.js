import test from "node:test";
import assert from "node:assert/strict";
import {
  invokeFunction,
  validateArguments,
  FUNCTION_NAMES,
  FUNCTION_DEFINITIONS,
} from "../src/functions/dispatcher.js";
import { DataAccessError } from "../src/functions/errors.js";
import { HANDLERS } from "../src/functions/handlers.js";
import { NOW, shopData, UID } from "./fixtures.js";

const ctx = { uid: UID, idToken: "fake-token" };
const loadData = async () => shopData;

test("definitions aur handlers match karte hain", () => {
  assert.equal(FUNCTION_NAMES.length, 6);
  assert.equal(Object.keys(HANDLERS).length, FUNCTION_DEFINITIONS.length);
  for (const name of FUNCTION_NAMES) {
    assert.equal(typeof HANDLERS[name], "function");
  }
});

test("validateArguments: defaults aur extra fields ignore", () => {
  const args = validateArguments("searchCustomer", {
    name: "  Ali  ",
    userId: "hacker-user",
    limit: "3",
  });
  assert.deepEqual(args, { name: "Ali", limit: 3 });

  assert.deepEqual(validateArguments("listDefaulters", {}), { limit: 10 });
});

test("validateArguments: invalid input reject hota hai", () => {
  assert.throws(
    () => validateArguments("searchCustomer", {}),
    /zaroori hai/,
  );
  assert.throws(
    () => validateArguments("searchCustomer", { name: "Ali", limit: 100 }),
    /zyada se zyada/,
  );
  assert.throws(
    () => validateArguments("getSalesSummary", { period: "pagal" }),
    /in mein se ek/,
  );
  assert.throws(
    () => validateArguments("ghostFunction", {}),
    /mojood nahi/,
  );
  assert.throws(
    () => validateArguments("searchCustomer", ["Ali"]),
    /object hone chahiye/,
  );
});

test("validateArguments: JSON string bhi chal jati hai", () => {
  assert.deepEqual(
    validateArguments("calculateBalance", '{"customerId":"c1"}'),
    { customerId: "c1", includeEntries: false },
  );
  assert.throws(
    () => validateArguments("calculateBalance", "{broken"),
    /valid JSON/,
  );
});

test("invokeFunction: searchCustomer live data se", async () => {
  const result = await invokeFunction(ctx, "searchCustomer", { name: "Ali" }, {
    loadData,
    now: NOW,
  });
  assert.equal(result.ok, true);
  assert.equal(result.function, "searchCustomer");
  assert.equal(result.data.count, 2);
});

test("invokeFunction: sales summary", async () => {
  const result = await invokeFunction(
    ctx,
    "getSalesSummary",
    { period: "today" },
    { loadData, now: NOW },
  );
  assert.equal(result.ok, true);
  assert.equal(result.data.sales.total, 3500);
  assert.equal(result.data.profit.net, 150);
});

test("invokeFunction: customerId sirf usi user ke data se", async () => {
  let seenCtx = null;
  const result = await invokeFunction(
    { uid: "another-user", idToken: "tok" },
    "calculateBalance",
    { customerId: "c1" },
    {
      loadData: async (received) => {
        seenCtx = received;
        return shopData; // is fixture mein customers dusre user ke hain
      },
      now: NOW,
    },
  );
  // Loader ko wahi ctx mila jo auth se aaya.
  assert.equal(seenCtx.uid, "another-user");
  // Data scoping Firestore query karti hai, handler nahi.
  assert.equal(result.ok, true);
});

test("invokeFunction: unknown function aur validation errors", async () => {
  const unknown = await invokeFunction(ctx, "hackDatabase", {}, { loadData });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, "unknown_function");

  const invalid = await invokeFunction(ctx, "searchCustomer", {}, { loadData });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "invalid_arguments");
});

test("invokeFunction: data access fail hone par saaf error", async () => {
  const result = await invokeFunction(ctx, "searchCustomer", { name: "Ali" }, {
    loadData: async () => {
      throw new DataAccessError("boom", "firestore_unreachable");
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "firestore_unreachable");
  assert.match(result.error.message, /dobara koshish/);
});

test("invokeFunction: ctx ke baghair unauthorized", async () => {
  const result = await invokeFunction({}, "searchCustomer", { name: "Ali" }, {
    loadData,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "unauthorized");
});

test("invokeFunction: handler crash package ho jata hai", async () => {
  const result = await invokeFunction(ctx, "searchCustomer", { name: "Ali" }, {
    loadData: async () => {
      throw new Error("unexpected");
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "internal_error");
});

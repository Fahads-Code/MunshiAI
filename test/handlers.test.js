import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateBalance,
  getSalesSummary,
  listCreditCustomers,
  listDefaulters,
  listPayments,
  normalizeShopData,
  searchCustomer,
} from "../src/functions/handlers.js";
import { resolvePeriod, startOfPktDay } from "../src/functions/period.js";
import { FunctionError } from "../src/functions/errors.js";
import { NOW, shopData } from "./fixtures.js";

const data = normalizeShopData(shopData);

test("period: aaj Pakistan ke din ke hisaab se shuru hota hai", () => {
  const range = resolvePeriod({ period: "today" }, NOW);
  assert.equal(range.key, "today");
  assert.equal(range.from, "2026-10-21T19:00:00.000Z"); // 22 Oct 00:00 PKT
  assert.equal(range.toMs, NOW.getTime() + 1);
  assert.equal(startOfPktDay(NOW).toISOString(), range.from);
});

test("period: kal aur pichle 7 din", () => {
  const yesterday = resolvePeriod({ period: "yesterday" }, NOW);
  assert.equal(yesterday.label, "Kal");
  assert.equal(yesterday.fromMs, Date.parse("2026-10-20T19:00:00.000Z"));

  const week = resolvePeriod({ period: "last7days" }, NOW);
  assert.equal(week.from, "2026-10-15T19:00:00.000Z");
});

test("period: is mahina aur pichla mahina", () => {
  const thisMonth = resolvePeriod({ period: "thisMonth" }, NOW);
  assert.equal(thisMonth.from, "2026-09-30T19:00:00.000Z"); // 1 Oct 00:00 PKT
  assert.equal(thisMonth.toMs, NOW.getTime() + 1);

  const lastMonth = resolvePeriod({ period: "lastMonth" }, NOW);
  assert.equal(lastMonth.from, "2026-08-31T19:00:00.000Z"); // 1 Sep PKT
  assert.equal(lastMonth.toMs, Date.parse("2026-09-30T19:00:00.000Z"));
});

test("period: custom dates aur aliases", () => {
  const custom = resolvePeriod(
    { period: "custom", from: "2026-10-01T00:00:00Z", to: "2026-10-10T00:00:00Z" },
    NOW,
  );
  assert.equal(custom.key, "custom");
  assert.equal(custom.fromMs, Date.parse("2026-10-01T00:00:00Z"));

  assert.equal(resolvePeriod({ period: "aaj" }, NOW).key, "today");
  assert.equal(resolvePeriod({ period: "is mahina" }, NOW).key, "thisMonth");
  assert.throws(() => resolvePeriod({ period: "pagal" }, NOW), FunctionError);
  assert.throws(
    () =>
      resolvePeriod(
        { period: "custom", from: "2026-10-10T00:00:00Z", to: "2026-10-01T00:00:00Z" },
        NOW,
      ),
    FunctionError,
  );
});

test("searchCustomer: partial naam se saare matches milte hain", () => {
  const result = searchCustomer(data, { name: "Ali", limit: 5 });
  assert.equal(result.count, 2);
  assert.equal(result.customers[0].name, "Ali Khan"); // balance zyada, is liye pehle
  assert.equal(result.customers[0].balance, 1500);
  assert.equal(result.customers[0].balanceInfo.kind, "receivable");
  assert.equal(result.customers[0].lastTransaction.amount, 500);
  assert.equal(result.customers[1].name, "Ali Raza");
});

test("searchCustomer: exact naam aur limit", () => {
  const exact = searchCustomer(data, { name: "Fahad" });
  assert.equal(exact.count, 1);
  assert.equal(exact.customers[0].id, "c4");
  assert.deepEqual(exact.customers[0].balanceInfo, {
    kind: "receivable",
    amount: 7000,
    label: "Customer se Rs. 7,000 lene hain",
  });

  assert.equal(searchCustomer(data, { name: "Ali", limit: 1 }).count, 1);
  assert.equal(searchCustomer(data, { name: "Zubair" }).count, 0);
});

test("calculateBalance: id se mukammal khata", () => {
  const result = calculateBalance(data, {
    customerId: "c1",
    includeEntries: true,
  });
  assert.equal(result.found, true);
  assert.equal(result.customer.name, "Ali Khan");
  assert.equal(result.balance.amount, 1500);
  assert.equal(result.lifetime.creditGiven, 2000);
  assert.equal(result.lifetime.cashAtSale, 1000);
  assert.equal(result.lifetime.repaid, 500); // sale-payment double count nahi
  assert.equal(result.lifetime.entries, 3);
  assert.equal(result.entries.length, 3);
  assert.equal(result.lastTransaction.type, "GOT");
});

test("calculateBalance: ambiguous naam par matches wapas", () => {
  const result = calculateBalance(data, { customerName: "Ali" });
  assert.equal(result.found, false);
  assert.equal(result.ambiguous, true);
  assert.equal(result.matches.length, 2);
  assert.equal(result.matches[0].balance, 1500);
});

test("calculateBalance: advance customer ka balance negative", () => {
  const result = calculateBalance(data, { customerName: "Bilal" });
  assert.equal(result.found, true);
  assert.equal(result.balance.kind, "payable");
  assert.equal(result.balance.amount, 500);
  assert.match(result.balance.label, /dene hain/);
});

test("getSalesSummary: aaj ka hisaab", () => {
  const result = getSalesSummary(data, { period: "today" }, NOW);
  assert.equal(result.sales.total, 3500);
  assert.equal(result.sales.bills, 2);
  assert.equal(result.sales.cashAtSale, 1500);
  assert.equal(result.sales.credit, 2000);
  assert.equal(result.recovery.total, 500);
  assert.equal(result.recovery.salePaymentsAtSale, 1000);
  assert.equal(result.expenses.total, 300);
  assert.equal(result.profit.gross, 450);
  assert.equal(result.profit.net, 150);
  assert.equal(result.profit.complete, true);
  assert.equal(result.cashInHand.total, 2000);
  assert.equal(result.cashInHand.netAfterExpenses, 1700);
  assert.equal(result.topItems[0].name, "Chawal");
  assert.equal(result.recentSales.length, 2);
});

test("getSalesSummary: pichle 7 din", () => {
  const result = getSalesSummary(data, { period: "last7days" }, NOW);
  assert.equal(result.sales.total, 10500);
  assert.equal(result.sales.credit, 9000);
  assert.equal(result.recovery.total, 500);
  assert.equal(result.expenses.total, 1300);
  assert.equal(result.profit.net, -150);
  assert.equal(result.profit.estimated, true);
});

test("getSalesSummary: pichla mahina", () => {
  const result = getSalesSummary(data, { period: "lastMonth" }, NOW);
  assert.equal(result.sales.total, 1200);
  assert.equal(result.sales.cashAtSale, 1200);
  assert.equal(result.recovery.total, 800);
  assert.equal(result.expenses.total, 0);
  assert.equal(result.profit.net, 180);
});

test("listDefaulters: sab se zyada udhaar pehle", () => {
  const result = listDefaulters(data, { limit: 10 });
  assert.equal(result.totalOutstanding, 8500);
  assert.equal(result.debtorCount, 2);
  assert.deepEqual(
    result.debtors.map((d) => [d.name, d.balance]),
    [
      ["Fahad Mehmood", 7000],
      ["Ali Khan", 1500],
    ],
  );
  assert.deepEqual(result.advancesInShop, { count: 1, total: 500 });
  assert.equal(result.settledCount, 1);
  assert.equal(listDefaulters(data, { limit: 1 }).debtors.length, 1);
});

test("listCreditCustomers: udhaar kis ne liya", () => {
  const today = listCreditCustomers(data, { period: "today" }, NOW);
  assert.equal(today.totalCredit, 2000);
  assert.equal(today.customerCount, 1);
  assert.equal(today.customers[0].name, "Ali Khan");
  assert.deepEqual(today.customers[0].items, ["Chawal"]);

  const week = listCreditCustomers(data, { period: "last7days" }, NOW);
  assert.equal(week.totalCredit, 9000);
  assert.equal(week.customerCount, 2);
});

test("listPayments: sirf purani wasooli, sale cash nahi", () => {
  const today = listPayments(data, { period: "today" }, NOW);
  assert.equal(today.totalReceived, 500);
  assert.equal(today.customerCount, 1);
  assert.equal(today.customers[0].name, "Ali Khan");
  assert.equal(today.customers[0].payments, 1);

  const lastMonth = listPayments(data, { period: "lastMonth" }, NOW);
  assert.equal(lastMonth.totalReceived, 800);
  assert.equal(lastMonth.customers[0].name, "Ali Raza");
});

test("normalizeShopData: bad values safe rehti hain", () => {
  const clean = normalizeShopData({
    customers: [{ id: "x", name: "  Ali  ", totalBalance: "1500.456" }],
    transactions: [
      {
        id: "t",
        type: "WHAT",
        amount: -50,
        paid: 9999,
        createdAt: "not-a-date",
        items: [{ name: "A", qty: "2", price: "10.555" }, null],
      },
    ],
    expenses: [{ id: "e", amount: "12.345" }],
  });

  assert.equal(clean.customers[0].name, "Ali");
  assert.equal(clean.customers[0].totalBalance, 1500.46);
  assert.equal(clean.transactions[0].type, "GAVE");
  assert.equal(clean.transactions[0].amount, 0);
  assert.equal(clean.transactions[0].paid, 0);
  assert.equal(clean.transactions[0].createdAt, null);
  assert.equal(clean.transactions[0].items.length, 1);
  assert.equal(clean.transactions[0].items[0].price, 10.56);
  assert.equal(clean.expenses[0].amount, 12.35);
});

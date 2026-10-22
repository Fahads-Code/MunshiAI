// Pure data handlers. Ye Firestore ya network ko touch nahi karte,
// is liye inhein asani se unit-test kiya ja sakta hai.
import { FunctionError } from "./errors.js";
import { resolvePeriod } from "./period.js";

const EPS = 0.009;

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

export const formatRs = (n) =>
  `Rs. ${round2(Math.abs(n)).toLocaleString("en-PK")}`;

export function isoDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }
  if (typeof value === "object" && typeof value.toDate === "function") {
    const d = value.toDate();
    return d instanceof Date && Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export function isSalePayment(tx) {
  return tx?.source === "sale-payment";
}

export function balanceInfo(balance) {
  const amount = round2(num(balance));
  if (amount > EPS) {
    return {
      kind: "receivable",
      amount,
      label: `Customer se ${formatRs(amount)} lene hain`,
    };
  }
  if (amount < -EPS) {
    return {
      kind: "payable",
      amount: round2(Math.abs(amount)),
      label: `Customer ko ${formatRs(amount)} dene hain (advance/jama)`,
    };
  }
  return { kind: "settled", amount: 0, label: "Hisaab barabar hai (Rs. 0)" };
}

/** Firestore se aaya raw data ek stable shape mein le aao. */
export function normalizeShopData(raw = {}) {
  const customers = (Array.isArray(raw.customers) ? raw.customers : [])
    .filter((c) => c && typeof c === "object")
    .map((c) => ({
      id: String(c.id ?? ""),
      name: String(c.name ?? "").trim().slice(0, 80) || "Customer",
      phone: typeof c.phone === "string" ? c.phone.slice(0, 30) : "",
      totalBalance: round2(num(c.totalBalance)),
      createdAt: isoDate(c.createdAt),
    }))
    .filter((c) => c.id);

  const transactions = (Array.isArray(raw.transactions) ? raw.transactions : [])
    .filter((t) => t && typeof t === "object")
    .map((t) => {
      const amount = Math.max(0, round2(num(t.amount)));
      const paid = Math.min(amount, Math.max(0, round2(num(t.paid))));
      return {
        id: String(t.id ?? ""),
        type: t.type === "GOT" ? "GOT" : "GAVE",
        amount,
        paid,
        customerId: t.customerId ? String(t.customerId) : null,
        customerName: String(t.customerName ?? "").trim().slice(0, 80),
        createdAt: isoDate(t.createdAt),
        items: (Array.isArray(t.items) ? t.items : [])
          .filter((i) => i && typeof i === "object")
          .slice(0, 100)
          .map((i) => ({
            name: String(i.name ?? "").slice(0, 60),
            qty: round2(num(i.qty)),
            unit: String(i.unit ?? "pc").slice(0, 20),
            price: round2(num(i.price)),
          })),
        profit: t.profit === null || t.profit === undefined ? null : round2(num(t.profit)),
        profitEstimated: t.profitEstimated === true,
        source: typeof t.source === "string" ? t.source : null,
        note: typeof t.note === "string" ? t.note.slice(0, 160) : "",
        receiptNo: typeof t.receiptNo === "string" ? t.receiptNo : null,
      };
    })
    .filter((t) => t.id)
    .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));

  const expenses = (Array.isArray(raw.expenses) ? raw.expenses : [])
    .filter((e) => e && typeof e === "object")
    .map((e) => ({
      id: String(e.id ?? ""),
      amount: Math.max(0, round2(num(e.amount))),
      category: String(e.category ?? "Other").slice(0, 40),
      note: typeof e.note === "string" ? e.note.slice(0, 120) : "",
      createdAt: isoDate(e.createdAt),
    }))
    .filter((e) => e.id);

  return { customers, transactions, expenses };
}

function inRange(iso, fromMs, toMs) {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) && t >= fromMs && t < toMs;
}

function customerTx(data, customer) {
  const name = norm(customer.name);
  return data.transactions.filter(
    (t) =>
      (t.customerId && t.customerId === customer.id) ||
      (!t.customerId && norm(t.customerName) === name),
  );
}

function lastTxOf(data, customer) {
  const txs = customerTx(data, customer);
  return txs.length ? summarizeTx(txs[0]) : null;
}

function summarizeTx(tx) {
  return {
    date: tx.createdAt,
    type: tx.type,
    label: tx.type === "GOT" ? "Wasooli (payment)" : "Sale / Udhaar",
    amount: tx.amount,
    paid: tx.paid,
    due: round2(Math.max(0, tx.amount - tx.paid)),
    items: tx.items.map((i) => `${i.name} (${i.qty} ${i.unit})`).join(", ") || null,
    note: tx.note || null,
  };
}

function nameScore(query, name) {
  const q = norm(query);
  const n = norm(name);
  if (!q || !n) return 0;
  if (n === q) return 100;
  if (n.startsWith(q)) return 85;
  if (n.includes(q)) return 70;

  const qWords = q.split(" ").filter(Boolean);
  const nWords = n.split(" ").filter(Boolean);

  if (qWords.length > 1 && qWords.every((w) => nWords.some((nw) => nw.startsWith(w)))) {
    return 60;
  }
  if (qWords.some((w) => nWords.some((nw) => nw === w))) return 45;
  if (qWords.some((w) => w.length >= 3 && nWords.some((nw) => nw.startsWith(w)))) return 35;
  return 0;
}

export function matchCustomers(data, query) {
  return data.customers
    .map((customer) => ({ customer, score: nameScore(query, customer.name) }))
    .filter((m) => m.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        Math.abs(b.customer.totalBalance) - Math.abs(a.customer.totalBalance) ||
        a.customer.name.localeCompare(b.customer.name),
    );
}

export function searchCustomer(data, args) {
  const query = args.name;
  const limit = args.limit ?? 5;
  const matches = matchCustomers(data, query).slice(0, limit);

  return {
    query,
    count: matches.length,
    customers: matches.map(({ customer, score }) => ({
      id: customer.id,
      name: customer.name,
      phone: customer.phone || null,
      balance: customer.totalBalance,
      balanceInfo: balanceInfo(customer.totalBalance),
      matchScore: score,
      lastTransaction: lastTxOf(data, customer),
    })),
    ...(matches.length === 0
      ? { note: `"${query}" naam ka koi customer records mein nahi mila.` }
      : {}),
  };
}

export function calculateBalance(data, args) {
  const { customerId, customerName, includeEntries = false } = args;

  let customer = null;
  let matches = [];

  if (customerId) {
    customer = data.customers.find((c) => c.id === customerId) || null;
    if (!customer) {
      return {
        found: false,
        reason: "customerId records mein nahi mila.",
        customerId,
      };
    }
  } else {
    matches = matchCustomers(data, customerName);
    if (matches.length === 0) {
      return { found: false, reason: `"${customerName}" naam ka customer nahi mila.` };
    }

    const topScore = matches[0].score;
    const topMatches = matches.filter((m) => m.score === topScore);
    if (topMatches.length > 1) {
      return {
        found: false,
        ambiguous: true,
        query: customerName,
        matches: matches.slice(0, 10).map(({ customer: c }) => ({
          id: c.id,
          name: c.name,
          phone: c.phone || null,
          balance: c.totalBalance,
          balanceInfo: balanceInfo(c.totalBalance),
        })),
        note: "Is naam se ek se zyada customer mile hain. Pehle customer choose karein.",
      };
    }
    customer = matches[0].customer;
  }

  const txs = customerTx(data, customer);

  let creditGiven = 0;
  let cashAtSale = 0;
  let repaid = 0;
  let salesCount = 0;
  let paymentsCount = 0;

  for (const t of txs) {
    if (t.type === "GOT") {
      if (isSalePayment(t)) continue;
      repaid += t.amount;
      paymentsCount += 1;
    } else {
      creditGiven += Math.max(0, t.amount - t.paid);
      cashAtSale += t.paid;
      salesCount += 1;
    }
  }

  const balance = customer.totalBalance;
  const result = {
    found: true,
    customer: {
      id: customer.id,
      name: customer.name,
      phone: customer.phone || null,
    },
    balance: balanceInfo(balance),
    lifetime: {
      creditGiven: round2(creditGiven),
      cashAtSale: round2(cashAtSale),
      repaid: round2(repaid),
      salesCount,
      paymentsCount,
      entries: txs.length,
    },
    lastTransaction: txs.length ? summarizeTx(txs[0]) : null,
  };

  if (includeEntries) {
    result.entries = txs.slice(0, 8).map(summarizeTx);
  }

  return result;
}

export function getSalesSummary(data, args, now = new Date()) {
  const range = resolvePeriod(args, now);

  const txs = data.transactions.filter((t) => inRange(t.createdAt, range.fromMs, range.toMs));
  const expenses = data.expenses.filter((e) =>
    inRange(e.createdAt, range.fromMs, range.toMs),
  );

  const sales = txs.filter((t) => t.type === "GAVE");
  const payments = txs.filter((t) => t.type === "GOT" && !isSalePayment(t));
  const salePayments = txs.filter((t) => t.type === "GOT" && isSalePayment(t));

  const totalSales = sales.reduce((s, t) => s + t.amount, 0);
  const cashAtSale = sales.reduce((s, t) => s + t.paid, 0);
  const creditGiven = sales.reduce((s, t) => s + Math.max(0, t.amount - t.paid), 0);
  const recovery = payments.reduce((s, t) => s + t.amount, 0);
  const salePaymentsTotal = salePayments.reduce((s, t) => s + t.amount, 0);
  const expenseTotal = expenses.reduce((s, e) => s + e.amount, 0);

  const profitComplete = sales.every((t) => t.profit !== null);
  const grossProfit = round2(sales.reduce((s, t) => s + (t.profit ?? 0), 0));
  const profitEstimated = sales.some((t) => t.profitEstimated);

  const topItemsMap = new Map();
  for (const t of sales) {
    for (const item of t.items) {
      const key = `${item.name.toLowerCase()}|${item.unit}`;
      const row = topItemsMap.get(key) ?? {
        name: item.name,
        unit: item.unit,
        qty: 0,
        revenue: 0,
      };
      row.qty = round2(row.qty + item.qty);
      row.revenue = round2(row.revenue + item.qty * item.price);
      topItemsMap.set(key, row);
    }
  }

  return {
    period: {
      key: range.key,
      label: range.label,
      from: range.from,
      to: range.to,
    },
    sales: {
      total: round2(totalSales),
      bills: sales.length,
      cashAtSale: round2(cashAtSale),
      credit: round2(creditGiven),
    },
    recovery: {
      total: round2(recovery),
      entries: payments.length,
      // Sale ke waqt mila cash alag hai; is liye recovery se nahi joda jata.
      salePaymentsAtSale: round2(salePaymentsTotal),
    },
    expenses: {
      total: round2(expenseTotal),
      entries: expenses.length,
    },
    profit: {
      gross: profitComplete ? grossProfit : null,
      net: profitComplete ? round2(grossProfit - expenseTotal) : null,
      complete: profitComplete,
      estimated: profitEstimated,
      note: profitComplete
        ? profitEstimated
          ? "Kuch items ka khareed qeemat darj nahi tha, is liye munafa takhmina hai."
          : null
        : "Kuch manual entries mein khareed qeemat darj nahi, is liye net munafa nahi bata sakte.",
    },
    cashInHand: {
      fromSales: round2(cashAtSale),
      fromRecovery: round2(recovery),
      total: round2(cashAtSale + recovery),
      netAfterExpenses: round2(cashAtSale + recovery - expenseTotal),
    },
    topItems: [...topItemsMap.values()]
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5),
    recentSales: sales.slice(0, 5).map(summarizeTx),
  };
}

export function listDefaulters(data, args) {
  const limit = args.limit ?? 10;
  const debtors = data.customers
    .filter((c) => c.totalBalance > EPS)
    .sort((a, b) => b.totalBalance - a.totalBalance);

  const advances = data.customers.filter((c) => c.totalBalance < -EPS);
  const totalOutstanding = debtors.reduce((s, c) => s + c.totalBalance, 0);
  const totalAdvance = advances.reduce((s, c) => s + Math.abs(c.totalBalance), 0);

  return {
    totalOutstanding: round2(totalOutstanding),
    debtorCount: debtors.length,
    debtors: debtors.slice(0, limit).map((c) => ({
      id: c.id,
      name: c.name,
      phone: c.phone || null,
      balance: c.totalBalance,
      lastTransaction: lastTxOf(data, c),
    })),
    advancesInShop: {
      count: advances.length,
      total: round2(totalAdvance),
    },
    settledCount: data.customers.filter((c) => Math.abs(c.totalBalance) <= EPS).length,
  };
}

export function listCreditCustomers(data, args, now = new Date()) {
  const limit = args.limit ?? 20;
  const range = resolvePeriod(args, now);

  const rows = new Map();
  for (const t of data.transactions) {
    if (t.type !== "GAVE") continue;
    if (!inRange(t.createdAt, range.fromMs, range.toMs)) continue;
    const credit = Math.max(0, t.amount - t.paid);
    if (credit <= EPS) continue;

    const key = t.customerId || `name:${norm(t.customerName)}`;
    const row = rows.get(key) ?? {
      customerId: t.customerId,
      name: t.customerName || "Walk-in Customer",
      credit: 0,
      bills: 0,
      items: [],
    };
    row.credit = round2(row.credit + credit);
    row.bills += 1;
    for (const item of t.items) {
      if (item.name && !row.items.includes(item.name)) row.items.push(item.name);
    }
    rows.set(key, row);
  }

  const list = [...rows.values()].sort((a, b) => b.credit - a.credit);

  return {
    period: { key: range.key, label: range.label, from: range.from, to: range.to },
    totalCredit: round2(list.reduce((s, r) => s + r.credit, 0)),
    customerCount: list.length,
    customers: list.slice(0, limit),
  };
}

export function listPayments(data, args, now = new Date()) {
  const limit = args.limit ?? 20;
  const range = resolvePeriod(args, now);

  const rows = new Map();
  for (const t of data.transactions) {
    if (t.type !== "GOT" || isSalePayment(t)) continue;
    if (!inRange(t.createdAt, range.fromMs, range.toMs)) continue;

    const key = t.customerId || `name:${norm(t.customerName)}`;
    const row = rows.get(key) ?? {
      customerId: t.customerId,
      name: t.customerName || "Walk-in Customer",
      amount: 0,
      payments: 0,
    };
    row.amount = round2(row.amount + t.amount);
    row.payments += 1;
    rows.set(key, row);
  }

  const list = [...rows.values()].sort((a, b) => b.amount - a.amount);

  return {
    period: { key: range.key, label: range.label, from: range.from, to: range.to },
    totalReceived: round2(list.reduce((s, r) => s + r.amount, 0)),
    customerCount: list.length,
    customers: list.slice(0, limit),
  };
}

export const HANDLERS = {
  searchCustomer,
  calculateBalance,
  getSalesSummary,
  listDefaulters,
  listCreditCustomers,
  listPayments,
};

/** Sanity check: handlers ke naam definitions se match karein. */
export function assertHandlersRegistered(definitions) {
  for (const def of definitions) {
    const name = def.function.name;
    if (typeof HANDLERS[name] !== "function") {
      throw new Error(`Function "${name}" ka handler missing hai.`);
    }
  }
  if (Object.keys(HANDLERS).length !== definitions.length) {
    throw new Error("HANDLERS aur FUNCTION_DEFINITIONS ka count match nahi karta.");
  }
}

export { FunctionError };

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
        customerPhone: typeof t.customerPhone === "string" ? t.customerPhone.slice(0, 30) : "",
        walkIn: !t.customerId,
        createdAt: isoDate(t.createdAt),
        items: (Array.isArray(t.items) ? t.items : [])
          .filter((i) => i && typeof i === "object")
          .slice(0, 100)
          .map((i) => {
            const cost = i.cost === undefined || i.cost === null ? null : round2(num(i.cost));
            return {
              name: String(i.name ?? "").slice(0, 60),
              qty: round2(num(i.qty)),
              unit: String(i.unit ?? "pc").slice(0, 20),
              price: round2(num(i.price)),
              ...(cost === null ? {} : { cost }),
            };
          }),
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
  const phone = phoneTail(customer.phone);
  return data.transactions.filter((t) => {
    if (t.customerId) return t.customerId === customer.id;
    if (norm(t.customerName) !== name) return false;
    // Legacy entries jinka customerId nahi tha: sirf tab jodein jab phone match kare,
    // warna kisi walk-in ka bill ghalat customer ke khate mein chala jayega.
    return phone.length >= 7 && phoneTail(t.customerPhone) === phone;
  });
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
    summary:
      `${range.label}: kul sale ${formatRs(totalSales)} (${sales.length} bills), ` +
      `sale ke waqt cash ${formatRs(cashAtSale)}, udhaar ${formatRs(creditGiven)}, ` +
      `purani wasooli ${formatRs(recovery)}, kharchay ${formatRs(expenseTotal)}. ` +
      (profitComplete
        ? `Munafa ${formatRs(grossProfit)}${profitEstimated ? " (kuch takhmina)" : ""}; ` +
          `kharchon ke baad net ${formatRs(grossProfit - expenseTotal)}.`
        : "Kuch entries ka cost saved nahi, is liye mukammal munafa maloom nahi."),
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

/* ------------------------------------------------------------------ */
/* Complete database query layer                                       */
/* ------------------------------------------------------------------ */

const phoneTail = (value) => {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
};

function phoneMatches(stored, query) {
  const q = String(query ?? "").replace(/\D/g, "");
  if (!q) return true;
  const s = String(stored ?? "").replace(/\D/g, "");
  if (!s) return false;
  const variants = new Set([q, q.replace(/^0+/, ""), phoneTail(q)]);
  for (const v of variants) {
    if (v && (s.includes(v) || phoneTail(s).includes(v))) return true;
  }
  return false;
}

const dateMs = (iso) => {
  const t = Date.parse(String(iso ?? ""));
  return Number.isFinite(t) ? t : 0;
};

const textHas = (haystack, needle) => {
  const q = norm(needle);
  return !q || norm(haystack).includes(q);
};

function txKindOf(tx) {
  if (tx.type === "GAVE") return "sale";
  return isSalePayment(tx) ? "sale-payment" : "payment";
}

/** Walk-in customer ko phone/naam se pehchaan; bina pehchaan wala har bill alag. */
function buyerKey(tx) {
  if (tx.customerId) return `id:${tx.customerId}`;
  const phone = phoneTail(tx.customerPhone);
  if (phone.length >= 7) return `phone:${phone}`;
  const name = norm(tx.customerName);
  if (name && name !== "walk in customer") return `name:${name}`;
  return `entry:${tx.id}`;
}

function txPhone(tx, customerById) {
  return (
    tx.customerPhone ||
    (tx.customerId ? customerById.get(tx.customerId)?.phone : "") ||
    ""
  );
}

function txRecord(tx, customerById) {
  const due = tx.type === "GAVE" ? Math.max(0, tx.amount - tx.paid) : 0;
  return {
    id: tx.id,
    date: tx.createdAt,
    kind: txKindOf(tx),
    walkIn: tx.walkIn === true,
    customerId: tx.customerId,
    customerName:
      tx.customerName || (tx.customerId ? "Customer" : "Walk-in Customer"),
    phone: txPhone(tx, customerById) || null,
    amount: round2(tx.amount),
    paid: round2(tx.paid),
    due: round2(due),
    itemsText:
      tx.items
        .map((i) => `${i.name} ${i.qty} ${i.unit} @ ${i.price}`)
        .join(", ") || null,
    receiptNo: tx.receiptNo || null,
    note: tx.note || null,
  };
}

const fmtDate = (iso) => {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString("en-PK", {
      timeZone: "Asia/Karachi",
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return String(iso).slice(0, 10);
  }
};

function emptyStats(customer) {
  return {
    customer,
    salesTotal: 0,
    cashAtSale: 0,
    creditGiven: 0,
    recovered: 0,
    bills: 0,
    payments: 0,
    firstActivity: null,
    lastActivity: null,
    items: new Map(),
  };
}

/**
 * Har customer ke lifetime totals ek dafa calculate karta hai.
 * Sirf transactions jinka customerId customer record se match karta hai.
 */
function buildCustomerStats(data) {
  const map = new Map();
  for (const customer of data.customers) map.set(customer.id, emptyStats(customer));

  for (const t of data.transactions) {
    const row = t.customerId ? map.get(t.customerId) : null;
    if (!row) continue;

    const at = dateMs(t.createdAt);
    if (at) {
      if (!row.firstActivity || at < row.firstActivity) row.firstActivity = at;
      if (!row.lastActivity || at > row.lastActivity) row.lastActivity = at;
    }

    if (t.type === "GAVE") {
      row.salesTotal += t.amount;
      row.cashAtSale += t.paid;
      row.creditGiven += Math.max(0, t.amount - t.paid);
      row.bills += 1;
      for (const item of t.items) {
        const key = `${norm(item.name)}|${item.unit}`;
        const ir = row.items.get(key) ?? {
          name: item.name,
          unit: item.unit,
          qty: 0,
          revenue: 0,
        };
        ir.qty = round2(ir.qty + item.qty);
        ir.revenue = round2(ir.revenue + item.qty * item.price);
        row.items.set(key, ir);
      }
    } else if (!isSalePayment(t)) {
      row.recovered += t.amount;
      row.payments += 1;
    }
  }

  return map;
}

function statsRecord(row) {
  const c = row.customer;
  return {
    id: c.id,
    name: c.name,
    phone: c.phone || null,
    balance: round2(c.totalBalance),
    balanceInfo: balanceInfo(c.totalBalance),
    salesTotal: round2(row.salesTotal),
    cashAtSale: round2(row.cashAtSale),
    creditGiven: round2(row.creditGiven),
    recovered: round2(row.recovered),
    bills: row.bills,
    payments: row.payments,
    avgBill: row.bills ? round2(row.salesTotal / row.bills) : 0,
    firstActivity: row.firstActivity
      ? new Date(row.firstActivity).toISOString()
      : null,
    lastActivity: row.lastActivity
      ? new Date(row.lastActivity).toISOString()
      : null,
  };
}

function resolveCustomerForProfile(data, args) {
  if (args.customerId) {
    const customer =
      data.customers.find((c) => c.id === args.customerId) || null;
    return customer
      ? { customer }
      : {
          error: {
            found: false,
            reason: `Is customerId (${args.customerId}) ka koi record nahi mila.`,
          },
        };
  }

  if (args.phone) {
    const matches = data.customers.filter((c) => phoneMatches(c.phone, args.phone));
    if (matches.length === 1) return { customer: matches[0] };
    if (matches.length > 1) return { ambiguous: matches };
  }

  if (args.customerName) {
    const matches = matchCustomers(data, args.customerName);
    if (matches.length === 0) {
      return {
        error: {
          found: false,
          reason: `"${args.customerName}" naam ka koi customer records mein nahi mila.`,
        },
      };
    }
    const topScore = matches[0].score;
    const topMatches = matches.filter((m) => m.score === topScore);
    if (topMatches.length > 1) {
      return { ambiguous: topMatches.map((m) => m.customer) };
    }
    return { customer: matches[0].customer };
  }

  return {
    error: {
      found: false,
      reason: "customerId, customerName ya phone mein se kam az kam ek dena zaroori hai.",
    },
  };
}

const CUSTOMER_SORTS = {
  balanceDesc: (a, b) => b.customer.totalBalance - a.customer.totalBalance,
  balanceAsc: (a, b) => a.customer.totalBalance - b.customer.totalBalance,
  salesDesc: (a, b) => b.salesTotal - a.salesTotal,
  billsDesc: (a, b) => b.bills - a.bills,
  recent: (a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0),
  nameAsc: (a, b) => a.customer.name.localeCompare(b.customer.name),
  nameDesc: (a, b) => b.customer.name.localeCompare(a.customer.name),
};

export function queryCustomers(data, args) {
  const limit = args.limit ?? 20;
  const offset = args.offset ?? 0;
  const kind = args.balanceKind ?? "any";
  const stats = buildCustomerStats(data);

  let rows = data.customers.map((c) => stats.get(c.id)).filter(Boolean);

  if (args.name) rows = rows.filter((r) => textHas(r.customer.name, args.name));
  if (args.phone) rows = rows.filter((r) => phoneMatches(r.customer.phone, args.phone));

  if (args.search) {
    rows = rows.filter(
      (r) =>
        textHas(r.customer.name, args.search) ||
        phoneMatches(r.customer.phone, args.search) ||
        [...r.items.values()].some((i) => textHas(i.name, args.search)),
    );
  }

  if (kind === "receivable") {
    rows = rows.filter((r) => r.customer.totalBalance > EPS);
  } else if (kind === "payable") {
    rows = rows.filter((r) => r.customer.totalBalance < -EPS);
  } else if (kind === "settled") {
    rows = rows.filter((r) => Math.abs(r.customer.totalBalance) <= EPS);
  }

  if (typeof args.minBalance === "number") {
    rows = rows.filter((r) => r.customer.totalBalance >= args.minBalance);
  }
  if (typeof args.maxBalance === "number") {
    rows = rows.filter((r) => r.customer.totalBalance <= args.maxBalance);
  }
  if (args.hasPhone === true) {
    rows = rows.filter((r) => phoneTail(r.customer.phone).length >= 7);
  } else if (args.hasPhone === false) {
    rows = rows.filter((r) => phoneTail(r.customer.phone).length < 7);
  }

  rows.sort(CUSTOMER_SORTS[args.sort] ?? CUSTOMER_SORTS.balanceDesc);

  const receivable = rows.filter((r) => r.customer.totalBalance > EPS);
  const payable = rows.filter((r) => r.customer.totalBalance < -EPS);
  const totalReceivable = round2(
    receivable.reduce((s, r) => s + r.customer.totalBalance, 0),
  );
  const totalPayable = round2(
    payable.reduce((s, r) => s + Math.abs(r.customer.totalBalance), 0),
  );

  const page = rows.slice(offset, offset + limit);
  const hasMore = offset + page.length < rows.length;

  return {
    matched: rows.length,
    shown: page.length,
    offset,
    nextOffset: hasMore ? offset + page.length : null,
    hasMore,
    totals: {
      receivable: totalReceivable,
      receivableCustomers: receivable.length,
      payable: totalPayable,
      payableCustomers: payable.length,
      settledCustomers: rows.filter((r) => Math.abs(r.customer.totalBalance) <= EPS)
        .length,
      salesTotal: round2(rows.reduce((s, r) => s + r.salesTotal, 0)),
      recovered: round2(rows.reduce((s, r) => s + r.recovered, 0)),
    },
    customers: page.map(statsRecord),
    summary:
      `${rows.length} customer match hue. ` +
      `${receivable.length} se kul ${formatRs(totalReceivable)} lene hain; ` +
      `${payable.length} ko kul ${formatRs(totalPayable)} dene hain; ` +
      `${rows.filter((r) => Math.abs(r.customer.totalBalance) <= EPS).length} ka hisaab barabar hai. ` +
      `${page.length} customers dikhaye gaye hain` +
      (hasMore ? `; agli list ke liye offset ${offset + page.length} use karein.` : "."),
  };
}

const TX_SORTS = {
  newest: (a, b) => dateMs(b.createdAt) - dateMs(a.createdAt),
  oldest: (a, b) => dateMs(a.createdAt) - dateMs(b.createdAt),
  amountDesc: (a, b) => b.amount - a.amount,
  amountAsc: (a, b) => a.amount - b.amount,
};

export function queryTransactions(data, args, now = new Date()) {
  const limit = args.limit ?? 10;
  const offset = args.offset ?? 0;
  const kind = args.type ?? "any";
  const range = resolvePeriod({ ...args, period: args.period ?? "allTime" }, now);
  const customerById = new Map(data.customers.map((c) => [c.id, c]));

  let rows = data.transactions.filter((t) =>
    inRange(t.createdAt, range.fromMs, range.toMs),
  );

  if (kind !== "any") rows = rows.filter((t) => txKindOf(t) === kind);
  if (args.customerId) rows = rows.filter((t) => t.customerId === args.customerId);
  if (args.customerName) {
    rows = rows.filter((t) => textHas(t.customerName, args.customerName));
  }
  if (typeof args.walkIn === "boolean") {
    rows = rows.filter((t) => (t.walkIn === true) === args.walkIn);
  }
  if (args.phone) {
    rows = rows.filter((t) =>
      phoneMatches(txPhone(t, customerById), args.phone),
    );
  }
  if (args.itemName) {
    rows = rows.filter((t) =>
      t.items.some((i) => textHas(i.name, args.itemName)),
    );
  }
  if (args.receiptNo) {
    rows = rows.filter((t) => textHas(t.receiptNo || "", args.receiptNo));
  }
  if (args.search) {
    rows = rows.filter((t) => {
      const haystacks = [
        t.customerName,
        txPhone(t, customerById),
        t.note,
        t.receiptNo || "",
        ...t.items.map((i) => i.name),
      ];
      return haystacks.some((h) => textHas(h, args.search));
    });
  }
  if (typeof args.minAmount === "number") {
    rows = rows.filter((t) => t.amount >= args.minAmount);
  }
  if (typeof args.maxAmount === "number") {
    rows = rows.filter((t) => t.amount <= args.maxAmount);
  }

  rows.sort(TX_SORTS[args.sort] ?? TX_SORTS.newest);

  const sales = rows.filter((t) => t.type === "GAVE");
  const payments = rows.filter((t) => t.type === "GOT" && !isSalePayment(t));
  const salePayments = rows.filter((t) => t.type === "GOT" && isSalePayment(t));

  const totals = {
    matched: rows.length,
    bills: sales.length,
    salesTotal: round2(sales.reduce((s, t) => s + t.amount, 0)),
    cashAtSale: round2(sales.reduce((s, t) => s + t.paid, 0)),
    creditGiven: round2(
      sales.reduce((s, t) => s + Math.max(0, t.amount - t.paid), 0),
    ),
    recovered: round2(payments.reduce((s, t) => s + t.amount, 0)),
    salePayments: round2(salePayments.reduce((s, t) => s + t.amount, 0)),
    buyers: new Set(rows.map(buyerKey)).size,
  };

  const page = rows.slice(offset, offset + limit);
  const hasMore = offset + page.length < rows.length;

  return {
    period: {
      key: range.key,
      label: range.label,
      from: range.from,
      to: range.to,
    },
    matched: rows.length,
    shown: page.length,
    offset,
    nextOffset: hasMore ? offset + page.length : null,
    hasMore,
    totals,
    transactions: page.map((t) => txRecord(t, customerById)),
    summary:
      `${range.label}: ${rows.length} entries mile (${sales.length} sale bills). ` +
      `Kul sale ${formatRs(totals.salesTotal)}, sale ke waqt cash ${formatRs(totals.cashAtSale)}, ` +
      `udhaar ${formatRs(totals.creditGiven)}, purani wasooli ${formatRs(totals.recovered)}, ` +
      `sale-cash ${formatRs(totals.salePayments)}. ` +
      `${page.length} entries dikhayi gayi hain` +
      (hasMore ? `; agli entries offset ${offset + page.length} se milengi.` : "."),
  };
}

export function getCustomerProfile(data, args) {
  const resolved = resolveCustomerForProfile(data, args);

  if (resolved.error) return resolved.error;
  if (resolved.ambiguous) {
    return {
      found: false,
      ambiguous: true,
      matches: resolved.ambiguous.slice(0, 10).map((c) => ({
        id: c.id,
        name: c.name,
        phone: c.phone || null,
        balance: c.totalBalance,
        balanceInfo: balanceInfo(c.totalBalance),
      })),
      note: "Ek se zyada customer mile hain. customerId de kar dobara poocho.",
    };
  }

  const customer = resolved.customer;
  const stats = buildCustomerStats(data).get(customer.id);
  const customerById = new Map(data.customers.map((c) => [c.id, c]));
  const entries = customerTx(data, customer);
  const phone =
    customer.phone ||
    entries.find((t) => t.customerPhone)?.customerPhone ||
    "";
  const includeEntries = args.includeEntries !== false;
  const entriesLimit = args.entriesLimit ?? 10;

  const lifetime = stats
    ? {
        salesTotal: round2(stats.salesTotal),
        cashAtSale: round2(stats.cashAtSale),
        creditGiven: round2(stats.creditGiven),
        recovered: round2(stats.recovered),
        bills: stats.bills,
        payments: stats.payments,
        avgBill: stats.bills ? round2(stats.salesTotal / stats.bills) : 0,
        firstVisit: stats.firstActivity
          ? new Date(stats.firstActivity).toISOString()
          : null,
        lastVisit: stats.lastActivity
          ? new Date(stats.lastActivity).toISOString()
          : null,
      }
    : null;

  const topItems = stats
    ? [...stats.items.values()]
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 5)
    : [];

  const balance = customer.totalBalance;
  const result = {
    found: true,
    customer: {
      id: customer.id,
      name: customer.name,
      phone: phone || null,
      customerSince: customer.createdAt,
    },
    balance: balanceInfo(balance),
    pending: {
      receivable: round2(Math.max(0, balance)),
      payable: round2(Math.max(0, -balance)),
    },
    lifetime,
    topItems,
    entriesCount: entries.length,
    summary:
      `${customer.name}${phone ? ` (${phone})` : " (phone saved nahi)"}: ` +
      `${balanceInfo(balance).label}. ` +
      (lifetime
        ? `Ab tak ${formatRs(lifetime.salesTotal)} ki sale, ${formatRs(
            lifetime.creditGiven,
          )} udhaar, ${formatRs(lifetime.recovered)} wasooli; ${lifetime.bills} bills. `
        : "") +
      `Aakhri activity: ${
        lifetime?.lastVisit ? fmtDate(lifetime.lastVisit) : "koi entry nahi"
      }.`,
  };

  if (includeEntries) {
    result.entries = entries
      .slice(0, entriesLimit)
      .map((t) => txRecord(t, customerById));
  }

  return result;
}

export function getItemReport(data, args, now = new Date()) {
  const limit = args.limit ?? 10;
  const range = resolvePeriod({ ...args, period: args.period ?? "allTime" }, now);
  const customerById = new Map(data.customers.map((c) => [c.id, c]));
  const rows = new Map();
  const matchedBills = new Set();
  const allBuyers = new Set();

  for (const t of data.transactions) {
    if (t.type !== "GAVE") continue;
    if (!inRange(t.createdAt, range.fromMs, range.toMs)) continue;

    for (const item of t.items) {
      if (args.itemName && !textHas(item.name, args.itemName)) continue;

      const key = `${norm(item.name)}|${item.unit}`;
      let row = rows.get(key);
      if (!row) {
        row = {
          name: item.name,
          unit: item.unit,
          qty: 0,
          revenue: 0,
          costTotal: 0,
          costKnown: true,
          bills: new Set(),
          buyers: new Map(),
          lastSold: null,
        };
        rows.set(key, row);
      }

      row.qty = round2(row.qty + item.qty);
      row.revenue = round2(row.revenue + item.qty * item.price);
      if (item.cost === undefined || item.cost === null) {
        row.costKnown = false;
      } else {
        row.costTotal = round2(row.costTotal + item.qty * item.cost);
      }
      row.bills.add(t.id);
      matchedBills.add(t.id);

      const bk = buyerKey(t);
      allBuyers.add(bk);
      const buyer = row.buyers.get(bk) ?? {
        name: t.customerName || "Walk-in Customer",
        phone: txPhone(t, customerById) || null,
        qty: 0,
        revenue: 0,
        bills: 0,
      };
      buyer.qty = round2(buyer.qty + item.qty);
      buyer.revenue = round2(buyer.revenue + item.qty * item.price);
      buyer.bills += 1;
      row.buyers.set(bk, buyer);

      if (!row.lastSold || dateMs(t.createdAt) > dateMs(row.lastSold)) {
        row.lastSold = t.createdAt;
      }
    }
  }

  const list = [...rows.values()].map((r) => ({
    name: r.name,
    unit: r.unit,
    qty: r.qty,
    revenue: r.revenue,
    bills: r.bills.size,
    buyers: r.buyers.size,
    profit: r.costKnown ? round2(r.revenue - r.costTotal) : null,
    profitNote: r.costKnown
      ? null
      : "Kuch entries ka purchase cost saved nahi, is liye asli munafa maloom nahi.",
    lastSold: r.lastSold,
    topBuyers: [...r.buyers.values()]
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 3),
  }));

  const sorters = {
    revenue: (a, b) => b.revenue - a.revenue,
    qty: (a, b) => b.qty - a.qty,
    profit: (a, b) => (b.profit ?? -1) - (a.profit ?? -1),
    buyers: (a, b) => b.buyers - a.buyers,
  };
  list.sort(sorters[args.sort] ?? sorters.revenue);

  const page = list.slice(0, limit);
  const totalRevenue = round2(list.reduce((s, i) => s + i.revenue, 0));
  const totalQty = round2(list.reduce((s, i) => s + i.qty, 0));
  const profitComplete = list.length > 0 && list.every((i) => i.profit !== null);
  const totalProfit = profitComplete
    ? round2(list.reduce((s, i) => s + i.profit, 0))
    : null;

  return {
    period: {
      key: range.key,
      label: range.label,
      from: range.from,
      to: range.to,
    },
    matched: list.length,
    shown: page.length,
    totals: {
      itemTypes: list.length,
      bills: matchedBills.size,
      buyers: allBuyers.size,
      qty: totalQty,
      revenue: totalRevenue,
      profit: totalProfit,
    },
    items: page,
    summary:
      `${range.label}: ${list.length} qism ke items biken. ` +
      `Kul sale ${formatRs(totalRevenue)}, kul quantity ${totalQty}, ` +
      `${matchedBills.size} bills, ${allBuyers.size} buyers. ` +
      (profitComplete
        ? `Asli munafa ${formatRs(totalProfit)}. `
        : "Kuch items ka cost saved nahi, is liye mukammal munafa maloom nahi. ") +
      (page.length
        ? `Sab se aage: ${page
            .slice(0, 3)
            .map((i) => `${i.name} (${formatRs(i.revenue)})`)
            .join(", ")}.`
        : "Is filter par koi item nahi mila."),
  };
}

const EXPENSE_SORTS = {
  newest: (a, b) => dateMs(b.createdAt) - dateMs(a.createdAt),
  oldest: (a, b) => dateMs(a.createdAt) - dateMs(b.createdAt),
  amountDesc: (a, b) => b.amount - a.amount,
  amountAsc: (a, b) => a.amount - b.amount,
};

export function getExpenseReport(data, args, now = new Date()) {
  const limit = args.limit ?? 20;
  const offset = args.offset ?? 0;
  const range = resolvePeriod({ ...args, period: args.period ?? "allTime" }, now);

  let rows = data.expenses.filter((e) =>
    inRange(e.createdAt, range.fromMs, range.toMs),
  );
  if (args.category) {
    rows = rows.filter((e) => textHas(e.category, args.category));
  }
  if (args.search) {
    rows = rows.filter(
      (e) => textHas(e.category, args.search) || textHas(e.note, args.search),
    );
  }

  const byCategory = new Map();
  for (const e of rows) {
    const key = e.category || "Other";
    const row = byCategory.get(key) ?? { category: key, total: 0, entries: 0 };
    row.total = round2(row.total + e.amount);
    row.entries += 1;
    byCategory.set(key, row);
  }

  const total = round2(rows.reduce((s, e) => s + e.amount, 0));
  const sorted = [...rows].sort(
    EXPENSE_SORTS[args.sort] ?? EXPENSE_SORTS.newest,
  );
  const page = sorted.slice(offset, offset + limit);
  const hasMore = offset + page.length < sorted.length;
  const categories = [...byCategory.values()].sort((a, b) => b.total - a.total);

  return {
    period: {
      key: range.key,
      label: range.label,
      from: range.from,
      to: range.to,
    },
    matched: rows.length,
    shown: page.length,
    offset,
    nextOffset: hasMore ? offset + page.length : null,
    hasMore,
    totals: { total, entries: rows.length, categories: categories.length },
    byCategory: categories,
    expenses: page.map((e) => ({
      id: e.id,
      date: e.createdAt,
      category: e.category,
      amount: e.amount,
      note: e.note || null,
    })),
    summary:
      `${range.label}: ${rows.length} kharchay, kul ${formatRs(total)}. ` +
      (categories.length
        ? `Sab se bara: ${categories
            .slice(0, 3)
            .map((c) => `${c.category} ${formatRs(c.total)}`)
            .join(", ")}. `
        : "") +
      `${page.length} entries dikhayi gayi hain` +
      (hasMore ? `; agli entries offset ${offset + page.length} se.` : "."),
  };
}

export function getDatabaseOverview(data) {
  const customerById = new Map(data.customers.map((c) => [c.id, c]));

  const sales = data.transactions.filter((t) => t.type === "GAVE");
  const payments = data.transactions.filter(
    (t) => t.type === "GOT" && !isSalePayment(t),
  );
  const salePayments = data.transactions.filter(
    (t) => t.type === "GOT" && isSalePayment(t),
  );

  const salesTotal = round2(sales.reduce((s, t) => s + t.amount, 0));
  const cashAtSale = round2(sales.reduce((s, t) => s + t.paid, 0));
  const creditGiven = round2(
    sales.reduce((s, t) => s + Math.max(0, t.amount - t.paid), 0),
  );
  const recovered = round2(payments.reduce((s, t) => s + t.amount, 0));
  const salePaymentsTotal = round2(
    salePayments.reduce((s, t) => s + t.amount, 0),
  );
  const expensesTotal = round2(data.expenses.reduce((s, e) => s + e.amount, 0));

  const profitComplete = sales.every((t) => t.profit !== null);
  const grossProfit = round2(sales.reduce((s, t) => s + (t.profit ?? 0), 0));
  const profitEstimated = sales.some((t) => t.profitEstimated);

  const timestamps = data.transactions
    .map((t) => dateMs(t.createdAt))
    .filter((t) => t > 0);
  const firstAt = timestamps.length
    ? timestamps.reduce((min, t) => (t < min ? t : min), timestamps[0])
    : null;
  const lastAt = timestamps.length
    ? timestamps.reduce((max, t) => (t > max ? t : max), timestamps[0])
    : null;

  const walkInSales = sales.filter((t) => t.walkIn === true);
  const walkInKeys = new Map();
  for (const t of walkInSales) {
    const key = buyerKey(t);
    const row = walkInKeys.get(key) ?? {
      key,
      phone: phoneTail(txPhone(t, customerById)),
      name: t.customerName,
      bills: 0,
      amount: 0,
    };
    row.bills += 1;
    row.amount = round2(row.amount + t.amount);
    walkInKeys.set(key, row);
  }
  const identified = [...walkInKeys.values()].filter(
    (r) => !r.key.startsWith("entry:"),
  );
  const withPhone = identified.filter((r) => r.phone.length >= 7);

  const itemsMissingCost = sales.reduce(
    (count, t) =>
      count + t.items.filter((i) => i.cost === undefined).length,
    0,
  );

  const orphans = data.transactions.filter(
    (t) => t.customerId && !customerById.has(t.customerId),
  ).length;

  const customersMissingPhone = data.customers.filter(
    (c) => phoneTail(c.phone).length < 7,
  ).length;

  const walkInMissingPhone = walkInSales.filter(
    (t) => phoneTail(t.customerPhone).length < 7,
  ).length;

  const unreadableDates = data.transactions.filter(
    (t) => !dateMs(t.createdAt),
  ).length;

  return {
    generatedAt: new Date().toISOString(),
    coverage: {
      customers: data.customers.length,
      transactions: data.transactions.length,
      expenses: data.expenses.length,
      firstTransactionAt: firstAt ? new Date(firstAt).toISOString() : null,
      lastTransactionAt: lastAt ? new Date(lastAt).toISOString() : null,
    },
    counts: {
      sales: sales.length,
      payments: payments.length,
      salePayments: salePayments.length,
      receipts: new Set(sales.map((t) => t.receiptNo).filter(Boolean)).size,
      customersWithDues: data.customers.filter((c) => c.totalBalance > EPS)
        .length,
      customersWithAdvance: data.customers.filter((c) => c.totalBalance < -EPS)
        .length,
      settledCustomers: data.customers.filter(
        (c) => Math.abs(c.totalBalance) <= EPS,
      ).length,
    },
    money: {
      salesTotal,
      cashAtSale,
      creditGiven,
      recovered,
      salePaymentsAtSale: salePaymentsTotal,
      expenses: expensesTotal,
      grossProfit: profitComplete ? grossProfit : null,
      netProfit: profitComplete ? round2(grossProfit - expensesTotal) : null,
      profitEstimated,
      receivableTotal: round2(
        data.customers
          .filter((c) => c.totalBalance > EPS)
          .reduce((s, c) => s + c.totalBalance, 0),
      ),
      payableTotal: round2(
        data.customers
          .filter((c) => c.totalBalance < -EPS)
          .reduce((s, c) => s + Math.abs(c.totalBalance), 0),
      ),
    },
    walkIn: {
      bills: walkInSales.length,
      amount: round2(walkInSales.reduce((s, t) => s + t.amount, 0)),
      uniqueIdentifiedCustomers: identified.length,
      withPhone: withPhone.length,
      repeatCustomers: identified.filter((r) => r.bills > 1).length,
      anonymousBills: walkInSales.length - identified.reduce((s, r) => s + r.bills, 0),
      customers: identified
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 10)
        .map((r) => ({
          name: r.name || "Walk-in Customer",
          phone: r.phone || null,
          bills: r.bills,
          amount: r.amount,
        })),
    },
    dataQuality: {
      customersMissingPhone,
      walkInMissingPhoneBills: walkInMissingPhone,
      itemsMissingCost,
      transactionsMissingDate: unreadableDates,
      transactionsWithUnknownCustomer: orphans,
    },
    summary:
      `Database mein ${data.customers.length} customers, ${data.transactions.length} transactions ` +
      `aur ${data.expenses.length} expenses hain. ` +
      `Data ${fmtDate(firstAt ? new Date(firstAt).toISOString() : null) ?? "shuru"} se ` +
      `${fmtDate(lastAt ? new Date(lastAt).toISOString() : null) ?? "ab tak"} tak hai. ` +
      `Ab tak sale ${formatRs(salesTotal)}, sale ke waqt cash ${formatRs(
        cashAtSale,
      )}, udhaar ${formatRs(creditGiven)}, wasooli ${formatRs(recovered)}, ` +
      `kharchay ${formatRs(expensesTotal)}, ` +
      (profitComplete
        ? `munafa ${formatRs(grossProfit)}${profitEstimated ? " (kuch takhmina)" : ""}. `
        : "munafa mukammal maloom nahi (cost missing). ") +
      `Walk-in: ${walkInSales.length} bills, ${identified.length} pehchane gaye customers, ` +
      `un mein ${withPhone.length} ke phone saved hain. ` +
      `${customersMissingPhone} customers ke phone saved nahi.`,
  };
}

export const HANDLERS = {
  searchCustomer,
  calculateBalance,
  getSalesSummary,
  listDefaulters,
  listCreditCustomers,
  listPayments,
  queryTransactions,
  queryCustomers,
  getCustomerProfile,
  getItemReport,
  getExpenseReport,
  getDatabaseOverview,
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

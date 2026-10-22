// OpenAI-style function schemas. Ye definitions LLM ko batati hain
// ke Munshi AI live dukan data se kya kya pooch sakta hai.
//
// Descriptions jaan boojh kar chhoti hain: har tool definition har request
// ke saath jati hai, is liye lambi tafseel token budget aur rate limit kha
// jati hai. Sirf wahi params rakhe gaye hain jo sawalon ke liye zaroori hain.

const PERIOD_DESCRIPTION =
  'Period (Pakistan time): "today", "yesterday", "last7days", "thisMonth", ' +
  '"lastMonth", "allTime", ya "custom" (from/to ISO dates ke saath).';

const PERIOD_PROP = {
  type: "string",
  enum: ["today", "yesterday", "last7days", "thisMonth", "lastMonth", "allTime", "custom"],
  description: PERIOD_DESCRIPTION,
};

export const FUNCTION_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "searchCustomer",
      description:
        "Find customers by name (partial/wrong spelling works). Returns phone, balance and last entry.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Customer name or part of it.", maxLength: 60 },
          limit: {
            type: "integer",
            description: "Max matches (1-20). Default 5.",
            minimum: 1,
            maximum: 20,
            default: 5,
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calculateBalance",
      description:
        "One customer's full khata: current balance, lifetime credit, cash at sale, repayments, last entries.",
      parameters: {
        type: "object",
        properties: {
          customerName: { type: "string", description: "Customer name.", maxLength: 60 },
          customerId: { type: "string", description: "Customer Firestore id if known.", maxLength: 120 },
          includeEntries: {
            type: "boolean",
            description: "Include the last 8 entries. Default false.",
            default: false,
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getSalesSummary",
      description:
        "Sales summary for a period: total sales, cash at sale, credit, repayments, expenses, profit, top items.",
      parameters: {
        type: "object",
        properties: {
          period: { ...PERIOD_PROP, default: "today" },
          from: { type: "string", description: "Custom period start (ISO)." },
          to: { type: "string", description: "Custom period end (ISO)." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "listDefaulters",
      description:
        "Customers who owe money, largest balance first. Also returns total outstanding and advances.",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "integer",
            description: "Max customers (1-200). Default 10.",
            minimum: 1,
            maximum: 200,
            default: 10,
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "listCreditCustomers",
      description:
        "Who bought on credit in a period and how much, with bill count and item names.",
      parameters: {
        type: "object",
        properties: {
          period: { ...PERIOD_PROP, default: "today" },
          from: { type: "string", description: "Custom period start (ISO)." },
          to: { type: "string", description: "Custom period end (ISO)." },
          limit: {
            type: "integer",
            description: "Max customers (1-100). Default 20.",
            minimum: 1,
            maximum: 100,
            default: 20,
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "listPayments",
      description:
        "Old balance repayments received in a period (excludes cash paid at sale time).",
      parameters: {
        type: "object",
        properties: {
          period: { ...PERIOD_PROP, default: "today" },
          from: { type: "string", description: "Custom period start (ISO)." },
          to: { type: "string", description: "Custom period end (ISO)." },
          limit: {
            type: "integer",
            description: "Max customers (1-100). Default 20.",
            minimum: 1,
            maximum: 100,
            default: 20,
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "queryTransactions",
      description:
        "Search EVERY transaction (sales, credit, repayments, cash at sale) by period, type, customer, " +
        "phone, item, receipt, free text or walk-in. For walk-in (bina khate) customers, set walkIn=true. " +
        "Returns exact totals, pagination (hasMore/nextOffset) and full entries with phone, items, amount, " +
        "paid, due, receipt and note. Use this for \"kaun aaya\", \"walk-in ne kya kharida\", " +
        "\"walk-in ke numbers\", \"is receipt mein kya tha\", \"Ali ki saari entries\".",
      parameters: {
        type: "object",
        properties: {
          period: { ...PERIOD_PROP, default: "allTime" },
          from: { type: "string", description: "Custom period start (ISO)." },
          to: { type: "string", description: "Custom period end (ISO)." },
          type: {
            type: "string",
            enum: ["any", "sale", "payment", "sale-payment"],
            description:
              "sale = goods/credit given; payment = old balance repaid; sale-payment = cash paid at sale; any = all.",
            default: "any",
          },
          customerName: { type: "string", description: "Customer name or part.", maxLength: 60 },
          phone: { type: "string", description: "Phone number or part.", maxLength: 30 },
          itemName: { type: "string", description: "Item name or part.", maxLength: 60 },
          receiptNo: { type: "string", description: "Receipt number or part.", maxLength: 40 },
          search: {
            type: "string",
            description: "Free-text search in customer, phone, note, item and receipt.",
            maxLength: 80,
          },
          walkIn: {
            type: "boolean",
            description: "true = only walk-in (no khata) customers; false = only registered customers.",
          },
          sort: {
            type: "string",
            enum: ["newest", "oldest", "amountDesc", "amountAsc"],
            default: "newest",
          },
          limit: {
            type: "integer",
            description: "Entries per page (1-100). Default 10.",
            minimum: 1,
            maximum: 100,
            default: 10,
          },
          offset: {
            type: "integer",
            description: "Pagination offset; use nextOffset for the next page.",
            minimum: 0,
            maximum: 100000,
            default: 0,
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "queryCustomers",
      description:
        "Filter and sort ALL REGISTERED customers: name, phone, owes/advance/settled, phone saved or not, " +
        "top buyers by lifetime sales or bills. Each row has lifetime sales, repayments, bills, " +
        "average bill and last activity. Returns exact totals and pagination. " +
        "Walk-in (bina khate) customers is list mein nahi aate — unke liye queryTransactions walkIn=true. " +
        "Use for \"saare customers\", \"kis ka phone nahi\", \"sab se zyada kharidne wala\".",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Customer name or part.", maxLength: 60 },
          phone: { type: "string", description: "Phone number or part.", maxLength: 30 },
          balanceKind: {
            type: "string",
            enum: ["any", "receivable", "payable", "settled"],
            description:
              "receivable = owes you; payable = has advance; settled = zero balance; any = all.",
            default: "any",
          },
          hasPhone: {
            type: "boolean",
            description: "true = only with phone; false = only without phone.",
          },
          sort: {
            type: "string",
            enum: ["balanceDesc", "balanceAsc", "salesDesc", "billsDesc", "recent", "nameAsc", "nameDesc"],
            description: "Default balanceDesc (largest amount owed first).",
            default: "balanceDesc",
          },
          limit: {
            type: "integer",
            description: "Customers per page (1-200). Default 20.",
            minimum: 1,
            maximum: 200,
            default: 20,
          },
          offset: {
            type: "integer",
            description: "Pagination offset.",
            minimum: 0,
            maximum: 100000,
            default: 0,
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getCustomerProfile",
      description:
        "Full profile of ONE customer: phone, balance, lifetime sales/credit/repayments, bills, " +
        "average bill, first/last visit, top items and recent entries with receipts. " +
        "Use for \"Ali ke baare mein sab kuch\", \"uska number aur aakhri visit\", \"kya kya kharida\".",
      parameters: {
        type: "object",
        properties: {
          customerId: { type: "string", description: "Customer Firestore id (most exact).", maxLength: 120 },
          customerName: { type: "string", description: "Customer name.", maxLength: 60 },
          phone: { type: "string", description: "Customer phone number.", maxLength: 30 },
          includeEntries: {
            type: "boolean",
            description: "Include recent entries. Default true.",
            default: true,
          },
          entriesLimit: {
            type: "integer",
            description: "Recent entries (1-100). Default 10.",
            minimum: 1,
            maximum: 100,
            default: 10,
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getItemReport",
      description:
        "Item-wise sales: qty, revenue, bills, unique buyers, top buyers, and real profit where " +
        "purchase cost is saved. Use for \"sab se zyada kya bika\", \"Chawal kitna bika\".",
      parameters: {
        type: "object",
        properties: {
          period: { ...PERIOD_PROP, default: "allTime" },
          from: { type: "string", description: "Custom period start (ISO)." },
          to: { type: "string", description: "Custom period end (ISO)." },
          itemName: { type: "string", description: "Only this item (name or part).", maxLength: 60 },
          sort: {
            type: "string",
            enum: ["revenue", "qty", "profit", "buyers"],
            description: "Default revenue.",
            default: "revenue",
          },
          limit: {
            type: "integer",
            description: "Items (1-100). Default 10.",
            minimum: 1,
            maximum: 100,
            default: 10,
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getExpenseReport",
      description:
        "Expenses by period, category or note, with category-wise exact totals and entries. " +
        "Use for \"is mahine kitna kharcha\", \"kiraya kitna diya\", \"sab se bara kharcha\".",
      parameters: {
        type: "object",
        properties: {
          period: { ...PERIOD_PROP, default: "allTime" },
          from: { type: "string", description: "Custom period start (ISO)." },
          to: { type: "string", description: "Custom period end (ISO)." },
          category: { type: "string", description: "Category name or part.", maxLength: 40 },
          search: { type: "string", description: "Search category or note.", maxLength: 80 },
          sort: {
            type: "string",
            enum: ["newest", "oldest", "amountDesc", "amountAsc"],
            default: "newest",
          },
          limit: {
            type: "integer",
            description: "Entries (1-100). Default 20.",
            minimum: 1,
            maximum: 100,
            default: 20,
          },
          offset: {
            type: "integer",
            description: "Pagination offset.",
            minimum: 0,
            maximum: 100000,
            default: 0,
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getDatabaseOverview",
      description:
        "One-shot whole-database overview: counts, data date range, all-time sales/cash/credit/" +
        "repayments/expenses/profit, walk-in stats, phone/cost gaps. Good first call when scope is unclear.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
];

export const FUNCTION_NAMES = FUNCTION_DEFINITIONS.map((d) => d.function.name);

// LLM ko sirf ye tools dikhayein. Purane 6 tools endpoints par mojood hain
// (backward compatibility), magar har request mein unki schemas bhejne se
// token budget aur Groq ki rate limit khatam hoti hai.
const TOOL_NAMES = new Set([
  "queryTransactions",
  "queryCustomers",
  "getCustomerProfile",
  "getSalesSummary",
  "getItemReport",
  "getExpenseReport",
  "getDatabaseOverview",
]);

export const TOOL_DEFINITIONS = FUNCTION_DEFINITIONS.filter((d) =>
  TOOL_NAMES.has(d.function.name),
);

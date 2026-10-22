// OpenAI-style function schemas. Ye definitions hi LLM ko batati hain
// ke Munshi AI live dukan data se kya kya pooch sakta hai.

const PERIOD_DESCRIPTION =
  'Muddat (period). "today" (aaj), "yesterday" (kal), "last7days" (pichle 7 din), ' +
  '"thisMonth" (is mahina), "lastMonth" (pichla mahina), "allTime" (ab tak), ' +
  'ya "custom" (is ke saath from/to ISO dates dein). Default "today".';

export const FUNCTION_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "searchCustomer",
      description:
        "Customer ko naam se dhoondein. Bilkul wahi jawab deta hai jo dukan ke khata records " +
        "mein hai: customer ka naam, phone, baqi balance (lena/dena) aur aakhri entry ki date. " +
        "Naam ke hisse (partial) ya galat spelling bhi chal jati hai.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Customer ka naam ya naam ka hissa, Roman Urdu/English mein.",
            minLength: 1,
            maxLength: 60,
          },
          limit: {
            type: "integer",
            description: "Zyada se zyada kitne customer wapas chahiye (1-20). Default 5.",
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
        "Kisi ek customer ka mukammal khata: mojooda baqi balance, kul udhar liya, kul wapas kiya " +
        "(wasooli), entries ki tadaad aur aakhri transactions. Agar naam se ek se zyada customer " +
        "milte hain to function ambiguous matches wapas karta hai.",
      parameters: {
        type: "object",
        properties: {
          customerName: {
            type: "string",
            description: "Customer ka naam (zaroori agar customerId nahi diya).",
            minLength: 1,
            maxLength: 60,
          },
          customerId: {
            type: "string",
            description:
              "Customer ka Firestore id, agar searchCustomer se pehle hi mil gaya ho.",
            maxLength: 120,
          },
          includeEntries: {
            type: "boolean",
            description: "true ho to aakhri 8 transactions bhi wapas karo.",
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
        "Kisi muddat ki sale ka mukammal summary: kul sale, cash sale, udhaar sale, purani " +
        "wasooli, kharchay, munafa aur net cash. 'Aaj kitni sale hui', 'is mahine ka profit', " +
        "'pichle 7 din ka hisaab' jaise sawalon ke liye.",
      parameters: {
        type: "object",
        properties: {
          period: {
            type: "string",
            enum: ["today", "yesterday", "last7days", "thisMonth", "lastMonth", "allTime", "custom"],
            description: PERIOD_DESCRIPTION,
            default: "today",
          },
          from: {
            type: "string",
            description: "Custom period ka shuru (ISO date), sirf period=custom ke saath.",
          },
          to: {
            type: "string",
            description: "Custom period ka aakhir (ISO date), sirf period=custom ke saath.",
          },
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
        "Jin customers se paisa lena hai (udhaar / baqi balance) unki list, sab se zyada " +
        "balance wale pehle. Kul market udhaar bhi batata hai. 'Sab se zyada udhaar kis ka hai', " +
        "'kitne logon se lena hai' jaise sawalon ke liye.",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "integer",
            description: "List mein kitne customers (1-50). Default 10.",
            minimum: 1,
            maximum: 50,
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
        "Kisi muddat mein kis kis customer ne udhaar par samaan liya aur kitna. " +
        "'Aaj kin customers ne udhaar liya', 'is hafte ka udhaar' jaise sawalon ke liye.",
      parameters: {
        type: "object",
        properties: {
          period: {
            type: "string",
            enum: ["today", "yesterday", "last7days", "thisMonth", "lastMonth", "allTime", "custom"],
            description: PERIOD_DESCRIPTION,
            default: "today",
          },
          from: {
            type: "string",
            description: "Custom period ka shuru (ISO date), sirf period=custom ke saath.",
          },
          to: {
            type: "string",
            description: "Custom period ka aakhir (ISO date), sirf period=custom ke saath.",
          },
          limit: {
            type: "integer",
            description: "Zyada se zyada kitne customers (1-50). Default 20.",
            minimum: 1,
            maximum: 50,
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
        "Kisi muddat mein kis customer se purana udhaar wapas mila (wasooli/payment) aur kitna. " +
        "Sale ke waqt diya gaya cash is mein nahi ginte. 'Aaj kis se payment aayi' jaise sawalon ke liye.",
      parameters: {
        type: "object",
        properties: {
          period: {
            type: "string",
            enum: ["today", "yesterday", "last7days", "thisMonth", "lastMonth", "allTime", "custom"],
            description: PERIOD_DESCRIPTION,
            default: "today",
          },
          from: {
            type: "string",
            description: "Custom period ka shuru (ISO date), sirf period=custom ke saath.",
          },
          to: {
            type: "string",
            description: "Custom period ka aakhir (ISO date), sirf period=custom ke saath.",
          },
          limit: {
            type: "integer",
            description: "Zyada se zyada kitne customers (1-50). Default 20.",
            minimum: 1,
            maximum: 50,
            default: 20,
          },
        },
        additionalProperties: false,
      },
    },
  },
];

export const FUNCTION_NAMES = FUNCTION_DEFINITIONS.map((d) => d.function.name);

export const TOOL_DEFINITIONS = FUNCTION_DEFINITIONS;

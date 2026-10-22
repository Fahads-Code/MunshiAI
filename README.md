# Munshi AI — Backend (Function Calling)

Express API jo Munshi AI app ke Smart Business Assistant ko **live Firestore data**
se jawab deta hai. Assistant ab sirf ek fixed payload nahi parhta: wo LLM ke
through khud decide karta hai kaunsa function call karna hai, backend usay
Firestore se chala kar result wapas LLM ko deta hai, aur LLM aakhri jawab Roman
Urdu mein likhta hai.

```
User sawal
   │
   ▼
POST /api/business-assistant
   │
   ▼
LLM (Groq) ──tool_calls──► invokeFunction()
   ▲                          │
   │                          ├─ searchCustomer
   └──── tool results ◄───────┤─ calculateBalance
                              ├─ getSalesSummary
                              ├─ listDefaulters
                              ├─ listCreditCustomers
                              └─ listPayments
                                   │
                                   ▼
                              Firestore (live)
```

Agar LLM/tool path fail ho jaye to backend purane **facts / deterministic
fallback** par chala jata hai, is liye user ko galat ya khali jawab nahi milta.

---

## Endpoints

Sab `/api` routes par Firebase ID token zaroori hai:

```
Authorization: Bearer <firebase-id-token>
```

| Method | Route | Kaam |
| --- | --- | --- |
| `GET` | `/health` | Health check |
| `GET` | `/api/functions` | Available functions ki OpenAI-style JSON schema |
| `POST` | `/api/functions/:name` | Ek function direct chalana (testing/debug) |
| `POST` | `/api/parse-entry` | Voice/text se ek khata entry nikalna |
| `POST` | `/api/business-assistant` | Function-calling assistant ka main endpoint |

### `POST /api/business-assistant`

```json
{
  "question": "Aaj kin customers ne udhaar par samaan liya?",
  "contextId": "firebase-uid",
  "facts": { "period": "Aaj", "totalCreditGiven": 2000 },
  "deterministicAnswer": "### Aaj ka udhaar ..."
}
```

- `question` — zaroori, max 600 characters.
- `contextId` — optional, sirf traceability ke liye. User **hamesha** token se
  verify hota hai; body se `userId` accept nahi hota.
- `facts` / `deterministicAnswer` — optional. Frontend ke local deterministic
  engine ka verified answer; LLM fail hone par yahi wapas milta hai.

Response:

```json
{
  "answer": "Aaj **Ali Khan** ne **Rs. 2,000** ka udhaar liya ...",
  "model": "qwen/qwen3.8-27b",
  "toolsUsed": [{ "name": "listCreditCustomers", "ok": true }],
  "source": "function-calling"
}
```

`source` in mein se ek hota hai: `function-calling`, `facts`, `context`,
`deterministic`.

### `POST /api/functions/:name`

Direct invocation. Body mein `arguments` object (ya seedha object) dein:

```bash
curl -X POST https://munshi-ai-red.vercel.app/api/functions/getSalesSummary \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "arguments": { "period": "last7days" } }'
```

Response:

```json
{
  "ok": true,
  "function": "getSalesSummary",
  "data": {
    "period": { "key": "last7days", "label": "Pichle 7 Din", "from": "...", "to": "..." },
    "sales": { "total": 10500, "bills": 2, "cashAtSale": 1500, "credit": 9000 },
    "recovery": { "total": 500, "entries": 1, "salePaymentsAtSale": 1000 },
    "expenses": { "total": 1300, "entries": 2 },
    "profit": { "gross": 1150, "net": -150, "complete": true, "estimated": true },
    "cashInHand": { "fromSales": 1500, "fromRecovery": 500, "total": 2000, "netAfterExpenses": 700 },
    "topItems": [],
    "recentSales": []
  }
}
```

Error shape:

```json
{
  "ok": false,
  "function": "calculateBalance",
  "error": { "code": "invalid_arguments", "message": "\"customerName\" zaroori hai." }
}
```

HTTP status: `400` invalid arguments, `401` login missing, `404` unknown
function, `503` Firestore unavailable.

---

## Functions

| Function | Parameters | Kya deta hai |
| --- | --- | --- |
| `searchCustomer` | `name`, `limit?` (1–20) | Naam se matches: id, phone, balance, balance status, last transaction |
| `calculateBalance` | `customerName?`, `customerId?`, `includeEntries?` | Ek customer ka balance, kul udhar, kul wasooli, entries; ambiguous naam par matches |
| `getSalesSummary` | `period?`, `from?`, `to?` | Sale, cash, udhaar, wasooli, kharcha, munafa, net cash, top items |
| `listDefaulters` | `limit?` (1–50) | Jin se lena hai, sab se zyada pehle; advances aur settled count |
| `listCreditCustomers` | `period?`, `from?`, `to?`, `limit?` | Kis ne kitna udhaar liya (bill + items) |
| `listPayments` | `period?`, `from?`, `to?`, `limit?` | Purani wasooli kis customer se kitni aayi |

`period`: `today`, `yesterday`, `last7days`, `thisMonth`, `lastMonth`,
`allTime`, `custom` (`from`/`to` ISO dates ke saath). Default `today`.
Din Pakistan time (UTC+5) ke hisaab se count hote hain.

**Cash double counting:** sale ke waqt jo cash mila wo `GAVE.paid` mein hai aur
ek alag `GOT` entry (`source: "sale-payment"`) bhi banti hai. Is liye wasooli
aur `calculateBalance` mein `sale-payment` entries ko skip kiya jata hai.

---

## Firestore access

Do modes hain:

1. **User token + Firestore REST (default)** — backend wahi ID token use karta
   hai jo request ke saath aaya. Firestore security rules lagte hain, is liye
   user sirf apna data parh sakta hai. Koi extra key nahi chahiye.
2. **Admin service account (optional)** — agar `FIREBASE_SERVICE_ACCOUNT`
   (JSON) ya `GOOGLE_APPLICATION_CREDENTIALS` set ho to `firebase-admin` use
   hota hai. Queries phir bhi `userId == token.uid` se filter hoti hain.

### Environment variables

| Variable | Zaroori | Kaam |
| --- | --- | --- |
| `GROQ_API_KEY` | Haan | Groq chat completions (tools) |
| `GEMINI_API_KEY` | Nahi | Plain-text fallback |
| `GEMINI_MODEL` | Nahi | Default `gemini-2.0-flash` |
| `GROQ_MODEL` | Nahi | Primary model override |
| `FIREBASE_PROJECT_ID` | Nahi | Default `munshi-ai-fab19` |
| `FIREBASE_SERVICE_ACCOUNT` | Nahi | Service account JSON (single line) |
| `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY` | Nahi | Service account alag alag |
| `ALLOWED_ORIGINS` | Nahi | Comma-separated CORS origins |
| `PORT` | Nahi | Local dev port (default 8787) |

Firestore rules mein `transactions`, `customers`, `expenses` par apne
`userId` ka read allowed hona chahiye (frontend pehle se isi par chal raha hai).

Har collection pehle bounded query se parhi jati hai (customers 2,000 /
transactions 10,000 / expenses 5,000). Agar count limit tak pahunche to poora
collection dobara parha jata hai, taake purani entries na chhooten.

---

## Naya function kaise add karein

1. **Schema** — `src/functions/definitions.js` mein ek naya object add karein
   (`name`, `description`, `parameters`). Description Roman Urdu/English mein
   likhein; LLM isi se decide karta hai ke kab call karna hai.
2. **Handler** — `src/functions/handlers.js` mein pure function likhein
   `(data, args, now)` signature ke saath aur `HANDLERS` object mein register
   karein. `data` already normalized hota hai (customers, transactions,
   expenses). Koi Firestore call handler ke andar na karein.
3. **Test** — `test/` mein fixture ke saath unit test add karein. Dispatcher
   aur `assertHandlersRegistered` khud check kar lenge ke handler mojood hai.
4. **Docs** — is README ke Functions table mein row add karein.

Validation, HTTP endpoint aur LLM tool registration khud-ba-khud ho jate hain
(`definitions.js` + `dispatcher.js`).

---

## Local development

```bash
npm install
npm test          # node:test, koi extra test dependency nahi
npm run dev       # http://localhost:8787
```

Frontend `.env.local` mein `VITE_API_URL=http://localhost:8787` set karein.

## Testing

- `test/handlers.test.js` — har function ki calculation (sale, profit,
  defaulter, credit, wasooli, period/timezone).
- `test/dispatcher.test.js` — schema validation, unknown function, auth scoping,
  Firestore failure handling.
- `test/dataAccess.test.js` — Firestore REST decoding, caching, permission
  errors.
- `test/toolLoop.test.js` — poora cycle: question → LLM → tool_calls →
  dispatcher → tool results → LLM → answer, plus failure/budget cases.

## Deployment

Backend Vercel par `index.js` ko serverless function ki tarah deploy karta hai
(`vercel.json`). Push karne par auto-deploy hota hai:

```bash
git add .
git commit -m "Add function-calling assistant"
git push
```

Vercel project settings mein `GROQ_API_KEY` (aur optional keys) add karein.
Firestore ke liye koi service account lazmi nahi — user token mode default hai.

---

## Cost estimate (Pakistan, 2026)

Plan mein diya gaya ₹2,500–₹5,000/month ka andaza zyada conservative tha.
Realistic assumptions:

| Item | Assumption | Monthly cost |
| --- | --- | --- |
| Vercel Hobby | 1 project, normal serverless usage | **$0** |
| Firestore | 10 GB storage, ~100k reads/month | ~**$1.80** (reads free tier mein) |
| Groq API | ~2–5M tokens/month (tools + answers) | ~**$0.10–0.20** |
| Domain (optional) | `.pk` ya `.com` | ~Rs. 1,000–3,000/year |

**Total: takreeban $0–$3/month ≈ Rs. 0–850/month** chhoti dukan ke liye.
Firestore ka free tier 50k reads/day hai; 100k reads/month us se kam hai.
Growth ke saath (10x users) bhi cost Rs. 2,000–3,000/month se zyada nahi honi
chahiye. Groq `$0.03 / 1M tokens` par 5M tokens ≈ $0.15.

> Note: pricing USD mein hai kyunki Vercel/Firestore/Groq USD bill karte hain;
> PKR conversion ~Rs. 280/USD assume kiya gaya hai.

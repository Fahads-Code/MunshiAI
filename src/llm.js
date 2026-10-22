// Shared Groq / Gemini plumbing for Munshi AI.
// Ek hi jagah model fallback, tool-calling aur plain text generation.

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

// qwen is primary (fast, Roman Urdu friendly). Baqi models fallback hain.
export const MODEL_CANDIDATES = [
  ...new Set(
    [
      process.env.GROQ_MODEL,
      "qwen/qwen3.8-27b",
      "openai/gpt-oss-20b",
      "openai/gpt-oss-120b",
      "llama-3.1-8b-instant",
      "llama-3.3-70b-versatile",
    ].filter(Boolean),
  ),
];

let workingModel = null;
let workingToolModel = null;
// Jin models par tools support nahi (400/404/422), unhein dobara try nahi karte.
const toolUnsupported = new Set();

export const getWorkingModel = () => workingModel;

export function rememberModel(model) {
  workingModel = model;
}

export function forgetModel(model) {
  if (!model || workingModel === model) workingModel = null;
}

/** Known model (decommissioned / missing) errors par agla model try karna hai. */
export function isModelProblem(status, bodyText) {
  return (
    status === 404 ||
    /model_not_found|model_decommissioned|model_permission|does not exist|decommissioned/i.test(
      bodyText || "",
    )
  );
}

function modelOrder() {
  if (!workingModel) return MODEL_CANDIDATES;
  return [workingModel, ...MODEL_CANDIDATES.filter((m) => m !== workingModel)];
}

/**
 * Raw Groq chat completion call.
 * `tools` diye jayein to OpenAI-style function calling payload banta hai.
 */
export function callGroq(
  model,
  messages,
  { jsonMode = false, tools, toolChoice = "auto", temperature = 0.1 } = {},
) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return Promise.reject(new Error("No Groq Key"));

  const body = {
    model,
    temperature,
    // Chhota jawab kaafi hai; bara default Groq ki output-token rate limit
    // reserve kar leta hai aur 429 aa jata hai.
    max_tokens: 700,
    messages,
    ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
    ...(tools && tools.length ? { tools, tool_choice: toolChoice } : {}),
  };

  return fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });
}

/** Optional Google Gemini fallback (plain text only). */
export async function callGemini(messages, { temperature = 0.1 } = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;

  try {
    const system = messages.find((m) => m.role === "system")?.content || "";
    const contents = messages
      .filter((m) => m.role !== "system" && m.role !== "tool")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [
          {
            text:
              typeof m.content === "string"
                ? m.content
                : JSON.stringify(m.content ?? ""),
          },
        ],
      }));

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        systemInstruction: system ? { parts: [{ text: system }] } : undefined,
        generationConfig: { temperature },
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn("Gemini error:", res.status, text.slice(0, 200));
      return null;
    }

    const json = await res.json();
    return (
      json?.candidates?.[0]?.content?.parts
        ?.map((p) => p.text || "")
        .join("")
        .trim() || null
    );
  } catch (err) {
    console.error("Gemini call error:", err);
    return null;
  }
}

/**
 * Plain text answer with Gemini + Groq model fallback.
 * Returns { text, model } or null.
 */
export async function generateText(messages, { jsonMode = false } = {}) {
  if (process.env.GEMINI_API_KEY) {
    const gemini = await callGemini(messages);
    if (gemini) return { text: gemini, model: GEMINI_MODEL };
  }

  for (const model of modelOrder()) {
    try {
      const res = await callGroq(model, messages, { jsonMode });
      if (res.ok) {
        const data = await res.json();
        const text = String(data?.choices?.[0]?.message?.content || "").trim();
        if (text) {
          rememberModel(model);
          return { text, model };
        }
        continue;
      }

      const errText = await res.text().catch(() => "");
      if (isModelProblem(res.status, errText)) {
        forgetModel(model);
        continue;
      }
      console.warn(`Groq ${model} error:`, res.status, errText.slice(0, 200));
    } catch (err) {
      console.warn(`Groq ${model} call fail:`, err?.message || err);
    }
  }

  return null;
}

/**
 * Chat completion with tools. Message object wapas karta hai taake
 * `tool_calls` ko handle kiya ja sake.
 * Returns { message, model } ya { message: null, error }.
 */
export async function generateChat(messages, tools) {
  let lastError = null;

  const base = modelOrder();
  const order = [
    ...new Set([
      ...(workingToolModel ? [workingToolModel] : []),
      ...base.filter((m) => !toolUnsupported.has(m)),
    ]),
  ];
  // Agar sab models ek dafa fail ho chuke hain to dobara try karo
  // (transient issue ho sakta hai).
  const candidates = order.length ? order : base;

  for (const model of candidates) {
    try {
      const res = await callGroq(model, messages, { tools, toolChoice: "auto" });
      if (res.ok) {
        const data = await res.json();
        const message = data?.choices?.[0]?.message;
        if (message) {
          workingToolModel = model;
          rememberModel(model);
          return { message, model };
        }
        lastError = "empty_message";
        continue;
      }

      const errText = await res.text().catch(() => "");
      lastError = `${res.status}: ${errText.slice(0, 300)}`;

      if (isModelProblem(res.status, errText)) {
        toolUnsupported.add(model);
        forgetModel(model);
        continue;
      }

      if ([400, 404, 422].includes(res.status)) {
        // Aam tor par model tools support nahi karta.
        toolUnsupported.add(model);
      }

      console.warn(`Tool call ${model} par fail:`, res.status, errText.slice(0, 200));
    } catch (err) {
      lastError = err?.message || String(err);
      console.warn(`Tool call ${model} par network error:`, lastError);
    }
  }

  return { message: null, model: null, error: lastError };
}

// Function-calling loop:
// question -> LLM (tools) -> tool_calls -> dispatcher -> tool results -> LLM -> final answer.
import { TOOL_DEFINITIONS } from "../functions/definitions.js";
import { invokeFunction } from "../functions/dispatcher.js";
import { loadShopData } from "../functions/dataAccess.js";
import { generateChat } from "../llm.js";
import { buildSystemPrompt, buildUserContent } from "./prompts.js";

const MAX_ROUNDS = 4;
const MAX_TOOL_CALLS = 8;

function parseToolArguments(raw) {
  if (raw === undefined || raw === null || raw === "") return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    throw new Error("Arguments valid JSON nahi hain.");
  }
}

/**
 * @param {object} params
 * @param {string} params.question
 * @param {object} [params.facts]
 * @param {string} [params.deterministicAnswer]
 * @param {{uid: string, idToken?: string, contextId?: string}} params.ctx
 * @param {Date} [params.now]
 * @param {number} [params.maxRounds]
 * @param {Function} [params.chat]    test injection: (messages, tools) => {message, model}
 * @param {Function} [params.invoke]  test injection: same as invokeFunction
 * @param {Function} [params.loadData] test injection: (ctx) => raw shop data
 * @returns {Promise<{answer: string|null, toolsUsed: Array, model?: string|null, error?: string, messages: Array}>}
 */
export async function answerWithTools({
  question,
  facts,
  deterministicAnswer,
  history = [],
  ctx,
  now = new Date(),
  maxRounds = MAX_ROUNDS,
  systemPrompt,
  chat = generateChat,
  invoke = invokeFunction,
  loadData,
}) {
  const toolsUsed = [];
  let lastSummary = null;
  const safeHistory = (Array.isArray(history) ? history : [])
    .filter(
      (h) =>
        h &&
        (h.role === "user" || h.role === "assistant") &&
        typeof h.content === "string" &&
        h.content.trim(),
    )
    .slice(-6)
    .map((h) => ({ role: h.role, content: h.content.slice(0, 800) }));
  const messages = [
    {
      role: "system",
      content: systemPrompt || buildSystemPrompt({ now, hasFacts: Boolean(facts) }),
    },
    ...safeHistory,
    {
      role: "user",
      content: buildUserContent({ question, facts, deterministicAnswer }),
    },
  ];

  if (!ctx || !ctx.uid) {
    return {
      answer: null,
      toolsUsed,
      lastSummary,
      error: "unauthorized",
      messages,
    };
  }

  // Ek request ke andar Firestore sirf ek dafa parha jaye.
  let cachedData = null;
  const load = async () => {
    if (!cachedData) {
      cachedData = loadData ? await loadData(ctx) : await loadShopData(ctx);
    }
    return cachedData;
  };

  for (let round = 0; round < maxRounds; round += 1) {
    const result = await chat(messages, TOOL_DEFINITIONS);
    const message = result?.message;

    if (!message) {
      return {
        answer: null,
        toolsUsed,
        lastSummary,
        model: result?.model ?? null,
        error: result?.error || "no_response",
        messages,
      };
    }

    const toolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls.filter((call) => call?.function?.name)
      : [];

    if (toolCalls.length === 0) {
      const answer = typeof message.content === "string" ? message.content.trim() : "";
      if (!answer) {
        return {
          answer: null,
          toolsUsed,
          lastSummary,
          model: result.model,
          error: "empty_answer",
          messages,
        };
      }
      return { answer, toolsUsed, lastSummary, model: result.model, messages };
    }

    messages.push({
      role: "assistant",
      content: message.content ?? null,
      tool_calls: message.tool_calls,
    });

    for (const call of toolCalls) {
      const name = call.function.name;
      const callId = call.id || `call_${toolsUsed.length + 1}`;

      if (toolsUsed.length >= MAX_TOOL_CALLS) {
        messages.push({
          role: "tool",
          tool_call_id: callId,
          name,
          content: JSON.stringify({
            ok: false,
            function: name,
            error: {
              code: "tool_budget_exhausted",
              message: "Bohat zyada tools call ho gaye. Ab available data se jawab do.",
            },
          }),
        });
        continue;
      }

      let args;
      try {
        args = parseToolArguments(call.function.arguments);
      } catch (err) {
        const failed = {
          ok: false,
          function: name,
          error: { code: "invalid_arguments", message: err.message },
        };
        toolsUsed.push({ name, arguments: call.function.arguments ?? null, ok: false });
        messages.push({
          role: "tool",
          tool_call_id: callId,
          name,
          content: JSON.stringify(failed),
        });
        continue;
      }

      let toolResult;
      try {
        toolResult = await invoke(ctx, name, args, { loadData: load });
      } catch (err) {
        console.error(`Tool "${name}" crash:`, err);
        toolResult = {
          ok: false,
          function: name,
          error: {
            code: "internal_error",
            message: "Tool chalane mein masla aa gaya.",
          },
        };
      }

      if (
        toolResult.ok !== false &&
        typeof toolResult.data?.summary === "string"
      ) {
        lastSummary = toolResult.data.summary;
      }
      toolsUsed.push({ name, arguments: args, ok: toolResult.ok !== false });
      messages.push({
        role: "tool",
        tool_call_id: callId,
        name,
        content: JSON.stringify(toolResult),
      });
    }
  }

  return {
    answer: null,
    toolsUsed,
    lastSummary,
    error: "max_rounds",
    messages,
  };
}

export { MAX_TOOL_CALLS, MAX_ROUNDS };

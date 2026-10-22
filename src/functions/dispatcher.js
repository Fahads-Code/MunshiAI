// Central dispatcher: LLM ka function_call -> validation -> handler -> JSON result.
import {
  FUNCTION_DEFINITIONS,
  FUNCTION_NAMES,
  TOOL_DEFINITIONS,
} from "./definitions.js";
import { HANDLERS, normalizeShopData, assertHandlersRegistered } from "./handlers.js";
import { FunctionError, DataAccessError } from "./errors.js";
import { loadShopData } from "./dataAccess.js";

const DEFINITIONS_BY_NAME = new Map(
  FUNCTION_DEFINITIONS.map((def) => [def.function.name, def.function]),
);

assertHandlersRegistered(FUNCTION_DEFINITIONS);

/* ------------------------------------------------------------------ */
/* Schema validation                                                   */
/* ------------------------------------------------------------------ */

function validateValue(schema, value, path) {
  if (!schema || typeof schema !== "object") return value;

  switch (schema.type) {
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new FunctionError(`"${path}" ek object hona chahiye.`);
      }
      const required = Array.isArray(schema.required) ? schema.required : [];
      const props = schema.properties || {};
      const out = {};

      for (const key of required) {
        const v = value[key];
        if (v === undefined || v === null || v === "") {
          throw new FunctionError(`"${key}" zaroori hai.`);
        }
      }

      for (const [key, propSchema] of Object.entries(props)) {
        const v = value[key];
        if (v === undefined || v === null || v === "") {
          if (propSchema.default !== undefined) out[key] = propSchema.default;
          continue;
        }
        out[key] = validateValue(propSchema, v, `${path}.${key}`);
      }
      return out;
    }

    case "integer":
    case "number": {
      const n = typeof value === "number" ? value : Number(String(value).trim());
      if (!Number.isFinite(n)) {
        throw new FunctionError(`"${path}" ek number hona chahiye.`);
      }
      const out = schema.type === "integer" ? Math.trunc(n) : n;
      if (schema.minimum !== undefined && out < schema.minimum) {
        throw new FunctionError(`"${path}" kam se kam ${schema.minimum} hona chahiye.`);
      }
      if (schema.maximum !== undefined && out > schema.maximum) {
        throw new FunctionError(`"${path}" zyada se zyada ${schema.maximum} ho sakta hai.`);
      }
      return out;
    }

    case "boolean": {
      if (typeof value === "boolean") return value;
      const s = String(value).toLowerCase();
      if (s === "true") return true;
      if (s === "false") return false;
      throw new FunctionError(`"${path}" true ya false hona chahiye.`);
    }

    case "string": {
      if (typeof value !== "string" && typeof value !== "number") {
        throw new FunctionError(`"${path}" text hona chahiye.`);
      }
      let s = String(value).trim();
      if (!s) throw new FunctionError(`"${path}" khali nahi ho sakta.`);
      if (schema.maxLength && s.length > schema.maxLength) s = s.slice(0, schema.maxLength);
      if (schema.minLength && s.length < schema.minLength) {
        throw new FunctionError(`"${path}" bohat chhota hai.`);
      }
      if (Array.isArray(schema.enum)) {
        const match = schema.enum.find((e) => e.toLowerCase() === s.toLowerCase());
        if (!match) {
          throw new FunctionError(
            `"${path}" in mein se ek hona chahiye: ${schema.enum.join(", ")}.`,
          );
        }
        return match;
      }
      return s;
    }

    default:
      return value;
  }
}

export function validateArguments(name, rawArgs) {
  const definition = DEFINITIONS_BY_NAME.get(name);
  if (!definition) {
    throw new FunctionError(`Function "${name}" mojood nahi.`, "unknown_function", 404);
  }

  let parsed = rawArgs;
  if (typeof parsed === "string") {
    try {
      parsed = parsed.trim() ? JSON.parse(parsed) : {};
    } catch {
      throw new FunctionError("Function arguments valid JSON nahi hain.");
    }
  }
  if (parsed === null || parsed === undefined) parsed = {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new FunctionError("Function arguments ek object hone chahiye.");
  }

  return validateValue(definition.parameters, parsed, name);
}

/* ------------------------------------------------------------------ */
/* Invocation                                                          */
/* ------------------------------------------------------------------ */

function errorResult(name, err) {
  if (err instanceof FunctionError) {
    return {
      ok: false,
      function: name,
      error: { code: err.code, message: err.message },
    };
  }
  if (err instanceof DataAccessError) {
    return {
      ok: false,
      function: name,
      error: {
        code: err.code,
        message: "Dukan ka live data is waqt nahi mil saka. Baraye mehrbani dobara koshish karein.",
      },
    };
  }
  console.error(`Function "${name}" unexpected error:`, err);
  return {
    ok: false,
    function: name,
    error: { code: "internal_error", message: "Function chalane mein masla aa gaya." },
  };
}

/**
 * @param {{uid: string, idToken?: string, contextId?: string}} ctx
 * @param {string} name
 * @param {object|string} rawArgs
 * @param {{loadData?: Function}} options
 * @returns {Promise<{ok: boolean, function: string, data?: object, error?: object}>}
 */
export async function invokeFunction(ctx, name, rawArgs, options = {}) {
  const loadData = options.loadData || loadShopData;

  if (!ctx || !ctx.uid) {
    return {
      ok: false,
      function: name,
      error: { code: "unauthorized", message: "Login zaroori hai." },
    };
  }

  try {
    const args = validateArguments(name, rawArgs);
    const rawData = await loadData(ctx);
    const data = normalizeShopData(rawData);
    const handler = HANDLERS[name];
    const result = handler(data, args, options.now ?? new Date());
    return { ok: true, function: name, data: result };
  } catch (err) {
    return errorResult(name, err);
  }
}

export { FUNCTION_DEFINITIONS, FUNCTION_NAMES, TOOL_DEFINITIONS, DEFINITIONS_BY_NAME };

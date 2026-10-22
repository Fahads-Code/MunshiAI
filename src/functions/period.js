// Pakistan Standard Time (UTC+5, no daylight saving) ke hisaab se
// period -> date range. Shopkeeper ke liye "aaj" Pakistan ka din hai.
import { FunctionError } from "./errors.js";

const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const PERIODS = [
  "today",
  "yesterday",
  "last7days",
  "thisMonth",
  "lastMonth",
  "allTime",
  "custom",
];

const ALIASES = {
  today: "today",
  aaj: "today",
  kal: "yesterday",
  yesterday: "yesterday",
  last7: "last7days",
  last7days: "last7days",
  week: "last7days",
  "this-week": "last7days",
  lastweek: "last7days",
  "7days": "last7days",
  thismonth: "thisMonth",
  "this-month": "thisMonth",
  ismahina: "thisMonth",
  lastmonth: "lastMonth",
  "last-month": "lastMonth",
  pichlamahina: "lastMonth",
  alltime: "allTime",
  "all-time": "allTime",
  overall: "allTime",
  custom: "custom",
};

export function startOfPktDay(date) {
  const shifted = new Date(date.getTime() + PKT_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - PKT_OFFSET_MS);
}

function startOfPktMonth(date) {
  const shifted = new Date(date.getTime() + PKT_OFFSET_MS);
  shifted.setUTCDate(1);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - PKT_OFFSET_MS);
}

function addPktMonths(date, months) {
  const shifted = new Date(date.getTime() + PKT_OFFSET_MS);
  shifted.setUTCMonth(shifted.getUTCMonth() + months);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - PKT_OFFSET_MS);
}

function normalizePeriod(value) {
  if (value === undefined || value === null || value === "") return "today";
  const key = String(value).toLowerCase().replace(/\s+/g, "-");
  return ALIASES[key] || ALIASES[key.replace(/-/g, "")] || null;
}

function parseIso(value, field) {
  const t = Date.parse(String(value));
  if (!Number.isFinite(t)) {
    throw new FunctionError(`"${field}" valid date (ISO) nahi hai.`, "invalid_arguments");
  }
  return t;
}

/**
 * @param {{period?: string, from?: string, to?: string}} input
 * @param {Date} now
 * @returns {{key: string, label: string, from: string, to: string, fromMs: number, toMs: number}}
 */
export function resolvePeriod(input = {}, now = new Date()) {
  const rawPeriod = input.period;
  const key = normalizePeriod(rawPeriod);
  if (!key) {
    throw new FunctionError(
      `"period" in mein se ek hona chahiye: ${PERIODS.join(", ")}.`,
      "invalid_arguments",
    );
  }

  const todayStart = startOfPktDay(now);
  const end = now.getTime() + 1;

  // Custom / explicit dates ko priority do.
  if (input.from || input.to) {
    const fromMs = input.from
      ? parseIso(input.from, "from")
      : new Date(2000, 0, 1).getTime();
    const toMs = input.to ? parseIso(input.to, "to") : end;
    if (toMs <= fromMs) {
      throw new FunctionError('"to" "from" ke baad hona chahiye.', "invalid_arguments");
    }
    return {
      key: "custom",
      label: "Mukhtasar Muddat",
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      fromMs,
      toMs,
    };
  }

  switch (key) {
    case "yesterday":
      return {
        key,
        label: "Kal",
        from: new Date(todayStart.getTime() - DAY_MS).toISOString(),
        to: todayStart.toISOString(),
        fromMs: todayStart.getTime() - DAY_MS,
        toMs: todayStart.getTime(),
      };
    case "last7days":
      return {
        key,
        label: "Pichle 7 Din",
        from: new Date(todayStart.getTime() - 6 * DAY_MS).toISOString(),
        to: new Date(end).toISOString(),
        fromMs: todayStart.getTime() - 6 * DAY_MS,
        toMs: end,
      };
    case "thisMonth": {
      const from = startOfPktMonth(now);
      return {
        key,
        label: "Is Mahina",
        from: from.toISOString(),
        to: new Date(end).toISOString(),
        fromMs: from.getTime(),
        toMs: end,
      };
    }
    case "lastMonth": {
      const from = addPktMonths(startOfPktMonth(now), -1);
      const to = startOfPktMonth(now);
      return {
        key,
        label: "Pichla Mahina",
        from: from.toISOString(),
        to: to.toISOString(),
        fromMs: from.getTime(),
        toMs: to.getTime(),
      };
    }
    case "allTime": {
      const from = Date.UTC(2000, 0, 1);
      return {
        key,
        label: "Ab tak (All Time)",
        from: new Date(from).toISOString(),
        to: new Date(end).toISOString(),
        fromMs: from,
        toMs: end,
      };
    }
    case "custom": {
      // period=custom lekin from/to missing: aaj hi maan lo.
      return {
        key: "today",
        label: "Aaj",
        from: todayStart.toISOString(),
        to: new Date(end).toISOString(),
        fromMs: todayStart.getTime(),
        toMs: end,
      };
    }
    case "today":
    default:
      return {
        key: "today",
        label: "Aaj",
        from: todayStart.toISOString(),
        to: new Date(end).toISOString(),
        fromMs: todayStart.getTime(),
        toMs: end,
      };
  }
}

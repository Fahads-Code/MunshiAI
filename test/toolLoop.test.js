import test from "node:test";
import assert from "node:assert/strict";
import { answerWithTools } from "../src/assistant/toolLoop.js";
import { NOW, shopData, UID } from "./fixtures.js";

const ctx = { uid: UID, idToken: "fake-token" };

function toolCall(id, name, args) {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

test("tool loop: LLM -> tool -> LLM -> final answer", async () => {
  const rounds = [];

  const chat = async (messages) => {
    rounds.push(messages.map((m) => m.role));
    if (rounds.length === 1) {
      return {
        model: "qwen",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [toolCall("call_1", "getSalesSummary", { period: "today" })],
        },
      };
    }
    return {
      model: "qwen",
      message: {
        role: "assistant",
        content: "Aaj ki kul sale **Rs. 3,500** hai aur net munafa **Rs. 150** hai.",
      },
    };
  };

  const result = await answerWithTools({
    question: "Aaj kitni sale hui?",
    ctx,
    chat,
    loadData: async () => shopData,
    now: NOW,
  });

  assert.match(result.answer, /3,500/);
  assert.equal(result.model, "qwen");
  assert.equal(result.toolsUsed.length, 1);
  assert.equal(result.toolsUsed[0].name, "getSalesSummary");
  assert.equal(result.toolsUsed[0].ok, true);

  assert.deepEqual(rounds[0], ["system", "user"]);
  assert.deepEqual(rounds[1], ["system", "user", "assistant", "tool"]);

  const toolMessage = result.messages.find((m) => m.role === "tool");
  const payload = JSON.parse(toolMessage.content);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.sales.total, 3500);
});

test("tool loop: ek round mein do tools, data sirf ek dafa load", async () => {
  let loads = 0;
  let round = 0;

  const chat = async () => {
    round += 1;
    if (round === 1) {
      return {
        model: "m",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            toolCall("a", "searchCustomer", { name: "Ali" }),
            toolCall("b", "listDefaulters", {}),
          ],
        },
      };
    }
    return { model: "m", message: { role: "assistant", content: "Jawab tayyar hai." } };
  };

  const result = await answerWithTools({
    question: "Ali ka khata aur sab se zyada udhaar?",
    ctx,
    chat,
    loadData: async () => {
      loads += 1;
      return shopData;
    },
    now: NOW,
  });

  assert.equal(result.answer, "Jawab tayyar hai.");
  assert.equal(result.toolsUsed.length, 2);
  assert.equal(loads, 1);
});

test("tool loop: facts user message mein jate hain aur tools optional hain", async () => {
  let seen = null;
  const result = await answerWithTools({
    question: "Fahad ka balance?",
    facts: { customerName: "Fahad", balance: 7000 },
    deterministicAnswer: "Fahad se Rs. 7,000 lene hain.",
    ctx,
    chat: async (messages) => {
      seen = messages;
      return { model: "m", message: { role: "assistant", content: "**Rs. 7,000** lene hain." } };
    },
    now: NOW,
  });

  assert.match(seen[1].content, /Verified facts/);
  assert.match(seen[1].content, /Rs. 7,000/);
  assert.equal(result.toolsUsed.length, 0);
  assert.match(result.answer, /7,000/);
});

test("tool loop: invalid tool arguments LLM ko error ban kar wapas jate hain", async () => {
  let round = 0;
  const result = await answerWithTools({
    question: "Ali ka balance?",
    ctx,
    chat: async () => {
      round += 1;
      if (round === 1) {
        return {
          model: "m",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "x", type: "function", function: { name: "calculateBalance", arguments: "{oops" } },
            ],
          },
        };
      }
      return { model: "m", message: { role: "assistant", content: "Data nahi mila." } };
    },
    loadData: async () => shopData,
    now: NOW,
  });

  const toolPayload = JSON.parse(result.messages.find((m) => m.role === "tool").content);
  assert.equal(toolPayload.ok, false);
  assert.equal(toolPayload.error.code, "invalid_arguments");
  assert.equal(result.toolsUsed[0].ok, false);
  assert.equal(result.answer, "Data nahi mila.");
});

test("tool loop: data fail ho to model ko error milta hai", async () => {
  let round = 0;
  const result = await answerWithTools({
    question: "Aaj ki sale?",
    ctx,
    chat: async () => {
      round += 1;
      if (round === 1) {
        return {
          model: "m",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [toolCall("x", "getSalesSummary", {})],
          },
        };
      }
      return {
        model: "m",
        message: { role: "assistant", content: "Records is waqt nahi mil sakte." },
      };
    },
    loadData: async () => {
      throw new Error("firestore down");
    },
    now: NOW,
  });

  const toolPayload = JSON.parse(result.messages.find((m) => m.role === "tool").content);
  assert.equal(toolPayload.ok, false);
  assert.equal(result.answer, "Records is waqt nahi mil sakte.");
});

test("tool loop: LLM jawab na de to null answer", async () => {
  const result = await answerWithTools({
    question: "Aaj ki sale?",
    ctx,
    chat: async () => ({ message: null, model: null, error: "502" }),
    loadData: async () => shopData,
    now: NOW,
  });
  assert.equal(result.answer, null);
  assert.equal(result.error, "502");
});

test("tool loop: rounds khatam par error, tool budget se zyada nahi", async () => {
  const result = await answerWithTools({
    question: "Sab kuch batao",
    ctx,
    maxRounds: 4,
    chat: async () => ({
      model: "m",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          toolCall("a", "searchCustomer", { name: "Ali" }),
          toolCall("b", "searchCustomer", { name: "Fahad" }),
          toolCall("c", "searchCustomer", { name: "Bilal" }),
        ],
      },
    }),
    loadData: async () => shopData,
    now: NOW,
  });

  assert.equal(result.answer, null);
  assert.equal(result.error, "max_rounds");
  assert.equal(result.toolsUsed.length, 8); // MAX_TOOL_CALLS
});

test("tool loop: bina uid ke chat call hi nahi hoti", async () => {
  let called = false;
  const result = await answerWithTools({
    question: "Aaj ki sale?",
    ctx: {},
    chat: async () => {
      called = true;
      return { message: { content: "x" } };
    },
  });
  assert.equal(called, false);
  assert.equal(result.answer, null);
  assert.equal(result.error, "unauthorized");
});

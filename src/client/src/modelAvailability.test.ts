import { describe, expect, it } from "vitest";
import { guardrailBlockedModelFromMessage, isGuardrailBlockedModelError, modelReferenceFromValue } from "./modelAvailability";

describe("model availability", () => {
  it("recognizes OpenRouter guardrail endpoint failures", () => {
    const message = {
      role: "assistant",
      stopReason: "error",
      provider: "openrouter",
      model: "openai/gpt-5.6-luna",
      errorMessage: '404: {"message":"0 endpoints out of 2 requested are available matching your guardrail restrictions and data policy","code":404,"metadata":{"ineligibility_reasons":[{"reason":"model-ignored-by-guardrail"}]}}',
    };

    expect(isGuardrailBlockedModelError(message)).toBe(true);
    expect(guardrailBlockedModelFromMessage(message)).toEqual({ provider: "openrouter", id: "openai/gpt-5.6-luna" });
  });

  it("does not hide models for unrelated provider failures", () => {
    expect(isGuardrailBlockedModelError({ role: "assistant", stopReason: "error", provider: "openrouter", model: "openai/gpt-5.6-luna", errorMessage: "404 model not found" })).toBe(false);
  });

  it("keeps provider prefixes intact when parsing picker values", () => {
    expect(modelReferenceFromValue("openrouter/openai/gpt-5.6-luna")).toEqual({ provider: "openrouter", id: "openai/gpt-5.6-luna" });
  });
});

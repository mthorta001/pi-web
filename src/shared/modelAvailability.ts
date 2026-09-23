export interface ModelReference {
  provider: string;
  id: string;
}

/**
 * OpenRouter reports guardrail failures as assistant messages with an error
 * stop reason. Keep this deliberately narrow so ordinary provider 404s or
 * transient network failures do not hide a model from the picker.
 */
export function isGuardrailBlockedModelError(message: unknown): boolean {
  const record = asRecord(message);
  if (record?.["role"] !== "assistant" || record["stopReason"] !== "error") return false;
  const errorMessage = readString(record["errorMessage"])?.toLowerCase() ?? "";
  return errorMessage.includes("model-ignored-by-guardrail")
    || (errorMessage.includes("guardrail") && errorMessage.includes("data policy") && errorMessage.includes("endpoint"));
}

export function guardrailBlockedModelFromMessage(message: unknown): ModelReference | undefined {
  if (!isGuardrailBlockedModelError(message)) return undefined;
  const record = asRecord(message);
  if (record === undefined) return undefined;
  const provider = readString(record["provider"]);
  const id = readString(record["model"]) ?? readString(record["responseModel"]);
  if (provider === undefined || provider === "" || id === undefined || id === "") return undefined;
  return { provider, id };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

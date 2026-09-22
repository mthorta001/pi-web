import type { SessionModel } from "../../shared/apiTypes";

export interface ModelAvailabilityFilter {
  machineId: string;
  unavailableModelKeys: ReadonlySet<string>;
}

export interface ModelReference {
  provider: string;
  id: string;
}

/** Build the browser-local key for one model on one PI WEB machine. */
export function modelAvailabilityKey(machineId: string, model: ModelReference): string {
  return `${machineId}\u0000${model.provider}\u0000${model.id}`;
}

export function modelIsUnavailable(model: Pick<SessionModel, "provider" | "id">, filter: ModelAvailabilityFilter | undefined): boolean {
  if (filter === undefined || model.provider === undefined || model.id === undefined) return false;
  return filter.unavailableModelKeys.has(modelAvailabilityKey(filter.machineId, { provider: model.provider, id: model.id }));
}

/** Parse the `${provider}/${id}` values used by the model picker. */
export function modelReferenceFromValue(value: string): ModelReference | undefined {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  return { provider: value.slice(0, separator), id: value.slice(separator + 1) };
}

export function modelValueIsUnavailable(value: string, filter: ModelAvailabilityFilter | undefined): boolean {
  const model = modelReferenceFromValue(value);
  return model !== undefined && filter !== undefined && modelIsUnavailable(model, filter);
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

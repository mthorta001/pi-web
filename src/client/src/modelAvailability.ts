import type { SessionModel } from "../../shared/apiTypes";
export { guardrailBlockedModelFromMessage, isGuardrailBlockedModelError } from "../../shared/modelAvailability";
import type { ModelReference } from "../../shared/modelAvailability";
export type { ModelReference } from "../../shared/modelAvailability";

export interface ModelAvailabilityFilter {
  machineId: string;
  unavailableModelKeys: ReadonlySet<string>;
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

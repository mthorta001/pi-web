import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { piWebDataDir } from "../../config.js";

const MODEL_AVAILABILITY_STATE_VERSION = 1;
const MODEL_AVAILABILITY_FILE_MODE = 0o600;

interface ModelAvailabilityProfileState {
  profileDir: string;
  guardrailBlockedModelIds: string[];
}

interface ModelAvailabilityPersistedState {
  version: typeof MODEL_AVAILABILITY_STATE_VERSION;
  profiles: ModelAvailabilityProfileState[];
}

/** Durable, per-agent-profile workspace-policy observations. */
export interface ModelAvailabilityStore {
  load(profileDir: string): Promise<readonly string[]>;
  save(profileDir: string, guardrailBlockedModelIds: readonly string[]): Promise<void>;
}

/**
 * PI WEB owns this state rather than Pi's agent directory: it describes a
 * workspace routing result, not a credential or Pi setting. Profiles still
 * remain isolated so one account's guardrails cannot hide another account's
 * models.
 */
export class FileModelAvailabilityStore implements ModelAvailabilityStore {
  constructor(readonly filePath = defaultModelAvailabilityFilePath()) {}

  async load(profileDir: string): Promise<readonly string[]> {
    const state = await this.read();
    const profile = state.profiles.find((candidate) => candidate.profileDir === profileKey(profileDir));
    return profile === undefined ? [] : [...profile.guardrailBlockedModelIds];
  }

  async save(profileDir: string, guardrailBlockedModelIds: readonly string[]): Promise<void> {
    const state = await this.read();
    const profileDirKey = profileKey(profileDir);
    const ids = uniqueNonEmptyStrings(guardrailBlockedModelIds);
    const profiles = state.profiles.filter((profile) => profile.profileDir !== profileDirKey);
    if (ids.length > 0) profiles.push({ profileDir: profileDirKey, guardrailBlockedModelIds: ids });
    await this.write({ version: MODEL_AVAILABILITY_STATE_VERSION, profiles });
  }

  private async read(): Promise<ModelAvailabilityPersistedState> {
    let source: string;
    try {
      source = await readFile(this.filePath, "utf8");
    } catch (error: unknown) {
      if (isNodeErrorWithCode(error, "ENOENT")) return { version: MODEL_AVAILABILITY_STATE_VERSION, profiles: [] };
      throw error;
    }
    return parseModelAvailabilityState(JSON.parse(source));
  }

  private async write(state: ModelAvailabilityPersistedState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid.toString()}-${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        mode: MODEL_AVAILABILITY_FILE_MODE,
        flag: "wx",
      });
      await rename(tempPath, this.filePath);
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}

export function defaultModelAvailabilityFilePath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  return join(piWebDataDir(env, cwd), "model-availability.json");
}

function parseModelAvailabilityState(value: unknown): ModelAvailabilityPersistedState {
  const record = requireRecord(value, "Model availability state must be an object");
  if (record["version"] !== MODEL_AVAILABILITY_STATE_VERSION) throw new Error("Unsupported model availability state version");
  const rawProfiles = record["profiles"];
  if (!Array.isArray(rawProfiles)) throw new Error("Model availability profiles must be an array");
  const profiles = rawProfiles.map(parseProfile);
  const profileDirs = new Set<string>();
  for (const profile of profiles) {
    if (profileDirs.has(profile.profileDir)) throw new Error("Duplicate model availability profile");
    profileDirs.add(profile.profileDir);
  }
  return { version: MODEL_AVAILABILITY_STATE_VERSION, profiles };
}

function parseProfile(value: unknown): ModelAvailabilityProfileState {
  const record = requireRecord(value, "Model availability profile must be an object");
  const profileDir = record["profileDir"];
  const ids = record["guardrailBlockedModelIds"];
  if (typeof profileDir !== "string" || profileDir === "") throw new Error("Model availability profileDir must be a non-empty string");
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string" && id.length > 0)) {
    throw new Error("Model availability guardrailBlockedModelIds must be non-empty strings");
  }
  const guardrailBlockedModelIds = uniqueNonEmptyStrings(ids);
  if (guardrailBlockedModelIds.length !== ids.length) throw new Error("Duplicate model availability model id");
  return { profileDir, guardrailBlockedModelIds };
}

function uniqueNonEmptyStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort();
}

function profileKey(profileDir: string): string {
  return resolve(profileDir);
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(message);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

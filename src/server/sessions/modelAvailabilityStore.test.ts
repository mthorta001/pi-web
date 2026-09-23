import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileModelAvailabilityStore, defaultModelAvailabilityFilePath } from "./modelAvailabilityStore.js";

describe("FileModelAvailabilityStore", () => {
  let root: string;
  let filePath: string;
  let store: FileModelAvailabilityStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-web-model-availability-"));
    filePath = join(root, "state", "model-availability.json");
    store = new FileModelAvailabilityStore(filePath);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("stores policy observations under PI_WEB_DATA_DIR by profile, not next to Pi credentials", async () => {
    expect(defaultModelAvailabilityFilePath({ PI_WEB_DATA_DIR: "state" }, root)).toBe(join(root, "state", "model-availability.json"));
    const agentA = join(root, "agent-a");
    const agentB = join(root, "agent-b");

    await store.save(agentA, ["openrouter/openai/gpt-5.6-luna", "openrouter/openai/gpt-5.6-luna"]);
    await store.save(agentB, ["openrouter/openai/gpt-5.6-sol"]);

    expect(await store.load(agentA)).toEqual(["openrouter/openai/gpt-5.6-luna"]);
    expect(await store.load(agentB)).toEqual(["openrouter/openai/gpt-5.6-sol"]);

    const raw: unknown = JSON.parse(await readFile(filePath, "utf8"));
    expect(raw).toMatchObject({
      version: 1,
      profiles: [
        { profileDir: resolve(agentA), guardrailBlockedModelIds: ["openrouter/openai/gpt-5.6-luna"] },
        { profileDir: resolve(agentB), guardrailBlockedModelIds: ["openrouter/openai/gpt-5.6-sol"] },
      ],
    });
    if (process.platform !== "win32") expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("does not silently discard malformed or unreadable durable state", async () => {
    await mkdir(join(root, "state"), { recursive: true });
    await writeFile(filePath, "{not-json", "utf8");

    await expect(store.load("agent-a")).rejects.toThrow();
    await expect(store.save("agent-a", ["openrouter/openai/gpt-5.6-luna"])).rejects.toThrow();
  });

  it("clears only the requested profile while retaining other profiles", async () => {
    await store.save("agent-a", ["openrouter/openai/gpt-5.6-luna"]);
    await store.save("agent-b", ["openrouter/openai/gpt-5.6-sol"]);
    await store.save("agent-a", []);

    expect(await store.load("agent-a")).toEqual([]);
    expect(await store.load("agent-b")).toEqual(["openrouter/openai/gpt-5.6-sol"]);
  });
});

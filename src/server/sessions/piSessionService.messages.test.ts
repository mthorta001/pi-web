import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PiSessionService } from "./piSessionService.js";
import { CapturingSessionEventHub, fakeRuntime, fakeSessionManager, runtimeCreator, sessionGateway, sessionRecord, sessionRef, testModel, testModelRuntime } from "./piSessionService.testSupport.js";
import { FileModelAvailabilityStore } from "./modelAvailabilityStore.js";

const TEST_AGENT_DIR = "/tmp/pi-web-test-agent";

describe("PiSessionService", () => {
  describe("assistant thinking-level attribution", () => {
    function messagesService(
      branch: unknown[],
      patch: Parameters<typeof fakeRuntime>[1] = {},
      availability: { agentDir?: string; store?: FileModelAvailabilityStore } = {},
    ) {
      const fake = fakeRuntime("session-1", {
        sessionFile: "/tmp/session-1.jsonl",
        sessionManager: fakeSessionManager("/workspace", { getBranch: () => branch }),
        ...patch,
      });
      const events = new CapturingSessionEventHub();
      const service = new PiSessionService(events, {
        agentDir: availability.agentDir ?? TEST_AGENT_DIR,
        modelRuntime: testModelRuntime,
        createAgentRuntime: runtimeCreator(fake.runtime),
        sessionManager: sessionGateway([sessionRecord("session-1")]),
        heartbeatIntervalMs: 60_000,
        ...(availability.store === undefined ? {} : { modelAvailabilityStore: availability.store }),
      });
      return { fake, service, events };
    }

    it("annotates paged assistant messages with the thinking level in effect from branch entries", async () => {
      const branch = [
        { type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
        { type: "message", message: { role: "assistant", provider: "openai", model: "gpt-4.1", content: [{ type: "text", text: "before any entry" }] } },
        { type: "thinking_level_change", thinkingLevel: "medium" },
        { type: "message", message: { role: "assistant", provider: "openai", model: "gpt-4.1", content: [{ type: "text", text: "first answer" }] } },
        { type: "thinking_level_change", thinkingLevel: "max" },
        { type: "message", message: { role: "assistant", provider: "openai", model: "gpt-4.1", content: [{ type: "text", text: "second answer" }] } },
        { type: "thinking_level_change", thinkingLevel: "off" },
        { type: "message", message: { role: "assistant", provider: "openai", model: "gpt-4.1", content: [{ type: "text", text: "unthinking answer" }] } },
        { type: "message", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "done" }] } },
      ];
      const { service } = messagesService(branch);

      const page = await service.messages(sessionRef("session-1"));

      expect(page).toEqual({
        start: 0,
        total: 6,
        messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", provider: "openai", model: "gpt-4.1", content: [{ type: "text", text: "before any entry" }] },
        { role: "assistant", provider: "openai", model: "gpt-4.1", content: [{ type: "text", text: "first answer" }], thinkingLevel: "medium" },
        { role: "assistant", provider: "openai", model: "gpt-4.1", content: [{ type: "text", text: "second answer" }], thinkingLevel: "max" },
        { role: "assistant", provider: "openai", model: "gpt-4.1", content: [{ type: "text", text: "unthinking answer" }] },
        { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "done" }] },
        ],
      });
      await service.dispose();
    });

    it("annotates live assistant message.end events with the session's current thinking level", async () => {
      const { fake, service, events } = messagesService([], { thinkingLevel: "high" });
      await service.status(sessionRef("session-1")); // bring the session online so it publishes events

      fake.emit({ type: "message_end", message: { role: "assistant", provider: "openai", model: "gpt-4.1", content: [{ type: "text", text: "answer" }] } });
      fake.emit({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "next" }] } });

      const messageEnds = events.sessionEvents.map(({ event }) => event).filter((event) => event.type === "message.end");
      expect(messageEnds).toEqual([
        { type: "message.end", message: { role: "assistant", provider: "openai", model: "gpt-4.1", content: [{ type: "text", text: "answer" }], thinkingLevel: "high" } },
        { type: "message.end", message: { role: "user", content: [{ type: "text", text: "next" }] } },
      ]);
      await service.dispose();
    });

    it("annotates the join-time stream snapshot partial with the current thinking level", async () => {
      const streamingMessage = {
        role: "assistant",
        provider: "openai",
        model: "gpt-4.1",
        content: [{ type: "thinking", thinking: "hmm", thinkingSignature: "provider-signature" }],
      };
      const { service } = messagesService([], { thinkingLevel: "xhigh", state: { streamingMessage } });

      const snapshot = await service.streamSnapshot(sessionRef("session-1"));

      expect(snapshot.partial).toEqual({
        role: "assistant",
        provider: "openai",
        model: "gpt-4.1",
        content: [{ type: "thinking", thinking: "hmm" }],
        thinkingLevel: "xhigh",
      });
      await service.dispose();
    });

    it("removes a guardrail-blocked model from the backend catalog", async () => {
      const ref = sessionRef("session-1");
      const target = testModel();
      const availableSnapshot = vi.spyOn(testModelRuntime, "getAvailableSnapshot").mockReturnValue([target]);
      const root = await mkdtemp(join(tmpdir(), "pi-web-model-availability-message-test-"));
      const agentDir = join(root, "agent");
      const store = new FileModelAvailabilityStore(join(root, "data", "model-availability.json"));
      const modelService = messagesService([], {}, { agentDir, store });
      let disposed = false;
      try {
        await modelService.service.status(ref);

        expect((await modelService.service.availableModels(ref)).some((model) => model.provider === target.provider && model.id === target.id)).toBe(true);

        modelService.fake.emit({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "error",
            provider: target.provider,
            model: target.id,
            errorMessage: '404: {"message":"0 endpoints out of 2 requested are available matching your guardrail restrictions and data policy","code":404,"metadata":{"ineligibility_reasons":[{"reason":"model-ignored-by-guardrail"}]}}',
          },
        });

        expect((await modelService.service.availableModels(ref)).some((model) => model.provider === target.provider && model.id === target.id)).toBe(false);
        expect((await modelService.service.modelCatalog(ref)).some((model) => model.provider === target.provider && model.id === target.id)).toBe(false);
        await expect(modelService.service.setModel(ref, target.provider, target.id)).rejects.toThrow("Model unavailable");
        expect(modelService.events.globalEvents).toContainEqual({ type: "models.changed", revision: 1 });

        await modelService.service.dispose();
        disposed = true;
        const reloaded = messagesService([], {}, { agentDir, store });
        try {
          expect((await reloaded.service.availableModels(ref)).some((model) => model.provider === target.provider && model.id === target.id)).toBe(false);
        } finally {
          await reloaded.service.dispose();
        }
      } finally {
        if (!disposed) await modelService.service.dispose().catch(() => undefined);
        availableSnapshot.mockRestore();
        await rm(root, { recursive: true, force: true });
      }
    });

    it("does not hide a model for an unrelated provider error", async () => {
      const ref = sessionRef("session-1");
      const target = testModel();
      const availableSnapshot = vi.spyOn(testModelRuntime, "getAvailableSnapshot").mockReturnValue([target]);
      const modelService = messagesService([]);
      try {
        await modelService.service.status(ref);
        modelService.fake.emit({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "error",
            provider: target.provider,
            model: target.id,
            errorMessage: "404: model catalog temporarily unavailable",
          },
        });

        expect((await modelService.service.availableModels(ref)).some((model) => model.provider === target.provider && model.id === target.id)).toBe(true);
      } finally {
        await modelService.service.dispose();
        availableSnapshot.mockRestore();
      }
    });

    it("backfills a guardrail denial from another historical session branch", async () => {
      const root = await mkdtemp(join(tmpdir(), "pi-web-model-availability-backfill-test-"));
      const agentDir = join(root, "agent");
      const target = testModel();
      const availableSnapshot = vi.spyOn(testModelRuntime, "getAvailableSnapshot").mockReturnValue([target]);
      const fake = fakeRuntime("session-1", { sessionFile: "/tmp/session-1.jsonl" });
      const gateway = sessionGateway([sessionRecord("session-1"), sessionRecord("historical-1")]);
      gateway.readBranch = (path) => Promise.resolve(path === "/sessions/historical-1.jsonl" ? [{
        type: "message",
        message: {
          role: "assistant",
          stopReason: "error",
          provider: target.provider,
          model: target.id,
          errorMessage: '404: {"message":"guardrail data policy endpoint","metadata":{"ineligibility_reasons":[{"reason":"model-ignored-by-guardrail"}]}}',
        },
      }] : []);
      const service = new PiSessionService(new CapturingSessionEventHub(), {
        agentDir,
        modelRuntime: testModelRuntime,
        createAgentRuntime: runtimeCreator(fake.runtime),
        sessionManager: gateway,
        heartbeatIntervalMs: 60_000,
        modelAvailabilityStore: new FileModelAvailabilityStore(join(root, "data", "model-availability.json")),
      });
      try {
        await vi.waitFor(async () => {
          expect((await service.availableModels(sessionRef("session-1"))).some((model) => model.provider === target.provider && model.id === target.id)).toBe(false);
        });
      } finally {
        await service.dispose();
        availableSnapshot.mockRestore();
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});

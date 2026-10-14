import { describe, expect, it } from "vitest";
import { historyMessagesFromEntries } from "./transcriptMessages.js";
import { pageMessagesAtSafeBoundary } from "./messagePaging.js";
import { projectBrowserMessageResponse } from "../browserMessageProjection.js";
import { parseMessagePage } from "../../client/src/api/parsers.js";
import { normalizeMessages } from "../../client/src/chatMessages.js";

describe("durable transcript identity", () => {
  it("propagates entry IDs through paging, browser projection, API parsing and ChatLine mapping", () => {
    const entries = [
      { type: "message", id: "pi-system-prompt", message: { role: "system", content: "", sections: [{ text: "private system prompt" }], toolsAdded: [{ name: "read" }] } },
      { type: "message", id: "user-1", message: { role: "user", content: "hello" } },
      { type: "thinking_level_change", id: "level-1", thinkingLevel: "high" },
      { type: "message", id: "assistant-1", message: { role: "assistant", id: "provider-id", entryId: "not-authoritative", content: "answer" } },
      { type: "custom_message", id: "hidden", display: false, content: "hidden" },
      { type: "custom_message", id: "custom-1", display: true, content: "notice" },
      { type: "compaction", id: "compact-1", summary: "compact" },
      { type: "branch_summary", id: "branch-1", summary: "branch" },
      { type: "message", id: "user-2", message: { role: "user", content: "next" } },
      { type: "message", id: "bash-1", message: { role: "bashExecution", command: "pwd", output: "/repo" } },
    ];
    const original = structuredClone(entries);
    const messages = historyMessagesFromEntries(entries);
    const linesForPage = (before?: number, limit?: number) => normalizeMessages(parseMessagePage(
      projectBrowserMessageResponse(pageMessagesAtSafeBoundary(messages, { ...(before === undefined ? {} : { before }), ...(limit === undefined ? {} : { limit }) })),
    ).messages);

    const visiblePage = pageMessagesAtSafeBoundary(messages);
    expect(visiblePage).toMatchObject({ start: 0, total: 7 });
    expect(visiblePage.messages[0]).toMatchObject({ role: "user", content: "hello", entryId: "user-1" });
    expect(JSON.stringify(visiblePage)).not.toContain("private system prompt");
    expect(linesForPage().map((line) => line.entryId)).toEqual([
      "user-1", "assistant-1", "custom-1", "compact-1", "branch-1", "user-2", "bash-1",
    ]);
    expect(linesForPage(5, 1).map((line) => line.entryId)).toEqual([
      "user-1", "assistant-1", "custom-1", "compact-1", "branch-1",
    ]);
    expect(linesForPage()[1]?.meta?.thinkingLevel).toBe("high");
    expect(historyMessagesFromEntries(entries)).toEqual(messages);
    expect(entries).toEqual(original);
  });

  it("keeps sourced system messages while excluding Pi's unsourced prompt", () => {
    const messages = historyMessagesFromEntries([
      { type: "message", id: "pi-system-prompt", message: { role: "system", content: "", sections: [{ text: "private system prompt" }] } },
      { type: "message", id: "branch-note", message: { role: "system", source: "pi-web", content: "Visible branch summary" } },
      { type: "message", id: "user-1", message: { role: "user", content: "hello" } },
    ]);

    expect(messages).toEqual([
      { role: "system", source: "pi-web", content: "Visible branch summary", entryId: "branch-note" },
      { role: "user", content: "hello", entryId: "user-1" },
    ]);
  });

  it("does not invent IDs for entries without durable identity", () => {
    const messages = historyMessagesFromEntries([
      { type: "message", message: { role: "user", id: "provider", entryId: "untrusted", content: "legacy" } },
      { type: "message", id: "", message: { role: "assistant", content: "answer" } },
    ]);
    expect(messages).toEqual([{ role: "user", id: "provider", content: "legacy" }, { role: "assistant", content: "answer" }]);
    expect(normalizeMessages(messages).every((line) => !("entryId" in line))).toBe(true);
  });
});

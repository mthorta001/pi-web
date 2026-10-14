import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import companion from '../dist/companion.js';
import { collectReply, collectSourceReply } from '../dist/roundtrip.js';
import { LogStore, logScope } from '../dist/store.js';
import { CAPTAIN_REPLY, PIRATE_INTRO, PIRATE_MARKER } from '../dist/browser/protocol.js';

const id = '12345678-1234-1234-1234-123456789abc';

function captainHarness({ getApiKeyAndHeaders = async () => ({ ok: true }), noModel = false } = {}) {
  const bus = new EventEmitter();
  const hooks = new Map();
  const sent = [];
  const entries = [];
  const sendWaiters = new Map();
  const context = {
    model: noModel ? undefined : { provider: 'anthropic', id: 'fake-model' },
    modelRegistry: { getApiKeyAndHeaders },
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: { getEntries: () => entries },
  };
  const notifySendWaiters = () => {
    for (const [count, waiters] of sendWaiters) {
      if (sent.length < count) continue;
      sendWaiters.delete(count);
      for (const resolve of waiters) resolve();
    }
  };
  const pi = {
    on: (name, handler) => hooks.set(name, handler),
    events: { on: (name, fn) => bus.on(name, fn), emit: (name, data) => bus.emit(name, data) },
    appendEntry(customType, data) { entries.push({ type: 'custom', customType, data }); }, setSessionName() {},
    sendUserMessage(prompt) {
      sent.push(prompt);
      hooks.get('before_agent_start')({ prompt }, context);
      notifySendWaiters();
    },
  };
  companion(pi);
  hooks.get('session_start')({}, context);
  const signal = new AbortController().signal;
  const connection = {
    signal,
    on(name, fn) { bus.on(name, fn); return () => bus.off(name, fn); },
    emit(name, data) { bus.emit(name, data); },
  };
  const waitForSentCount = (count) => sent.length >= count
    ? Promise.resolve()
    : new Promise((resolve) => {
      const waiters = sendWaiters.get(count) ?? [];
      waiters.push(resolve);
      sendWaiters.set(count, waiters);
    });
  return { pi, bus, hooks, sent, entries, context, signal, connection, waitForSentCount };
}

test('correlated native roundtrip distinguishes receipt, running and final settlement; supports followups', async () => {
  const { pi, bus, hooks, sent, entries, context, signal, connection, waitForSentCount } = captainHarness();
  for (const question of ['Inspect changes', 'Explain that risk']) {
    const sentBefore = sent.length;
    const stages = [];
    const result = collectReply(connection, id, question, signal, (stage) => stages.push(stage));
    await waitForSentCount(sentBefore + 1);
    if (sentBefore === 0) {
      assert.equal(sent[0], PIRATE_INTRO);
      hooks.get('before_agent_start')({ messageType: 'custom', message: { role: 'custom', customType: 'test', content: 'no prompt', display: true } }, context);
      hooks.get('message_end')({ message: { role: 'assistant', content: [{ type: 'text', text: 'Arrr' }], stopReason: 'stop' } });
      hooks.get('agent_settled')();
      await waitForSentCount(2);
    }
    assert.match(sent.at(-1), /theatrical pirate captain briefing the crew/);
    assert.match(sent.at(-1), /Rewrite it from scratch: nautical metaphors, colorful pirate phrasing, and a little humor/);
    assert.match(sent.at(-1), /Preserve the important facts, warnings, and next steps; keep code and commands exact/);
    assert.match(sent.at(-1), /Always speak pirate/);
    assert.ok(sent.at(-1).endsWith(`Source reply:
${question}`));
    assert.ok(stages.includes('Native Pi agent running'));
    bus.emit(CAPTAIN_REPLY, { requestId: 'other', status: 'completed', text: 'wrong' });
    hooks.get('message_end')({ message: { role: 'assistant', content: [{ type: 'text', text: 'Evidence-backed answer' }], stopReason: 'stop' } });
    hooks.get('agent_settled')();
    assert.equal(await result, 'Evidence-backed answer');
    assert.equal(bus.listenerCount(CAPTAIN_REPLY), 0);
    hooks.get('session_shutdown')();
    // Simulate Pi replacing extension listeners on reload; durable entries stay.
    bus.removeAllListeners();
    companion(pi);
    hooks.get('session_start')({}, context);
  }
  assert.equal(sent.filter((prompt) => prompt === PIRATE_INTRO).length, 1);
  assert.equal(entries.filter((entry) => entry.customType === PIRATE_MARKER).length, 1);
});

test('preflights Pi model authentication before accepting a request', async () => {
  const noModel = captainHarness({ noModel: true });
  await assert.rejects(
    collectReply(noModel.connection, id, 'Select a model', noModel.signal, () => {}),
    /Select a Pi model/,
  );
  assert.equal(noModel.sent.length, 0);

  let authAvailable = false;
  const harness = captainHarness({
    getApiKeyAndHeaders: async () => authAvailable ? { ok: true } : { ok: false, error: 'No API key found for anthropic' },
  });
  await assert.rejects(
    collectReply(harness.connection, id, 'Check credentials', harness.signal, () => {}),
    /No API key found/,
  );
  assert.equal(harness.sent.length, 0);

  authAvailable = true;
  const retry = collectReply(harness.connection, id, 'Retry with credentials', harness.signal, () => {});
  await harness.waitForSentCount(1);
  assert.equal(harness.sent[0], PIRATE_INTRO);
  harness.hooks.get('message_end')({ message: { role: 'assistant', content: [{ type: 'text', text: 'Arrr' }], stopReason: 'stop' } });
  harness.hooks.get('agent_settled')();
  await harness.waitForSentCount(2);
  harness.hooks.get('message_end')({ message: { role: 'assistant', content: [{ type: 'text', text: 'Credentials restored' }], stopReason: 'stop' } });
  harness.hooks.get('agent_settled')();
  assert.equal(await retry, 'Credentials restored');
});

test('preflights Captain followups and fails cleanly when authentication expires', async () => {
  let checks = 0;
  let failFollowup = true;
  const harness = captainHarness({
    getApiKeyAndHeaders: async () => {
      checks++;
      return failFollowup && checks === 2
        ? { ok: false, error: 'Credentials expired' }
        : { ok: true };
    },
  });
  const first = collectReply(harness.connection, id, 'First pass', harness.signal, () => {});
  await harness.waitForSentCount(1);
  harness.hooks.get('message_end')({ message: { role: 'assistant', content: [{ type: 'text', text: 'Arrr' }], stopReason: 'stop' } });
  harness.hooks.get('agent_settled')();
  await assert.rejects(first, /Credentials expired/);
  assert.equal(harness.sent.length, 1);

  failFollowup = false;
  const retry = collectReply(harness.connection, id, 'Retry after login', harness.signal, () => {});
  await harness.waitForSentCount(2);
  harness.hooks.get('message_end')({ message: { role: 'assistant', content: [{ type: 'text', text: 'Session recovered' }], stopReason: 'stop' } });
  harness.hooks.get('agent_settled')();
  assert.equal(await retry, 'Session recovered');
});

test('custom messages fail the active request and release the slot for retry', async () => {
  const harness = captainHarness();
  const first = collectReply(harness.connection, id, 'Inspect safely', harness.signal, () => {});
  await harness.waitForSentCount(1);
  harness.hooks.get('message_start')({
    message: { role: 'custom', customType: 'test', content: 'unrelated extension context', display: true, timestamp: Date.now() },
  }, harness.context);
  harness.hooks.get('message_end')({ message: { role: 'assistant', content: [{ type: 'text', text: 'Potentially tainted answer' }], stopReason: 'stop' } });
  harness.hooks.get('agent_settled')();
  await assert.rejects(first, /custom message interfered/);

  const retry = collectReply(harness.connection, id, 'Retry cleanly', harness.signal, () => {});
  await harness.waitForSentCount(2);
  harness.hooks.get('message_end')({ message: { role: 'assistant', content: [{ type: 'text', text: 'Clean answer' }], stopReason: 'stop' } });
  harness.hooks.get('agent_settled')();
  assert.equal(await retry, 'Clean answer');
});

test('source reads only completed assistant text on the active branch without side effects', async () => {
  const bus = new EventEmitter();
  const hooks = new Map();
  let idle = true;
  let pending = false;
  let entries = [];
  const assistant = (text, stopReason = 'stop') => ({ type: 'message', message: { role: 'assistant', stopReason, content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text }] } });
  let branch = [assistant('older'), assistant('latest completed'), assistant('unfinished', 'aborted')];
  companion({
    on: (name, handler) => hooks.set(name, handler),
    events: { on: (name, fn) => bus.on(name, fn), emit: (name, data) => bus.emit(name, data) },
    appendEntry() { assert.fail('source mutated'); }, setSessionName() { assert.fail('source renamed'); },
    sendUserMessage() { assert.fail('source prompted'); },
  });
  hooks.get('session_start')({}, { isIdle: () => idle, hasPendingMessages: () => pending, sessionManager: { getBranch: () => branch, getEntries: () => entries } });
  const signal = new AbortController().signal;
  const connection = { signal, on(name, fn) { bus.on(name, fn); return () => bus.off(name, fn); }, emit(name, data) { bus.emit(name, data); } };
  const read = () => collectSourceReply(connection, id, signal, () => {});
  assert.equal(await read(), 'latest completed');
  branch = [assistant('other branch')];
  assert.equal(await read(), 'other branch');
  idle = false;
  await assert.rejects(read(), /must be idle/);
  idle = true; pending = true;
  await assert.rejects(read(), /must be idle/);
  pending = false; branch = [assistant('partial', 'length'), assistant('tool preamble', 'toolUse')];
  await assert.rejects(read(), /no completed assistant text/);
  branch = [assistant('x'.repeat(48001))];
  await assert.rejects(read(), /translation limit/);
  entries = [{ type: 'custom', customType: PIRATE_MARKER }];
  await assert.rejects(read(), /other than the pirate/);
});

test('an ambiguous send fails once without resending', async () => {
  let sends = 0;
  let unsubscribed = false;
  const signal = new AbortController().signal;
  await assert.rejects(collectReply({ signal, on: () => () => { unsubscribed = true; }, emit() { sends++; throw new Error('ambiguous transport error'); } }, id, 'Translate me', signal, () => {}), /ambiguous transport/);
  assert.equal(sends, 1);
  assert.equal(unsubscribed, true);
});

test('disconnect fails visibly and cleans up without cancelling agent work', async () => {
  const controller = new AbortController();
  let unsubscribed = false;
  const result = collectReply({ signal: controller.signal, on: () => () => { unsubscribed = true; }, emit() {} }, id, 'Inspect', new AbortController().signal, () => {});
  controller.abort();
  await assert.rejects(result, /interrupted/);
  assert.equal(unsubscribed, true);
});

test('log survives store recreation and isolates workspace identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'captains-log-'));
  try {
    const scope = logScope('project', 'workspace');
    const record = { id, createdAt: new Date().toISOString(), sessionId: 'dedicated-session', question: 'Why?', status: 'completed', stages: ['Native companion received request'], text: 'Because' };
    await new LogStore(directory).save(scope, record);
    assert.deepEqual(await new LogStore(directory).read(scope, id), record);
    assert.deepEqual(await new LogStore(directory).list(logScope('project', 'other')), []);
    await assert.rejects(new LogStore(directory).read(scope, '../escape'), /Invalid/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

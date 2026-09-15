// Local subset of the official mods' test ($, on), tier and mock.clock shape.
// This drives real register.ts hooks but does NOT emulate host tree validation.
import { test as nodeTest, describe } from 'node:test';
import assert from 'node:assert/strict';
import { register } from '../../plugins/codex/hooks/live-tool-row/register.ts';
export { describe };
export function tier(name) { assert.equal(name, 'user'); }
export function test(name, fn) {
  nodeTest(name, async () => {
    const hooks = new Map();
    const on = (event, matcher, hook) => {
      if (typeof matcher === 'function') [hook, matcher] = [matcher, {}];
      const handlers = hooks.get(event) ?? [];
      handlers.push({ matcher, hook });
      hooks.set(event, handlers);
    };
    const dispatch = async (event, input = {}, index = 0) => {
      const handlers = hooks.get(event) ?? [];
      const entry = handlers[index];
      if (!entry) throw new Error(`Unanswered event: ${event}`);
      const next = value => dispatch(event, value, index + 1);
      if (!Object.entries(entry.matcher).every(([key, value]) => input[key] === value)) return next(input);
      return entry.hook($, input, next);
    };
    const element = type => ({ children, ...props }) => ({ type, props, children: Array.isArray(children) ? children : [children ?? ''] });
    const $ = {
      ui: { status: text => { void dispatch('ui.status', { text }); }, toast: (text, options) => { void dispatch('ui.toast', { text, ...options }); }, render: e => dispatch('ui.render', e), resolve: () => ({ Box: element('Box'), Text: element('Text'), Code: element('Code') }), invalidate: event => { void dispatch('ui.invalidate', { event }); } },
      fs: { stat: path => dispatch('fs.stat', { path }), read: path => dispatch('fs.read', { path }) },
      process: { run: (argv, init) => dispatch('process.run', { argv, init }) },
      session: { cwd: () => dispatch('session.cwd') },
      env: { get: name => dispatch('env.get', { name }) },
      store: {}, clock: {},
    };
    register(on);
    await fn($, on);
  });
}
export const mock = {
  env(on, values) { on('env.get', (_, e) => values[e.name]); },
  clock($) {
    let now = Date.parse('2026-09-15T00:00:00Z');
    const timers = new Set();
    const settle = () => new Promise(resolve => setImmediate(resolve));
    $.clock.now = async () => now;
    $.clock.every = (ms, callback) => {
      const timer = { ms, due: now + ms, callback };
      timers.add(timer);
      return { cancel: () => timers.delete(timer) };
    };
    return {
      settle, timers,
      async advance(ms) {
        const target = now + ms;
        for (;;) {
          const timer = [...timers].sort((a, b) => a.due - b.due)[0];
          if (!timer || timer.due > target) break;
          now = timer.due;
          timer.due += timer.ms;
          timer.callback();
          await settle();
        }
        now = target;
        await settle();
      },
    };
  },
};
export function fixture() {
  return {
    schemaVersion: 1, jobId: 'task-abc123-xyz789', label: 'fixture task', status: 'running',
    startedAt: '2026-09-15T00:00:00Z', endedAt: null, threadId: null, turnId: null,
    activeCommands: [{ itemId: 'cmd', command: 'npm test', cwd: '/work', startedAt: '2026-09-15T00:00:00Z' }],
    lastMessage: { kind: 'assistant', text: 'Checking the change', at: '2026-09-15T00:00:00Z' },
    files: [{ path: 'main.ts', kind: 'update', additions: 3, deletions: 1 }],
    usage: { inputTokens: 12, outputTokens: 5, cachedInputTokens: 0, complete: true },
    pendingQuestion: null, history: { committedSeq: '1', continuity: 'complete' },
    tail: [{ seq: '1', at: '2026-09-15T00:00:00Z', type: 'message', text: 'Started task' }],
  };
}
export function row(command = 'node /tools/codex-companion.mjs observe follow task-abc123-xyz789 --cwd /work', props = {}) {
  return { component: 'ToolUse', surface: 'terminal', requestId: 'tool-1', viewport: { columns: 120, rows: 40 },
    props: { tool: 'Bash', tool_use_id: 'tool-1', input: { command }, isRunning: true, isErrored: false, isInterrupted: false, ...props } };
}
export function world($, on) {
  const clock = mock.clock($);
  mock.env(on, { HOME: '/home/test' });
  const state = { text: JSON.stringify(fixture()), mtime: 1, reads: 0, stats: 0, runs: [], invalidations: [], statuses: [], toasts: [], missing: false, unknown: false };
  on('session.cwd', () => '/work');
  on('ui.render', { component: 'ToolUse' }, () => ({ type: 'Text', children: ['native Bash row'] }));
  on('ui.render', { component: 'PromptHint' }, (_, e) => ({ type: 'Text', children: [e.props.hint] }));
  on('ui.status', (_, e) => { state.statuses.push(e.text); });
  on('ui.toast', (_, e) => { state.toasts.push(e); });
  on('ui.invalidate', (_, e) => { state.invalidations.push(e); });
  on('process.run', (_, e) => {
    state.runs.push(e);
    if (state.unknown && e.argv.includes('view-path')) return { exitCode: 1, stderr: 'UNKNOWN_JOB task-abc123-xyz789\n', stdout: '' };
    return { exitCode: 0, stderr: '', stdout: e.argv[0] === 'bash' ? '/tools/codex-companion.mjs\n' : '/jobs/live-view.json\n' };
  });
  on('fs.stat', () => { state.stats++; if (state.missing) throw new Error('ENOENT'); return { kind: 'file', size: 1, mtimeMs: state.mtime }; });
  on('fs.read', () => { state.reads++; return state.text; });
  return { clock, state };
}
export function textOf(tree) {
  if (typeof tree === 'string') return tree;
  if (tree.type === 'Code') return tree.props.source;
  return (tree.children ?? []).map(textOf).join(tree.type === 'Box' ? '\n' : '');
}

export function hint(props = {}, columns = 120) {
  return { component: 'PromptHint', surface: 'terminal', requestId: 'hint', viewport: { columns, rows: 40 },
    props: { isDraft: false, isWorking: true, hint: '? for shortcuts', ...props } };
}

// Logical rows omit only the shared body layout, keeping the prior style assertions.
export function rowsOf(tree) {
  return [tree.children[0], ...tree.children[1].children[0].children];
}

export function terminalOutput(kind, text = '', label = 'row label') {
  return `CURSOR: x\n${kind} job=task-abc123-xyz789 [${label}] ${kind === 'QUESTION' ? 'request=1' : 'thread=thread-1'}${text ? ` ${text}` : ''}`;
}

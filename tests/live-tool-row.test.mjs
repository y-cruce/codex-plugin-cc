import assert from 'node:assert/strict';
import { describe, test, tier, fixture, row, resultRow, world, textOf, hint, rowsOf, terminalOutput } from './fixtures/live-tool-row.mjs';
import { followOf } from '../plugins/codex/hooks/live-tool-row/command.ts';
import { refresh } from '../plugins/codex/hooks/live-tool-row/register.ts';
import { terminalOf, duration, elapsed, shortPath, tailLimit, tokens, waiting } from '../plugins/codex/hooks/live-tool-row/format.ts';
import { clip, liveTree, statusText } from '../plugins/codex/hooks/live-tool-row/view.ts';
import { markdown } from '../plugins/codex/hooks/live-tool-row/markdown.ts';

tier('user');
describe('live ToolUse row', () => {
  test('keeps completed follow groups expanded and stops polling', async ($, on) => {
    const { clock, state } = world($, on);
    const seen = [];
    on('ui.render', { component: 'ToolGroup' }, (_, e) => {
      seen.push(e);
      return { type: 'Text', children: [e.props.isExpanded ? 'expanded' : 'collapsed'] };
    });
    const group = { component: 'ToolGroup', surface: 'terminal', requestId: 'group-1', props: {
      calls: [row().props, row(undefined, { tool: 'Read', tool_use_id: 'read-1' }).props], isActive: true, isExpanded: false,
    } };
    assert.equal(textOf(await $.ui.render(group)), 'expanded');
    assert.equal(seen[0].props.calls, group.props.calls);
    assert.equal(group.props.isExpanded, false);
    await $.ui.render(row());
    await clock.settle();
    const done = { ...group, props: { ...group.props, calls: group.props.calls.map(call => ({ ...call, isRunning: false })) } };
    assert.equal(textOf(await $.ui.render(done)), 'expanded');
    assert.equal(seen.at(-1).props.isExpanded, true);
    const stats = state.stats;
    await clock.advance(2000);
    assert.equal(clock.timers.size, 0);
    assert.equal(state.stats, stats);
    for (const props of [{ calls: [] }, { calls: [row('sleep 30').props] }, { calls: [row(undefined, { tool: 'Read' }).props] }, { isExpanded: true, calls: [] }]) {
      const input = { ...group, props: { ...group.props, ...props } };
      await $.ui.render(input);
      assert.equal(seen.at(-1), input);
    }
    await $.ui.render({ ...group, props: { ...group.props, calls: [{ ...row().props, tool_use_id: undefined }] } });
    assert.equal(seen.at(-1).props.isExpanded, true);
  });
  test('recognizes worker/direct follow and literal quoted or escaped paths', async ($, on) => {
    const { state } = world($, on);
    assert.equal(followOf('bash ~/.claude/codex-worker.sh follow task-abc123-xyz789').worker, true);
    assert.equal(followOf('node "/a b/codex-companion.mjs" observe follow task-abc123-xyz789 --cwd="/work space"').cwd, '/work space');
    assert.equal(followOf('node /a\\ b/codex-companion.mjs observe follow task-abc123-xyz789').script, '/a b/codex-companion.mjs');
    assert.equal(followOf('node /a/codex-companion.mjs observe follow task-abc123-xyz789; echo --cwd /wrong').cwd, undefined);
    for (const command of [undefined, 'ls', 'observe status task-abc123-xyz789', 'node /x/codex-companion.mjs observe follow task-BAD-id']) assert.equal(followOf(command), null);
    for (const props of [{ tool: 'Read' }, { isRunning: false, isErrored: true }, { input: null }, { input: { command: 'sleep 3' } }]) {
      assert.equal(textOf(await $.ui.render(row(undefined, props))), 'native Bash row');
    }
    assert.equal(state.runs.length, 0);
  });
  test('resolves view-path once, shares jobs, and reads only changed mtime', async ($, on) => {
    const { clock, state } = world($, on);
    await $.ui.render(row());
    await clock.settle();
    assert.match(textOf(await $.ui.render(row())), /Codex · fixture task/);
    await $.ui.render(row(undefined, { tool_use_id: 'tool-2' }));
    await clock.advance(1500);
    assert.equal(state.runs.length, 1);
    assert.deepEqual(state.runs[0].argv, ['node', '/tools/codex-companion.mjs', 'observe', 'view-path', 'task-abc123-xyz789', '--cwd', '/work']);
    assert.equal(state.reads, 1);
    assert.equal(clock.timers.size, 1);
    state.mtime++;
    state.text = JSON.stringify({ ...fixture(), label: 'updated' });
    await clock.advance(500);
    assert.equal(state.reads, 2);
    assert.match(textOf(await $.ui.render(row())), /updated/);
  });
  test('resolves worker companion, expands home and defaults cwd', async ($, on) => {
    const { clock, state } = world($, on);
    const input = row('bash ~/.claude/codex-worker.sh follow task-abc123-xyz789');
    await $.ui.render(input);
    await clock.settle();
    await $.ui.render(input);
    await clock.advance(1000);
    assert.equal(state.runs.length, 2);
    assert.deepEqual(state.runs[0].argv, ['bash', '/home/test/.claude/codex-worker.sh', 'companion']);
    assert.equal(state.runs[1].init.cwd, '/work');
  });
  test('invalid JSON falls back to native, retains prior data, and recovers', async ($, on) => {
    const { clock, state } = world($, on);
    const previous = fixture();
    const job = { follow: followOf(row().props.input.command), path: Promise.resolve('/jobs/live-view.json'), data: previous, mtime: 0, error: '' };
    state.text = '{broken';
    await refresh($, job);
    assert.equal(job.data, previous);
    assert.ok(job.error);
    await $.ui.render(row());
    await clock.settle();
    const text = textOf(await $.ui.render(row()));
    assert.match(text, /^native Bash row\ncodex live view unavailable:/);
    const reads = state.reads;
    await clock.advance(1000);
    assert.equal(state.reads, reads);
    state.mtime++;
    state.text = JSON.stringify(fixture());
    await clock.advance(500);
    assert.match(textOf(await $.ui.render(row())), /Codex · fixture task/);
    state.missing = true;
    await clock.advance(500);
    assert.match(textOf(await $.ui.render(row())), /unavailable: ENOENT/);
    state.missing = false;
    await clock.advance(500);
    assert.match(textOf(await $.ui.render(row())), /Codex · fixture task/);
  });
  test('retries a failed view-path lookup after a few polls instead of caching it', async ($, on) => {
    const { clock, state } = world($, on);
    state.unknown = true;
    await $.ui.render(row());
    await clock.settle();
    assert.match(textOf(await $.ui.render(row())), /unavailable: UNKNOWN_JOB/);
    const runs = state.runs.length;
    await clock.advance(1500);
    assert.equal(state.runs.length, runs);
    state.unknown = false;
    await clock.advance(1000);
    assert.ok(state.runs.length > runs);
    assert.match(textOf(await $.ui.render(row())), /Codex · fixture task/);
  });
  test('ending the final row cancels polling; lookup remains cached', async ($, on) => {
    const { clock, state } = world($, on);
    await $.ui.render(row());
    await clock.settle();
    await $.ui.render(row(undefined, { tool_use_id: 'tool-2' }));
    assert.match(textOf(await $.ui.render(row(undefined, { isRunning: false, output: terminalOutput('DONE') }))), /Codex · fixture task/);
    assert.equal(clock.timers.size, 1);
    await $.ui.render(row(undefined, { tool_use_id: 'tool-2', isRunning: false, isInterrupted: true }));
    const stats = state.stats;
    await clock.advance(3000);
    assert.equal(clock.timers.size, 0);
    assert.equal(state.stats, stats);
    await $.ui.render(row());
    await clock.settle();
    assert.equal(state.runs.length, 1);
  });
  test('elapsed redraw is once per second and shared across many rows', async ($, on) => {
    const { clock, state } = world($, on);
    for (let n = 0; n < 20; n++) await $.ui.render(row(undefined, { tool_use_id: `tool-${n}` }));
    await clock.settle();
    state.invalidations.length = 0;
    await clock.advance(3000);
    assert.equal(state.invalidations.length, 3);
    assert.ok(state.invalidations.every(call => call.event === 'ui.render'));
    assert.match(textOf(await $.ui.render(row())), /3s/);
  });
  test('bounds non-prose cells, keeps newest tail and displays unknown file counts', async ($, on) => {
    world($, on);
    const data = fixture();
    const long = '中文😀🧑‍💻e\u0301\u001b\t'.repeat(150);
    data.label = long;
    data.activeCommands = Array.from({ length: 5 }, () => ({ ...data.activeCommands[0], command: long }));
    data.pendingQuestion = { requestId: 'q', text: long, openedAt: data.startedAt, expiresAt: null };
    data.lastMessage.text = `${long}\n${long}\n${long}\nnot shown`;
    data.tail = Array.from({ length: 200 }, (_, n) => ({ seq: `${n}`, text: `event-${n} ${long}` }));
    for (const columns of [1, 2, 9, 40, 120]) {
      const tree = liveTree($.ui.resolve(row()), data, columns, Date.parse(data.startedAt) + 1000);
      const lines = textOf(tree).split('\n');
      assert.equal(rowsOf(tree).length, 16);
      // Independently count conservative code-point cells; combining marks
      // have zero physical width, emoji/CJK two. No raw controls can survive.
      // Prose rows wrap instead of being cut, so only truncated rows are measured.
      for (const node of rowsOf(tree)) {
        const line = textOf(node);
        assert.equal(/[\p{Cc}\p{Cf}]/u.test(line.replaceAll('\n', '')), false);
        if (['wrap', 'truncate-middle'].includes(node.props?.wrap)) continue;
        const cells = Array.from(line).reduce((sum, char) => sum + (/\p{Mark}/u.test(char) ? 0 : /[\p{Extended_Pictographic}\p{Script=Han}]/u.test(char) ? 2 : 1), 0);
        const available = node === rowsOf(tree)[0] ? columns : Math.max(1, columns - 2);
        assert.ok(cells <= available, `${cells} > ${available}: ${line}`);
      }
      if (columns === 120) {
        assert.match(lines.at(-1), /event-199/);
        assert.equal(rowsOf(tree)[0].children[1].props.bold, true);
        assert.equal(rowsOf(tree)[0].children[2].props.color, 'cyan');
      }
    }
    data.files[0].additions = null;
    assert.equal(textOf(liveTree($.ui.resolve(row()), data, 120, 0)).includes('(+? −1)'), true);
    data.files = [];
    assert.equal(textOf(liveTree($.ui.resolve(row()), data, 120, 0)).includes('files:'), false);
  });
  test('prose rows wrap whole; the newest assistant row shows the full lastMessage; commands stay one line', async ($, on) => {
    world($, on);
    const data = fixture();
    const paragraph = 'first line\nsecond line that is quite a bit longer than forty columns\tend\u001b';
    data.lastMessage = { kind: 'assistant', text: paragraph, at: data.startedAt };
    data.tail = [
      { seq: '1', at: data.startedAt, type: 'command.completed', text: `$ ${'x'.repeat(100)}`, exitCode: 0, durationMs: 1200 },
      { seq: '2', at: data.startedAt, type: 'message.completed', text: 'assistant: first line second line…' },
      { seq: '3', at: data.startedAt, type: 'reasoning.completed', text: 'reasoning: older thought' },
    ];
    const tree = liveTree($.ui.resolve(row()), data, 40, 0);
    const rows = rowsOf(tree).map(node => ({ text: textOf(node), wrap: node.props?.wrap }));
    const command = rows.find(r => r.text.startsWith('● $ xxx'));
    assert.equal(command.wrap, 'truncate-middle');
    assert.ok(command.text.endsWith('· 1.2s')); 
    const message = rows.find(r => r.text.startsWith('›'));
    assert.equal(message.wrap, 'wrap');
    assert.equal(message.text, '› first line\nsecond line that is quite a bit longer than forty columns end');
    const thought = rows.find(r => r.text.startsWith('…'));
    assert.equal(thought.wrap, 'wrap');
    assert.equal(thought.text, '… older thought');
    assert.equal(clip('中文😀', 5), '中文');
  });
});


describe('live row polish', () => {
  test('parses the last terminal line from string or Bash stdout and strips only metadata', () => {
    for (const kind of ['DONE', 'FAILED', 'QUESTION', 'NOTIFIED', 'TIMEOUT', 'STALLED']) {
      const text = 'Which color? [green] request=keep this text';
      const output = terminalOutput(kind, text, 'named job');
      const expected = { kind, text, label: 'named job' };
      assert.deepEqual(terminalOf(output), expected);
      assert.deepEqual(terminalOf({ stdout: `${terminalOutput('NOTIFIED', 'old')}\r\n${output}\r\n` }), expected);
    }
    assert.deepEqual(terminalOf('TIMEOUT job=task-abc123-xyz789 [name] 60s elapsed, continue with --after'), { kind: 'TIMEOUT', label: 'name', text: '60s elapsed, continue with --after' });
    assert.deepEqual(terminalOf('DONE job=task-abc123-xyz789'), { kind: 'DONE', text: '', label: undefined });
    assert.deepEqual(terminalOf('QUESTION job=task-abc123-xyz789 thread=t request=1 Which color?'), { kind: 'QUESTION', text: 'Which color?', label: undefined });
    for (const output of [null, {}, { stdout: 123 }, 'CURSOR: x', 'NOTIFIED job=', 'QUESTION_PENDING job=task-abc123-xyz789 request=1 wait', 'text DONE job=x']) assert.equal(terminalOf(output), undefined);
  });
  for (const [kind, status, color, dim] of [['QUESTION', 'question', 'magenta', false], ['NOTIFIED', 'notified', 'cyan', false], ['TIMEOUT', 'paused', undefined, true], ['STALLED', 'stalled', undefined, true]]) {
    test(`renders ${kind} from its own stdout without lookup, file reads or timers`, async ($, on) => {
      const { state, clock } = world($, on);
      state.missing = true;
      const body = 'Original text with enough words to wrap at a narrow terminal width.';
      const input = row(undefined, { isRunning: false, output: terminalOutput(kind, body) });
      input.viewport.columns = 40;
      const tree = await $.ui.render(input);
      assert.equal(textOf(tree), `● Codex · row label · ${status}${kind === 'TIMEOUT' ? '' : `\n${body}`}`);
      assert.equal(tree.children[0].props.color, color);
      assert.equal(tree.children[0].props.dimColor, dim);
      if (kind !== 'TIMEOUT') {
        assert.equal(tree.children[1].props.paddingLeft, 2);
        assert.equal(tree.children[1].children[0].props.wrap, 'wrap');
      }
      await clock.advance(2000);
      assert.equal(state.runs.length, 0);
      assert.equal(state.stats, 0);
      assert.equal(state.reads, 0);
      assert.equal(clock.timers.size, 0);
      assert.equal(state.toasts.length, 0);
    });
  }
  for (const [kind, status, color] of [['DONE', 'completed', 'green'], ['FAILED', 'failed', 'red']]) {
    test(`renders ${kind} full answer with its own status despite stale shared status`, async ($, on) => {
      const { state } = world($, on);
      const input = row(undefined, { isRunning: false, output: terminalOutput(kind) });
      const tree = await $.ui.render(input);
      assert.match(textOf(tree), new RegExp(`fixture task · ${status} ·`));
      assert.match(textOf(tree), /Checking the change/);
      assert.equal(rowsOf(tree)[0].children[2].props.color, color);
      assert.doesNotMatch(textOf(tree), /running|cursor|CURSOR/);
      await $.ui.render(input);
      assert.equal(state.reads, 1);
    });
  }
  test('keeps NOTIFIED and QUESTION rows stable beside DONE for the same job', async ($, on) => {
    const { state, clock } = world($, on);
    await $.ui.render(row()); await clock.settle();
    const notified = row(undefined, { isRunning: false, output: terminalOutput('NOTIFIED', 'color received: green') });
    const question = row(undefined, { tool_use_id: 'question', isRunning: false, output: terminalOutput('QUESTION', 'Which color?') });
    const first = await $.ui.render(notified);
    const second = await $.ui.render(question);
    assert.equal(textOf(first), '● Codex · fixture task · notified\ncolor received: green');
    assert.equal(textOf(second), '● Codex · fixture task · question\nWhich color?');
    assert.equal(state.reads, 1);
    const data = fixture(); data.label = 'latest label'; data.lastMessage.text = 'FINAL FULL ANSWER';
    state.mtime++; state.text = JSON.stringify(data);
    const done = row(undefined, { tool_use_id: 'done', isRunning: false, output: terminalOutput('DONE') });
    const third = await $.ui.render(done);
    assert.match(textOf(third), /latest label · completed/);
    assert.match(textOf(third), /FINAL FULL ANSWER/);
    assert.deepEqual(await $.ui.render(notified), first);
    assert.deepEqual(await $.ui.render(question), second);
    assert.doesNotMatch(textOf(first) + textOf(second), /FINAL FULL ANSWER/);
    assert.equal(state.reads, 2);
    assert.equal(clock.timers.size, 0);
  });
  test('unparseable ended output returns the native row and releases polling without a final read', async ($, on) => {
    const { state, clock } = world($, on);
    for (const output of [undefined, { stdout: 'CURSOR: x\nNOTIFI' }, 'no terminal']) {
      assert.equal(textOf(await $.ui.render(row(undefined, { isRunning: false, output }))), 'native Bash row');
    }
    assert.equal(state.runs.length, 0);
    await $.ui.render(row()); await clock.settle();
    assert.equal(textOf(await $.ui.render(row(undefined, { isRunning: false }))), 'native Bash row');
    assert.equal(clock.timers.size, 0);
    assert.equal(state.reads, 1);
  });
  test('shows one magenta question and cyan answer, filters closed and dynamic tool lifecycle before tail limiting', ($, on) => {
    world($, on);
    const data = fixture(); data.activeCommands = []; data.files = []; data.lastMessage = null;
    data.tail = [
      { type: 'question.opened', text: 'Question request=1: Which color?' },
      { type: 'question.resolved', text: 'director → answer delivered request=1' },
      { type: 'question.closed', text: 'Question resolved request=1' },
      { type: 'tool.started', text: 'regular tool started' },
      { type: 'tool.completed', text: 'regular tool completed' },
      ...Array.from({ length: 12 }, () => [
        { type: 'tool.started', text: 'dynamicToolCall started: notify_director' },
        { type: 'tool.completed', text: 'dynamicToolCall completed: notify_director' },
      ]).flat(),
    ];
    const tree = liveTree($.ui.resolve(row()), data, 120, 0, 16);
    const nodes = rowsOf(tree);
    const question = nodes.find(node => textOf(node).startsWith('?'));
    assert.equal(textOf(question), '? Question request=1: Which color?');
    assert.equal(question.props.color, 'magenta');
    const answer = nodes.find(node => textOf(node).startsWith('→'));
    assert.equal(textOf(answer), '→ answer delivered');
    assert.equal(answer.props.color, 'cyan');
    assert.doesNotMatch(textOf(tree), /Question resolved|dynamicToolCall|director →/);
    assert.match(textOf(tree), /regular tool started\nregular tool completed/);
    assert.equal(nodes.filter(node => node.props.color === 'magenta').length, 1);
  });
  test('formats tokens, durations, paths and waiting without controls', () => {
    assert.equal(tokens(82400), '82.4k');
    assert.equal(tokens(999), '999');
    assert.equal(tokens(1000), '1k');
    assert.equal(duration(1234), '1.2s');
    assert.equal(duration(61000), '1m1s');
    assert.equal(elapsed('2026-09-15T00:00:00Z', Date.parse('2026-09-15T00:00:03Z')), '3s');
    assert.equal(shortPath('a/long/path/main.ts', 10), '…h/main.ts');
    assert.equal(shortPath('main.ts', 10), 'main.ts');
    const now = Date.parse('2026-09-15T00:03:00Z');
    assert.equal(waiting('2026-09-15T00:00:00Z', '2026-09-15T00:10:00Z', now), 'waiting 3m · expires in 7m');
    assert.equal(waiting('2026-09-15T00:00:00Z', null, now), 'waiting 3m');
    assert.equal(waiting('2026-09-15T00:00:00Z', '2026-09-15T00:01:00Z', now), 'waiting 3m · expires in 0s');
    assert.equal(tailLimit(), 8);
  });
  test('renders a completed card once, preserves original output, and falls back on interruption/error', async ($, on) => {
    const { state, clock } = world($, on);
    const data = { ...fixture(), status: 'completed', endedAt: '2026-09-15T00:01:02Z' };
    data.lastMessage.text = 'Original answer\nsecond line';
    data.files = Array.from({ length: 5 }, (_, n) => ({ ...data.files[0], path: `file-${n}.ts` }));
    state.text = JSON.stringify(data);
    const output = { stdout: `private tool result\n${terminalOutput('DONE')}` };
    const done = row(undefined, { isRunning: false, output });
    const tree = await $.ui.render(done);
    assert.match(textOf(tree), /completed · 1m2s · 5 files\nOriginal answer\nsecond line/);
    assert.match(textOf(tree), /file-2.ts \(\+3 −1\)\n\+2 more$/);
    assert.equal(rowsOf(tree).at(-1).props.dimColor, true);
    assert.equal(done.props.output, output);
    assert.equal(output.stdout, `private tool result\n${terminalOutput('DONE')}`);
    assert.doesNotMatch(textOf(tree), /cursor|CURSOR/);
    await $.ui.render(done);
    await clock.advance(3000);
    assert.equal(state.reads, 1);
    assert.equal(state.stats, 1);
    assert.equal(clock.timers.size, 0);
    for (const flag of ['isInterrupted', 'isErrored']) assert.equal(textOf(await $.ui.render(row(undefined, { isRunning: false, [flag]: true }))), 'native Bash row');
    assert.equal(state.reads, 1);
    assert.doesNotMatch(textOf(await $.ui.render(row(undefined, { isRunning: false, output: terminalOutput('DONE') }))), /cursor/);
  });
  test('does not reread an ended row when another follow for the same job rerenders', async ($, on) => {
    const { state, clock } = world($, on);
    await $.ui.render(row()); await clock.settle();
    const done = row(undefined, { isRunning: false, output: terminalOutput('DONE') });
    await $.ui.render(done);
    await $.ui.render(row(undefined, { tool_use_id: 'another-follow' })); await clock.settle();
    const reads = state.reads;
    await $.ui.render(done);
    assert.equal(state.reads, reads);
  });
  test('aggregates distinct running jobs in PromptHint and restores the hint on terminal data', async ($, on) => {
    const { state, clock } = world($, on);
    const data = fixture();
    const other = { ...fixture(), label: 'second', jobId: 'task-second-abcdef', activeCommands: [], files: [...data.files, ...data.files] };
    assert.equal(statusText([data, other], Date.parse(data.startedAt)), 'Codex · 2 running · fixture task 0s $ npm test · second 0s ✎ 2 files');
    assert.equal(statusText([{ ...data, status: 'completed' }], 0), undefined);
    await $.ui.render(row()); await clock.settle();
    await $.ui.render(row(undefined, { tool_use_id: 'duplicate' }));
    const initial = textOf(await $.ui.render(hint()));
    assert.match(initial, /^Codex · 1 running/);
    await clock.advance(500);
    assert.equal(textOf(await $.ui.render(hint())), initial);
    state.mtime++; state.text = JSON.stringify({ ...data, status: 'completed' });
    await clock.advance(500);
    assert.equal(textOf(await $.ui.render(hint())), '? for shortcuts');
    await clock.advance(1000);
    assert.equal(textOf(await $.ui.render(hint())), '? for shortcuts');
    assert.deepEqual(state.statuses, []);
  });
  test('restores PromptHint when the last running row is interrupted', async ($, on) => {
    const { state, clock } = world($, on);
    await $.ui.render(row()); await clock.settle();
    await $.ui.render(row(undefined, { isRunning: false, isInterrupted: true }));
    assert.equal(textOf(await $.ui.render(hint())), '? for shortcuts');
    assert.deepEqual(state.statuses, []);
    assert.equal(clock.timers.size, 0);
  });
  test('toasts each question, notification and terminal event once across ticks and tail eviction', async ($, on) => {
    const { state, clock } = world($, on);
    const data = fixture();
    data.status = 'waiting-for-answer';
    data.pendingQuestion = { requestId: 'q1', text: 'Question '.repeat(30), openedAt: data.startedAt, expiresAt: null };
    data.tail = [{ seq: '2', type: 'question.opened', text: '?', at: data.startedAt }, { seq: '3', type: 'director.notified', text: 'review ready', at: data.startedAt }];
    state.text = JSON.stringify(data);
    await $.ui.render(row()); await clock.settle();
    await $.ui.render(row(undefined, { tool_use_id: 'duplicate' }));
    await clock.advance(1500);
    assert.equal(state.toasts.length, 2);
    const question = state.toasts.find(item => item.timeoutMs === 8000);
    assert.match(question.text, /^Codex/);
    assert.doesNotMatch(question.text, /[\p{Cc}]/u);
    assert.ok(question.text.includes(clip(data.pendingQuestion.text, 80)));
    data.tail = []; state.mtime++; state.text = JSON.stringify(data); await clock.advance(500);
    assert.equal(state.toasts.length, 2);
    data.tail.push({ seq: '4', type: 'director.notified', text: 'new event', at: data.startedAt });
    state.mtime++; state.text = JSON.stringify(data); await clock.advance(500);
    assert.equal(state.toasts.length, 3);
    for (const status of ['completed', 'failed', 'cancelled']) {
      data.status = status; data.endedAt = '2026-09-15T00:01:00Z';
      state.mtime++; state.text = JSON.stringify(data); await clock.advance(1000);
      assert.equal(state.toasts.filter(item => item.text.endsWith(`· ${status}`)).length, 1);
    }
  });
  test('a follow row draws no result block; other Bash results stay native', async ($, on) => {
    const { clock } = world($, on);
    const output = { stdout: '… 19:03:42 still running\nCURSOR: abc\nTIMEOUT job=task-abc123-xyz789 [fixture task] thread=t 540s elapsed, continue with --after', stderr: '', interrupted: false };
    assert.equal(textOf(await $.ui.render(resultRow(output))), '');
    assert.equal(textOf(await $.ui.render(resultRow({ stdout: 'hello', stderr: '' }, { tool_use_id: 'other' }))), 'native Bash result');
    assert.equal(textOf(await $.ui.render(resultRow(output, { isErrored: true }))), 'native Bash result');
    await $.ui.render(row(undefined, { tool_use_id: 'seen' })); await clock.settle();
    assert.equal(textOf(await $.ui.render(resultRow({ stdout: 'no terminal line yet', stderr: '' }, { tool_use_id: 'seen' }))), '');
    assert.equal(textOf(await $.ui.render(resultRow({ stdout: 'x', stderr: '' }, { tool: 'Read', tool_use_id: 'seen' }))), 'native Bash result');
  });
  test('a job first seen already finished draws its card without a completion toast', async ($, on) => {
    const { state, clock } = world($, on);
    const data = fixture(); data.status = 'completed'; data.endedAt = '2026-09-15T00:01:00Z';
    state.text = JSON.stringify(data);
    await $.ui.render(row(undefined, { isRunning: false, output: 'CURSOR: abc123456\nDONE job=task-abc123-xyz789' })); await clock.settle();
    await clock.advance(1500);
    assert.equal(state.toasts.length, 0);
  });
  test('colors command completion dots, preserves suffix and styles event kinds', ($, on) => {
    world($, on);
    const data = fixture(); data.activeCommands = []; data.lastMessage = null; data.files = [];
    data.tail = [0, 7, null].map((exitCode, n) => ({ seq: String(n), type: 'command.completed', text: '$ echo hello', exitCode, durationMs: 1200 }));
    data.tail.push(...['message.completed', 'reasoning.completed', 'question.opened', 'director.notified', 'source.error', 'fileChange.completed', 'control.message.updated'].map(type => ({ type, text: 'body' })));
    const tree = liveTree($.ui.resolve(row()), data, 120, 0, 48);
    const commands = rowsOf(tree).filter(node => node.props.wrap === 'truncate-middle');
    assert.deepEqual(commands.map(node => node.children[0].props.color), ['green', 'red', 'gray']);
    assert.ok(commands.every(node => textOf(node) === '● $ echo hello · 1.2s'));
    for (const [prefix, color, dim] of [['›', undefined, false], ['…', undefined, true], ['?', 'magenta', false], ['→', 'cyan', false]]) {
      const node = rowsOf(tree).find(node => textOf(node).startsWith(prefix));
      assert.equal(node.props.color, color); assert.equal(node.props.dimColor, dim);
    }
    assert.equal(rowsOf(tree).find(node => textOf(node) === 'body').props.color, 'red');
    assert.ok(rowsOf(tree).some(node => textOf(node) === '✎ body'));
  });
  test('puts the waiting question first and warns only when running without progress over 120 seconds', ($, on) => {
    world($, on);
    const data = fixture(); const now = Date.parse(data.startedAt) + 180000;
    let tree = liveTree($.ui.resolve(row()), data, 200, now);
    assert.match(textOf(rowsOf(tree)[0]), /no progress 3m/);
    assert.equal(rowsOf(tree)[0].children.at(-1).props.dimColor, true);
    assert.doesNotMatch(textOf(liveTree($.ui.resolve(row()), data, 200, now - 60000)), /no progress/);
    data.status = 'waiting-for-answer';
    data.pendingQuestion = { requestId: 'q', text: 'first\nsecond', openedAt: data.startedAt, expiresAt: '2026-09-15T00:10:00Z' };
    tree = liveTree($.ui.resolve(row()), data, 200, now);
    assert.equal(rowsOf(tree)[0].props.color, 'magenta');
    assert.equal(textOf(rowsOf(tree)[1]), '? first\nsecond');
    assert.equal(textOf(rowsOf(tree)[2]), 'waiting 3m · expires in 7m');
    assert.doesNotMatch(textOf(tree), /no progress/);
  });
  test('selects the newest 4 to 12 tail entries from viewport rows, defaulting to 8', ($, on) => {
    world($, on);
    const data = fixture(); data.activeCommands = []; data.files = []; data.lastMessage = null;
    data.tail = Array.from({ length: 30 }, (_, n) => ({ seq: String(n), type: 'message.completed', text: `event-${n}`, at: data.startedAt }));
    for (const [rows, count] of [[4, 4], [24, 6], [40, 10], [100, 12], [undefined, 8]]) {
      const tree = liveTree($.ui.resolve(row()), data, 120, 0, rows);
      const events = rowsOf(tree).filter(node => textOf(node).startsWith('›'));
      assert.equal(events.length, count);
      assert.equal(textOf(events[0]), `› event-${30 - count}`);
      assert.equal(textOf(events.at(-1)), '› event-29');
    }
  });
});

describe('Markdown and prompt footer', () => {
  test('commits earlier Markdown blocks and hides the streaming last block behind an ellipsis', ($, on) => {
    world($, on);
    const ui = $.ui.resolve(row());
    const committed = '# Heading\n\n- **item**\n\n| A | B |\n|--|--|\n| one | two |\n\n```ts\nconst x = 1\n\nreturn x\n```\n\n';
    const last = '**writing** `code` [a](/x/y\u001b';
    const nodes = markdown(ui, committed + last, { dimColor: true }, '› ', 100, true);
    assert.deepEqual(nodes.slice(0, -1), markdown(ui, committed, { dimColor: true }, '› ', 100));
    assert.equal(nodes.at(-1).type, 'Text');
    assert.equal(nodes.at(-1).props.dimColor, true);
    assert.equal(textOf(nodes.at(-1)), '…');
    assert.doesNotMatch(textOf({ type: 'Box', children: nodes }), /writing|\[a\]/);
    assert.ok(nodes.some(node => node.type === 'Code'));
    assert.ok(nodes.some(node => node.type === 'Box'));
  });
  test('a single streaming block shows only the prefixed ellipsis until it completes', ($, on) => {
    world($, on);
    for (const source of ['# **Title**\n- *item* [a](/x/y', '| A | B |\n|--|--|\n| x | [a](/x/y']) {
      const nodes = markdown($.ui.resolve(row()), source, {}, '› ', 100, true);
      assert.equal(nodes.length, 1);
      assert.equal(nodes[0].type, 'Text');
      assert.equal(nodes[0].props.dimColor, true);
      assert.equal(textOf(nodes[0]), '› …');
    }
  });
  test('hides an unclosed fence including internal blank lines and commits only after its closing blank line', ($, on) => {
    world($, on);
    const ui = $.ui.resolve(row());
    for (const fence of ['```', '~~~~']) {
      const source = `${fence}ts\n**raw**\n\n[a](/x/y\n\n`;
      for (const prefix of ['', '# Ready\n\n']) {
        const nodes = markdown(ui, prefix + source, {}, '', 100, true);
        assert.equal(textOf(nodes.at(-1)), '…');
        assert.ok(nodes.every(node => node.type !== 'Code'));
        assert.doesNotMatch(textOf({ type: 'Box', children: nodes }), /raw/);
      }
      assert.equal(markdown(ui, source + fence, {}, '', 100, true)[0].type, 'Text');
      assert.equal(markdown(ui, source + fence + '\n\n', {}, '', 100, true)[0].type, 'Code');
    }
  });
  test('switches newest delta tables to columns on completion and always renders result cards as Markdown', async ($, on) => {
    const { state, clock } = world($, on);
    const data = fixture(); data.activeCommands = []; data.files = [];
    data.lastMessage.text = '| Name | Detail |\n|--|--|\n| file | [a](/x/y) |';
    data.tail = [{ type: 'message.completed', text: 'assistant: **older**' }, { type: 'message.delta', text: 'truncated' }];
    state.text = JSON.stringify(data);
    await $.ui.render(row()); await clock.settle();
    let tree = await $.ui.render(row());
    assert.match(textOf(tree), /› older/);
    assert.equal(textOf(rowsOf(tree).at(-1)), '› …');
    assert.ok(rowsOf(tree).every(node => node.type !== 'Box'));
    const result = liveTree($.ui.resolve(row()), data, 120, 0, undefined, { kind: 'DONE' });
    assert.deepEqual(rowsOf(result).filter(node => node.type === 'Box').map(node => node.children.map(textOf)), [['Name', 'Detail'], ['file', 'a']]);
    data.tail.at(-1).type = 'message.completed';
    state.text = JSON.stringify(data); state.mtime++;
    await clock.advance(500);
    tree = await $.ui.render(row());
    assert.deepEqual(rowsOf(tree).filter(node => node.type === 'Box').map(node => node.children.map(textOf)), [['Name', 'Detail'], ['file', 'a']]);
    assert.doesNotMatch(textOf(tree), /\|--|\/x\/y/);
  });
  test('renders inline bold, both italics, cyan code and link labels in wrapping paragraphs', ($, on) => {
    world($, on);
    const nodes = markdown($.ui.resolve(row()), '**bold** *star* _under_ `code` [title](https://example.com)\nnext\u001b');
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].props.wrap, 'wrap');
    assert.equal(textOf(nodes[0]), 'bold star under code title\nnext');
    for (const [text, key, value] of [['bold', 'bold', true], ['star', 'italic', true], ['under', 'italic', true], ['code', 'color', 'cyan']]) {
      const node = nodes[0].children.find(node => textOf(node) === text);
      assert.equal(node.props[key], value);
      assert.equal(node.props.inverse, undefined);
    }
  });
  test('renders all six heading levels and two-level unordered and ordered lists', ($, on) => {
    world($, on);
    const ui = $.ui.resolve(row());
    const headings = markdown(ui, Array.from({ length: 6 }, (_, n) => `${'#'.repeat(n + 1)} Title`).join('\n'));
    assert.equal(headings.length, 6);
    assert.ok(headings.every(node => node.props.bold && textOf(node) === 'Title'));
    const lists = markdown(ui, '- first\n    * nested\n+ next\n1. one\n    2. two\n3. three');
    assert.deepEqual(lists.map(textOf), ['• first', '  • nested', '• next', '1. one', '  2. two', '3. three']);
  });
  test('uses Code with language and sanitizes controls; quotes are dim', ($, on) => {
    world($, on);
    const nodes = markdown($.ui.resolve(row()), '```ts\nconst a = 1;\u001b\n\treturn a;\n```\n> **quoted**');
    assert.equal(nodes[0].type, 'Code');
    assert.equal(nodes[0].props.language, 'ts');
    assert.equal(nodes[0].props.source, 'const a = 1;\n return a;');
    assert.equal(nodes[1].props.dimColor, true);
    assert.equal(textOf(nodes[1]), 'quoted');
    const plain = markdown($.ui.resolve(row()), '~~~\nplain\n~~~');
    assert.equal(plain[0].type, 'Code');
    assert.equal(plain[0].props.language, undefined);
  });
  test('keeps unknown syntax, tables and horizontal rules unchanged', ($, on) => {
    world($, on);
    const nodes = markdown($.ui.resolve(row()), '~~strike~~ <tag> {unknown} **unclosed ``unknown`` ![image](url)\n| **raw** | table |\n---');
    assert.deepEqual(nodes.map(textOf), ['~~strike~~ <tag> {unknown} **unclosed ``unknown`` ![image](url)', '| **raw** | table |', '---']);
  });
  test('caps code at 10000 characters and appends a separate dim ellipsis only on overflow', ($, on) => {
    world($, on);
    for (const size of [10000, 10001]) {
      const nodes = markdown($.ui.resolve(row()), `\`\`\`js\n${'x'.repeat(size)}\n\`\`\``);
      assert.equal(nodes[0].props.source.length, 10000);
      assert.equal(nodes.length, size === 10000 ? 1 : 2);
      if (size > 10000) {
        assert.equal(textOf(nodes[1]), '…');
        assert.equal(nodes[1].props.dimColor, true);
      }
    }
  });
  test('renders older and full newest assistant text and result Markdown but keeps reasoning plain and dim', ($, on) => {
    world($, on);
    const data = fixture(); data.activeCommands = []; data.files = [];
    data.lastMessage.text = '# Full answer\n```ts\nconst full = true\n```';
    data.tail = [
      { type: 'message.completed', text: 'assistant: **older**' },
      { type: 'message.updated', text: 'assistant: truncated' },
      { type: 'reasoning.completed', text: 'reasoning: **plain** `raw`' },
    ];
    const ui = $.ui.resolve(row());
    let tree = liveTree(ui, data, 120, 0);
    assert.match(textOf(tree), /› older\n› Full answer\nconst full = true\n… \*\*plain\*\* `raw`/);
    assert.equal(rowsOf(tree).at(-1).props.dimColor, true);
    tree = liveTree(ui, data, 120, 0, undefined, { kind: 'DONE' });
    assert.equal(rowsOf(tree)[1].props.bold, true);
    assert.equal(rowsOf(tree)[2].type, 'Code');
    data.lastMessage = { ...data.lastMessage, kind: 'reasoning', text: '**raw thought**' };
    for (const result of [undefined, { kind: 'DONE' }]) {
      tree = liveTree(ui, data, 120, 0, undefined, result);
      const thought = rowsOf(tree).find(node => textOf(node).includes('**raw thought**'));
      assert.ok(thought.props.dimColor);
    }
  });
  test('PromptHint draws cyan Codex and dim status, appends only hints that fit, and uses the shared tick', async ($, on) => {
    const { state, clock } = world($, on);
    await $.ui.render(row()); await clock.settle();
    let tree = await $.ui.render(hint());
    assert.equal(textOf(tree), 'Codex · 1 running · fixture task 0s $ npm test  ? for shortcuts');
    assert.equal(tree.children[0].props.color, 'cyan');
    assert.ok(tree.children.slice(1).every(node => node.props.dimColor));
    const own = statusText([fixture()], Date.parse(fixture().startedAt));
    for (const columns of [own.length, own.length + 16]) {
      tree = await $.ui.render(hint({}, columns));
      assert.equal(textOf(tree), own);
    }
    assert.equal(textOf(await $.ui.render(hint({}, own.length + 17))), `${own}  ? for shortcuts`);
    assert.equal(textOf(await $.ui.render(hint({ hint: '中文' }, own.length + 5))), own);
    assert.equal(textOf(await $.ui.render(hint({ hint: '中文' }, own.length + 6))), `${own}  中文`);
    state.invalidations.length = 0;
    await clock.advance(1000);
    assert.match(textOf(await $.ui.render(hint())), /fixture task 1s/);
    assert.equal(state.invalidations.length, 1);
    assert.equal(clock.timers.size, 1);
    assert.deepEqual(state.statuses, []);
  });
  test('PromptHint passes the original event through when no job exists or the prompt is a draft', async ($, on) => {
    const seen = [];
    on('ui.render', { component: 'PromptHint' }, (_, e) => { seen.push(e); return { type: 'Text', children: ['original hint'] }; });
    const { clock } = world($, on);
    const empty = hint();
    assert.equal(textOf(await $.ui.render(empty)), 'original hint');
    assert.equal(seen.at(-1), empty);
    await $.ui.render(row()); await clock.settle();
    const draft = hint({ isDraft: true });
    assert.equal(textOf(await $.ui.render(draft)), 'original hint');
    assert.equal(seen.at(-1), draft);
  });
  test('splits command output onto a dim row only for a failed completion', ($, on) => {
    world($, on);
    const data = fixture(); data.activeCommands = []; data.files = []; data.lastMessage = null;
    data.tail = [0, 2, null].map(exitCode => ({ type: 'command.completed', text: '$ echo hello ⏎ first\nsecond ⏎ third', exitCode, durationMs: 1200 }));
    data.tail.push({ type: 'command.started', text: '$ started ⏎ hidden', exitCode: 2 });
    const tree = liveTree($.ui.resolve(row()), data, 40, 0);
    const commands = rowsOf(tree).filter(node => node.props.wrap === 'truncate-middle');
    assert.deepEqual(commands.map(textOf), ['● $ echo hello · 1.2s', '● $ echo hello · 1.2s', '● $ echo hello · 1.2s', '$ started']);
    assert.deepEqual(commands.slice(0, 3).map(node => node.children[0].props.color), ['green', 'red', 'gray']);
    const outputs = rowsOf(tree).filter(node => textOf(node).startsWith('  '));
    assert.equal(outputs.length, 1);
    assert.equal(textOf(outputs[0]), '  first second ⏎ third');
    assert.equal(outputs[0].props.dimColor, true);
    assert.equal(outputs[0].props.wrap, 'truncate-end');
    assert.equal(rowsOf(tree)[rowsOf(tree).indexOf(commands[1]) + 1], outputs[0]);
    assert.doesNotMatch(textOf(tree), /hidden/);
  });
});

describe('table layout, body indent and startup noise', () => {
  const source = '| Name | Detail |\n|---|:--:|\n| 中文😀 | **bold** *italic* `code` [link](https://example.com) |\n| second | final cell |';
  test('fits table columns by visible terminal cells, hides separator and formats cells', ($, on) => {
    world($, on);
    const nodes = markdown($.ui.resolve(row()), source, {}, '', 100);
    assert.equal(nodes.length, 3);
    assert.deepEqual(nodes[0].children.map(node => node.props.width), [6, 21]);
    for (const node of nodes) {
      assert.equal(node.props.flexDirection, 'row');
      assert.equal(node.props.columnGap, 2);
      assert.ok(node.children.every(cell => cell.props.flexShrink === 0 && cell.children[0].props.wrap === 'truncate-end'));
    }
    assert.ok(nodes[0].children.every(cell => cell.children[0].props.bold));
    const parts = nodes[1].children[1].children[0].children;
    for (const [text, prop, value] of [['bold', 'bold', true], ['italic', 'italic', true], ['code', 'color', 'cyan']]) {
      assert.equal(parts.find(part => textOf(part) === text).props[prop], value);
    }
    assert.equal(parts.map(textOf).join(''), 'bold italic code link');
    assert.doesNotMatch(nodes.map(textOf).join('\n'), /---|:--:|`|https:/);
  });
  test('compresses proportionally with an eight-cell minimum and preserves full wrapping text', ($, on) => {
    world($, on);
    const nodes = markdown($.ui.resolve(row()), source, {}, '', 24);
    assert.deepEqual(nodes[0].children.map(node => node.props.width), [8, 14]);
    assert.ok(nodes.every(node => node.children.every(cell => cell.children[0].props.wrap === 'wrap')));
    assert.equal(textOf(nodes[1].children[1]), 'bold italic code link');
    const wide = markdown($.ui.resolve(row()), '| A | B | C |\n|--|--|--|\n| 12345678901234567890 | 1234567890123456789012345678901234567890 | x |', {}, '', 44);
    assert.deepEqual(wide[0].children.map(cell => cell.props.width), [10, 22, 8]);
  });
  test('falls back to header-labelled rows below the minimum including gaps, with blank row separators', ($, on) => {
    world($, on);
    const ui = $.ui.resolve(row());
    const nodes = markdown(ui, source, {}, '', 17);
    assert.deepEqual(nodes.map(textOf), ['Name: 中文😀', 'Detail: bold italic code link', ' ', 'Name: second', 'Detail: final cell']);
    assert.ok(nodes.filter(node => textOf(node) !== ' ').every(node => node.props.wrap === 'wrap'));
    assert.equal(nodes[1].children.find(node => textOf(node) === 'code').props.color, 'cyan');
    assert.equal(markdown(ui, source, {}, '', 18)[0].type, 'Box');
  });
  test('pads irregular rows to the maximum column count and accepts optional outer pipes and escaped pipes', ($, on) => {
    world($, on);
    const nodes = markdown($.ui.resolve(row()), 'A | B\n--|--\n`x\\|y` | two | extra\nonly |', {}, '', 100);
    assert.ok(nodes.every(node => node.children.length === 3));
    assert.deepEqual(nodes.map(node => node.children.map(textOf)), [['A', 'B', ''], ['x|y', 'two', 'extra'], ['only', '', '']]);
  });
  test('indents every body node two cells and subtracts two from clipping and Markdown layout in live and result cards', ($, on) => {
    world($, on);
    const ui = $.ui.resolve(row());
    const data = fixture();
    data.pendingQuestion = { requestId: 'q', text: 'question\ncontinued', openedAt: data.startedAt, expiresAt: null };
    data.lastMessage.text = source;
    data.tail.push({ type: 'other', text: 'x'.repeat(100) });
    for (const result of [undefined, { output: 'CURSOR: abc123456' }]) {
      const tree = liveTree(ui, data, 26, 0, undefined, result);
      assert.equal(tree.children.length, 2);
      assert.match(textOf(tree.children[0]), /^● Codex/);
      const body = tree.children[1];
      assert.equal(body.props.paddingLeft, 2);
      assert.equal(body.children[0].props.width, 24);
      const tables = rowsOf(tree).filter(node => node.type === 'Box');
      assert.deepEqual(tables[0].children.map(cell => cell.props.width), [8, 14]);
      if (!result) {
        assert.equal(textOf(rowsOf(tree).at(-1)), 'x'.repeat(24));
        assert.ok(rowsOf(tree).some(node => textOf(node) === ' '));
        assert.ok(rowsOf(tree).some(node => textOf(node).startsWith('$ npm')));
        assert.ok(rowsOf(tree).some(node => textOf(node).includes('question\ncontinued')));
      }
    }
  });
  test('removes startup events and duplicate warnings before tail limiting without mutating data', ($, on) => {
    world($, on);
    const data = fixture(); data.activeCommands = []; data.files = []; data.lastMessage = null;
    data.tail = [{ type: 'job.started', text: 'Job started' }, { type: 'source.warning', text: 'warning' }, { type: 'source.warning', text: 'distinct warning' }, ...Array.from({ length: 15 }, () => ({ type: 'source.warning', text: 'warning' }))];
    const original = JSON.stringify(data);
    const tree = liveTree($.ui.resolve(row()), data, 100, 0);
    assert.deepEqual(rowsOf(tree).slice(1).map(textOf), [' ', 'warning', 'distinct warning']);
    assert.ok(rowsOf(tree).slice(2).every(node => node.props.dimColor));
    assert.equal(JSON.stringify(data), original);
    data.tail = [{ type: 'job.started', text: 'Job started' }];
    assert.equal(rowsOf(liveTree($.ui.resolve(row()), data, 100, 0)).length, 1);
  });
  test('status detail prefers changed files, then clipped latest tail, then only label and time', () => {
    const data = fixture(); data.activeCommands = [];
    const now = Date.parse(data.startedAt);
    assert.equal(statusText([data], now), 'Codex · 1 running · fixture task 0s ✎ 1 files');
    data.files = []; data.tail.push({ text: '中文'.repeat(30) });
    assert.equal(statusText([data], now), `Codex · 1 running · fixture task 0s ${'中文'.repeat(7)}中`);
    data.tail = [];
    assert.equal(statusText([data], now), 'Codex · 1 running · fixture task 0s');
  });
});

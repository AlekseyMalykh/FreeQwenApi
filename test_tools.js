import { parseToolCallFromText, executeTool, buildToolSystemPrompt, getToolDefinitions, getPendingPatch } from './src/tools/toolExecutor.js';
import {
    getAgentState, createAgentState, getOrCreateAgentState,
    updateAgentState, recordToolAction, setPendingPatch,
    clearPendingPatch, confirmSessionPatch, touchRecentFile,
    setLastSearchResults, updateCwd, resetAgentState,
    buildAgentRuntimeContext, getAllSessionKeys, getAgentStateCount,
    setTaskGoal, addProgressEntry, incrementNoProgress, recordSeenAction,
    setLastDecision, addObservation, autoTransitionMode,
    resolveSessionKey, confirmPendingPatch, rejectPendingPatch,
    markPatchApplied
} from './src/api/agentState.js';
import { runAgentLoop } from './src/api/orchestrator.js';
import { buildToolObservation, hasProgress } from './src/api/toolObservation.js';
import path from 'path';
import fs from 'fs';

const TEST_DIR = path.resolve('test_output');
const TEST_FILE = path.join(TEST_DIR, 'test.txt');

// Setup
if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });

let passed = 0;
let failed = 0;
let skipped = 0;

function assert(condition, name) {
    if (condition) { console.log(`  ✅ ${name}`); passed++; }
    else { console.log(`  ❌ ${name}`); failed++; }
}

function skip(name, reason) {
    console.log(`  ⏭️  ${name} (${reason})`);
    skipped++;
}

// Cleanup
function cleanup() {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
}

// ─── 1. Session identity tests ───────────────────────────────────────────────
console.log('\n=== 1. Session Identity Tests ===\n');

// Test 1: resolveSessionKey from x-session-key header
const key1 = resolveSessionKey({ 'x-session-key': 'my-session-123' }, {});
assert(key1 === 'my-session-123', 'resolveSessionKey uses x-session-key header');

// Test 2: resolveSessionKey from conversation_id
const key2 = resolveSessionKey({}, { conversation_id: 'conv_abc' });
assert(key2 === 'conv_conv_abc', 'resolveSessionKey uses conversation_id from body');

// Test 3: resolveSessionKey generates new key
const key3 = resolveSessionKey({}, {});
assert(key3.startsWith('session_'), 'resolveSessionKey generates new session key');

// Test 4: sessionKey != chatId
const state4 = getOrCreateAgentState({ sessionKey: 'test_sid', chatId: 'qwen-chat-123', projectRoot: 'C:/test' });
assert(state4.sessionKey === 'test_sid', 'sessionKey is separate from chatId');
assert(state4.chatId === 'qwen-chat-123', 'chatId stored separately in state');
resetAgentState('test_sid');

// Test 5: session isolation
const stateA = getOrCreateAgentState({ sessionKey: 'iso_a', projectRoot: 'C:/A' });
const stateB = getOrCreateAgentState({ sessionKey: 'iso_b', projectRoot: 'C:/B' });
assert(stateA.projectRoot !== stateB.projectRoot, 'Sessions are isolated');
resetAgentState('iso_a');
resetAgentState('iso_b');

// Test 6: resolveSessionKey with empty/whitespace header
const keyEmpty = resolveSessionKey({ 'x-session-key': '  ' }, {});
assert(keyEmpty.startsWith('session_'), 'Empty session key generates new one');

// Test 7: resolveSessionKey with both header and conversation_id
const keyBoth = resolveSessionKey({ 'x-session-key': 'explicit-key' }, { conversation_id: 'conv_123' });
assert(keyBoth === 'explicit-key', 'x-session-key takes priority over conversation_id');

// Test 8: reset + reuse session
resetAgentState('test_sid');
const reused = getOrCreateAgentState({ sessionKey: 'test_sid', projectRoot: 'C:/new' });
assert(reused.projectRoot === 'C:/new', 'Session can be recreated after reset');
resetAgentState('test_sid');

// ─── 2. Patch lifecycle tests ────────────────────────────────────────────────
console.log('\n=== 2. Patch Lifecycle Tests ===\n');

// Test 6: propose -> pending
createAgentState({ sessionKey: 'patch_test', projectRoot: 'C:/test' });
setPendingPatch('patch_test', 'patch_abc', 'file.js');
const ps1 = getAgentState('patch_test');
assert(ps1.patchState.status === 'pending', 'Patch state is pending after propose');
assert(ps1.patchState.id === 'patch_abc', 'Patch ID stored');
assert(ps1.mode === 'propose', 'Mode transitions to propose');
assert(ps1.taskStatus === 'awaiting_approval', 'Task status is awaiting_approval');

// Test 7: confirm pending patch
const confirmed = confirmPendingPatch('patch_test');
assert(confirmed, 'confirmPendingPatch returns true');
const ps2 = getAgentState('patch_test');
assert(ps2.patchState.status === 'confirmed', 'Patch state is confirmed');
assert(ps2.patchState.confirmedAt > 0, 'confirmedAt timestamp set');

// Test 8: reject pending patch
clearPendingPatch('patch_test');
setPendingPatch('patch_test', 'patch_xyz', 'other.js');
const rejected = rejectPendingPatch('patch_test');
assert(rejected, 'rejectPendingPatch returns true');
const ps3 = getAgentState('patch_test');
assert(ps3.patchState.status === 'rejected', 'Patch state is rejected');
assert(ps3.patchState.rejectedAt > 0, 'rejectedAt timestamp set');

// Test 9: mark patch applied
clearPendingPatch('patch_test');
setPendingPatch('patch_test', 'patch_def', 'app.js');
markPatchApplied('patch_test');
const ps4 = getAgentState('patch_test');
assert(ps4.patchState.status === 'applied', 'Patch state is applied');

// Test 10: clear pending patch
clearPendingPatch('patch_test');
const ps5 = getAgentState('patch_test');
assert(ps5.patchState.status === 'none', 'Patch state cleared to none');

// Test 11: double confirm should fail
setPendingPatch('patch_test', 'p1', 'f.js');
confirmPendingPatch('patch_test');
const doubleConfirm = confirmPendingPatch('patch_test');
assert(!doubleConfirm, 'Double confirm returns false');
clearPendingPatch('patch_test');

// Test 12: reject after confirm should work
setPendingPatch('patch_test', 'p2', 'f.js');
confirmPendingPatch('patch_test');
const rejectAfterConfirm = rejectPendingPatch('patch_test');
assert(rejectAfterConfirm, 'Reject after confirm returns true');
const ps6 = getAgentState('patch_test');
assert(ps6.patchState.status === 'rejected', 'Patch state is rejected after confirm+reject');
clearPendingPatch('patch_test');

// Test 13: apply without confirm (via markPatchApplied directly)
setPendingPatch('patch_test', 'p3', 'f.js');
markPatchApplied('patch_test');
const ps7 = getAgentState('patch_test');
assert(ps7.patchState.status === 'applied', 'Patch state is applied without confirm');
clearPendingPatch('patch_test');

// Test 14: reject when no patch
const noPatchReject = rejectPendingPatch('patch_test');
assert(!noPatchReject, 'Reject with no patch returns false');

// Test 15: runtime context changes with patch state
setPendingPatch('patch_test', 'p4', 'routes.js');
const ctxPending = buildAgentRuntimeContext(getAgentState('patch_test'));
assert(ctxPending.includes('PATCH: pending'), 'Context shows pending patch');
confirmPendingPatch('patch_test');
const ctxConfirmed = buildAgentRuntimeContext(getAgentState('patch_test'));
assert(ctxConfirmed.includes('PATCH: confirmed'), 'Context shows confirmed patch');
clearPendingPatch('patch_test');
resetAgentState('patch_test');

// ─── 3. Runtime context tests ────────────────────────────────────────────────
console.log('\n=== 3. Runtime Context Tests ===\n');

const ctxState = createAgentState({ sessionKey: 'ctx_test', projectRoot: 'C:/app', taskGoal: 'Fix bug' });
ctxState.recentFiles = ['a.js', 'b.js'];
ctxState.lastSearchResults = [{ tool: 'grep', query: 'bug', resultCount: 3 }];
ctxState.progressSummary = ['Found bug location', 'Read routes.js'];
ctxState.patchState = { id: 'p1', file: 'routes.js', status: 'pending' };

const ctx = buildAgentRuntimeContext(ctxState);
assert(ctx.includes('Fix bug'), 'Context includes task goal');
assert(ctx.includes('STATUS: exploring'), 'Context includes status');
assert(ctx.includes('MODE: explore'), 'Context includes mode');
assert(ctx.includes('PATCH: pending'), 'Context includes patch state');
assert(ctx.includes('PROGRESS:'), 'Context includes progress');
assert(ctx.includes('C:/app'), 'Context includes project root');
assert(ctx.length < 500, `Context is concise (${ctx.length} chars)`);

// Test: runtime context stays under 500 chars even with lots of data
const bigState = createAgentState({ sessionKey: 'big_ctx', projectRoot: 'C:/app', taskGoal: 'Fix all bugs in the entire codebase including edge cases and performance issues' });
bigState.recentFiles = Array(20).fill(null).map((_, i) => `file_${i}.js`);
bigState.progressSummary = Array(10).fill(null).map((_, i) => `Step ${i}: found issue ${i}`);
bigState.lastObservations = Array(5).fill(null).map((_, i) => ({ tool: 'grep', summary: `Found ${i * 10} matches for pattern ${i} in file ${i}.js` }));
bigState.lastSearchResults = Array(5).fill(null).map((_, i) => ({ tool: 'grep', query: `query_${i}`, resultCount: i * 10 }));
bigState.actionHistory = Array(10).fill(null).map((_, i) => ({ tool: 'read_file', summary: `file_${i}.js`, success: true, at: Date.now() }));
bigState.lastDecision = 'Read all files to understand the bug';
bigState.noProgressCount = 3;
const bigCtx = buildAgentRuntimeContext(bigState);
assert(bigCtx.length < 500, `Context stays under 500 chars even with lots of data (${bigCtx.length} chars)`);
resetAgentState('big_ctx');
resetAgentState('ctx_test');

// ─── 4. Structured observation tests ─────────────────────────────────────────
console.log('\n=== 4. Structured Observation Tests ===\n');

const grepObs = buildToolObservation('grep', { pattern: 'test' }, {
    success: true,
    output: 'Found 3 matches:\nfile1.js:10: test\nfile2.js:20: test\nfile1.js:30: test'
});
assert(grepObs.matchCount === 3, 'grep observation has correct match count');
assert(grepObs.files.length === 2, 'grep observation has correct file count');

const readObs = buildToolObservation('read_file', { path: 'test.js' }, {
    success: true,
    output: Array(300).fill('line').map((l, i) => `${String(i+1).padStart(4)}: content`).join('\n')
});
assert(readObs.totalLines === 300, 'read_file observation has correct line count');
assert(readObs.truncated, 'read_file observation is truncated');
assert(readObs.displayLines <= 200, 'read_file observation respects line limit');

// ─── 5. Progress detection tests ─────────────────────────────────────────────
console.log('\n=== 5. Progress Detection Tests ===\n');

const progState = createAgentState({ sessionKey: 'prog_test', projectRoot: 'C:/test' });
progState.recentFiles = ['file1.js'];

assert(hasProgress(progState, 'read_file', { path: 'file2.js', success: true }), 'New file read counts as progress');
assert(!hasProgress(progState, 'read_file', { path: 'file1.js', success: true }), 'Same file read is not progress');
assert(hasProgress(progState, 'grep', { matchCount: 5, success: true }), 'grep with matches is progress');
assert(!hasProgress(progState, 'grep', { matchCount: 0, success: true }), 'grep with no matches is not progress');
assert(hasProgress(progState, 'propose_patch', { patchId: 'p1', success: true }), 'propose_patch is progress');
assert(hasProgress(progState, 'bash', { summary: 'git status output', success: true }), 'bash with output is progress');
resetAgentState('prog_test');

// ─── 6. Orchestration loop tests ─────────────────────────────────────────────
console.log('\n=== 6. Orchestration Loop Tests ===\n');

// Test: Multi-step loop with propose_patch
let step1Count = 0;
const mockSendToModel1 = async () => {
    step1Count++;
    if (step1Count === 1) {
        return { choices: [{ message: { content: 'TOOL_CALL: grep\nARG pattern: function\nARG path: C:/test\nEND_TOOL' } }] };
    }
    if (step1Count === 2) {
        const orchFile = path.join(TEST_DIR, 'orch_file.js');
        fs.writeFileSync(orchFile, 'old\n', 'utf-8');
        return { choices: [{ message: { content: `TOOL_CALL: propose_patch\nARG path: ${orchFile}\nARG patch: --- a/orch_file.js\n+++ b/orch_file.js\n@@ -1 +1 @@\n-old\n+new\nEND_TOOL` } }] };
    }
    return { choices: [{ message: { content: 'Done!' } }] };
};

const result1 = await runAgentLoop(mockSendToModel1, {
    sessionKey: 'orch_test_1',
    clientWorkdir: TEST_DIR,
    maxSteps: 5,
    initialMessage: 'Find the function and fix it'
});
assert(result1.success, 'Orchestrator loop succeeds');
assert(result1.stopped, 'Loop stopped');
assert(result1.toolCalls.length === 2, `Two tool calls executed (${result1.toolCalls.length})`);
assert(result1.agent?.patchState?.status === 'pending', 'Patch state is pending in agent metadata');
resetAgentState('orch_test_1');

// Test: write_file stops loop for safety
const mockSendToModel2 = async () => {
    return { choices: [{ message: { content: 'TOOL_CALL: write_file\nARG path: C:/test/file.js\nARG content: x\nEND_TOOL' } }] };
};

const result2 = await runAgentLoop(mockSendToModel2, {
    sessionKey: 'orch_test_2',
    clientWorkdir: 'C:/test',
    maxSteps: 5,
    initialMessage: 'Write a file'
});
assert(result2.stopped && result2.stopReason.includes('write_file'), 'Loop stops on write_file for safety');
resetAgentState('orch_test_2');

// Test: Task completion
let step3Count = 0;
const mockSendToModel3 = async () => {
    step3Count++;
    if (step3Count === 1) {
        return { choices: [{ message: { content: 'TOOL_CALL: grep\nARG pattern: test\nEND_TOOL' } }] };
    }
    return { choices: [{ message: { content: 'Task complete!' } }] };
};

const result3 = await runAgentLoop(mockSendToModel3, {
    sessionKey: 'orch_test_3',
    clientWorkdir: 'C:/test',
    maxSteps: 5,
    initialMessage: 'Run grep'
});
assert(result3.stopped && result3.stopReason === 'Task completed', 'Loop stops when model completes task');
assert(result3.toolCalls.length === 1, `One tool call executed (${result3.toolCalls.length})`);
resetAgentState('orch_test_3');

// ─── Cleanup ─────────────────────────────────────────────────────────────────
cleanup();

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n=== Results: ${passed} passed, ${failed} failed, ${skipped} skipped ===\n`);
if (failed > 0) process.exit(1);

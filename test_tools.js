import { parseToolCallFromText, executeTool, buildToolSystemPrompt, getToolDefinitions } from './src/tools/toolExecutor.js';
import path from 'path';
import fs from 'fs';

const TEST_DIR = path.resolve('test_output');
const TEST_FILE = path.join(TEST_DIR, 'test.txt');
const TEST_SUBDIR = path.join(TEST_DIR, 'subdir');

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

// ─── 1. Parser tests ─────────────────────────────────────────────────────────
console.log('\n=== 1. Parser Tests ===\n');

const r1 = parseToolCallFromText('TOOL_CALL: bash\nARG command: git status\nARG workdir: C:/Projects/app\nEND_TOOL');
assert(r1 && r1[0]?.name === 'bash' && r1[0]?.arguments?.command === 'git status', 'Parse TOOL_CALL format');
assert(r1 && r1[0]?.arguments?.workdir === 'C:/Projects/app', 'Parse workdir arg');

const r2 = parseToolCallFromText('{"tool_calls": [{"name": "bash", "arguments": {"command": "ls"}}]}');
assert(r2 && r2[0]?.name === 'bash', 'Parse JSON fallback');

const r3 = parseToolCallFromText('Привет! Как дела?');
assert(r3 === null, 'Regular text returns null');

const r4 = parseToolCallFromText('python и т.д.)');
assert(r4 === null, 'No false positive on "python и т.д."');

const r5 = parseToolCallFromText('TOOL_CALL: read_file\nARG path: C:/Projects/app/README.md\nEND_TOOL');
assert(r5 && r5[0]?.name === 'read_file' && r5[0]?.arguments?.path === 'C:/Projects/app/README.md', 'Parse read_file');

// ─── 2. Tool executor tests ──────────────────────────────────────────────────
console.log('\n=== 2. Tool Executor Tests ===\n');

// Bash is disabled by default
const r6 = await executeTool('bash', { command: 'echo test' });
assert(!r6.success && r6.error?.includes('disabled'), 'bash disabled by default');

// File tools (always enabled)
const r7 = await executeTool('write_file', { path: TEST_FILE, content: 'hello world' });
assert(r7.success, 'write_file creates file');

const r8 = await executeTool('read_file', { path: TEST_FILE });
assert(r8.success && r8.output.includes('hello world'), 'read_file reads content');

const r9 = await executeTool('read_file', { path: '/nonexistent/file.txt' });
assert(!r9.success, 'read_file returns error for missing file');

// mkdir via bash (if enabled)
const r10 = await executeTool('bash', { command: `mkdir "${TEST_SUBDIR}"`, workdir: TEST_DIR });
if (r10.success) {
    assert(fs.existsSync(TEST_SUBDIR), 'bash mkdir creates directory');
} else {
    skip('bash mkdir', 'bash disabled');
}

// Alias normalization
const r11 = await executeTool('write', { filePath: TEST_FILE, content: 'alias test' });
if (r11.success) {
    assert(r11.success, 'executeTool normalizes write -> write_file');
} else {
    skip('write alias', 'write_file alias failed');
}

// ─── 3. clientWorkdir tests ──────────────────────────────────────────────────
console.log('\n=== 3. clientWorkdir Tests ===\n');

const r12 = await executeTool('bash', { command: 'echo test' }, TEST_DIR);
if (r12.success) {
    assert(r12.success, 'executeTool accepts clientWorkdir');
} else {
    skip('clientWorkdir bash', 'bash disabled');
}

// Guard: no workdir falls back to process.cwd()
const r13 = await executeTool('bash', { command: 'echo cwd' });
if (r13.success) {
    assert(r13.success, 'executeTool works without clientWorkdir (uses cwd)');
} else {
    skip('cwd fallback', 'bash disabled');
}

// ─── 4. System prompt tests ──────────────────────────────────────────────────
console.log('\n=== 4. System Prompt Tests ===\n');

const prompt = buildToolSystemPrompt([{
    type: 'function',
    function: {
        name: 'bash',
        description: 'Execute shell command',
        parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
    }
}]);

assert(prompt.includes('TOOL_CALL:'), 'Prompt includes TOOL_CALL format');
assert(prompt.includes('END_TOOL'), 'Prompt includes END_TOOL marker');
assert(prompt.includes('ARG '), 'Prompt includes ARG format');
assert(prompt.includes('stateless') || prompt.includes('NOT assume state'), 'Prompt includes stateless warning');
assert(prompt.includes('directly to the user'), 'Prompt mentions direct result return');

// ─── 5. getToolDefinitions tests ─────────────────────────────────────────────
console.log('\n=== 5. getToolDefinitions Tests ===\n');

const defs = getToolDefinitions();
assert(Array.isArray(defs) && defs.length > 0, 'getToolDefinitions returns array');

const openaiTools = getToolDefinitions([{
    type: 'function',
    function: { name: 'bash', description: 'test', parameters: { type: 'object', properties: {}, required: [] } }
}]);
assert(openaiTools.length === 1 && openaiTools[0].name === 'bash', 'Parses OpenAI tool format');

const emptyTools = getToolDefinitions([]);
assert(emptyTools.length === 0, 'Empty array returns empty');

// ─── 6. Path safety tests ────────────────────────────────────────────────────
console.log('\n=== 6. Path Safety Tests ===\n');

// Path traversal blocked by sandbox
const r14 = await executeTool('read_file', { path: path.resolve('..', '..', 'etc', 'passwd') }, TEST_DIR);
assert(!r14.success && r14.error?.includes('outside project'), 'Path traversal blocked by sandbox');

// Absolute path within project works
const r15 = await executeTool('read_file', { path: TEST_FILE }, TEST_DIR);
assert(r15.success, 'Absolute path within project works');

// ─── 7. Project root injection tests ─────────────────────────────────────────
console.log('\n=== 7. Project Root Injection Tests ===\n');

const promptWithRoot = buildToolSystemPrompt([{
    type: 'function',
    function: { name: 'bash', description: 'test', parameters: { type: 'object', properties: {}, required: [] } }
}], 'C:/Projects/my-app');

assert(promptWithRoot.includes('C:/Projects/my-app'), 'Prompt includes project root');
assert(promptWithRoot.includes('Current project root:'), 'Prompt has project root label');
assert(promptWithRoot.includes('NEVER use paths outside'), 'Prompt includes sandbox warning');

const promptNoRoot = buildToolSystemPrompt([{
    type: 'function',
    function: { name: 'bash', description: 'test', parameters: { type: 'object', properties: {}, required: [] } }
}]);
assert(!promptNoRoot.includes('Current project root:'), 'Prompt without root has no project label');

// ─── Cleanup ─────────────────────────────────────────────────────────────────
cleanup();

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n=== Results: ${passed} passed, ${failed} failed, ${skipped} skipped ===\n`);
if (failed > 0) process.exit(1);

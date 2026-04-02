import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { logInfo, logError, logDebug, logWarn } from '../logger/index.js';
import { ENABLE_BASH_TOOL } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');

// ─── Pending patch storage ───────────────────────────────────────────────────
const pendingPatches = new Map();
const PATCH_TTL = 10 * 60 * 1000; // 10 minutes

export function getPendingPatch(patchId) {
    const entry = pendingPatches.get(patchId);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        pendingPatches.delete(patchId);
        return null;
    }
    return entry;
}

export function createPendingPatch(patchData) {
    const id = `patch_${crypto.randomUUID().substring(0, 8)}`;
    pendingPatches.set(id, {
        id,
        ...patchData,
        status: 'pending',
        createdAt: Date.now(),
        expiresAt: Date.now() + PATCH_TTL
    });
    return id;
}

export function confirmPendingPatch(patchId) {
    const entry = pendingPatches.get(patchId);
    if (!entry) return { success: false, error: 'Patch not found or expired' };
    if (entry.status !== 'pending') return { success: false, error: `Patch already ${entry.status}` };
    entry.status = 'confirmed';
    return { success: true, patch: entry };
}

export function rejectPendingPatch(patchId) {
    pendingPatches.delete(patchId);
    return { success: true };
}

// Cleanup expired patches every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of pendingPatches) {
        if (now > entry.expiresAt) pendingPatches.delete(id);
    }
}, 5 * 60 * 1000).unref();

export const TOOL_DEFINITIONS = {
    bash: {
        name: 'bash',
        description: 'Execute a shell command. Use for git, ls, mkdir, rm, python, npm, etc.',
        parameters: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'The command to execute' },
                workdir: { type: 'string', description: 'Working directory (absolute path)' }
            },
            required: ['command']
        }
    },
    read_file: {
        name: 'read_file',
        description: 'Read file contents.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Absolute path to file' }
            },
            required: ['path']
        }
    },
    write_file: {
        name: 'write_file',
        description: 'Write content to a file.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Absolute path to file' },
                content: { type: 'string', description: 'File content' }
            },
            required: ['path', 'content']
        }
    },
    edit_file: {
        name: 'edit_file',
        description: 'Replace text in a file.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Absolute path to file' },
                old_string: { type: 'string', description: 'Text to find' },
                new_string: { type: 'string', description: 'Replacement text' }
            },
            required: ['path', 'old_string', 'new_string']
        }
    },
    glob: {
        name: 'glob',
        description: 'Find files by pattern.',
        parameters: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'Glob pattern' },
                path: { type: 'string', description: 'Directory to search' }
            },
            required: ['pattern']
        }
    },
    grep: {
        name: 'grep',
        description: 'Search file contents.',
        parameters: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'Search pattern' },
                path: { type: 'string', description: 'Directory to search' }
            },
            required: ['pattern']
        }
    },
    apply_patch: {
        name: 'apply_patch',
        description: 'Apply a pending patch by ID. The patch must have been proposed first and confirmed by the user.',
        parameters: {
            type: 'object',
            properties: {
                patch_id: { type: 'string', description: 'The patch ID returned from propose_patch' }
            },
            required: ['patch_id']
        }
    },
    propose_patch: {
        name: 'propose_patch',
        description: 'Propose a code change as a unified diff. The user will review and confirm before it is applied. Use this instead of write_file or edit_file for code modifications.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Absolute path to the file to modify' },
                patch: { type: 'string', description: 'Unified diff content (--- a/file ... +++ b/file ...)' },
                description: { type: 'string', description: 'Human-readable description of the change' }
            },
            required: ['path', 'patch']
        }
    }
};

const TOOL_NAME_ALIASES = {
    write: 'write_file', create_file: 'write_file', save_file: 'write_file',
    read: 'read_file', open_file: 'read_file', cat: 'read_file',
    edit: 'edit_file', modify: 'edit_file',
    shell: 'bash', exec: 'bash', run: 'bash', command: 'bash',
    find_files: 'glob', search_files: 'glob', search: 'grep', find: 'grep'
};

const ARG_NAME_ALIASES = {
    filePath: 'path', filepath: 'path', file: 'path', filename: 'path',
    text: 'content', data: 'content',
    cmd: 'command', shell_command: 'command',
    glob_pattern: 'pattern', query: 'pattern'
};

const ARG_NAMES_TO_STRIP = ['description', 'tool_call_id'];

/**
 * Apply a unified diff patch to original content.
 * Handles standard unified diff format:
 * --- a/file
 * +++ b/file
 * @@ -start,count +start,count @@
 *  context
 * -removed
 * +added
 */
function applyUnifiedDiff(original, patch) {
    const lines = patch.split('\n');
    const originalLines = original.split('\n');
    const resultLines = [];
    
    let hunks = [];
    let currentHunk = null;
    
    // Parse hunks
    for (const line of lines) {
        if (line.startsWith('@@')) {
            if (currentHunk) hunks.push(currentHunk);
            const match = line.match(/^@@\s*-(\d+)(?:,(\d+))?\s*\+(\d+)(?:,(\d+))?\s*@@/);
            if (!match) return { success: false, error: `Invalid hunk header: ${line}` };
            currentHunk = {
                origStart: parseInt(match[1]) - 1, // 0-indexed
                origCount: parseInt(match[2]) || 1,
                newStart: parseInt(match[3]) - 1,
                newCount: parseInt(match[4]) || 1,
                lines: []
            };
        } else if (currentHunk && (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+'))) {
            currentHunk.lines.push(line);
        }
    }
    if (currentHunk) hunks.push(currentHunk);
    
    if (hunks.length === 0) return { success: false, error: 'No valid hunks found in patch' };
    
    // Apply hunks in reverse order to avoid offset issues
    let content = originalLines;
    for (let i = hunks.length - 1; i >= 0; i--) {
        const hunk = hunks[i];
        const origStart = hunk.origStart;
        
        // Verify context matches
        let matchOffset = 0;
        let found = false;
        
        // Try exact position first, then search nearby
        for (let offset = 0; offset <= 10; offset++) {
            for (const dir of [0, offset, -offset]) {
                if (dir === 0 && offset > 0) continue;
                const pos = origStart + dir;
                if (pos < 0 || pos > content.length) continue;
                
                if (hunkMatchesAt(hunk, content, pos)) {
                    matchOffset = dir;
                    found = true;
                    break;
                }
            }
            if (found) break;
        }
        
        if (!found) {
            return { success: false, error: `Hunk failed at line ${origStart + 1}: context does not match` };
        }
        
        const pos = origStart + matchOffset;
        const newLines = [];
        for (const hLine of hunk.lines) {
            if (hLine.startsWith('-') || hLine.startsWith(' ')) {
                // skip original
            }
            if (hLine.startsWith('+') || hLine.startsWith(' ')) {
                newLines.push(hLine.startsWith('+') ? hLine.substring(1) : hLine.substring(1));
            }
        }
        
        // Calculate how many original lines to remove
        let removeCount = 0;
        for (const hLine of hunk.lines) {
            if (hLine.startsWith('-') || hLine.startsWith(' ')) removeCount++;
        }
        
        content.splice(pos, removeCount, ...newLines);
    }
    
    const addedLines = hunks.reduce((sum, h) => sum + h.lines.filter(l => l.startsWith('+')).length, 0);
    const removedLines = hunks.reduce((sum, h) => sum + h.lines.filter(l => l.startsWith('-')).length, 0);
    
    return {
        success: true,
        content: content.join('\n'),
        summary: `+${addedLines} -${removedLines} (${hunks.length} hunk${hunks.length > 1 ? 's' : ''})`
    };
}

function hunkMatchesAt(hunk, content, pos) {
    const contextLines = hunk.lines.filter(l => l.startsWith('-') || l.startsWith(' '));
    for (let i = 0; i < contextLines.length; i++) {
        const expected = contextLines[i].substring(1);
        const actual = content[pos + i];
        if (actual !== expected) return false;
    }
    return true;
}

function generateDiffPreview(original, modified, filePath) {
    const origLines = original.split('\n');
    const modLines = modified.split('\n');
    const lines = [];
    
    const maxLen = Math.max(origLines.length, modLines.length);
    let inHunk = false;
    
    for (let i = 0; i < maxLen; i++) {
        const orig = i < origLines.length ? origLines[i] : undefined;
        const mod = i < modLines.length ? modLines[i] : undefined;
        
        if (orig === mod) {
            if (inHunk) {
                lines.push(`  ${orig}`);
                // Close hunk after 3 context lines
                if (lines.filter(l => l.startsWith(' ')).slice(-3).every(l => l.trim())) {
                    // Keep showing context
                }
            }
        } else {
            inHunk = true;
            if (orig !== undefined) lines.push(`- ${orig}`);
            if (mod !== undefined) lines.push(`+ ${mod}`);
        }
    }
    
    return lines.slice(0, 50).join('\n') + (lines.length > 50 ? '\n...' : '');
}

function normalizeToolCall(toolName, args) {
    const normalizedName = TOOL_NAME_ALIASES[toolName] || toolName;
    const normalizedArgs = {};
    for (const [key, value] of Object.entries(args || {})) {
        if (ARG_NAMES_TO_STRIP.includes(key)) continue;
        const normalizedName = ARG_NAME_ALIASES[key] || key;
        if (!normalizedArgs[normalizedName]) normalizedArgs[normalizedName] = value;
    }
    return { name: normalizedName, arguments: normalizedArgs };
}

export function getToolDefinitions(toolNames = null) {
    if (!toolNames) return Object.values(TOOL_DEFINITIONS);
    if (Array.isArray(toolNames) && toolNames.length > 0 && typeof toolNames[0] === 'object') {
        return toolNames
            .filter(t => t && (t.type === 'function' || t.function))
            .map(t => {
                const fn = t.function || t;
                return {
                    name: fn.name,
                    description: fn.description || '',
                    parameters: fn.parameters || { type: 'object', properties: {}, required: [] }
                };
            });
    }
    return toolNames.filter(name => TOOL_DEFINITIONS[name]).map(name => TOOL_DEFINITIONS[name]);
}

export function buildToolSystemPrompt(toolNames = null, projectRoot = null) {
    const availableTools = getToolDefinitions(toolNames);
    if (availableTools.length === 0) return '';

    const toolList = availableTools.map(t => {
        const params = Object.entries(t.parameters.properties)
            .map(([k, v]) => `  - ${k}: ${v.description}`)
            .join('\n');
        return `### ${t.name}\n${t.description}\nParameters:\n${params}`;
    }).join('\n\n');

    const projectContext = projectRoot
        ? `\nCurrent project root: ${projectRoot}\nAll file paths should be relative to this root.\nUse the project root as the base for all workdir and path arguments.\n`
        : '';

    return `You have access to tools. When you need to perform an action, use the EXACT format below.

TOOL CALL FORMAT (no JSON, no curly braces):
TOOL_CALL: tool_name
ARG arg_name: arg_value
ARG arg_name: arg_value
END_TOOL

RULES:
1. Use ONLY the format above. No JSON. No curly braces. No explanations.
2. Each argument on its own line starting with "ARG ".
3. For paths, use forward slashes: C:/Projects/app/file.txt
4. If no tool is needed, respond with normal text.
5. ALWAYS use the project root as the base for all file paths and workdir.
6. NEVER use paths outside the project root.${projectContext}

CRITICAL PATH HANDLING RULES:
- If the user provides an explicit file path (e.g., "C:/dir/file.py"), use read_file with that exact path.
- Do NOT search, glob, grep, or list directories before trying the explicit path.
- If the user names a file and then provides a directory, combine them into a direct target path.
- Use exploration (glob, grep, ls) ONLY if the direct path fails or is truly ambiguous.
- The user's explicit instruction always overrides exploratory heuristics.

IMPORTANT:
You do NOT have persistent access to tools.
Tool results are returned directly to the user.
You must NOT assume state between tool calls.

EXAMPLES:
User: "выполни git status"
You:
TOOL_CALL: bash
ARG command: git status
ARG workdir: C:/Projects/app
END_TOOL

User: "прочитай README.md"
You:
TOOL_CALL: read_file
ARG path: C:/Projects/app/README.md
END_TOOL

User: "создай папку test"
You:
TOOL_CALL: bash
ARG command: mkdir test
ARG workdir: C:/Projects/app
END_TOOL

User: "добавь console.log в main.js"
You:
TOOL_CALL: propose_patch
ARG path: C:/Projects/app/main.js
ARG patch: --- a/main.js
+++ b/main.js
@@ -1,3 +1,4 @@
 console.log('start')
+console.log('added')
 console.log('end')
ARG description: Add console.log statement
END_TOOL

IMPORTANT: For code changes, ALWAYS use propose_patch instead of write_file or edit_file.
The user will see the diff preview and must confirm before the patch is applied.

Available tools:
${toolList}`;
}

export function parseToolCallFromText(text) {
    const trimmed = text.trim();
    
    // Parse TOOL_CALL format (no JSON, no escaping issues)
    const toolCallMatch = trimmed.match(/TOOL_CALL:\s*(\w+)([\s\S]*?)END_TOOL/i);
    if (toolCallMatch) {
        const toolName = toolCallMatch[1];
        const argsBlock = toolCallMatch[2];
        const args = {};
        
        // Parse ARG lines, accumulating multi-line values
        const lines = argsBlock.split('\n');
        let currentArg = null;
        let currentValue = '';
        
        for (const line of lines) {
            const argMatch = line.match(/^ARG\s+(\w+):\s*(.*)$/);
            if (argMatch) {
                // Save previous arg
                if (currentArg) {
                    args[currentArg] = currentValue.trim();
                }
                currentArg = argMatch[1];
                currentValue = argMatch[2];
            } else if (currentArg && line.trim()) {
                // Multi-line value continuation
                currentValue += '\n' + line;
            }
        }
        // Save last arg
        if (currentArg) {
            args[currentArg] = currentValue.trim();
        }
        
        if (Object.keys(args).length > 0) {
            return [{ name: toolName, arguments: args }];
        }
    }
    
    // Fallback: try JSON (for backward compatibility)
    try {
        const parsed = JSON.parse(trimmed);
        if (parsed.tool_calls && Array.isArray(parsed.tool_calls)) {
            return parsed.tool_calls.map(tc => ({
                name: tc.name,
                arguments: typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments
            }));
        }
    } catch (e) {}
    
    return null;
}

export async function executeTool(toolName, args, clientWorkdir = null) {
    const normalized = normalizeToolCall(toolName, args || {});
    
    // Guard: if no workdir provided, use current working directory
    if (!clientWorkdir && !normalized.arguments.workdir) {
        clientWorkdir = process.cwd();
    }
    if (clientWorkdir && !normalized.arguments.workdir) {
        normalized.arguments.workdir = clientWorkdir;
    }
    
    // Safety: block bash if not explicitly enabled
    if (normalized.name === 'bash' && !ENABLE_BASH_TOOL) {
        logWarn('bash tool blocked — set ENABLE_BASH_TOOL=1 to enable');
        return { success: false, error: 'bash tool is disabled. Set ENABLE_BASH_TOOL=1 to enable.' };
    }
    
    // Safety: sandbox file tools to project root
    const projectRoot = clientWorkdir ? path.resolve(clientWorkdir) : PROJECT_ROOT;
    const fileTools = ['read_file', 'write_file', 'edit_file', 'apply_patch'];
    if (fileTools.includes(normalized.name) && normalized.arguments.path) {
        const resolvedPath = path.resolve(normalized.arguments.path);
        if (!resolvedPath.startsWith(projectRoot)) {
            logWarn(`Path traversal blocked: ${normalized.arguments.path} (root: ${projectRoot})`);
            return { success: false, error: `Path outside project root: ${normalized.arguments.path}` };
        }
    }
    
    const executor = TOOL_EXECUTORS[normalized.name];
    if (!executor) {
        return { success: false, error: `Unknown tool: ${toolName}` };
    }

    try {
        logInfo(`Executing: ${normalized.name}(${JSON.stringify(normalized.arguments)})`);
        return await executor(normalized.arguments);
    } catch (error) {
        logError(`Tool error: ${normalized.name}`, error);
        return { success: false, error: error.message || String(error) };
    }
}

const TOOL_EXECUTORS = {
    async read_file({ path: filePath }) {
        const resolved = path.resolve(filePath);
        if (!fs.existsSync(resolved)) return { success: false, error: `File not found: ${filePath}` };
        const stat = fs.statSync(resolved);
        if (stat.isDirectory()) {
            const entries = fs.readdirSync(resolved);
            return { success: true, output: `Directory: ${filePath}\n${entries.join('\n')}` };
        }
        if (stat.size > 500000) return { success: false, error: `File too large (${stat.size} bytes)` };
        const content = fs.readFileSync(resolved, 'utf-8');
        const lines = content.split('\n');
        return { success: true, output: lines.map((l, i) => `${String(i + 1).padStart(4)}: ${l}`).join('\n') };
    },

    async write_file({ path: filePath, content }) {
        const resolved = path.resolve(filePath);
        try {
            fs.mkdirSync(path.dirname(resolved), { recursive: true });
            fs.writeFileSync(resolved, content, 'utf-8');
            return { success: true, output: `Written ${content.length} bytes to ${filePath}` };
        } catch (e) { return { success: false, error: e.message }; }
    },

    async edit_file({ path: filePath, old_string, new_string }) {
        const resolved = path.resolve(filePath);
        if (!fs.existsSync(resolved)) return { success: false, error: `File not found: ${filePath}` };
        const content = fs.readFileSync(resolved, 'utf-8');
        if (!content.includes(old_string)) return { success: false, error: `String not found in file` };
        fs.writeFileSync(resolved, content.replace(old_string, new_string), 'utf-8');
        return { success: true, output: `Edited ${filePath}` };
    },

    async propose_patch({ path: filePath, patch, description }) {
        const resolved = path.resolve(filePath);
        if (!fs.existsSync(resolved)) return { success: false, error: `File not found: ${filePath}` };
        
        try {
            const original = fs.readFileSync(resolved, 'utf-8');
            const result = applyUnifiedDiff(original, patch);
            
            if (!result.success) return { success: false, error: result.error };
            
            // Store as pending patch
            const patchId = createPendingPatch({
                path: filePath,
                resolvedPath: resolved,
                patch,
                description: description || 'Code modification',
                originalContent: original,
                newContent: result.content,
                summary: result.summary
            });
            
            // Generate diff preview for user
            const diffPreview = generateDiffPreview(original, result.content, filePath);
            
            return {
                success: true,
                patch_id: patchId,
                output: `Patch proposed (ID: ${patchId})\n${result.summary}\n\nPreview:\n${diffPreview}\n\nThe user must confirm this patch before it is applied.`,
                patch_id_for_client: patchId,
                diff_preview: diffPreview
            };
        } catch (e) {
            return { success: false, error: `Patch proposal failed: ${e.message}` };
        }
    },

    async apply_patch({ patch_id }) {
        const entry = getPendingPatch(patch_id);
        if (!entry) return { success: false, error: `Patch ${patch_id} not found or expired` };
        if (entry.status !== 'confirmed') return { success: false, error: `Patch ${patch_id} is not confirmed (status: ${entry.status})` };
        
        try {
            fs.writeFileSync(entry.resolvedPath, entry.newContent, 'utf-8');
            pendingPatches.delete(patch_id);
            return { success: true, output: `Patch applied to ${entry.path}\n${entry.summary}` };
        } catch (e) {
            return { success: false, error: `Patch apply failed: ${e.message}` };
        }
    },

    async bash({ command, workdir }) {
        const cwd = workdir ? path.resolve(workdir.replace(/\//g, '\\')) : PROJECT_ROOT;
        const noisePatterns = [/fnm\s*:/i, /fnm env/i, /WindowsPowerShell_profile/i, /CommandNotFoundException.*fnm/i];
        const filterNoise = (t) => t ? t.split('\n').filter(l => !noisePatterns.some(p => p.test(l))).join('\n').trim() : '';

        return new Promise((resolve) => {
            let stdout = '', stderr = '';
            const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
                cwd, timeout: 60000, env: { ...process.env, PSExecutionPolicyPreference: 'Bypass' }
            });
            
            const timeout = setTimeout(() => { child.kill(); resolve({ success: true, output: 'Command timed out' }); }, 60000);
            child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
            child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
            
            child.on('close', (code) => {
                clearTimeout(timeout);
                let output = stdout.trim() || '(no output)';
                const cleanStderr = filterNoise(stderr);
                if (cleanStderr) output += `\nSTDERR:\n${cleanStderr}`;
                resolve({ success: true, output: output.substring(0, 10000) });
            });
            child.on('error', (err) => {
                clearTimeout(timeout);
                resolve({ success: true, output: `Error: ${err.message}` });
            });
        });
    },

    async glob({ pattern, path: searchPath }) {
        const { glob } = await import('glob');
        const cwd = searchPath ? path.resolve(searchPath) : PROJECT_ROOT;
        try {
            const files = await glob(pattern, { cwd, nodir: false });
            return { success: true, output: files.length ? `Found ${files.length}:\n${files.join('\n')}` : `No files matching: ${pattern}` };
        } catch (e) { return { success: false, error: e.message }; }
    },

    async grep({ pattern, path: searchPath }) {
        const cwd = searchPath ? path.resolve(searchPath) : PROJECT_ROOT;
        const { glob } = await import('glob');
        try {
            const files = await glob('**/*', { cwd, nodir: true });
            const regex = new RegExp(pattern, 'i');
            const results = [];
            for (const file of files.slice(0, 200)) {
                try {
                    const content = fs.readFileSync(path.join(cwd, file), 'utf-8');
                    content.split('\n').forEach((line, i) => {
                        if (regex.test(line) && results.length < 50) results.push(`${file}:${i + 1}: ${line.trim()}`);
                    });
                } catch {}
            }
            return { success: true, output: results.length ? `Found ${results.length}:\n${results.join('\n')}` : `No matches for: ${pattern}` };
        } catch (e) { return { success: false, error: e.message }; }
    }
};

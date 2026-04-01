import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { logInfo, logError, logDebug, logWarn } from '../logger/index.js';
import { ENABLE_BASH_TOOL } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');

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

export function buildToolSystemPrompt(toolNames = null) {
    const availableTools = getToolDefinitions(toolNames);
    if (availableTools.length === 0) return '';

    const toolList = availableTools.map(t => {
        const params = Object.entries(t.parameters.properties)
            .map(([k, v]) => `  - ${k}: ${v.description}`)
            .join('\n');
        return `### ${t.name}\n${t.description}\nParameters:\n${params}`;
    }).join('\n\n');

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
        
        for (const line of argsBlock.split('\n')) {
            const argMatch = line.match(/^ARG\s+(\w+):\s*(.+)$/);
            if (argMatch) {
                args[argMatch[1]] = argMatch[2].trim();
            }
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

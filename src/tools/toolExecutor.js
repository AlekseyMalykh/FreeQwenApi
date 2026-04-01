import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { logInfo, logError, logDebug, logWarn } from '../logger/index.js';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');

export const TOOL_DEFINITIONS = {
    read_file: {
        name: 'read_file',
        description: 'Read the contents of a file from the filesystem. Returns the file content as text.',
        parameters: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: 'Path to the file to read (absolute or relative to project root)'
                }
            },
            required: ['path']
        }
    },
    write_file: {
        name: 'write_file',
        description: 'Write content to a file. Creates the file if it does not exist, overwrites if it does.',
        parameters: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: 'Path to the file to write (absolute or relative to project root)'
                },
                content: {
                    type: 'string',
                    description: 'Content to write to the file'
                }
            },
            required: ['path', 'content']
        }
    },
    edit_file: {
        name: 'edit_file',
        description: 'Edit specific content in an existing file by replacing old_string with new_string.',
        parameters: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: 'Path to the file to edit'
                },
                old_string: {
                    type: 'string',
                    description: 'The exact text to find and replace'
                },
                new_string: {
                    type: 'string',
                    description: 'The text to replace old_string with'
                }
            },
            required: ['path', 'old_string', 'new_string']
        }
    },
    bash: {
        name: 'bash',
        description: 'Execute a bash/shell command and return the output. Use for running CLI commands, scripts, git operations, etc.',
        parameters: {
            type: 'object',
            properties: {
                command: {
                    type: 'string',
                    description: 'The shell command to execute'
                },
                workdir: {
                    type: 'string',
                    description: 'Working directory for the command (optional, defaults to project root)'
                }
            },
            required: ['command']
        }
    },
    glob: {
        name: 'glob',
        description: 'Find files matching a glob pattern. Returns a list of file paths.',
        parameters: {
            type: 'object',
            properties: {
                pattern: {
                    type: 'string',
                    description: 'Glob pattern to match (e.g., "*.js", "src/**/*.ts")'
                },
                path: {
                    type: 'string',
                    description: 'Directory to search in (optional, defaults to project root)'
                }
            },
            required: ['pattern']
        }
    },
    grep: {
        name: 'grep',
        description: 'Search for a pattern in file contents. Returns matching lines with file paths.',
        parameters: {
            type: 'object',
            properties: {
                pattern: {
                    type: 'string',
                    description: 'Regular expression pattern to search for'
                },
                path: {
                    type: 'string',
                    description: 'Directory or file to search in (optional)'
                },
                include: {
                    type: 'string',
                    description: 'File pattern to include (e.g., "*.js")'
                }
            },
            required: ['pattern']
        }
    }
};

export function getToolDefinitions(toolNames = null) {
    if (!toolNames) {
        return Object.values(TOOL_DEFINITIONS);
    }

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

    return toolNames
        .filter(name => TOOL_DEFINITIONS[name])
        .map(name => TOOL_DEFINITIONS[name]);
}

export function buildToolSystemPrompt(toolNames = null) {
    const availableTools = getToolDefinitions(toolNames);
    if (availableTools.length === 0) return '';

    const toolDescriptions = availableTools.map(tool => {
        const params = Object.entries(tool.parameters.properties)
            .map(([name, schema]) => {
                const isRequired = tool.parameters.required.includes(name);
                return `  - ${name} (${schema.type})${isRequired ? ' [REQUIRED]' : ''}: ${schema.description}`;
            })
            .join('\n');

        return `### ${tool.name}\n${tool.description}\nParameters:\n${params}`;
    }).join('\n\n');

    const toolNamesList = availableTools.map(t => t.name).join(', ');

    return `You have access to these tools: ${toolNamesList}. They are AVAILABLE and WORKING.

CRITICAL RULES:
1. When a user asks you to do something that matches a tool, you MUST call it. Do NOT say "I cannot", "tool not available", or "I don't have access".
2. To call a tool, respond with ONLY this JSON format — nothing else:
{"tool_calls": [{"name": "tool_name", "arguments": {"arg1": "value1"}}]}
3. For shell commands (git, npm, ls, etc.), use the "bash" tool with the exact command.
4. For reading files, use "read_file". For writing, use "write_file".
5. You can call multiple tools at once by adding more objects to the tool_calls array.

Available tools:
${toolDescriptions}

EXAMPLES:
User: "выполни git status" → {"tool_calls": [{"name": "bash", "arguments": {"command": "git status"}}]}
User: "прочитай README.md" → {"tool_calls": [{"name": "read_file", "arguments": {"path": "README.md"}}]}
User: "найди все .js файлы" → {"tool_calls": [{"name": "glob", "arguments": {"pattern": "**/*.js"}}]}

IMPORTANT: If you need a tool, respond with ONLY the JSON. No explanations.`;
}

const TOOL_NAME_ALIASES = {
    write: 'write_file',
    create_file: 'write_file',
    save_file: 'write_file',
    read: 'read_file',
    open_file: 'read_file',
    cat: 'read_file',
    edit: 'edit_file',
    modify: 'edit_file',
    shell: 'bash',
    exec: 'bash',
    run: 'bash',
    command: 'bash',
    find_files: 'glob',
    search_files: 'glob',
    search: 'grep',
    find: 'grep'
};

const ARG_NAME_ALIASES = {
    filePath: 'path',
    filepath: 'path',
    file: 'path',
    filename: 'path',
    content: 'content',
    text: 'content',
    data: 'content',
    cmd: 'command',
    shell_command: 'command',
    cmd_command: 'command',
    pattern: 'pattern',
    glob_pattern: 'pattern',
    query: 'pattern',
    search_pattern: 'pattern'
};

function normalizeToolCall(toolName, args) {
    const normalizedName = TOOL_NAME_ALIASES[toolName] || toolName;
    
    const normalizedArgs = {};
    for (const [key, value] of Object.entries(args)) {
        const normalizedName = ARG_NAME_ALIASES[key] || key;
        if (!normalizedArgs[normalizedName]) {
            normalizedArgs[normalizedName] = value;
        }
    }
    
    return { name: normalizedName, arguments: normalizedArgs };
}

export async function executeTool(toolName, args) {
    const normalized = normalizeToolCall(toolName, args || {});
    
    const executor = TOOL_EXECUTORS[normalized.name];
    if (!executor) {
        return {
            success: false,
            error: `Unknown tool: ${toolName}`
        };
    }

    try {
        logInfo(`Executing tool: ${normalized.name}(${JSON.stringify(normalized.arguments)})`);
        const result = await executor(normalized.arguments);
        logDebug(`Tool ${normalized.name} result: ${typeof result.output === 'string' ? result.output.substring(0, 200) : 'non-string'}`);
        return result;
    } catch (error) {
        logError(`Tool execution error: ${normalized.name}`, error);
        return {
            success: false,
            error: error.message || String(error)
        };
    }
}

const TOOL_EXECUTORS = {
    async read_file({ path: filePath }) {
        const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(PROJECT_ROOT, filePath);
        
        if (!fs.existsSync(resolvedPath)) {
            return {
                success: false,
                error: `File not found: ${resolvedPath}`
            };
        }

        const stat = fs.statSync(resolvedPath);
        if (stat.isDirectory()) {
            const entries = fs.readdirSync(resolvedPath);
            return {
                success: true,
                output: `Directory listing for ${filePath}:\n${entries.map(e => {
                    const isDir = fs.statSync(path.join(resolvedPath, e)).isDirectory();
                    return `  ${isDir ? '📁' : '📄'} ${e}`;
                }).join('\n')}`
            };
        }

        if (stat.size > 500000) {
            return {
                success: false,
                error: `File too large (${stat.size} bytes). Maximum is 500KB.`
            };
        }

        const content = fs.readFileSync(resolvedPath, 'utf-8');
        const lines = content.split('\n');
        const numberedContent = lines.map((line, i) => `${String(i + 1).padStart(4)}: ${line}`).join('\n');

        return {
            success: true,
            output: `File: ${filePath}\n---\n${numberedContent}`,
            metadata: {
                path: resolvedPath,
                size: stat.size,
                lines: lines.length
            }
        };
    },

    async write_file({ path: filePath, content }) {
        const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(PROJECT_ROOT, filePath);
        
        try {
            const dir = path.dirname(resolvedPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(resolvedPath, content, 'utf-8');
            return {
                success: true,
                output: `Successfully wrote ${content.length} bytes to ${filePath}`
            };
        } catch (error) {
            return {
                success: false,
                error: `Failed to write file: ${error.message}`
            };
        }
    },

    async edit_file({ path: filePath, old_string, new_string }) {
        const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(PROJECT_ROOT, filePath);
        
        if (!fs.existsSync(resolvedPath)) {
            return {
                success: false,
                error: `File not found: ${resolvedPath}`
            };
        }

        const content = fs.readFileSync(resolvedPath, 'utf-8');
        
        if (!content.includes(old_string)) {
            return {
                success: false,
                error: `String not found in file. Make sure old_string matches exactly (including whitespace).`
            };
        }

        const occurrences = content.split(old_string).length - 1;
        if (occurrences > 1) {
            return {
                success: false,
                error: `Found ${occurrences} occurrences of old_string. Make it more specific to match only once.`
            };
        }

        const newContent = content.replace(old_string, new_string);
        fs.writeFileSync(resolvedPath, newContent, 'utf-8');

        return {
            success: true,
            output: `Successfully edited ${filePath}`
        };
    },

    async bash({ command, workdir }) {
        const cwd = workdir ? 
            (path.isAbsolute(workdir) ? workdir : path.join(PROJECT_ROOT, workdir)) : 
            PROJECT_ROOT;

        // On Windows, use PowerShell instead of cmd.exe for better compatibility
        const isWindows = process.platform === 'win32';
        const shell = isWindows ? 'powershell.exe' : '/bin/sh';
        const shellArgs = isWindows ? ['-NoProfile', '-Command'] : ['-c'];

        try {
            const { stdout, stderr } = await execAsync(command, { 
                cwd, 
                timeout: 60000,
                maxBuffer: 1024 * 1024,
                shell: shell,
                shellArgs
            });
            
            let output = '';
            if (stdout) output += stdout;
            if (stderr) output += `\nSTDERR:\n${stderr}`;
            
            if (!output) output = '(no output)';
            
            return {
                success: true,
                output: output.substring(0, 10000) + (output.length > 10000 ? '\n... (output truncated)' : '')
            };
        } catch (error) {
            return {
                success: true,
                output: `Exit code: ${error.code}\nSTDOUT:\n${error.stdout || '(empty)'}\nSTDERR:\n${error.stderr || error.message}`.substring(0, 10000)
            };
        }
    },

    async glob({ pattern, path: searchPath }) {
        const { glob } = await import('glob');
        const cwd = searchPath ? 
            (path.isAbsolute(searchPath) ? searchPath : path.join(PROJECT_ROOT, searchPath)) : 
            PROJECT_ROOT;

        try {
            const files = await glob(pattern, { cwd, nodir: false });
            return {
                success: true,
                output: files.length > 0 
                    ? `Found ${files.length} file(s):\n${files.map(f => `  ${f}`).join('\n')}`
                    : `No files matching pattern: ${pattern}`
            };
        } catch (error) {
            return {
                success: false,
                error: `Glob error: ${error.message}`
            };
        }
    },

    async grep({ pattern, path: searchPath, include }) {
        const cwd = searchPath ? 
            (path.isAbsolute(searchPath) ? searchPath : path.join(PROJECT_ROOT, searchPath)) : 
            PROJECT_ROOT;

        const globPattern = include || '**/*';
        const { glob } = await import('glob');
        
        try {
            const files = await glob(globPattern, { cwd, nodir: true, absolute: false });
            const regex = new RegExp(pattern, 'i');
            const results = [];

            for (const file of files.slice(0, 200)) {
                try {
                    const content = fs.readFileSync(path.join(cwd, file), 'utf-8');
                    const lines = content.split('\n');
                    for (let i = 0; i < lines.length; i++) {
                        if (regex.test(lines[i])) {
                            results.push({
                                file,
                                lineNumber: i + 1,
                                line: lines[i].trim()
                            });
                            if (results.length >= 50) break;
                        }
                    }
                    if (results.length >= 50) break;
                } catch {
                    continue;
                }
            }

            if (results.length === 0) {
                return {
                    success: true,
                    output: `No matches found for pattern: ${pattern}`
                };
            }

            const output = results
                .map(r => `${r.file}:${r.lineNumber}: ${r.line}`)
                .join('\n');

            return {
                success: true,
                output: `Found ${results.length} match(es):\n${output}`
            };
        } catch (error) {
            return {
                success: false,
                error: `Grep error: ${error.message}`
            };
        }
    }
};

export function parseToolCallFromText(text) {
    const trimmed = text.trim();
    
    // 1. Try pure JSON
    try {
        const parsed = JSON.parse(trimmed);
        if (parsed.tool_calls && Array.isArray(parsed.tool_calls)) {
            return parsed.tool_calls.map(tc => ({
                name: tc.name,
                arguments: typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments
            }));
        }
        if (parsed.name && (parsed.arguments || parsed.args)) {
            return [{
                name: parsed.name,
                arguments: typeof parsed.arguments === 'string' ? JSON.parse(parsed.arguments) : (parsed.arguments || parsed.args || {})
            }];
        }
    } catch (e) {
    }

    // 2. Try JSON in code block
    const jsonBlockMatch = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
    if (jsonBlockMatch) {
        try {
            const parsed = JSON.parse(jsonBlockMatch[1]);
            if (parsed.tool_calls && Array.isArray(parsed.tool_calls)) {
                return parsed.tool_calls.map(tc => ({
                    name: tc.name,
                    arguments: typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments
                }));
            }
        } catch (e) {
        }
    }

    // 3. Extract JSON from mixed text (e.g., "I'll use: {...}")
    const jsonInTextMatch = trimmed.match(/\{[\s\S]*"tool_calls"[\s\S]*\}/);
    if (jsonInTextMatch) {
        try {
            const parsed = JSON.parse(jsonInTextMatch[0]);
            if (parsed.tool_calls && Array.isArray(parsed.tool_calls)) {
                return parsed.tool_calls.map(tc => ({
                    name: tc.name,
                    arguments: typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments
                }));
            }
        } catch (e) {
        }
    }

    // 3b. Parse "Tool call: toolName({...})" format
    const toolCallPattern = /Tool call:\s*(\w+)\((\{[\s\S]*\})\)\s*$/im;
    const toolCallMatch = trimmed.match(toolCallPattern);
    if (toolCallMatch) {
        const toolName = toolCallMatch[1];
        const argsStr = toolCallMatch[2];
        try {
            const args = JSON.parse(argsStr);
            const { description, ...cleanArgs } = args;
            return [{ name: toolName, arguments: cleanArgs }];
        } catch (e) {
        }
    }

    // 3c. Parse multiple "Tool call: ..." lines
    const multiToolCallPattern = /Tool call:\s*(\w+)\((\{[\s\S]*?\})\)/g;
    let multiMatch;
    const multiCalls = [];
    while ((multiMatch = multiToolCallPattern.exec(trimmed)) !== null) {
        const toolName = multiMatch[1];
        const argsStr = multiMatch[2];
        try {
            const args = JSON.parse(argsStr);
            const { description, ...cleanArgs } = args;
            multiCalls.push({ name: toolName, arguments: cleanArgs });
        } catch (e) {
        }
    }
    if (multiCalls.length > 0) {
        return multiCalls;
    }

    // 4. Natural language patterns — bash commands
    const bashPatterns = [
        // Russian: "сделай команду ...", "выполни ...", "запусти ...", "команда ..."
        /(?:сделай|выполни|запусти|выполнить|запустить|команда|cmd|shell)\s+(?:команду\s+)?["']?([^"'\n]{2,})["']?/i,
        // English: "run ...", "execute ...", "use bash to ..."
        /(?:run|execute)\s+(?:the\s+)?(?:command\s+)?["']?([^"'\n]{2,})["']?/i,
        // Direct command patterns: "git status", "npm install", etc.
        /\b(git\s+\w+|npm\s+\w+|node\s+[^|&;]+|python\s+[^|&;]+|ls|dir|pwd|cd\s+\S+|echo\s+.+|cat\s+\S+|type\s+\S+)\b/i,
        // "use bash: command" or "bash: command"
        /(?:use\s+)?bash[:\s]+["']?([^"'\n]+)["']?/i,
    ];

    for (const pattern of bashPatterns) {
        const match = trimmed.match(pattern);
        if (match && match[1]) {
            let command = match[1].trim();
            // Clean up trailing punctuation
            command = command.replace(/[.!?]+$/, '').trim();
            if (command.length >= 2) {
                return [{ name: 'bash', arguments: { command } }];
            }
        }
    }

    // 5. Natural language patterns — file operations
    const filePatterns = [
        // Russian: "открой файл ...", "прочитай ...", "покажи содержимое ..."
        { regex: /(?:открой|прочитай|покажи|посмотри|view|show|cat)\s+(?:файл\s+|содержимое\s+)?["']?([^"'\n]+\.[a-zA-Z0-9]+)["']?/i, tool: 'read_file', arg: 'path' },
        // Russian: "запиши в ...", "создай файл ...", "сохрани ..."
        { regex: /(?:запиши|создай|сохрани|write|save|create)\s+(?:файл\s+|в\s+)?["']?([^"'\n]+\.[a-zA-Z0-9]+)["']?(?:\s+(?:с\s+содержимым|with|content)[:\s]*([\s\S]*))?/i, tool: 'write_file', args: ['path', 'content'] },
        // English: "read file ...", "open ..."
        { regex: /(?:read|open|view|show)\s+(?:file\s+)?["']?([^"'\n]+\.[a-zA-Z0-9]+)["']?/i, tool: 'read_file', arg: 'path' },
    ];

    for (const { regex, tool, arg, args } of filePatterns) {
        const match = trimmed.match(regex);
        if (match) {
            const callArgs = {};
            if (arg) {
                callArgs[arg] = match[1].trim();
            } else if (args) {
                args.forEach((a, i) => {
                    if (match[i + 1]) callArgs[a] = match[i + 1].trim();
                });
            }
            return [{ name: tool, arguments: callArgs }];
        }
    }

    // 6. Search patterns
    const searchPatterns = [
        { regex: /(?:find|search|найди|поиск)\s+(?:files?\s+)?["']?([^"'\n]+)["']?/i, tool: 'glob', arg: 'pattern' },
        { regex: /(?:grep|search|grep)\s+(?:for\s+|по\s+)?["']?([^"'\n]+)["']?(?:\s+in\s+["']?([^"'\n]+)["']?)?/i, tool: 'grep', args: ['pattern', 'path'] },
    ];

    for (const { regex, tool, arg, args } of searchPatterns) {
        const match = trimmed.match(regex);
        if (match) {
            const callArgs = {};
            if (arg) {
                callArgs[arg] = match[1].trim();
            } else if (args) {
                args.forEach((a, i) => {
                    if (match[i + 1]) callArgs[a] = match[i + 1].trim();
                });
            }
            return [{ name: tool, arguments: callArgs }];
        }
    }

    return null;
}

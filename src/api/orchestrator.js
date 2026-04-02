import path from 'path';
import { logInfo, logError, logDebug, logWarn } from '../logger/index.js';
import {
    getOrCreateAgentState,
    getAgentState,
    recordToolAction,
    setPendingPatch,
    clearPendingPatch,
    markPatchApplied,
    touchRecentFile,
    setLastSearchResults,
    updateCwd,
    setActiveDirectoryTarget,
    setActiveFileTarget,
    setLastListedDirectory,
    buildAgentRuntimeContext,
    setTaskGoal,
    addProgressEntry,
    incrementNoProgress,
    recordSeenAction,
    setLastDecision,
    addObservation,
    autoTransitionMode
} from './agentState.js';
import { executeTool, parseToolCallFromText } from '../tools/toolExecutor.js';
import { buildToolObservation, hasProgress } from './toolObservation.js';
import { AGENT_NO_PROGRESS_LIMIT, ENABLE_BASH_TOOL } from '../config.js';

const DEFAULT_MAX_STEPS = 5;

function joinPath(base, name) {
    if (!base) return name;
    const normalizedBase = base.replace(/[\\/]+$/, '');
    const sep = normalizedBase.includes('\\') ? '\\' : '/';
    return `${normalizedBase}${sep}${name}`;
}

function normalizePath(p) {
    return typeof p === 'string' ? p.replace(/\\/g, '/') : p;
}

/**
 * Extract explicit file path from user message.
 * Returns { type: 'file' | 'directory', path: string } or null.
 */
export function extractExplicitPath(text) {
    if (!text) return null;
    
    // Match Windows paths: C:\... or C:/...
    const winPath = text.match(/([A-Za-z]:[\\\/][^\s"'`,;]+(?:\.\w{1,4})?)/);
    if (winPath) {
        const p = winPath[1];
        const hasExtension = /\.\w{1,4}$/.test(p);
        return { type: hasExtension ? 'file' : 'directory', path: p };
    }
    
    // Match Unix-like paths: /home/... or ./... or ../...
    const unixPath = text.match(/(\/[^\s"'`,;]+(?:\.\w{1,4})?)/);
    if (unixPath) {
        const p = unixPath[1];
        const hasExtension = /\.\w{1,4}$/.test(p);
        return { type: hasExtension ? 'file' : 'directory', path: p };
    }
    
    // Match simple filename with extension mentioned in context
    const filename = text.match(/[\w.-]+\.\w{1,8}/);
    if (
        filename &&
        (
            text.includes('файл') || text.includes('file') ||
            text.includes('открой') || text.includes('прочитай') ||
            text.includes('посмотри') || text.includes('show') || text.includes('read')
        )
    ) {
        return { type: 'file', path: filename[0] };
    }
    
    return null;
}

/**
 * Try to infer a direct file target from the latest user message and agent state.
 * Handles cases like:
 * - "посмотри содержимое example"
 * when recentFiles already contains "example.py" in the current cwd.
 */
export function inferDirectFileTarget(message, agentState) {
    if (!message || !agentState) return null;

    const cwd = agentState.cwd;
    const recentFiles = Array.isArray(agentState.recentFiles) ? agentState.recentFiles : [];
    if (!cwd || recentFiles.length === 0) return null;

    // If user asks to open a filename after listing a directory, prefer that directory
    const listedDir = agentState.activeDirectoryTarget || agentState.lastListedDirectory || cwd;

    // Explicit bare filename mention without extension, e.g. "example"
    const bareNameMatch =
        message.match(/\b(?:файл|file|содержимое|content of|read|open|посмотри|прочитай)\s+([A-Za-z0-9_.-]+)\b/i) ||
        message.match(/\b([A-Za-z0-9_.-]+)\b/);

    if (!bareNameMatch) return null;

    const requestedName = bareNameMatch[1];
    if (!requestedName) return null;

    const candidates = recentFiles.filter(f => {
        const fileName = f.split(/[\\/]/).pop();
        if (!fileName) return false;

        if (fileName.toLowerCase() === requestedName.toLowerCase()) return true;

        const baseName = fileName.replace(/\.[^.]+$/, '');
        return baseName.toLowerCase() === requestedName.toLowerCase();
    });

    if (candidates.length === 0) return null;

    const chosen = candidates[0];
    const fileName = chosen.split(/[\\/]/).pop();
    if (!fileName) return null;

    return {
        type: 'file',
        path: joinPath(listedDir, fileName)
    };
}

function inferActiveDirectoryTarget(message, agentState) {
    if (!message || !agentState) return null;
    const explicit = extractExplicitPath(message);
    if (explicit?.type === 'directory') return explicit.path;

    const text = message.toLowerCase();
    const dirRefs = [
        'папк', 'директори', 'содержимое папки', 'в этой папке',
        'folder', 'directory', 'contents of the folder', 'in this folder'
    ];
    const asksAboutDirectory = dirRefs.some(ref => text.includes(ref));
    if (!asksAboutDirectory) return null;

    return agentState.activeDirectoryTarget || agentState.lastListedDirectory || agentState.cwd || null;
}

function inferActiveFileTarget(message, agentState) {
    if (!message || !agentState) return null;
    const text = message.toLowerCase();

    const explicit = extractExplicitPath(message);
    if (explicit?.type === 'file') {
        return { path: explicit.path, reason: 'explicit_file_path' };
    }

    const followUpRefs = [
        'этот файл', 'в этом файле', 'покажи этот файл', 'покажи файл',
        'что в нем', 'что в нём', 'его содержимое', 'в нем', 'в нём',
        'измени', 'замени', 'исправь', 'поменяй', 'открой',
        'this file', 'the file', 'show this file', 'what is in it',
        'change', 'modify', 'replace', 'fix', 'open'
    ];
    const hasFollowUpRef = followUpRefs.some(ref => text.includes(ref));

    if (hasFollowUpRef) {
        if (agentState.activeFileTarget) return { path: agentState.activeFileTarget, reason: 'follow_up_active_file' };
        if (agentState.lastReadFile) return { path: agentState.lastReadFile, reason: 'follow_up_last_read_file' };
    }

    const inferred = inferDirectFileTarget(message, agentState);
    if (inferred?.type === 'file') return { path: inferred.path, reason: 'inferred_from_recent_files' };
    return null;
}

function inferCdTarget(message, agentState) {
    if (!message) return null;
    const text = message.trim();
    const match = text.match(/\bcd\s+([^\n\r)]+)/i);
    if (!match) return null;
    const rawTarget = match[1].trim().replace(/^["']|["']$/g, '');
    if (!rawTarget) return null;
    const base = agentState?.cwd || process.cwd();
    const resolved = path.isAbsolute(rawTarget) ? rawTarget : path.resolve(base, rawTarget);
    return resolved;
}

/**
 * Build direct path guidance for the model.
 * If user gave an explicit path, tell the model to use it directly.
 */
function buildDirectPathGuidance(message, agentState) {
    const pathInfo = extractExplicitPath(message);
    const activeTarget = inferActiveFileTarget(message, agentState);
    const activeDir = inferActiveDirectoryTarget(message, agentState);
    const cdTarget = inferCdTarget(message, agentState);

    if (cdTarget) {
        return `\nDIRECT INSTRUCTION: The user wants to change working directory to ${normalizePath(cdTarget)}.\nDo NOT rely on shell session persistence. Use bash only if needed, and update the working context to this directory for subsequent actions.`;
    }

    // Highest priority: active/explicit file target for show/edit follow-ups
    if (activeTarget?.path) {
        const lower = message.toLowerCase();
        const isEditIntent =
            ['измени', 'замени', 'исправь', 'поменяй', 'change', 'modify', 'replace', 'fix']
                .some(w => lower.includes(w));

        if (isEditIntent) {
            return `\nDIRECT INSTRUCTION: The target file is already known: ${normalizePath(activeTarget.path)}\nDo NOT grep, glob, or read the file again. Use this file as the active edit target and propose a patch directly.`;
        }

        return `\nDIRECT INSTRUCTION: The target file is already known: ${normalizePath(activeTarget.path)}\nDo NOT search, glob, or ask for clarification. Use read_file only if content is truly unavailable; otherwise answer using the existing file context.`;
    }

    if (!pathInfo) return '';
    
    if (pathInfo.type === 'file') {
        return `\nDIRECT INSTRUCTION: The user specified an explicit file path: ${normalizePath(pathInfo.path)}\nUse read_file with this exact path. Do NOT search, glob, or list directories first.`;
    }
    
    // Directory path - check if we have a recent file name to combine
    const mentionedFile = message.match(/[\w.-]+\.\w{1,8}/);
    if (mentionedFile) {
        const fullPath = joinPath(pathInfo.path, mentionedFile[0]);
        return `\nDIRECT INSTRUCTION: The user specified directory ${pathInfo.path} and mentioned file ${mentionedFile[0]}.\nUse read_file with path: ${normalizePath(fullPath)}. Do NOT search or glob first.`;
    }
    
    // Fallback: infer target from cwd + recently seen files, e.g. "example" -> "example.py"
    const inferred = inferDirectFileTarget(message, agentState);
    if (inferred?.type === 'file') {
        return `\nDIRECT INSTRUCTION: The user referred to a file in the current working directory.\nUse read_file with path: ${normalizePath(inferred.path)}. Do NOT search or glob first.`;
    }

    if (activeDir) {
        return `\nDIRECT INSTRUCTION: The active directory is ${normalizePath(activeDir)}.\nResolve relative file references against this directory. If the user asks for folder contents, inspect this directory directly.`;
    }

    // Directory path — suggest appropriate tools based on capabilities
    const bashAvailable = ENABLE_BASH_TOOL;
    const projectRoot = agentState?.projectRoot || '';
    const normalizedPath = normalizePath(pathInfo.path).toLowerCase();
    const normalizedRoot = normalizePath(projectRoot).toLowerCase();
    const insideProjectRoot = normalizedRoot && normalizedPath.startsWith(normalizedRoot);

    if (bashAvailable) {
        return `\nDIRECT INSTRUCTION: The user specified directory: ${normalizePath(pathInfo.path)}\nUse bash with 'ls' or glob to list contents of this directory. If successful, treat this as the active directory for follow-up requests.`;
    }

    if (insideProjectRoot) {
        return `\nDIRECT INSTRUCTION: The user specified directory: ${normalizePath(pathInfo.path)}\nBash is disabled. Use glob to inspect this directory inside the project root.`;
    }

    return `\nDIRECT INSTRUCTION: The user specified directory: ${normalizePath(pathInfo.path)}\nBash is disabled and this path is outside the project root. Do NOT call bash, glob, or read_file repeatedly. Explain the limitation clearly.`;
}

/**
 * Check if the tool call should stop the loop
 */
function checkStopConditions(toolCalls, step, maxSteps, state) {
    if (step >= maxSteps) return { stop: true, reason: `Max steps (${maxSteps}) reached` };
    
    for (const tc of toolCalls) {
        const name = tc.name;
        // Stop on propose_patch — user must review
        if (name === 'propose_patch') return { stop: true, reason: 'Patch proposed, awaiting user approval' };
        // Stop on write_file for safety (prefer propose_patch)
        if (name === 'write_file') return { stop: true, reason: 'write_file called, stopping for safety' };
    }
    
    // Check no progress limit
    if (state && state.noProgressCount >= AGENT_NO_PROGRESS_LIMIT) {
        return { stop: true, reason: `No progress for ${state.noProgressCount} steps` };
    }
    
    return { stop: false };
}

/**
 * Build the next message for the model with goal-aware context
 */
function buildNextMessage(toolCalls, observations, state, step, userMessage) {
    const goalBlock = state?.taskGoal ? `\nYou are working on this task:\n${state.taskGoal}\n` : '';
    const modeBlock = `Current mode: ${state?.mode || 'explore'}`;
    
    const progressBlock = state?.progressSummary.length > 0
        ? `\nProgress so far:\n${state.progressSummary.slice(-5).map(p => `- ${p}`).join('\n')}`
        : '';
    
    const obsBlock = observations.length > 0
        ? `\nLatest observations:\n${observations.slice(-3).map(o => `- ${o.summary || o}`).join('\n')}`
        : '';
    
    // Direct path guidance (highest priority)
    const directPathGuidance = userMessage ? buildDirectPathGuidance(userMessage, state) : '';

    let directoryContextGuidance = '';
    if (state?.activeDirectoryTarget && userMessage) {
        const lower = userMessage.toLowerCase();
        const asksToList = [
            'содержимое папки', 'видишь содержимое', 'что в папке', 'покажи папку',
            'folder contents', 'list directory', 'show folder', 'what is in the folder'
        ].some(ref => lower.includes(ref));

        const asksToOpenFile = [
            'открой', 'покажи', 'прочитай', 'read', 'open', 'show'
        ].some(ref => lower.includes(ref));

        if (asksToList) {
            directoryContextGuidance = `\nDIRECTORY CONTEXT: The active directory is ${state.activeDirectoryTarget}\nUse this directory directly. Do NOT fall back to the project root.`;
        } else if (asksToOpenFile && !extractExplicitPath(userMessage)?.path) {
            directoryContextGuidance = `\nDIRECTORY CONTEXT: Resolve relative file names against the active directory ${state.activeDirectoryTarget}\nIf the user asks to open hello.py, first try ${normalizePath(joinPath(state.activeDirectoryTarget, 'hello.py'))} when appropriate.`;
        }
    }

    // File context guidance — if user asks about "it" / "the file" / edit follow-up
    let fileContextGuidance = '';
    if (state?.lastReadFile && userMessage) {
        const lower = userMessage.toLowerCase();
        const vagueRefs = [
            'в нем', 'в нём', 'его содержимое', 'что в нем', 'что в нём',
            'what is in it', 'show me the content', 'its content', 'the file',
            'этот файл', 'в этом файле'
        ];
        const editRefs = [
            'измени', 'замени', 'исправь', 'поменяй',
            'change', 'modify', 'replace', 'fix'
        ];
        const hasVagueRef = vagueRefs.some(ref => lower.includes(ref));
        const hasEditRef = editRefs.some(ref => lower.includes(ref));

        if (hasVagueRef && !hasEditRef) {
            fileContextGuidance = `\nFILE CONTEXT: The user is asking about the last read file: ${state.lastReadFile}\nYou already have the content. Do NOT call read_file, ls, or glob. Answer using the content you already received.`;
        }

        if (hasEditRef) {
            const target = state.activeFileTarget || state.lastReadFile;
            fileContextGuidance = `\nFILE CONTEXT: The user wants to modify the known file: ${target}\nDo NOT grep the whole project. Do NOT glob. Do NOT read the same file repeatedly. Use the known file as the edit target and propose a patch directly.`;
        }
    }

    if (!state?.lastReadFile && state?.activeFileTarget && userMessage) {
        fileContextGuidance = `\nFILE CONTEXT: The active file target is ${state.activeFileTarget}\nUse this file directly for the user's request.`;
    }

    const guidance = `\nDecide the single best next step.
You may:
- explore more files (glob, grep)
- inspect a file in detail (read_file)
- propose a patch (propose_patch)
- finish if the task is complete

Do not repeat a previous action unless it is necessary.
Prefer propose_patch instead of write_file for code changes.
If the user gave an explicit file path, use read_file directly with that path.
Do not use bash to read a file when read_file is available.
Treat cd as a working-directory update, not as persistent shell state.`;

    return `${directPathGuidance}${directoryContextGuidance}${fileContextGuidance}${goalBlock}${modeBlock}${progressBlock}${obsBlock}${guidance}`;
}

/**
 * Run the agent orchestration loop with Phase 6 features:
 * - Goal-aware runtime context
 * - Mode transitions (explore -> analyze -> propose)
 * - Progress tracking
 * - Repeated action detection
 * - Structured observations
 * - Smarter stop conditions
 */
export async function runAgentLoop(sendToModel, options = {}) {
    const {
        sessionKey,
        clientWorkdir,
        maxSteps = DEFAULT_MAX_STEPS,
        onStep = null
    } = options;
    
    // Get or create agent state
    const projectRoot = clientWorkdir || process.cwd();
    const agentState = getOrCreateAgentState({
        sessionKey,
        projectRoot,
        cwd: clientWorkdir,
        taskGoal: options.initialMessage?.substring(0, 200),
        chatId: options.chatId,
        parentId: options.parentId
    });
    
    // Set task goal if provided
    if (options.initialMessage && !agentState.taskGoal) {
        setTaskGoal(sessionKey, options.initialMessage.substring(0, 200));
    }
    
    logInfo(`Agent loop started for session: ${sessionKey}, maxSteps: ${maxSteps}, mode: ${agentState.mode}`);
    
    let currentMessage = options.initialMessage;
    const lastUserMessage = options.lastUserMessage || options.initialMessage;
    let allToolCalls = [];
    let allObservations = [];
    let lastResponse = null;
    let stopped = false;
    let stopReason = '';
    
    for (let step = 0; step < maxSteps; step++) {
        logInfo(`=== Agent loop step ${step + 1}/${maxSteps} (mode: ${agentState.mode}) ===`);
        
        // Build runtime context for this step
        const runtimeContext = buildAgentRuntimeContext(agentState);
        
        // Send to model
        const response = await sendToModel(currentMessage, runtimeContext, agentState);
        
        if (!response || response.error) {
            logError(`Agent loop step ${step + 1} failed: ${response?.error}`);
            return {
                success: false,
                error: response?.error || 'Model response failed',
                steps: step,
                toolCalls: allToolCalls,
                observations: allObservations,
                lastResponse,
                agent: buildAgentMetadata(agentState, stopReason)
            };
        }
        
        lastResponse = response;
        const content = response.choices?.[0]?.message?.content || '';
        
        // Parse tool calls
        const toolCalls = parseToolCallFromText(content);
        
        if (!toolCalls || toolCalls.length === 0) {
            // No tool calls — model is done
            logInfo(`Agent loop completed at step ${step + 1}: no more tool calls`);
            stopped = true;
            stopReason = 'Task completed';
            agentState.taskStatus = 'done';
            agentState.mode = 'done';
            break;
        }
        
        // Check stop conditions
        const stopCheck = checkStopConditions(toolCalls, step, maxSteps, agentState);
        if (stopCheck.stop) {
            logInfo(`Agent loop stopped: ${stopCheck.reason}`);
            stopped = true;
            stopReason = stopCheck.reason;
            
            // Still execute the tool calls (e.g., propose_patch)
            const { observations } = await executeToolCalls(toolCalls, agentState, sessionKey, clientWorkdir, lastUserMessage);
            allToolCalls.push(...toolCalls);
            allObservations.push(...observations);
            
            break;
        }
        
        // Execute tool calls
        logInfo(`Executing ${toolCalls.length} tool call(s) at step ${step + 1}`);
        const { observations, blockedTools } = await executeToolCalls(toolCalls, agentState, sessionKey, clientWorkdir, lastUserMessage);
        
        allToolCalls.push(...toolCalls);
        allObservations.push(...observations);
        
        // Gate: if a critical tool was blocked (e.g., bash disabled), stop immediately
        if (blockedTools.length > 0) {
            const blockedNames = blockedTools.map(t => t.name).join(', ');
            logWarn(`Blocked tools detected: ${blockedNames}. Stopping loop.`);
            stopped = true;
            stopReason = `Tools unavailable: ${blockedNames}`;
            
            // Build a clear response for the user about what's blocked
            const blockedMsg = blockedTools.map(t => {
                if (t.name === 'bash') return `bash tool is disabled (set ENABLE_BASH_TOOL=1 to enable).`;
                return `${t.name} tool is not available.`;
            }).join(' ');
            
            // Return the blocked tool info directly
            return {
                success: true,
                stopped: true,
                stopReason,
                steps: allToolCalls.length,
                toolCalls: allToolCalls,
                observations: allObservations,
                lastResponse: {
                    choices: [{
                        message: {
                            role: 'assistant',
                            content: `Cannot complete this request. ${blockedMsg}`
                        },
                        finish_reason: 'blocked_tool'
                    }]
                },
                agent: buildAgentMetadata(agentState, stopReason)
            };
        }
        
        // Check for progress
        let hadProgress = false;
        for (let i = 0; i < toolCalls.length; i++) {
            const tc = toolCalls[i];
            const obs = observations[i];
            
            // Check for repeated action (semantic: same tool + same args)
            const isRepeated = recordSeenAction(sessionKey, tc.name, tc.arguments);
            if (isRepeated) {
                incrementNoProgress(sessionKey);
                logWarn(`Repeated action detected: ${tc.name}(${JSON.stringify(tc.arguments)})`);
            } else if (hasProgress(agentState, tc.name, obs)) {
                hadProgress = true;
                addProgressEntry(sessionKey, `${tc.name}: ${tc.arguments?.path || tc.arguments?.command || tc.arguments?.pattern || ''}`);
            }
        }
        
        if (!hadProgress) {
            const count = incrementNoProgress(sessionKey);
            logWarn(`No progress step ${count}/${AGENT_NO_PROGRESS_LIMIT}`);
        }
        
        // Auto-transition mode
        autoTransitionMode(sessionKey);
        
        // Record decision
        setLastDecision(sessionKey, toolCalls.map(tc => tc.name).join(', '), `Step ${step + 1}`);
        
        // Callback for progress reporting
        if (onStep) {
            onStep({
                step: step + 1,
                toolCalls,
                observations,
                agentState: {
                    mode: agentState.mode,
                    taskStatus: agentState.taskStatus,
                    recentFiles: agentState.recentFiles,
                    patchState: agentState.patchState,
                    noProgressCount: agentState.noProgressCount
                }
            });
        }
        
        // Build next message (pass latest user message for direct path detection)
        currentMessage = buildNextMessage(toolCalls, observations, agentState, step, lastUserMessage);
    }
    
    // If we exited the loop without stopping, it means max steps reached
    if (!stopped) {
        stopped = true;
        stopReason = `Max steps (${maxSteps}) reached`;
    }
    
    logInfo(`Agent loop finished: ${stopReason}, ${allToolCalls.length} total tool calls`);
    
    return {
        success: true,
        stopped,
        stopReason,
        steps: allToolCalls.length,
        toolCalls: allToolCalls,
        observations: allObservations,
        lastResponse,
        agent: buildAgentMetadata(agentState, stopReason)
    };
}

/**
 * Execute a batch of tool calls and update agent state with structured observations
 */
async function executeToolCalls(toolCalls, agentState, sessionKey, clientWorkdir, lastUserMessage) {
    const observations = [];
    const blockedTools = [];
    
    for (const tc of toolCalls) {
        const toolName = tc.name;
        const toolArgs = tc.arguments || {};
        
        // Semantic cd handling: update cwd and active directory explicitly
        if (toolName === 'bash' && typeof toolArgs.command === 'string') {
            const cdTarget = inferCdTarget(toolArgs.command, agentState) || inferCdTarget(lastUserMessage, agentState);
            if (cdTarget) {
                const normalizedCd = normalizePath(cdTarget);
                updateCwd(sessionKey, normalizedCd);
                setActiveDirectoryTarget(sessionKey, normalizedCd, 'semantic_cd');
            }
        }
        
        logInfo(`Executing: ${toolName}(${JSON.stringify(toolArgs)})`);
        const result = await executeTool(toolName, toolArgs, clientWorkdir);
        
        // Track blocked tools for immediate loop termination
        if (!result.success && result.error?.includes('disabled')) {
            blockedTools.push({ name: toolName, error: result.error });
        }
        
        // Build structured observation
        const observation = buildToolObservation(toolName, toolArgs, result);
        observations.push(observation);
        
        // Update agent state
        if (agentState) {
            if (toolArgs.workdir) updateCwd(sessionKey, normalizePath(toolArgs.workdir));
            const toolPath = normalizePath(toolArgs.path || toolArgs.filePath || null);

            if (toolName === 'read_file' && toolPath) {
                const wasSameFile = agentState.lastReadFile === toolPath;

                if (result.success) {
                    // Store file context for follow-up questions
                    agentState.lastReadFile = toolPath;
                    agentState.lastReadContent = observation.content?.substring(0, 2000) || null;
                    setActiveFileTarget(sessionKey, toolPath, 'successful_read_file');
                    const parentDir = normalizePath(path.dirname(toolPath));
                    setActiveDirectoryTarget(sessionKey, parentDir, 'parent_of_active_file');
                }

                // Detect repeated read only if it was already the active/last-read file before this call
                if (wasSameFile) {
                    incrementNoProgress(sessionKey);
                    logWarn(`Repeated read of same file: ${toolPath}`);
                }
            }

            if (['read_file', 'write_file', 'edit_file', 'apply_patch', 'propose_patch'].includes(toolName) && toolPath) {
                touchRecentFile(sessionKey, toolPath);
            }

            if (toolName === 'glob' && toolArgs.pattern) {
                setLastSearchResults(sessionKey, {
                    tool: 'glob',
                    query: toolArgs.pattern,
                    resultCount: observation.fileCount || 0
                });

                const targetDir = normalizePath(toolArgs.path || toolArgs.workdir || agentState.cwd);
                if (result.success && targetDir) {
                    setLastListedDirectory(sessionKey, targetDir, observation.files || []);
                    setActiveDirectoryTarget(sessionKey, targetDir, 'glob_listing');
                }
            }
            if (toolName === 'grep' && toolArgs.pattern) {
                setLastSearchResults(sessionKey, {
                    tool: 'grep',
                    query: toolArgs.pattern,
                    resultCount: observation.matchCount || 0
                });
            }
            
            if (toolName === 'propose_patch' && observation.patchId) {
                setPendingPatch(sessionKey, observation.patchId, toolArgs.path);
            }
            if (toolName === 'apply_patch' && observation.success) {
                const state = getAgentState(sessionKey);
                if (state && state.patchState.status === 'confirmed') {
                    markPatchApplied(sessionKey);
                    clearPendingPatch(sessionKey);
                } else {
                    logWarn(`apply_patch blocked: patch not confirmed (status: ${state?.patchState?.status})`);
                }
            }

            if (toolName === 'bash' && result.success) {
                const listTarget = normalizePath(toolArgs.workdir || agentState.cwd);
                if (listTarget && /(ls|dir|Get-ChildItem)/i.test(toolArgs.command || '')) {
                    setLastListedDirectory(sessionKey, listTarget, []);
                    setActiveDirectoryTarget(sessionKey, listTarget, 'bash_listing');
                }
            }
            
            recordToolAction(sessionKey, {
                tool: toolName,
                summary: toolArgs.path || toolArgs.command || toolArgs.pattern || '',
                success: result.success
            });
            
            addObservation(sessionKey, observation);
            agentState.lastToolResultSummary = observation.summary?.substring(0, 200) || '';
        }
    }
    
    return { observations, blockedTools };
}

/**
 * Build agent metadata for response
 */
function buildAgentMetadata(state, stopReason) {
    if (!state) return null;
    return {
        sessionKey: state.sessionKey,
        chatId: state.chatId,
        parentId: state.parentId,
        mode: state.mode,
        taskStatus: state.taskStatus,
        taskGoal: state.taskGoal,
        stopReason,
        stepsUsed: state.actionHistory?.length || 0,
        progressSummary: state.progressSummary?.slice(-5) || [],
        recentFiles: state.recentFiles?.slice(0, 5) || [],
        patchState: state.patchState,
        noProgressCount: state.noProgressCount
    };
}

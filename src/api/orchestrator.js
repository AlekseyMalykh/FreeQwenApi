import { logInfo, logError, logDebug, logWarn } from '../logger/index.js';
import {
    getOrCreateAgentState,
    recordToolAction,
    setPendingPatch,
    clearPendingPatch,
    touchRecentFile,
    setLastSearchResults,
    updateCwd,
    buildAgentRuntimeContext,
    setTaskGoal,
    updateTaskStatus,
    setAgentMode,
    addProgressEntry,
    incrementNoProgress,
    recordSeenAction,
    setLastDecision,
    addObservation,
    autoTransitionMode
} from './agentState.js';
import { executeTool, parseToolCallFromText } from '../tools/toolExecutor.js';
import { buildToolObservation, isRepeatedAction, hasProgress } from './toolObservation.js';
import { AGENT_NO_PROGRESS_LIMIT, ENABLE_GOAL_AWARE_AGENT } from '../config.js';

const DEFAULT_MAX_STEPS = 5;

// Tool policies per mode
const TOOLS_BY_MODE = {
    explore: ['glob', 'grep', 'read_file', 'bash'],
    analyze: ['read_file', 'grep', 'bash'],
    propose: ['propose_patch', 'read_file'],
    done: []
};

/**
 * Summarize tool output for the model (prevent context overflow)
 */
function summarizeToolResult(toolName, result) {
    if (!result.success) {
        return `Tool ${toolName} failed: ${result.error || 'Unknown error'}`;
    }
    
    const output = result.output || '(no output)';
    const summary = output.length > 2000
        ? output.substring(0, 2000) + `\n... (output truncated, ${output.length} total chars)`
        : output;
    
    return summary;
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
function buildNextMessage(toolCalls, observations, state, step) {
    const goalBlock = state?.taskGoal ? `\nYou are working on this task:\n${state.taskGoal}\n` : '';
    const modeBlock = `Current mode: ${state?.mode || 'explore'}`;
    
    const progressBlock = state?.progressSummary.length > 0
        ? `\nProgress so far:\n${state.progressSummary.slice(-5).map(p => `- ${p}`).join('\n')}`
        : '';
    
    const obsBlock = observations.length > 0
        ? `\nLatest observations:\n${observations.slice(-3).map(o => `- ${o.summary || o}`).join('\n')}`
        : '';
    
    const guidance = `\nDecide the single best next step.
You may:
- explore more files (glob, grep)
- inspect a file in detail (read_file)
- propose a patch (propose_patch)
- finish if the task is complete

Do not repeat a previous action unless it is necessary.
Prefer propose_patch instead of write_file for code changes.`;
    
    return `${goalBlock}${modeBlock}${progressBlock}${obsBlock}${guidance}`;
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
        taskGoal: options.initialMessage?.substring(0, 200) // Use first message as goal
    });
    
    // Set task goal if provided
    if (options.initialMessage && !agentState.taskGoal) {
        setTaskGoal(sessionKey, options.initialMessage.substring(0, 200));
    }
    
    logInfo(`Agent loop started for session: ${sessionKey}, maxSteps: ${maxSteps}, mode: ${agentState.mode}`);
    
    let currentMessage = options.initialMessage;
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
            const { observations } = await executeToolCalls(toolCalls, agentState, sessionKey, clientWorkdir);
            allToolCalls.push(...toolCalls);
            allObservations.push(...observations);
            
            break;
        }
        
        // Execute tool calls
        logInfo(`Executing ${toolCalls.length} tool call(s) at step ${step + 1}`);
        const { observations } = await executeToolCalls(toolCalls, agentState, sessionKey, clientWorkdir);
        
        allToolCalls.push(...toolCalls);
        allObservations.push(...observations);
        
        // Check for progress
        let hadProgress = false;
        for (let i = 0; i < toolCalls.length; i++) {
            const tc = toolCalls[i];
            const obs = observations[i];
            
            // Check for repeated action
            const isRepeated = recordSeenAction(sessionKey, tc.name, tc.arguments);
            if (isRepeated) {
                incrementNoProgress(sessionKey);
                logWarn(`Repeated action detected: ${tc.name}`);
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
                    pendingPatchId: agentState.pendingPatchId,
                    noProgressCount: agentState.noProgressCount
                }
            });
        }
        
        // Build next message
        currentMessage = buildNextMessage(toolCalls, observations, agentState, step);
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
async function executeToolCalls(toolCalls, agentState, sessionKey, clientWorkdir) {
    const observations = [];
    
    for (const tc of toolCalls) {
        const toolName = tc.name;
        const toolArgs = tc.arguments || {};
        
        logInfo(`Executing: ${toolName}(${JSON.stringify(toolArgs)})`);
        const result = await executeTool(toolName, toolArgs, clientWorkdir);
        
        // Build structured observation
        const observation = buildToolObservation(toolName, toolArgs, result);
        observations.push(observation);
        
        // Update agent state
        if (agentState) {
            if (toolArgs.workdir) updateCwd(sessionKey, toolArgs.workdir);
            
            if (['read_file', 'write_file', 'edit_file', 'apply_patch', 'propose_patch'].includes(toolName) && toolArgs.path) {
                touchRecentFile(sessionKey, toolArgs.path);
            }
            
            if (toolName === 'glob' && toolArgs.pattern) {
                setLastSearchResults(sessionKey, {
                    tool: 'glob',
                    query: toolArgs.pattern,
                    resultCount: observation.fileCount || 0
                });
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
                clearPendingPatch(sessionKey);
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
    
    return { observations };
}

/**
 * Build agent metadata for response
 */
function buildAgentMetadata(state, stopReason) {
    if (!state) return null;
    return {
        mode: state.mode,
        taskStatus: state.taskStatus,
        taskGoal: state.taskGoal,
        stopReason,
        stepsUsed: state.actionHistory?.length || 0,
        progressSummary: state.progressSummary?.slice(-5) || [],
        recentFiles: state.recentFiles?.slice(0, 5) || [],
        pendingPatchId: state.pendingPatchId,
        noProgressCount: state.noProgressCount
    };
}

import { logInfo, logError, logDebug, logWarn } from '../logger/index.js';
import {
    getOrCreateAgentState,
    recordToolAction,
    setPendingPatch,
    clearPendingPatch,
    touchRecentFile,
    setLastSearchResults,
    updateCwd,
    buildAgentRuntimeContext
} from './agentState.js';
import { executeTool, parseToolCallFromText } from '../tools/toolExecutor.js';

const DEFAULT_MAX_STEPS = 5;
const MAX_TOOL_RESULT_CHARS = 2000;

/**
 * Summarize tool output for the model (prevent context overflow)
 */
function summarizeToolResult(toolName, result) {
    if (!result.success) {
        return `Tool ${toolName} failed: ${result.error || 'Unknown error'}`;
    }
    
    const output = result.output || '(no output)';
    const summary = output.length > MAX_TOOL_RESULT_CHARS
        ? output.substring(0, MAX_TOOL_RESULT_CHARS) + `\n... (output truncated, ${output.length} total chars)`
        : output;
    
    return summary;
}

/**
 * Check if the tool call should stop the loop
 */
function shouldStopLoop(toolCalls, step, maxSteps) {
    if (step >= maxSteps) return { stop: true, reason: `Max steps (${maxSteps}) reached` };
    
    for (const tc of toolCalls) {
        const name = tc.name;
        // Stop on propose_patch — user must review
        if (name === 'propose_patch') return { stop: true, reason: 'Patch proposed, awaiting user approval' };
        // Stop on write_file for safety (prefer propose_patch)
        if (name === 'write_file') return { stop: true, reason: 'write_file called, stopping for safety' };
    }
    
    return { stop: false };
}

/**
 * Build the conversation for the next step
 */
function buildNextMessage(toolCalls, toolResults, step) {
    const resultSummaries = toolResults
        .map((r, i) => {
            const tc = toolCalls[i];
            return `Step ${step + 1} — ${tc.name} result:\n${r}`;
        })
        .join('\n\n');
    
    return `Here are the results of your last actions:\n\n${resultSummaries}\n\nContinue with the next step. If the task is complete, say so.`;
}

/**
 * Run the agent orchestration loop.
 * 
 * This replaces the single-step tool execution with a controlled multi-step loop:
 * 1. Send message to model
 * 2. Parse tool calls
 * 3. Execute tools
 * 4. Update agent state
 * 5. Check stop conditions
 * 6. If not stopped, go to step 1 with tool results
 * 
 * @param {Function} sendToModel - Function that sends a message to the model and returns the response
 * @param {Object} options
 * @param {string} options.sessionKey - Session key for agent state
 * @param {string} options.clientWorkdir - Working directory from client
 * @param {number} options.maxSteps - Maximum number of tool execution steps
 * @param {Function} options.onStep - Callback called after each step
 * @returns {Object} Final result
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
        cwd: clientWorkdir
    });
    
    logInfo(`Agent loop started for session: ${sessionKey}, maxSteps: ${maxSteps}`);
    
    let currentMessage = options.initialMessage;
    let allToolCalls = [];
    let allToolResults = [];
    let lastResponse = null;
    let stopped = false;
    let stopReason = '';
    
    for (let step = 0; step < maxSteps; step++) {
        logInfo(`=== Agent loop step ${step + 1}/${maxSteps} ===`);
        
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
                toolResults: allToolResults,
                lastResponse
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
            break;
        }
        
        // Check stop conditions
        const stopCheck = shouldStopLoop(toolCalls, step, maxSteps);
        if (stopCheck.stop) {
            logInfo(`Agent loop stopped: ${stopCheck.reason}`);
            stopped = true;
            stopReason = stopCheck.reason;
            
            // Still execute the tool calls (e.g., propose_patch)
            const toolResults = await executeToolCalls(toolCalls, agentState, sessionKey, clientWorkdir);
            allToolCalls.push(...toolCalls);
            allToolResults.push(...toolResults);
            
            break;
        }
        
        // Execute tool calls
        logInfo(`Executing ${toolCalls.length} tool call(s) at step ${step + 1}`);
        const toolResults = await executeToolCalls(toolCalls, agentState, sessionKey, clientWorkdir);
        
        allToolCalls.push(...toolCalls);
        allToolResults.push(...toolResults);
        
        // Callback for progress reporting
        if (onStep) {
            onStep({
                step: step + 1,
                toolCalls,
                toolResults,
                agentState: {
                    recentFiles: agentState.recentFiles,
                    pendingPatchId: agentState.pendingPatchId,
                    actionHistory: agentState.actionHistory.slice(-3)
                }
            });
        }
        
        // Build next message
        currentMessage = buildNextMessage(toolCalls, toolResults, step);
    }
    
    // If we exited the loop without stopping, it means max steps reached
    if (!stopped) {
        stopped = true;
        stopReason = `Max steps (${maxSteps}) reached`;
    }
    
    logInfo(`Agent loop finished: ${stopped ? stopReason : 'max steps reached'}, ${allToolCalls.length} total tool calls`);
    
    return {
        success: true,
        stopped,
        stopReason,
        steps: allToolCalls.length > 0 ? Math.ceil(allToolCalls.length / 1) : 0,
        toolCalls: allToolCalls,
        toolResults: allToolResults,
        lastResponse,
        agentState: {
            recentFiles: agentState.recentFiles,
            pendingPatchId: agentState.pendingPatchId,
            pendingPatchFile: agentState.pendingPatchFile,
            pendingPatchConfirmed: agentState.pendingPatchConfirmed,
            actionHistory: agentState.actionHistory.slice(-5)
        }
    };
}

/**
 * Execute a batch of tool calls and update agent state
 */
async function executeToolCalls(toolCalls, agentState, sessionKey, clientWorkdir) {
    const results = [];
    
    for (const tc of toolCalls) {
        const toolName = tc.name;
        const toolArgs = tc.arguments || {};
        
        logInfo(`Executing: ${toolName}(${JSON.stringify(toolArgs)})`);
        const result = await executeTool(toolName, toolArgs, clientWorkdir);
        
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
                    resultCount: result.success ? (result.output?.match(/\n/g)?.length || 0) : 0
                });
            }
            if (toolName === 'grep' && toolArgs.pattern) {
                setLastSearchResults(sessionKey, {
                    tool: 'grep',
                    query: toolArgs.pattern,
                    resultCount: result.success ? (result.output?.match(/\n/g)?.length || 0) : 0
                });
            }
            
            if (toolName === 'propose_patch' && result.patch_id) {
                setPendingPatch(sessionKey, result.patch_id, toolArgs.path);
            }
            if (toolName === 'apply_patch' && result.success) {
                clearPendingPatch(sessionKey);
            }
            
            recordToolAction(sessionKey, {
                tool: toolName,
                summary: toolArgs.path || toolArgs.command || toolArgs.pattern || '',
                success: result.success
            });
            
            agentState.lastToolResultSummary = summarizeToolResult(toolName, result).substring(0, 200);
        }
        
        results.push(summarizeToolResult(toolName, result));
    }
    
    return results;
}

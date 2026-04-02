import { logInfo, logError, logDebug } from '../logger/index.js';

// ─── Session agent state storage ─────────────────────────────────────────────
const sessionAgentState = new Map();
const STATE_TTL = 2 * 60 * 60 * 1000; // 2 hours
const MAX_RECENT_FILES = 20;
const MAX_SEARCH_RESULTS = 5;
const MAX_ACTION_HISTORY = 50;

export function getAgentState(sessionKey) {
    const entry = sessionAgentState.get(sessionKey);
    if (!entry) return null;
    if (Date.now() - entry.updatedAt > STATE_TTL) {
        sessionAgentState.delete(sessionKey);
        logDebug(`Agent state expired for session: ${sessionKey}`);
        return null;
    }
    return entry;
}

export function createAgentState({ sessionKey, scope, projectRoot, cwd, taskGoal }) {
    const state = {
        sessionKey,
        scope: scope || null,
        projectRoot: projectRoot || process.cwd(),
        cwd: cwd || projectRoot || process.cwd(),
        recentFiles: [],
        lastReadFiles: [],
        lastSearchResults: [],
        pendingPatchId: null,
        pendingPatchFile: null,
        pendingPatchConfirmed: false,
        actionHistory: [],
        lastToolResultSummary: null,
        
        // Phase 6: goal-aware runtime
        taskGoal: taskGoal || null,
        taskStatus: 'exploring', // exploring | planning | awaiting_approval | done
        taskSummary: null,
        lastDecision: null,
        lastDecisionReason: null,
        noProgressCount: 0,
        mode: 'explore', // explore | analyze | propose | done
        progressSummary: [],
        seenActions: [], // for repeated action detection
        lastObservations: [],
        
        createdAt: Date.now(),
        updatedAt: Date.now()
    };
    sessionAgentState.set(sessionKey, state);
    logInfo(`Agent state created for session: ${sessionKey}, projectRoot: ${state.projectRoot}`);
    return state;
}

export function getOrCreateAgentState({ sessionKey, scope, projectRoot, cwd, taskGoal }) {
    let state = getAgentState(sessionKey);
    if (!state) {
        state = createAgentState({ sessionKey, scope, projectRoot, cwd, taskGoal });
    }
    // Update projectRoot/cwd if provided
    if (projectRoot && state.projectRoot !== projectRoot) {
        state.projectRoot = projectRoot;
        if (!cwd) state.cwd = projectRoot;
    }
    if (cwd) state.cwd = cwd;
    // Update taskGoal if provided and not already set
    if (taskGoal && !state.taskGoal) {
        state.taskGoal = taskGoal;
    }
    state.updatedAt = Date.now();
    return state;
}

export function updateAgentState(sessionKey, patch) {
    const state = sessionAgentState.get(sessionKey);
    if (!state) return null;
    Object.assign(state, patch, { updatedAt: Date.now() });
    return state;
}

export function recordToolAction(sessionKey, action) {
    const state = sessionAgentState.get(sessionKey);
    if (!state) return;
    
    state.actionHistory.push({
        tool: action.tool,
        summary: action.summary || '',
        success: action.success !== false,
        at: Date.now()
    });
    
    // Trim history
    if (state.actionHistory.length > MAX_ACTION_HISTORY) {
        state.actionHistory = state.actionHistory.slice(-MAX_ACTION_HISTORY);
    }
    
    state.updatedAt = Date.now();
}

export function setPendingPatch(sessionKey, patchId, filePath) {
    const state = sessionAgentState.get(sessionKey);
    if (!state) return;
    state.pendingPatchId = patchId;
    state.pendingPatchFile = filePath;
    state.pendingPatchConfirmed = false;
    state.updatedAt = Date.now();
}

export function confirmSessionPatch(sessionKey) {
    const state = sessionAgentState.get(sessionKey);
    if (!state || !state.pendingPatchId) return false;
    state.pendingPatchConfirmed = true;
    state.updatedAt = Date.now();
    return true;
}

export function clearPendingPatch(sessionKey) {
    const state = sessionAgentState.get(sessionKey);
    if (!state) return;
    state.pendingPatchId = null;
    state.pendingPatchFile = null;
    state.pendingPatchConfirmed = false;
    state.updatedAt = Date.now();
}

export function touchRecentFile(sessionKey, filePath) {
    const state = sessionAgentState.get(sessionKey);
    if (!state) return;
    
    // Remove if already present
    state.recentFiles = state.recentFiles.filter(f => f !== filePath);
    state.recentFiles.unshift(filePath);
    state.recentFiles = state.recentFiles.slice(0, MAX_RECENT_FILES);
    
    state.lastReadFiles.push({ path: filePath, at: Date.now() });
    state.lastReadFiles = state.lastReadFiles.slice(-MAX_RECENT_FILES);
    
    state.updatedAt = Date.now();
}

export function setLastSearchResults(sessionKey, payload) {
    const state = sessionAgentState.get(sessionKey);
    if (!state) return;
    
    state.lastSearchResults.push({
        tool: payload.tool || 'grep',
        query: payload.query || '',
        resultCount: payload.resultCount || 0,
        at: Date.now()
    });
    
    state.lastSearchResults = state.lastSearchResults.slice(-MAX_SEARCH_RESULTS);
    state.updatedAt = Date.now();
}

export function updateCwd(sessionKey, newCwd) {
    const state = sessionAgentState.get(sessionKey);
    if (!state || !newCwd) return;
    state.cwd = newCwd;
    state.updatedAt = Date.now();
}

export function resetAgentState(sessionKey) {
    const state = sessionAgentState.get(sessionKey);
    if (!state) return null;
    
    const preserved = { sessionKey, scope: state.scope, projectRoot: state.projectRoot };
    sessionAgentState.delete(sessionKey);
    logInfo(`Agent state reset for session: ${sessionKey}`);
    return preserved;
}

export function cleanupExpiredAgentStates() {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, entry] of sessionAgentState) {
        if (now - entry.updatedAt > STATE_TTL) {
            sessionAgentState.delete(key);
            cleaned++;
        }
    }
    if (cleaned > 0) logDebug(`Cleaned up ${cleaned} expired agent states`);
    return cleaned;
}

// Auto-cleanup every 10 minutes
setInterval(cleanupExpiredAgentStates, 10 * 60 * 1000).unref();

export function getAllSessionKeys() {
    return Array.from(sessionAgentState.keys());
}

export function getAgentStateCount() {
    return sessionAgentState.size;
}

export function buildAgentRuntimeContext(state) {
    if (!state) return '';
    
    const parts = [];
    
    parts.push('RUNTIME CONTEXT:');
    parts.push(`Current project root: ${state.projectRoot}`);
    parts.push(`Current working directory: ${state.cwd}`);
    
    // Phase 6: goal-aware context
    if (state.taskGoal) {
        parts.push(`\nTASK GOAL: ${state.taskGoal}`);
    }
    parts.push(`CURRENT STATUS: ${state.taskStatus}`);
    parts.push(`MODE: ${state.mode}`);
    
    if (state.progressSummary.length > 0) {
        parts.push('\nPROGRESS SUMMARY:');
        state.progressSummary.slice(-5).forEach(p => parts.push(`- ${p}`));
    }
    
    if (state.recentFiles.length > 0) {
        parts.push('\nRecent files:');
        state.recentFiles.slice(0, 10).forEach(f => parts.push(`- ${f}`));
    }
    
    if (state.lastSearchResults.length > 0) {
        parts.push('\nRecent search results:');
        state.lastSearchResults.slice(-3).forEach(s => {
            parts.push(`- ${s.tool} "${s.query}" -> ${s.resultCount} results`);
        });
    }
    
    if (state.pendingPatchId) {
        parts.push(`\nPending patch: ${state.pendingPatchId} for ${state.pendingPatchFile}${state.pendingPatchConfirmed ? ' (confirmed)' : ' (awaiting approval)'}`);
    }
    
    if (state.lastDecision) {
        parts.push(`\nRECENT DECISION: ${state.lastDecision}`);
    }
    
    if (state.noProgressCount > 0) {
        parts.push(`\nNo progress steps: ${state.noProgressCount}`);
    }
    
    if (state.actionHistory.length > 0) {
        parts.push('\nRecent actions:');
        state.actionHistory.slice(-5).forEach(a => {
            parts.push(`- ${a.tool} ${a.summary}${a.success ? '' : ' (failed)'}`);
        });
    }
    
    return parts.join('\n');
}

// ─── Phase 6: Goal-aware agent helpers ───────────────────────────────────────

export function setTaskGoal(sessionKey, goal) {
    const state = sessionAgentState.get(sessionKey);
    if (!state) return;
    state.taskGoal = goal;
    state.taskStatus = 'exploring';
    state.mode = 'explore';
    state.progressSummary = [];
    state.noProgressCount = 0;
    state.seenActions = [];
    state.updatedAt = Date.now();
}

export function updateTaskStatus(sessionKey, status) {
    const state = sessionAgentState.get(sessionKey);
    if (!state) return;
    state.taskStatus = status;
    state.updatedAt = Date.now();
}

export function setAgentMode(sessionKey, mode) {
    const state = sessionAgentState.get(sessionKey);
    if (!state) return;
    state.mode = mode;
    state.updatedAt = Date.now();
}

export function addProgressEntry(sessionKey, entry) {
    const state = sessionAgentState.get(sessionKey);
    if (!state) return;
    state.progressSummary.push(entry);
    state.noProgressCount = 0; // reset on progress
    state.updatedAt = Date.now();
}

export function incrementNoProgress(sessionKey) {
    const state = sessionAgentState.get(sessionKey);
    if (!state) return 0;
    state.noProgressCount++;
    state.updatedAt = Date.now();
    return state.noProgressCount;
}

export function recordSeenAction(sessionKey, toolName, args) {
    const state = sessionAgentState.get(sessionKey);
    if (!state) return false;
    
    const actionKey = `${toolName}:${JSON.stringify(args || {})}`;
    const isRepeated = state.seenActions.includes(actionKey);
    
    state.seenActions.push(actionKey);
    // Keep last 20 actions for detection
    if (state.seenActions.length > 20) {
        state.seenActions = state.seenActions.slice(-20);
    }
    
    state.updatedAt = Date.now();
    return isRepeated;
}

export function setLastDecision(sessionKey, decision, reason) {
    const state = sessionAgentState.get(sessionKey);
    if (!state) return;
    state.lastDecision = decision;
    state.lastDecisionReason = reason;
    state.updatedAt = Date.now();
}

export function addObservation(sessionKey, observation) {
    const state = sessionAgentState.get(sessionKey);
    if (!state) return;
    state.lastObservations.push(observation);
    if (state.lastObservations.length > 5) {
        state.lastObservations = state.lastObservations.slice(-5);
    }
    state.updatedAt = Date.now();
}

// Auto-transition mode based on state
export function autoTransitionMode(sessionKey) {
    const state = sessionAgentState.get(sessionKey);
    if (!state) return state?.mode || 'explore';
    
    // If patch is pending, we're awaiting approval
    if (state.pendingPatchId && !state.pendingPatchConfirmed) {
        state.mode = 'propose';
        state.taskStatus = 'awaiting_approval';
        return state.mode;
    }
    
    // If we've read files and found search results, move to analyze
    if (state.mode === 'explore' && state.lastSearchResults.length > 0 && state.recentFiles.length > 0) {
        state.mode = 'analyze';
        state.taskStatus = 'planning';
    }
    
    // If we've analyzed enough, move to propose
    if (state.mode === 'analyze' && state.recentFiles.length >= 2) {
        state.mode = 'propose';
        state.taskStatus = 'planning';
    }
    
    state.updatedAt = Date.now();
    return state.mode;
}

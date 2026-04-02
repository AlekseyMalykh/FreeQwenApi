import { logInfo, logError, logDebug } from '../logger/index.js';
import crypto from 'crypto';

// ─── Session agent state storage ─────────────────────────────────────────────
const sessionAgentState = new Map();
const STATE_TTL = 2 * 60 * 60 * 1000; // 2 hours
const MAX_RECENT_FILES = 20;
const MAX_SEARCH_RESULTS = 5;
const MAX_ACTION_HISTORY = 50;

/**
 * Resolve or generate a local session key for agent state.
 * 
 * Priority:
 * 1. x-session-key header (explicit local session identity)
 * 2. conversation_id from request body (if it looks like a local ID)
 * 3. Generate new local session key
 * 
 * chatId (upstream Qwen conversation id) is stored separately in state,
 * NOT used as sessionKey.
 */
export function resolveSessionKey(headers, body) {
    // 1. Explicit session key from header (highest priority)
    const headerKey = headers?.['x-session-key'] || headers?.['x-agent-session'];
    if (headerKey && headerKey.trim()) return headerKey.trim();
    
    // 2. conversation_id from body (if it looks like a local ID, not Qwen chatId)
    const conversationId = body?.conversation_id;
    if (conversationId && typeof conversationId === 'string' && conversationId.trim()) {
        // Don't use UUID-like Qwen chatIds as session keys
        if (!conversationId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)) {
            return `conv_${conversationId.trim()}`;
        }
    }
    
    // 3. Generate new local session key
    return `session_${crypto.randomUUID().substring(0, 12)}`;
}

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

export function createAgentState({ sessionKey, scope, projectRoot, cwd, taskGoal, chatId, parentId }) {
    const state = {
        sessionKey,
        scope: scope || null,
        projectRoot: projectRoot || process.cwd(),
        cwd: cwd || projectRoot || process.cwd(),
        
        // Upstream Qwen conversation linkage (separate from local sessionKey)
        chatId: chatId || null,
        parentId: parentId || null,
        
        recentFiles: [],
        lastSearchResults: [],
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
        
        // Patch lifecycle state machine
        patchState: {
            id: null,
            file: null,
            status: 'none', // none | pending | confirmed | rejected | applied
            confirmedAt: null,
            rejectedAt: null,
            appliedAt: null
        },
        
        createdAt: Date.now(),
        updatedAt: Date.now()
    };
    sessionAgentState.set(sessionKey, state);
    logInfo(`Agent state created for session: ${sessionKey}, projectRoot: ${state.projectRoot}`);
    return state;
}

export function getOrCreateAgentState({ sessionKey, scope, projectRoot, cwd, taskGoal, chatId, parentId }) {
    let state = getAgentState(sessionKey);
    if (!state) {
        state = createAgentState({ sessionKey, scope, projectRoot, cwd, taskGoal, chatId, parentId });
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
    // Store upstream Qwen linkage if provided
    if (chatId) state.chatId = chatId;
    if (parentId) state.parentId = parentId;
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

// ─── Patch lifecycle state machine ───────────────────────────────────────────
// States: none -> pending -> (confirmed -> applied) | rejected

export function setPendingPatch(sessionKey, patchId, filePath) {
    const state = sessionAgentState.get(sessionKey);
    if (!state) return;
    state.patchState = {
        id: patchId,
        file: filePath,
        status: 'pending',
        confirmedAt: null,
        rejectedAt: null,
        appliedAt: null
    };
    state.taskStatus = 'awaiting_approval';
    state.mode = 'propose';
    state.updatedAt = Date.now();
}

export function confirmPendingPatch(sessionKey) {
    const state = sessionAgentState.get(sessionKey);
    if (!state || state.patchState.status !== 'pending') return false;
    state.patchState.status = 'confirmed';
    state.patchState.confirmedAt = Date.now();
    state.updatedAt = Date.now();
    return true;
}

export function confirmSessionPatch(sessionKey) {
    return confirmPendingPatch(sessionKey);
}

export function rejectPendingPatch(sessionKey) {
    const state = sessionAgentState.get(sessionKey);
    if (!state) return false;
    // Can only reject if pending or confirmed (not none, not already rejected)
    if (state.patchState.status === 'none' || state.patchState.status === 'rejected') return false;
    state.patchState.status = 'rejected';
    state.patchState.rejectedAt = Date.now();
    state.mode = state.mode === 'propose' ? 'analyze' : state.mode;
    state.taskStatus = state.taskStatus === 'awaiting_approval' ? 'planning' : state.taskStatus;
    state.updatedAt = Date.now();
    return true;
}

export function markPatchApplied(sessionKey) {
    const state = sessionAgentState.get(sessionKey);
    if (!state) return;
    state.patchState.status = 'applied';
    state.patchState.appliedAt = Date.now();
    state.updatedAt = Date.now();
}

export function clearPendingPatch(sessionKey) {
    const state = sessionAgentState.get(sessionKey);
    if (!state) return;
    state.patchState = {
        id: null,
        file: null,
        status: 'none',
        confirmedAt: null,
        rejectedAt: null,
        appliedAt: null
    };
    state.updatedAt = Date.now();
}

export function touchRecentFile(sessionKey, filePath) {
    const state = sessionAgentState.get(sessionKey);
    if (!state) return;
    
    // Remove if already present
    state.recentFiles = state.recentFiles.filter(f => f !== filePath);
    state.recentFiles.unshift(filePath);
    state.recentFiles = state.recentFiles.slice(0, MAX_RECENT_FILES);
    
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
    const MAX_SUMMARY_CHARS = 120;
    const HARD_LIMIT = 500;
    
    // Priority 1: Task goal and status (always first)
    if (state.taskGoal) {
        parts.push(`TASK GOAL: ${state.taskGoal.substring(0, MAX_SUMMARY_CHARS)}`);
    }
    parts.push(`STATUS: ${state.taskStatus}`);
    parts.push(`MODE: ${state.mode}`);
    
    // Priority 2: Location
    parts.push(`PROJECT: ${state.projectRoot}`);
    parts.push(`CWD: ${state.cwd}`);
    
    // Priority 3: Pending patch state (critical for decision making)
    if (state.patchState?.status && state.patchState.status !== 'none') {
        const ps = state.patchState;
        const patchInfo = `PATCH: ${ps.status} (${ps.id?.substring(0, 12) || 'unknown'}) for ${ps.file || 'unknown'}`;
        parts.push(patchInfo);
    }
    
    // Priority 4: Progress summary (concise)
    if (state.progressSummary.length > 0) {
        const recent = state.progressSummary.slice(-3);
        parts.push(`PROGRESS: ${recent.join(' | ').substring(0, MAX_SUMMARY_CHARS)}`);
    }
    
    // Priority 5: Recent decisive observations (limited)
    if (state.lastObservations.length > 0) {
        const recent = state.lastObservations.slice(-2)
            .map(o => o.summary || o.tool || '')
            .filter(Boolean)
            .slice(0, 2);
        if (recent.length > 0) {
            parts.push(`OBSERVATIONS: ${recent.join(' | ').substring(0, MAX_SUMMARY_CHARS)}`);
        }
    }
    
    // Priority 6: Recent files (limited to 3)
    if (state.recentFiles.length > 0) {
        const files = state.recentFiles.slice(0, 3);
        parts.push(`FILES: ${files.join(', ')}`);
    }
    
    // Priority 7: Recent search results (limited to 1)
    if (state.lastSearchResults.length > 0) {
        const searches = state.lastSearchResults.slice(-1)
            .map(s => `${s.tool}("${s.query}")→${s.resultCount}`);
        parts.push(`SEARCHES: ${searches.join(', ')}`);
    }
    
    // Priority 8: Recent decisions
    if (state.lastDecision) {
        parts.push(`LAST DECISION: ${state.lastDecision.substring(0, MAX_SUMMARY_CHARS)}`);
    }
    
    // Priority 9: No progress warning
    if (state.noProgressCount > 0) {
        parts.push(`NO PROGRESS: ${state.noProgressCount} step(s)`);
    }
    
    let result = parts.join('\n');
    // Hard limit: truncate if still too long
    if (result.length > HARD_LIMIT) {
        result = result.substring(0, HARD_LIMIT - 3) + '...';
    }
    
    return result;
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
    if (!state) return 'explore';
    
    // If patch is pending, we're awaiting approval
    if (state.patchState?.status === 'pending') {
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

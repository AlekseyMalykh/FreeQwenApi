import { logDebug } from '../logger/index.js';

const MAX_OBSERVATION_CHARS = 1500;
const MAX_READFILE_LINES = 200;
const MAX_EXCERPT_LINES = 10;

/**
 * Build a structured observation from tool execution result.
 * Replaces raw output truncation with intelligent summaries.
 */
export function buildToolObservation(toolName, toolArgs, result) {
    switch (toolName) {
        case 'grep':
            return buildGrepObservation(toolArgs, result);
        case 'glob':
            return buildGlobObservation(toolArgs, result);
        case 'read_file':
            return buildReadFileObservation(toolArgs, result);
        case 'propose_patch':
            return buildProposePatchObservation(toolArgs, result);
        case 'apply_patch':
            return buildApplyPatchObservation(toolArgs, result);
        case 'bash':
            return buildBashObservation(toolArgs, result);
        default:
            return buildDefaultObservation(toolName, toolArgs, result);
    }
}

function buildGrepObservation(args, result) {
    if (!result.success) {
        return {
            tool: 'grep',
            query: args.pattern,
            success: false,
            error: result.error,
            summary: `grep failed: ${result.error}`
        };
    }
    
    const output = result.output || '';
    const lines = output.split('\n').filter(l => l && !l.startsWith('Found'));
    const matchCount = lines.length;
    
    // Extract unique files
    const files = [...new Set(lines.map(l => l.split(':')[0]).filter(Boolean))];
    
    // Build summary
    let summary = `grep "${args.pattern}" -> ${matchCount} matches in ${files.length} file(s)`;
    if (files.length > 0) {
        summary += `\nFiles: ${files.slice(0, 5).join(', ')}`;
    }
    
    // Key excerpts (first few matches)
    const excerpts = lines.slice(0, 5).map(l => {
        const parts = l.split(':');
        return parts.length >= 3 ? `${parts[0]}:${parts[1]}: ${parts.slice(2).join(':').trim()}` : l;
    });
    
    return {
        tool: 'grep',
        query: args.pattern,
        matchCount,
        files: files.slice(0, 10),
        excerpts,
        summary,
        truncated: output.length > MAX_OBSERVATION_CHARS
    };
}

function buildGlobObservation(args, result) {
    if (!result.success) {
        return {
            tool: 'glob',
            pattern: args.pattern,
            success: false,
            error: result.error,
            summary: `glob failed: ${result.error}`
        };
    }
    
    const output = result.output || '';
    const lines = output.split('\n').filter(l => l && !l.startsWith('Found'));
    const fileCount = lines.length;
    
    let summary = `glob "${args.pattern}" -> ${fileCount} file(s)`;
    if (lines.length > 0) {
        summary += `\n${lines.slice(0, 10).join('\n')}`;
    }
    
    return {
        tool: 'glob',
        pattern: args.pattern,
        fileCount,
        files: lines.slice(0, 10),
        summary,
        truncated: output.length > MAX_OBSERVATION_CHARS
    };
}

function buildReadFileObservation(args, result) {
    if (!result.success) {
        return {
            tool: 'read_file',
            path: args.path,
            success: false,
            error: result.error,
            summary: `read_file failed: ${result.error}`
        };
    }
    
    const output = result.output || '';
    const lines = output.split('\n');
    const totalLines = lines.length;
    
    // Truncate to MAX_READFILE_LINES
    const displayLines = lines.slice(0, MAX_READFILE_LINES);
    const displayContent = displayLines.join('\n');
    
    let summary = `read_file: ${args.path} (${totalLines} lines)`;
    if (totalLines > MAX_READFILE_LINES) {
        summary += ` (showing first ${MAX_READFILE_LINES} lines)`;
    }
    
    return {
        tool: 'read_file',
        path: args.path,
        totalLines,
        displayLines: Math.min(totalLines, MAX_READFILE_LINES),
        content: displayContent,
        summary,
        truncated: totalLines > MAX_READFILE_LINES
    };
}

function buildProposePatchObservation(args, result) {
    if (!result.success) {
        return {
            tool: 'propose_patch',
            path: args.path,
            success: false,
            error: result.error,
            summary: `propose_patch failed: ${result.error}`
        };
    }
    
    return {
        tool: 'propose_patch',
        path: args.path,
        patchId: result.patch_id,
        summary: result.output || `Patch proposed for ${args.path}`,
        diffPreview: result.diff_preview || '',
        awaitingApproval: true
    };
}

function buildApplyPatchObservation(args, result) {
    if (!result.success) {
        return {
            tool: 'apply_patch',
            patchId: args.patch_id,
            success: false,
            error: result.error,
            summary: `apply_patch failed: ${result.error}`
        };
    }
    
    return {
        tool: 'apply_patch',
        patchId: args.patch_id,
        summary: result.output || 'Patch applied successfully',
        success: true
    };
}

function buildBashObservation(args, result) {
    if (!result.success) {
        return {
            tool: 'bash',
            command: args.command,
            success: false,
            error: result.error,
            summary: `bash failed: ${result.error}`
        };
    }
    
    const output = result.output || '';
    const truncated = output.length > MAX_OBSERVATION_CHARS;
    const displayOutput = truncated
        ? output.substring(0, MAX_OBSERVATION_CHARS) + '\n... (output truncated)'
        : output;
    
    return {
        tool: 'bash',
        command: args.command,
        output: displayOutput,
        summary: output.split('\n').slice(0, 10).join('\n') || '(no output)',
        truncated
    };
}

function buildDefaultObservation(toolName, args, result) {
    const output = result.output || result.error || '';
    const truncated = output.length > MAX_OBSERVATION_CHARS;
    
    return {
        tool: toolName,
        args,
        success: result.success,
        summary: output.substring(0, MAX_OBSERVATION_CHARS) + (truncated ? '...' : ''),
        truncated
    };
}

/**
 * Detect if an action is repeated (same tool + same args)
 */
export function isRepeatedAction(seenActions, toolName, args) {
    const actionKey = `${toolName}:${JSON.stringify(args || {})}`;
    return seenActions.includes(actionKey);
}

/**
 * Check if there was meaningful progress from this step
 */
export function hasProgress(state, toolName, observation) {
    if (!observation || !observation.success) return false;
    
    // New file read = progress
    if (toolName === 'read_file' && observation.path) {
        return !state.recentFiles.includes(observation.path);
    }
    
    // New search results = progress
    if ((toolName === 'grep' || toolName === 'glob') && observation.matchCount > 0) {
        return true;
    }
    
    // Patch proposed = progress
    if (toolName === 'propose_patch' && observation.patchId) {
        return true;
    }
    
    // Patch applied = progress
    if (toolName === 'apply_patch' && observation.success) {
        return true;
    }
    
    return false;
}

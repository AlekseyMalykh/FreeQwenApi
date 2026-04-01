function normalizeToolName(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/[\s-]+/g, '_');
}

export function normalizeToolCall(toolCall, index = 0) {
    if (!toolCall) return null;

    return {
        id: toolCall.id || `call_${Date.now()}_${index}`,
        type: 'function',
        function: {
            name: toolCall.function?.name || '',
            arguments: toolCall.function?.arguments || '{}'
        }
    };
}

export function createAssistantMessage(content, toolCalls = []) {
    return {
        role: 'assistant',
        content: toolCalls.length > 0 ? '' : (content || ''),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
    };
}

export function inferToolCallsFromContent(content, tools = []) {
    if (typeof content !== 'string' || !Array.isArray(tools) || tools.length === 0) {
        return [];
    }

    const trimmed = content.trim();
    if (!trimmed) {
        return [];
    }

    const toolNames = tools
        .map(tool => tool?.function?.name)
        .filter(Boolean);

    if (toolNames.length === 0) {
        return [];
    }

    const readToolName = toolNames.find(name =>
        ['read_file', 'readfile', 'open_file', 'openfile', 'view', 'cat_file'].includes(
            normalizeToolName(name)
        )
    );

    if (!readToolName) {
        return [];
    }

    const makeReadCall = (filePath) => {
        const cleanPath = String(filePath || '')
            .trim()
            .replace(/^['"`]+|['"`]+$/g, '');

        if (!cleanPath) {
            return [];
        }

        return [{
            id: `call_${Date.now()}_0`,
            type: 'function',
            function: {
                name: readToolName,
                arguments: JSON.stringify({ path: cleanPath })
            }
        }];
    };

    const commandPatterns = [
        /^cat\s+(.+)$/i,
        /^type\s+(.+)$/i,
        /^get-content\s+(.+)$/i,
        /^read-file\s+(.+)$/i,
        /^read_file\s+(.+)$/i,
        /^open\s+(.+)$/i,
        /^view\s+(.+)$/i
    ];

    for (const pattern of commandPatterns) {
        const match = trimmed.match(pattern);
        if (match?.[1]) {
            return makeReadCall(match[1]);
        }
    }

    const fencedCodeMatch = trimmed.match(/^(?:```[a-zA-Z0-9_-]*\n)?([^\n]+)(?:\n```)?$/s);
    const singleLineCandidate = fencedCodeMatch?.[1]?.trim() || trimmed;

    const windowsPathMatch = singleLineCandidate.match(/^[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]+$/);
    if (windowsPathMatch) {
        return makeReadCall(windowsPathMatch[0]);
    }

    const unixPathMatch = singleLineCandidate.match(/^(?:\.{1,2}\/|\/)[^\0\r\n]+$/);
    if (unixPathMatch) {
        return makeReadCall(unixPathMatch[0]);
    }

    const likelyRelativeFileMatch = singleLineCandidate.match(/^(?:\.\/)?(?:[^\/\r\n\t]+\/)*[^\/\r\n\t]+\.[A-Za-z0-9._-]+$/);
    if (likelyRelativeFileMatch) {
        return makeReadCall(likelyRelativeFileMatch[0]);
    }

    const quotedPathMatch = trimmed.match(/["'`](.+?\.(?:json|txt|md|py|js|ts|tsx|jsx|yaml|yml|ini|toml|log|csv|xml))["'`]/i);
    if (quotedPathMatch?.[1]) {
        return makeReadCall(quotedPathMatch[1]);
    }

    const readmeIntentPatterns = [
        /\bREADME(?:\.md)?\b/i,
        /\breadme\b/i,
        /\bopen\s+readme\b/i,
        /\bоткрой\s+readme\b/i,
        /\bпокажи\s+readme\b/i,
        /\bпрочитай\s+readme\b/i
    ];

    if (readmeIntentPatterns.some(pattern => pattern.test(trimmed))) {
        return makeReadCall('README.md');
    }

    return [];
}

export function resolveToolCalls(content, structured, payload) {
    const normalized = (structured || [])
        .map((toolCall, index) => normalizeToolCall(toolCall, index))
        .filter(Boolean);

    if (normalized.length > 0) {
        return normalized;
    }

    return inferToolCallsFromContent(
        content,
        payload?._inferenceTools || payload?.tools || []
    );
}
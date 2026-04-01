import crypto from 'crypto';
import { getProviderCapabilities } from './capabilities.js';

export function flattenConversationForQwen(messages = [], systemMessage = null) {
    const parts = [];

    if (systemMessage && typeof systemMessage === 'string' && systemMessage.trim()) {
        parts.push(`[SYSTEM]\n${systemMessage.trim()}`);
    }

    for (const msg of Array.isArray(messages) ? messages : []) {
        if (!msg || typeof msg !== 'object') continue;

        const role = msg.role || 'user';
        let text = '';

        if (typeof msg.content === 'string') {
            text = msg.content.trim();
        } else if (Array.isArray(msg.content)) {
            text = msg.content
                .map(part => {
                    if (typeof part === 'string') return part;
                    if (part?.type === 'text' && typeof part.text === 'string') return part.text;
                    return '';
                })
                .filter(Boolean)
                .join('\n')
                .trim();
        } else if (msg.content != null) {
            try {
                text = JSON.stringify(msg.content, null, 2);
            } catch {
                text = String(msg.content);
            }
        }

        if (role === 'tool') {
            const toolName = msg.name || 'tool';
            parts.push(`[TOOL:${toolName}]\n${text}`);
            continue;
        }

        if (role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
            const toolCallsText = msg.tool_calls
                .map(tc => {
                    const fnName = tc?.function?.name || 'unknown_tool';
                    const fnArgs = tc?.function?.arguments || '{}';
                    return `Tool call: ${fnName}(${fnArgs})`;
                })
                .join('\n');

            parts.push(text ? `[ASSISTANT]\n${text}\n${toolCallsText}` : `[ASSISTANT]\n${toolCallsText}`);
            continue;
        }

        parts.push(`[${String(role).toUpperCase()}]\n${text}`);
    }

    return parts.filter(Boolean).join('\n\n');
}

export function buildProviderPayload({
    messageContent,
    model,
    chatId,
    parentId,
    files,
    systemMessage,
    tools,
    toolChoice,
    chatType = 't2t',
    size = null,
    provider = 'freeqwen'
}) {
    const caps = getProviderCapabilities(model, provider);

    const userMessageId = crypto.randomUUID();
    const assistantChildId = crypto.randomUUID();
    const isVideo = chatType === 't2v';

    const featureConfig = {
        thinking_enabled: isVideo,
        output_schema: 'phase'
    };

    if (isVideo) {
        featureConfig.research_mode = 'normal';
        featureConfig.auto_thinking = true;
        featureConfig.thinking_format = 'summary';
        featureConfig.auto_search = true;
    }

    const isConversationPayload =
        messageContent &&
        typeof messageContent === 'object' &&
        messageContent.__conversation === true;

    let content = messageContent;

    if (caps.requiresConversationFlattening && isConversationPayload) {
        content = flattenConversationForQwen(messageContent.messages, systemMessage);
    }

    const message = {
        fid: userMessageId,
        parentId,
        parent_id: parentId,
        role: 'user',
        content,
        chat_type: chatType,
        sub_chat_type: chatType,
        timestamp: Math.floor(Date.now() / 1000),
        user_action: 'chat',
        models: [model],
        files: files || [],
        childrenIds: [assistantChildId],
        extra: { meta: { subChatType: chatType } },
        feature_config: featureConfig
    };

    const payload = {
        stream: !isVideo,
        incremental_output: true,
        chat_id: chatId,
        chat_mode: 'normal',
        messages: [message],
        model,
        parent_id: parentId,
        timestamp: Math.floor(Date.now() / 1000),
        _caps: caps,
        _inferenceTools: Array.isArray(tools) ? tools : []
    };

    if (size) {
        payload.size = size;
    }

    if (systemMessage && !caps.requiresConversationFlattening) {
        payload.system_message = systemMessage;
    }

    if (caps.supportsNativeTools && Array.isArray(tools) && tools.length > 0) {
        payload.tools = tools;

        if (!caps.shouldAvoidToolChoice) {
            payload.tool_choice = toolChoice || 'auto';
        }
    }

    return payload;
}
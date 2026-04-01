export function getProviderCapabilities(model, provider = 'freeqwen') {
    const normalized = String(model || '').toLowerCase();
    const isQwen = normalized.includes('qwen');

    if (provider === 'freeqwen' || isQwen) {
        return {
            provider: 'freeqwen',
            supportsNativeTools: false,
            supportsOpenAIConversationRoles: false,
            supportsSystemMessagePassthrough: true,
            requiresConversationFlattening: true,
            useLocalToolInference: true,
            shouldAvoidToolChoice: true
        };
    }

    return {
        provider: 'openai-compatible',
        supportsNativeTools: true,
        supportsOpenAIConversationRoles: true,
        supportsSystemMessagePassthrough: true,
        requiresConversationFlattening: false,
        useLocalToolInference: false,
        shouldAvoidToolChoice: false
    };
}
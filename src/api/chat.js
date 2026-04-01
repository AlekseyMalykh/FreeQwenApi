import { getBrowserContext, getAuthenticationStatus, setAuthenticationStatus } from '../browser/browser.js';
import { checkAuthentication, checkVerification } from '../browser/auth.js';
import { shutdownBrowser, initBrowser } from '../browser/browser.js';
import { saveAuthToken } from '../browser/session.js';
import { getAvailableToken, markRateLimited, removeInvalidToken } from './tokenManager.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logInfo, logError, logWarn, logDebug, logRaw } from '../logger/index.js';
import crypto from 'crypto';
import {
    CHAT_API_URL, CREATE_CHAT_URL, CHAT_PAGE_URL, TASK_STATUS_URL,
    PAGE_TIMEOUT, RETRY_DELAY, PAGE_POOL_SIZE,
    DEFAULT_MODEL, MAX_RETRY_COUNT,
    TASK_POLL_MAX_ATTEMPTS, TASK_POLL_INTERVAL
} from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MODELS_FILE = path.join(__dirname, '..', 'AvailableModels.txt');
const AUTH_KEYS_FILE = path.join(__dirname, '..', 'Authorization.txt');

let authToken = null;
let availableModels = null;
let authKeys = null;
let browserTokenRateLimited = false;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

import { buildProviderPayload } from '../providers/request-adapter.js';
import {
    createAssistantMessage,
    resolveToolCalls
} from '../providers/response-adapter.js';
import {
    executeTool,
    parseToolCallFromText,
    buildToolSystemPrompt
} from '../tools/toolExecutor.js';

// ─── Page helpers ────────────────────────────────────────────────────────────

async function getPage(context) {
    if (context && typeof context.newPage === 'function') {
        return await context.newPage();
    }

    if (context && typeof context.goto === 'function') {
        // Если передана Puppeteer Page, не переиспользуем её как рабочую:
        // создаём отдельную вкладку из того же браузера, чтобы избежать гонок
        // и случайного закрытия базовой страницы.
        if (typeof context.browser === 'function') {
            try {
                const browser = context.browser();
                if (browser && typeof browser.newPage === 'function') {
                    return await browser.newPage();
                }
            } catch (error) {
                logWarn(`Не удалось создать новую страницу из текущего контекста: ${error.message}`);
            }
        }

        if (typeof context.isClosed === 'function' && context.isClosed()) {
            throw new Error('Базовая страница браузера закрыта');
        }

        return context;
    }

    throw new Error('Неверный контекст: не страница Puppeteer, не контекст Playwright');
}

export const pagePool = {
    pages: [],
    maxSize: PAGE_POOL_SIZE,

    async getPage(context) {
        const baseContext = getBrowserContext();
        while (this.pages.length > 0) {
            const page = this.pages.pop();
            try {
                if (page === baseContext) {
                    logWarn('Базовая страница не должна быть в пуле, пропускаем');
                    continue;
                }
                if (page.isClosed()) {
                    logWarn('Страница из пула закрыта, пропускаем');
                    continue;
                }
                await page.evaluate(() => document.readyState);
                return page;
            } catch (e) {
                logWarn(`Страница из пула протухла (${e.message?.substring(0, 60)}), создаём новую`);
                if (page !== baseContext) {
                    try { await page.close(); } catch { /* already dead */ }
                }
            }
        }

        const newPage = await getPage(context);
        await newPage.goto(CHAT_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });

        if (!authToken) {
            try {
                authToken = await newPage.evaluate(() => localStorage.getItem('token'));
                logInfo('Токен авторизации получен из браузера');
                if (authToken) {
                    saveAuthToken(authToken);
                }
            } catch (e) {
                logError('Ошибка при получении токена авторизации', e);
            }
        }

        return newPage;
    },

    releasePage(page) {
        try {
            if (page.isClosed()) return;
        } catch { return; }

        const baseContext = getBrowserContext();
        if (page === baseContext) {
            // Базовую страницу держим отдельно от пула.
            return;
        }

        if (this.pages.length < this.maxSize) {
            this.pages.push(page);
        } else {
            page.close().catch(e => logError('Ошибка при закрытии страницы', e));
        }
    },

    async clear() {
        const baseContext = getBrowserContext();
        for (const page of this.pages) {
            if (page === baseContext) continue;
            try { await page.close(); } catch (e) {
                logError('Ошибка при закрытии страницы в пуле', e);
            }
        }
        this.pages = [];
    }
};

// ─── Task polling ────────────────────────────────────────────────────────────

export async function pollTaskStatus(taskId, page, token, maxAttempts = TASK_POLL_MAX_ATTEMPTS, interval = TASK_POLL_INTERVAL) {
    logInfo(`Начинаем опрос статуса задачи: ${taskId}`);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const statusUrl = `${TASK_STATUS_URL}/${taskId}`;

            const result = await page.evaluate(async (data) => {
                try {
                    const response = await fetch(data.url, {
                        method: 'GET',
                        headers: {
                            'Authorization': `Bearer ${data.token}`,
                            'Accept': 'application/json'
                        }
                    });
                    if (!response.ok) {
                        return { success: false, status: response.status, error: await response.text() };
                    }
                    return { success: true, data: await response.json() };
                } catch (e) {
                    return { success: false, error: e.toString() };
                }
            }, { url: statusUrl, token });

            if (!result.success) {
                logWarn(`Ошибка при проверке статуса (попытка ${attempt}/${maxAttempts}): ${result.error}`);
                if (attempt < maxAttempts) await delay(interval);
                continue;
            }

            const taskData = result.data;
            const taskStatus = taskData.task_status || taskData.status || 'unknown';
            logDebug(`Статус задачи (${attempt}/${maxAttempts}): ${taskStatus}`);

            if (taskStatus === 'completed' || taskStatus === 'success') {
                logInfo('Задача завершена успешно');
                return { success: true, status: 'completed', data: taskData };
            }

            if (taskStatus === 'failed' || taskStatus === 'error') {
                logError('Задача завершилась с ошибкой');
                return { success: false, status: 'failed', error: taskData.error || taskData.message || 'Task failed', data: taskData };
            }

            if (attempt < maxAttempts) await delay(interval);
        } catch (error) {
            logError(`Ошибка при опросе задачи (попытка ${attempt}/${maxAttempts})`, error);
            if (attempt < maxAttempts) await delay(interval);
        }
    }

    logError(`Превышен лимит попыток (${maxAttempts}) для задачи ${taskId}`);
    return { success: false, status: 'timeout', error: 'Task polling timeout exceeded' };
}

// ─── Token extraction ────────────────────────────────────────────────────────

export async function extractAuthToken(context, forceRefresh = false) {
    if (authToken && !forceRefresh) return authToken;

    try {
        const page = await getPage(context);
        const shouldClosePage = page !== context;
        try {
            await page.goto(CHAT_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
            await delay(RETRY_DELAY);

            const newToken = await page.evaluate(() => localStorage.getItem('token'));
            if (shouldClosePage) await page.close();

            if (newToken) {
                authToken = newToken;
                logInfo('Токен авторизации успешно извлечен');
                saveAuthToken(authToken);
                return authToken;
            }
            logError('Токен авторизации не найден в браузере');
            return null;
        } catch (error) {
            if (shouldClosePage) await page.close().catch(() => {});
            throw error;
        }
    } catch (error) {
        logError('Ошибка при извлечении токена авторизации', error);
        return null;
    }
}

// ─── Models & keys from files ────────────────────────────────────────────────

export function getAvailableModelsFromFile() {
    try {
        if (!fs.existsSync(MODELS_FILE)) {
            logError(`Файл с моделями не найден: ${MODELS_FILE}`);
            return [DEFAULT_MODEL];
        }
        const models = fs.readFileSync(MODELS_FILE, 'utf8')
            .split('\n')
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#'));

        logInfo('===== ДОСТУПНЫЕ МОДЕЛИ =====');
        models.forEach(m => logInfo(`- ${m}`));
        logInfo('============================');
        return models;
    } catch (error) {
        logError('Ошибка при чтении файла с моделями', error);
        return [DEFAULT_MODEL];
    }
}

function getAuthKeysFromFile() {
    try {
        if (!fs.existsSync(AUTH_KEYS_FILE)) {
            const template = `# Файл API-ключей для прокси\n# --------------------------------------------\n# В этом файле перечислены токены, которые\n# прокси будет считать «действительными».\n# Один ключ — одна строка без пробелов.\n#\n# 1) Хотите ОТКЛЮЧИТЬ авторизацию целиком?\n#    Оставьте файл пустым — сервер перестанет\n#    проверять заголовок Authorization.\n#\n# 2) Хотите разрешить доступ нескольким людям?\n#    Впишите каждый ключ в отдельной строке:\n#      d35ab3e1-a6f9-4d...\n#      f2b1cd9c-1b2e-4a...\n#\n# Пустые строки и строки, начинающиеся с «#»,\n# игнорируются.`;
            try {
                fs.writeFileSync(AUTH_KEYS_FILE, template, { encoding: 'utf8', flag: 'wx' });
                logInfo(`Создан шаблон файла ключей: ${AUTH_KEYS_FILE}`);
            } catch (e) {
                logError('Не удалось создать шаблон Authorization.txt', e);
            }
            return [];
        }
        return fs.readFileSync(AUTH_KEYS_FILE, 'utf8')
            .split('\n')
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#'));
    } catch (error) {
        logError('Ошибка при чтении файла с ключами авторизации', error);
        return [];
    }
}

export function isValidModel(modelName) {
    if (!availableModels) availableModels = getAvailableModelsFromFile();
    return availableModels.includes(modelName);
}

export function getAllModels() {
    if (!availableModels) availableModels = getAvailableModelsFromFile();
    return {
        models: availableModels.map(model => ({
            id: model,
            name: model,
            description: `Модель ${model}`
        }))
    };
}

export function getApiKeys() {
    if (!authKeys) authKeys = getAuthKeysFromFile();
    return authKeys;
}

// ─── sendMessage — helper functions ──────────────────────────────────────────

function validateAndPrepareMessage(message) {
    if (message === null || message === undefined) {
        return { error: 'Сообщение не может быть пустым' };
    }
    if (typeof message === 'string') return { content: message };
    if (message && typeof message === 'object' && message.__conversation === true && Array.isArray(message.messages)) {
        return { content: message };
    }
    if (Array.isArray(message)) {
        const isValid = message.every(item =>
            (item.type === 'text' && typeof item.text === 'string') ||
            (item.type === 'image' && typeof item.image === 'string') ||
            (item.type === 'file' && typeof item.file === 'string')
        );
        if (!isValid) return { error: 'Некорректная структура составного сообщения' };
        return { content: message };
    }
    return { error: 'Неподдерживаемый формат сообщения' };
}

async function resolveAuthToken(browserContext) {
    const tokenObj = await getAvailableToken();
    if (tokenObj && tokenObj.token) {
        authToken = tokenObj.token;
        logInfo(`Используется аккаунт: ${tokenObj.id}`);
        return tokenObj;
    }

    if (browserTokenRateLimited) {
        logWarn('Browser-токен залимичен, пропускаем fallback');
        return null;
    }

    if (!getAuthenticationStatus()) {
        logInfo('Проверка авторизации...');
        const authCheck = await checkAuthentication(browserContext);
        if (!authCheck) return null;
    }

    if (!authToken) {
        logInfo('Получение токена авторизации...');
        authToken = await extractAuthToken(browserContext);
    }

    return authToken ? { id: 'browser', token: authToken } : null;
}




function parseNonSseCompletionBody(body, payload = null) {
    const isErrorCode = (code) => {
        if (code === null || code === undefined || code === '') return false;

        if (typeof code === 'number') {
            return code >= 400;
        }

        if (typeof code === 'string') {
            const normalized = code.trim().toLowerCase();

            if (!normalized) return false;

            if (normalized === 'ratelimited') return true;
            if (normalized === 'error') return true;
            if (normalized === 'failed') return true;
            if (normalized === 'forbidden') return true;
            if (normalized === 'unauthorized') return true;
            if (normalized === 'invalid_request') return true;

            if (/^\d+$/.test(normalized)) {
                return Number(normalized) >= 400;
            }

            return false;
        }

        return false;
    };

    try {
        const parsed = JSON.parse(body);

        const topLevelCode = parsed?.code;
        const nestedCode = parsed?.data?.code;

        const explicitError =
            parsed?.success === false ||
            Boolean(parsed?.error) ||
            Boolean(parsed?.data?.error) ||
            isErrorCode(topLevelCode) ||
            isErrorCode(nestedCode);

        if (explicitError) {
            const isRateLimited =
                String(topLevelCode).toLowerCase() === 'ratelimited' ||
                String(nestedCode).toLowerCase() === 'ratelimited' ||
                topLevelCode === 429 ||
                nestedCode === 429 ||
                String(topLevelCode) === '429' ||
                String(nestedCode) === '429';

            return {
                success: false,
                status: isRateLimited ? 429 : 500,
                error:
                    parsed?.error ||
                    parsed?.data?.error ||
                    parsed?.message ||
                    parsed?.data?.message ||
                    `Structured API error (code: ${topLevelCode ?? nestedCode ?? 'unknown'})`,
                errorBody: body
            };
        }

        const candidate =
            (parsed?.choices || parsed?.id || parsed?.response_id)
                ? parsed
                : (parsed?.success === true && parsed?.data ? parsed.data : parsed);

        if (candidate && typeof candidate === 'object' && (candidate?.choices || candidate?.id || candidate?.response_id)) {
            const choice = candidate?.choices?.[0] || {};
            const originalMessage = choice?.message || {};

            const messageContent =
                typeof originalMessage?.content === 'string'
                    ? originalMessage.content
                    : '';

            let finalToolCalls = [];

            try {
                finalToolCalls = resolveToolCalls(
                    messageContent,
                    Array.isArray(originalMessage.tool_calls) ? originalMessage.tool_calls : [],
                    payload
                );
            } catch (e) {
                return {
                    success: false,
                    error: e?.message || String(e),
                    details: e?.stack || null,
                    stage: 'parseNonSseCompletionBody:tool_processing',
                    errorBody: body
                };
            }

            let assistantMessage;
            try {
                assistantMessage = createAssistantMessage(messageContent, finalToolCalls);
            } catch (e) {
                return {
                    success: false,
                    error: e?.message || String(e),
                    details: e?.stack || null,
                    stage: 'parseNonSseCompletionBody:createAssistantMessage',
                    errorBody: body
                };
            }

            if (Array.isArray(candidate.choices) && candidate.choices[0]) {
                candidate.choices[0].message = assistantMessage;
                candidate.choices[0].finish_reason =
                    finalToolCalls.length > 0
                        ? 'tool_calls'
                        : (choice.finish_reason || 'stop');
            } else {
                candidate.choices = [
                    {
                        index: 0,
                        message: assistantMessage,
                        finish_reason: finalToolCalls.length > 0 ? 'tool_calls' : 'stop'
                    }
                ];
            }

            if (!candidate.object) {
                candidate.object = 'chat.completion';
            }

            if (!candidate.created) {
                candidate.created = Math.floor(Date.now() / 1000);
            }

            if (!candidate.model && payload?.model) {
                candidate.model = payload.model;
            }

            if (!candidate.usage) {
                candidate.usage = {
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    total_tokens: 0
                };
            }

            return {
                success: true,
                isTask: false,
                data: candidate
            };
        }

        return {
            success: false,
            error: 'Unexpected non-SSE 200 response structure',
            errorBody: body
        };
    } catch (e) {
        return {
            success: false,
            error: e?.message || 'Failed to parse non-SSE response as JSON',
            details: e?.stack || null,
            errorBody: body
        };
    }
}

async function executeApiRequestWithNodeStreaming(apiUrl, payload, token, onChunk) {
    try {
        if (!token) {
            return { success: false, error: 'Токен авторизации не найден' };
        }

        if (typeof fetch !== 'function') {
            return { success: false, error: 'Fetch API is unavailable' };
        }

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                'Accept': '*/*'
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorBody = await response.text();
            return {
                success: false,
                status: response.status,
                statusText: response.statusText,
                errorBody
            };
        }

        if (payload.stream === false) {
            const body = await response.text();
            const parsedResponse = parseNonSseCompletionBody(body, payload);

            if (parsedResponse && typeof parsedResponse === 'object') {
                if (parsedResponse.success) {
                    return parsedResponse;
                }
            } else {
                return {
                    success: false,
                    error: 'parseNonSseCompletionBody returned invalid result',
                    details: String(parsedResponse)
                };
            }

            try {
                const jsonResponse = JSON.parse(body);

                if (jsonResponse.code === 'RateLimited' || jsonResponse.error) {
                    return {
                        success: false,
                        status: 429,
                        errorBody: JSON.stringify(jsonResponse)
                    };
                }

                return {
                    success: true,
                    isTask: true,
                    data: jsonResponse
                };
            } catch (e) {
                return {
                    success: false,
                    error: e?.message || 'Failed to parse non-stream response',
                    details: body
                };
            }
        }

        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('text/event-stream')) {
            const body = await response.text();
            const parsed = parseNonSseCompletionBody(body, payload);

            if (parsed && typeof parsed === 'object') {
                return parsed;
            }

            return {
                success: false,
                error: 'parseNonSseCompletionBody returned invalid result',
                details: String(parsed)
            };
        }

        const reader = response.body?.getReader?.();
        if (!reader) {
            const body = await response.text();
            const parsed = parseNonSseCompletionBody(body, payload);

            if (parsed && typeof parsed === 'object') {
                return parsed;
            }

            return {
                success: false,
                error: 'parseNonSseCompletionBody returned invalid result',
                details: String(parsed)
            };
        }

        const decoder = new TextDecoder();
        let buffer = '';
        let fullContent = '';
        let responseId = null;
        let usage = null;
        let finished = false;
        let streamError = null;
        let hasStreamedChunks = false;
        const collectedToolCalls = [];

        const supportsNativeTools = Boolean(payload?._caps?.supportsNativeTools);
        const useLocalToolInference = Boolean(payload?._caps?.useLocalToolInference);

        while (!finished) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const rawLine of lines) {
                const line = rawLine.trim();
                if (!line || !line.startsWith('data:')) continue;

                const jsonStr = line.substring(5).trim();
                if (!jsonStr) continue;

                if (jsonStr === '[DONE]') {
                    finished = true;
                    break;
                }

                try {
                    const chunk = JSON.parse(jsonStr);

                    if (chunk.code === 'RateLimited' || (chunk.code && chunk.detail)) {
                        streamError = {
                            status: 429,
                            errorBody: JSON.stringify(chunk)
                        };
                        finished = true;
                        break;
                    }

                    if (chunk.error && !chunk.choices) {
                        streamError = {
                            status: 500,
                            errorBody: JSON.stringify(chunk)
                        };
                        finished = true;
                        break;
                    }

                    if (chunk['response.created']) {
                        responseId = chunk['response.created'].response_id;
                    }

                    if (chunk.response_id) {
                        responseId = chunk.response_id;
                    }

                    if (chunk.usage) {
                        usage = chunk.usage;
                    }

                    if (chunk.choices && chunk.choices[0]) {
                        const choice = chunk.choices[0];
                        const delta = choice.delta || {};

                        if (typeof delta.content === 'string' && delta.content.length > 0) {
                            fullContent += delta.content;

                            const shouldStreamTextImmediately =
                                supportsNativeTools || !useLocalToolInference;

                            if (shouldStreamTextImmediately && typeof onChunk === 'function') {
                                onChunk(delta.content);
                                hasStreamedChunks = true;
                            }
                        }

                        if (Array.isArray(delta.tool_calls)) {
                            for (const toolCallDelta of delta.tool_calls) {
                                const index = toolCallDelta.index ?? 0;

                                if (!collectedToolCalls[index]) {
                                    collectedToolCalls[index] = {
                                        id: toolCallDelta.id || `call_${Date.now()}_${index}`,
                                        type: toolCallDelta.type || 'function',
                                        function: {
                                            name: toolCallDelta.function?.name || '',
                                            arguments: toolCallDelta.function?.arguments || ''
                                        }
                                    };
                                } else {
                                    if (toolCallDelta.id) {
                                        collectedToolCalls[index].id = toolCallDelta.id;
                                    }

                                    if (toolCallDelta.type) {
                                        collectedToolCalls[index].type = toolCallDelta.type;
                                    }

                                    if (toolCallDelta.function?.name) {
                                        collectedToolCalls[index].function.name += toolCallDelta.function.name;
                                    }

                                    if (toolCallDelta.function?.arguments) {
                                        collectedToolCalls[index].function.arguments += toolCallDelta.function.arguments;
                                    }
                                }
                            }
                        }

                        const finishReason = choice.finish_reason;
                        if (
                            finishReason === 'stop' ||
                            finishReason === 'tool_calls' ||
                            finishReason === 'length'
                        ) {
                            finished = true;
                        }

                        if (delta.status === 'finished') {
                            finished = true;
                        }
                    }
                } catch (e) {
                    logDebug(`Broken SSE chunk: ${jsonStr}`);
                    logDebug(`Chunk parse error: ${e?.message || String(e)}`);
                }
            }
        }

        if (streamError) {
            return {
                success: false,
                ...streamError,
                hasStreamedChunks
            };
        }

        let finalToolCalls = [];
        let assistantMessage;

        try {
            finalToolCalls = resolveToolCalls(
                fullContent,
                collectedToolCalls,
                payload
            );

            assistantMessage = createAssistantMessage(
                fullContent,
                finalToolCalls
            );
        } catch (e) {
            return {
                success: false,
                error: e?.message || String(e),
                details: e?.stack || null,
                stage: 'finalize_response'
            };
        }

        if (
            finalToolCalls.length === 0 &&
            fullContent &&
            typeof onChunk === 'function' &&
            !hasStreamedChunks
        ) {
            onChunk(fullContent);
            hasStreamedChunks = true;
        }

        return {
            success: true,
            isTask: false,
            hasStreamedChunks,
            data: {
                id: responseId || 'chatcmpl-' + Date.now(),
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: payload.model,
                choices: [
                    {
                        index: 0,
                        message: assistantMessage,
                        finish_reason: finalToolCalls.length > 0 ? 'tool_calls' : 'stop'
                    }
                ],
                usage: usage || {
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    total_tokens: 0
                },
                response_id: responseId
            }
        };
    } catch (error) {
        return {
            success: false,
            error: error?.message || String(error),
            details: error?.stack || null
        };
    }
}

async function executeApiRequest(page, apiUrl, payload, token, onChunk = null) {
    if (payload?.stream !== false && typeof onChunk === 'function') {
        const streamedResponse = await executeApiRequestWithNodeStreaming(apiUrl, payload, token, onChunk);

        const canReturnDirectly =
            streamedResponse.success ||
            Boolean(streamedResponse.status) ||
            Boolean(streamedResponse.errorBody) ||
            streamedResponse.hasStreamedChunks === true;

        if (canReturnDirectly) {
            return streamedResponse;
        }

        logWarn(`Node-streaming недоступен (${streamedResponse.error || 'unknown error'}), fallback к browser fetch.`);
    }

    const requestBody = { apiUrl, payload, token };

    logDebug(`Используем токен: ${token ? 'Токен существует' : 'Токен отсутствует'}`);
    logDebug(`API URL: ${apiUrl}`);

    return page.evaluate(async (data) => {
        try {
            const t = data.token;
            if (!t) return { success: false, error: 'Токен авторизации не найден' };

            const response = await fetch(data.apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${t}`,
                    'Accept': '*/*'
                },
                body: JSON.stringify(data.payload)
            });

            if (response.ok) {
                if (data.payload.stream === false) {
                    const jsonResponse = await response.json();
                    if (jsonResponse.code === 'RateLimited' || jsonResponse.error) {
                        return { success: false, status: 429, errorBody: JSON.stringify(jsonResponse) };
                    }
                    return { success: true, isTask: true, data: jsonResponse };
                }

                const contentType = response.headers.get('content-type') || '';

                if (!contentType.includes('text/event-stream')) {
                    const body = await response.text();
                    try {
                        const parsed = JSON.parse(body);
                        const topLevelCode = parsed?.code;
                        const nestedCode = parsed?.data?.code;
                        const hasStructuredError =
                            parsed?.success === false ||
                            Boolean(parsed?.error) ||
                            Boolean(parsed?.data?.error) ||
                            Boolean(topLevelCode) ||
                            Boolean(nestedCode);

                        // API иногда возвращает JSON с success=false и code при HTTP 200.
                        if (hasStructuredError) {
                            const isRateLimited = topLevelCode === 'RateLimited' || nestedCode === 'RateLimited';
                            return {
                                success: false,
                                status: isRateLimited ? 429 : 500,
                                errorBody: body
                            };
                        }
                        // Валидный JSON-ответ completion (иногда Qwen возвращает так)
                        if (parsed.choices || parsed.id || (parsed.success === true && parsed.data)) {
                            return { success: true, isTask: false, data: parsed };
                        }
                    } catch { /* not JSON, treat as unexpected */ }
                    return { success: false, error: 'Unexpected non-SSE 200 response', errorBody: body };
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                let fullContent = '';
                let responseId = null;
                let usage = null;
                let finished = false;
                let streamError = null;

                while (!finished) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        if (!line.trim() || !line.startsWith('data: ')) continue;
                        const jsonStr = line.substring(6).trim();
                        if (!jsonStr) continue;
                        try {
                            const chunk = JSON.parse(jsonStr);

                            if (chunk.code === 'RateLimited' || (chunk.code && chunk.detail)) {
                                streamError = { status: 429, errorBody: JSON.stringify(chunk) };
                                finished = true;
                                break;
                            }
                            if (chunk.error && !chunk.choices) {
                                streamError = { status: 500, errorBody: JSON.stringify(chunk) };
                                finished = true;
                                break;
                            }

                            if (chunk['response.created']) responseId = chunk['response.created'].response_id;
                            if (chunk.choices && chunk.choices[0]) {
                                const delta = chunk.choices[0].delta;
                                if (delta && delta.content) fullContent += delta.content;
                                if (delta && delta.status === 'finished') finished = true;
                            }
                            if (chunk.usage) usage = chunk.usage;
                        } catch { /* ignore parse errors for individual chunks */ }
                    }
                }

                if (streamError) {
                    return { success: false, ...streamError };
                }

                return {
                    success: true,
                    isTask: false,
                    data: {
                        id: responseId || 'chatcmpl-' + Date.now(),
                        object: 'chat.completion',
                        created: Math.floor(Date.now() / 1000),
                        model: data.payload.model,
                        choices: [{ index: 0, message: { role: 'assistant', content: fullContent }, finish_reason: 'stop' }],
                        usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                        response_id: responseId
                    }
                };
            }

            const errorBody = await response.text();
            return { success: false, status: response.status, statusText: response.statusText, errorBody };
        } catch (error) {
            return {
                success: false,
                error: error?.message || String(error),
                details: error?.stack || null
            };
        }
    }, requestBody);
}

async function handleApiError(response, tokenObj, message, model, chatId, parentId, files, retryCount, chatType, size, waitForCompletion, onChunk = null) {
    if (!response || typeof response !== 'object') {
        logError(`Ошибка при получении ответа: response is invalid -> ${String(response)}`);
        return {
            error: `Invalid response from API: ${String(response)}`,
            details: 'handleApiError получил пустой или некорректный response',
            chatId
        };
    }

    try {
        logRaw(JSON.stringify(response, null, 2));
    } catch (e) {
        logError(`Не удалось сериализовать response в handleApiError: ${e?.message || String(e)}`);
    }

    const errorMessage =
        response.error ||
        response.statusText ||
        response.errorBody ||
        response.message ||
        'Unknown API error';

    logError(`Ошибка при получении ответа: ${errorMessage}`);

    if (response.errorBody) {
        logDebug(`Тело ответа с ошибкой: ${response.errorBody}`);
    }

    return {
        error: errorMessage,
        details: response.errorBody || response.details || 'Нет дополнительных деталей',
        chatId
    };
}
export async function sendMessageWithTools(message, model = DEFAULT_MODEL, chatId = null, parentId = null, files = null, tools = null, toolChoice = null, systemMessage = null, chatType = 't2t', size = null, waitForCompletion = true, retryCount = 0, onChunk = null, maxToolRounds = 5) {
    if (!availableModels) availableModels = getAvailableModelsFromFile();

    if (!chatId) {
        const newChatResult = await createChatV2(model);
        if (newChatResult.error) return { error: 'Не удалось создать чат: ' + newChatResult.error };
        chatId = newChatResult.chatId;
        logInfo(`Создан новый чат v2 с ID: ${chatId}`);
    }

    const validated = validateAndPrepareMessage(message);
    if (validated.error) {
        logError(validated.error);
        return { error: validated.error, chatId };
    }
    let messageContent = validated.content;

    if (!model || model.trim() === '') {
        model = DEFAULT_MODEL;
    } else if (!isValidModel(model)) {
        logWarn(`Модель "${model}" не найдена в списке доступных. Используется модель по умолчанию.`);
        model = DEFAULT_MODEL;
    }
    logInfo(`Используемая модель: "${model}"`);
    if (chatType !== 't2t') {
        const typeLabels = { t2i: 'изображение', t2v: 'видео' };
        logInfo(`Тип генерации: ${chatType} (${typeLabels[chatType] || chatType})${size ? `, размер: ${size}` : ''}`);
    }

    const browserContext = getBrowserContext();
    if (!browserContext) return { error: 'Браузер не инициализирован', chatId };

    const tokenObj = await resolveAuthToken(browserContext);
    if (!tokenObj) return { error: 'Ошибка авторизации: не удалось получить токен', chatId };

    // Build enhanced system message with tool descriptions
    let effectiveSystemMessage = systemMessage || '';
    const toolPrompt = buildToolSystemPrompt(tools);
    if (toolPrompt) {
        effectiveSystemMessage = effectiveSystemMessage
            ? `${effectiveSystemMessage}\n\n${toolPrompt}`
            : toolPrompt;
        logInfo(`Tool system prompt injected (${toolPrompt.length} chars)`);
    }

    // When tools are present, buffer streaming output to avoid sending raw JSON to client.
    // We need the full response first to detect tool calls, then execute tools, then send final answer.
    const hasTools = Array.isArray(tools) && tools.length > 0;
    const bufferedChunks = [];
    let streamingCallback = onChunk;
    
    if (hasTools && typeof onChunk === 'function') {
        streamingCallback = (chunk) => {
            bufferedChunks.push(chunk);
        };
    }

    let currentParentId = parentId;
    let accumulatedContent = '';
    let allToolCalls = [];

    for (let round = 0; round <= maxToolRounds; round++) {
        logInfo(`=== Tool execution round ${round}/${maxToolRounds} ===`);

        let page = null;
        try {
            page = await pagePool.getPage(browserContext);

            const verificationNeeded = await checkVerification(page);
            if (verificationNeeded) {
                await page.reload({ waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
            }

            if (!authToken) {
                logWarn('Токен отсутствует перед отправкой запроса');
                authToken = await page.evaluate(() => localStorage.getItem('token'));
                if (!authToken) return { error: 'Токен авторизации не найден. Требуется перезапуск в ручном режиме.', chatId };
                saveAuthToken(authToken);
            }

            logInfo('Отправка запроса к API v2...');

            const payload = buildProviderPayload({
                messageContent,
                model,
                chatId,
                parentId: currentParentId,
                files,
                systemMessage: effectiveSystemMessage,
                tools,
                toolChoice,
                chatType,
                size,
                provider: 'freeqwen'
            });
            logDebug('=== PAYLOAD V2 ===\n' + JSON.stringify(payload, null, 2));
            logDebug(`Отправка сообщения в чат ${chatId} с parent_id: ${currentParentId || 'null'}`);

            const apiUrl = `${CHAT_API_URL}?chat_id=${chatId}`;
            const response = await executeApiRequest(page, apiUrl, payload, authToken, streamingCallback);

            logDebug(`RAW executeApiRequest result type: ${typeof response}`);
            try {
                logRaw(JSON.stringify(response, null, 2));
            } catch (e) {
                logError(`Не удалось сериализовать response: ${e?.message || String(e)}`);
            }

            if (!response || typeof response !== 'object') {
                logError(`executeApiRequest вернул некорректный response: ${String(response)}`);
                return {
                    error: `executeApiRequest returned invalid response: ${String(response)}`,
                    chatId
                };
            }

            if (response.success && response.isTask) {
                logInfo('Обнаружен ответ с задачей (видеогенерация)');
                logRaw(JSON.stringify(response.data));

                const taskId = extractTaskId(response.data);
                if (!taskId) {
                    logError('Task ID не найден в ответе');
                    pagePool.releasePage(page);
                    page = null;
                    return { error: 'Task ID not found in response', chatId, rawResponse: response.data };
                }

                logInfo(`Task ID: ${taskId}`);

                if (!waitForCompletion) {
                    logInfo('Возвращаем task_id для клиентского polling');
                    pagePool.releasePage(page);
                    page = null;
                    return {
                        id: taskId,
                        object: 'chat.completion.task',
                        created: Math.floor(Date.now() / 1000),
                        model,
                        task_id: taskId,
                        chatId,
                        parentId: response.data.data?.parent_id || taskId,
                        status: 'processing',
                        message: 'Video generation task created. Poll GET /api/tasks/status/:taskId for progress.'
                    };
                }

                logInfo('Начинаем polling для получения видео...');
                const taskResult = await pollTaskStatus(taskId, page, authToken);

                pagePool.releasePage(page);
                page = null;

                if (taskResult.success && taskResult.status === 'completed') {
                    logInfo('Видео успешно сгенерировано');
                    const videoUrl = extractVideoUrl(taskResult.data);
                    return {
                        id: taskId,
                        object: 'chat.completion',
                        created: Math.floor(Date.now() / 1000),
                        model,
                        choices: [{
                            index: 0,
                            message: { role: 'assistant', content: videoUrl || JSON.stringify(taskResult.data) },
                            finish_reason: 'stop'
                        }],
                        usage: taskResult.data.usage || { prompt_tokens: 0, output_tokens: 0, total_tokens: 0 },
                        response_id: taskId,
                        chatId,
                        parentId: taskId,
                        task_id: taskId,
                        video_url: videoUrl
                    };
                }

                logError(`Не удалось получить видео: ${taskResult.error}`);
                return { error: taskResult.error || 'Video generation failed', status: taskResult.status, chatId, task_id: taskId };
            }

            pagePool.releasePage(page);
            page = null;

            if (response.success) {
                logRaw(JSON.stringify(response.data));
                logInfo('Ответ получен успешно');
                response.data.chatId = chatId;
                response.data.parentId = response.data.response_id;
                response.data.id = response.data.id || 'chatcmpl-' + Date.now();

                const message = response.data.choices?.[0]?.message;
                const hasToolCalls = Array.isArray(message?.tool_calls) && message.tool_calls.length > 0;

                if (
                    typeof onChunk === 'function' &&
                    message?.content &&
                    !response.hasStreamedChunks &&
                    !hasToolCalls
                ) {
                    onChunk(message.content);
                }

                // Check if model wants to use tools
                const content = message?.content || '';
                let toolCalls = null;

                if (hasToolCalls) {
                    toolCalls = message.tool_calls;
                } else if (tools && tools.length > 0 && content) {
                    toolCalls = parseToolCallFromText(content);
                    
                    // Fallback: try direct JSON parse if content looks like tool call
                    if (!toolCalls && content.trim().startsWith('{')) {
                        try {
                            const parsed = JSON.parse(content.trim());
                            if (parsed.tool_calls && Array.isArray(parsed.tool_calls)) {
                                toolCalls = parsed.tool_calls.map(tc => ({
                                    name: tc.name,
                                    arguments: typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : (tc.arguments || {})
                                }));
                            }
                        } catch (e) {
                            // Not valid JSON, ignore
                        }
                    }
                }

                // Also check buffered chunks for tool calls (streaming mode)
                if (!toolCalls && tools && tools.length > 0 && bufferedChunks.length > 0) {
                    const fullBuffered = bufferedChunks.join('');
                    if (fullBuffered.trim().startsWith('{')) {
                        try {
                            const parsed = JSON.parse(fullBuffered.trim());
                            if (parsed.tool_calls && Array.isArray(parsed.tool_calls)) {
                                toolCalls = parsed.tool_calls.map(tc => ({
                                    name: tc.name,
                                    arguments: typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : (tc.arguments || {})
                                }));
                                // Update content to match buffered
                                message.content = fullBuffered;
                            }
                        } catch (e) {
                            // Not valid JSON, ignore
                        }
                    }
                }

                if (!toolCalls || toolCalls.length === 0) {
                    // No tool calls needed — final response
                    // Flush buffered chunks to client if we were buffering
                    if (hasTools && bufferedChunks.length > 0 && typeof onChunk === 'function') {
                        for (const chunk of bufferedChunks) {
                            onChunk(chunk);
                        }
                    }
                    if (round > 0 && accumulatedContent) {
                        response.data.choices[0].message.content = accumulatedContent + '\n\n' + (content || '');
                    }
                    if (allToolCalls.length > 0) {
                        response.data.tool_calls = allToolCalls;
                    }
                    return response.data;
                }

                // We have tool calls — execute them
                // Discard buffered chunks (they contain raw JSON, not useful to client)
                bufferedChunks.length = 0;
                logInfo(`Model requested ${toolCalls.length} tool call(s), round ${round}`);
                logInfo(`Tool calls: ${JSON.stringify(toolCalls)}`);
                allToolCalls.push(...toolCalls);

                const toolResults = [];
                for (const tc of toolCalls) {
                    const toolName = tc.name || tc.function?.name;
                    const toolArgs = tc.arguments || (tc.function?.arguments ? JSON.parse(tc.function.arguments) : {});

                    logInfo(`Executing tool: ${toolName} with args: ${JSON.stringify(toolArgs)}`);
                    const result = await executeTool(toolName, toolArgs);

                    if (result.success) {
                        toolResults.push({
                            name: toolName,
                            output: result.output || '(no output)'
                        });
                        logInfo(`Tool ${toolName} executed successfully, output length: ${(result.output || '').length}`);
                    } else {
                        toolResults.push({
                            name: toolName,
                            output: `Error: ${result.error || 'Unknown error'}`
                        });
                        logError(`Tool ${toolName} failed: ${result.error}`);
                    }
                }

                // Build tool results text
                const toolResultsText = toolResults
                    .map(tr => `## Result of ${tr.name}:\n${tr.output}`)
                    .join('\n\n---\n\n');

                logInfo(`Tool results ready. Returning directly.`);
                logDebug(`Tool results text: ${toolResultsText.substring(0, 500)}`);

                // Qwen API v2 does NOT support multi-turn with tool results.
                // Return tool output directly. Clients like opencode will format it.
                // Discard buffered chunks since we're returning tool results instead.
                bufferedChunks.length = 0;

                return {
                    id: response.data.id || 'chatcmpl-' + Date.now(),
                    object: 'chat.completion',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [{
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: toolResultsText
                        },
                        finish_reason: 'tool_calls'
                    }],
                    usage: response.data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                    chatId,
                    parentId: response.data.response_id || response.data.parentId,
                    tool_calls: allToolCalls
                };
            }

            return handleApiError(response, tokenObj, message, model, chatId, currentParentId, files, retryCount, chatType, size, waitForCompletion, onChunk);
        } catch (error) {
            logError('Ошибка при отправке сообщения', error);
            return { error: error.toString(), chatId };
        } finally {
            if (page) {
                pagePool.releasePage(page);
            }
        }
    }

    // Max rounds reached
    logWarn(`Max tool rounds (${maxToolRounds}) reached`);
    return {
        id: 'chatcmpl-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
            index: 0,
            message: { role: 'assistant', content: accumulatedContent || 'Tool execution limit reached.' },
            finish_reason: 'tool_calls'
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        chatId,
        parentId: currentParentId,
        tool_calls: allToolCalls
    };
}

// ─── Main public API ─────────────────────────────────────────────────────────

export async function sendMessage(message, model = DEFAULT_MODEL, chatId = null, parentId = null, files = null, tools = null, toolChoice = null, systemMessage = null, chatType = 't2t', size = null, waitForCompletion = true, retryCount = 0, onChunk = null) {
    if (!availableModels) availableModels = getAvailableModelsFromFile();

    if (!chatId) {
        const newChatResult = await createChatV2(model);
        if (newChatResult.error) return { error: 'Не удалось создать чат: ' + newChatResult.error };
        chatId = newChatResult.chatId;
        logInfo(`Создан новый чат v2 с ID: ${chatId}`);
    }

    const validated = validateAndPrepareMessage(message);
    if (validated.error) {
        logError(validated.error);
        return { error: validated.error, chatId };
    }
    const messageContent = validated.content;

    if (!model || model.trim() === '') {
        model = DEFAULT_MODEL;
    } else if (!isValidModel(model)) {
        logWarn(`Модель "${model}" не найдена в списке доступных. Используется модель по умолчанию.`);
        model = DEFAULT_MODEL;
    }
    logInfo(`Используемая модель: "${model}"`);
    if (chatType !== 't2t') {
        const typeLabels = { t2i: 'изображение', t2v: 'видео' };
        logInfo(`Тип генерации: ${chatType} (${typeLabels[chatType] || chatType})${size ? `, размер: ${size}` : ''}`);
    }

    const browserContext = getBrowserContext();
    if (!browserContext) return { error: 'Браузер не инициализирован', chatId };

    const tokenObj = await resolveAuthToken(browserContext);
    if (!tokenObj) return { error: 'Ошибка авторизации: не удалось получить токен', chatId };

    let page = null;
    try {
        page = await pagePool.getPage(browserContext);

        const verificationNeeded = await checkVerification(page);
        if (verificationNeeded) {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
        }

        if (!authToken) {
            logWarn('Токен отсутствует перед отправкой запроса');
            authToken = await page.evaluate(() => localStorage.getItem('token'));
            if (!authToken) return { error: 'Токен авторизации не найден. Требуется перезапуск в ручном режиме.', chatId };
            saveAuthToken(authToken);
        }

        logInfo('Отправка запроса к API v2...');

        const payload = buildProviderPayload({
            messageContent,
            model,
            chatId,
            parentId,
            files,
            systemMessage,
            tools,
            toolChoice,
            chatType,
            size,
            provider: 'freeqwen'
        });
        logDebug('=== PAYLOAD V2 ===\n' + JSON.stringify(payload, null, 2));
        logDebug(`Отправка сообщения в чат ${chatId} с parent_id: ${parentId || 'null'}`);

            const apiUrl = `${CHAT_API_URL}?chat_id=${chatId}`;
            const response = await executeApiRequest(page, apiUrl, payload, authToken, streamingCallback);

        logDebug(`RAW executeApiRequest result type: ${typeof response}`);
        try {
            logRaw(JSON.stringify(response, null, 2));
        } catch (e) {
            logError(`Не удалось сериализовать response: ${e?.message || String(e)}`);
        }

        if (!response || typeof response !== 'object') {
            logError(`executeApiRequest вернул некорректный response: ${String(response)}`);
            return {
                error: `executeApiRequest returned invalid response: ${String(response)}`,
                chatId
            };
        }

        if (response.success && response.isTask) {
            logInfo('Обнаружен ответ с задачей (видеогенерация)');
            logRaw(JSON.stringify(response.data));

            const taskId = extractTaskId(response.data);
            if (!taskId) {
                logError('Task ID не найден в ответе');
                pagePool.releasePage(page);
                page = null;
                return { error: 'Task ID not found in response', chatId, rawResponse: response.data };
            }

            logInfo(`Task ID: ${taskId}`);

            if (!waitForCompletion) {
                logInfo('Возвращаем task_id для клиентского polling');
                pagePool.releasePage(page);
                page = null;
                return {
                    id: taskId,
                    object: 'chat.completion.task',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    task_id: taskId,
                    chatId,
                    parentId: response.data.data?.parent_id || taskId,
                    status: 'processing',
                    message: 'Video generation task created. Poll GET /api/tasks/status/:taskId for progress.'
                };
            }

            logInfo('Начинаем polling для получения видео...');
            const taskResult = await pollTaskStatus(taskId, page, authToken);

            pagePool.releasePage(page);
            page = null;

            if (taskResult.success && taskResult.status === 'completed') {
                logInfo('Видео успешно сгенерировано');
                const videoUrl = extractVideoUrl(taskResult.data);
                return {
                    id: taskId,
                    object: 'chat.completion',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [{
                        index: 0,
                        message: { role: 'assistant', content: videoUrl || JSON.stringify(taskResult.data) },
                        finish_reason: 'stop'
                    }],
                    usage: taskResult.data.usage || { prompt_tokens: 0, output_tokens: 0, total_tokens: 0 },
                    response_id: taskId,
                    chatId,
                    parentId: taskId,
                    task_id: taskId,
                    video_url: videoUrl
                };
            }

            logError(`Не удалось получить видео: ${taskResult.error}`);
            return { error: taskResult.error || 'Video generation failed', status: taskResult.status, chatId, task_id: taskId };
        }

        pagePool.releasePage(page);
        page = null;

        if (response.success) {
            logRaw(JSON.stringify(response.data));
            logInfo('Ответ получен успешно');
            response.data.chatId = chatId;
            response.data.parentId = response.data.response_id;
            response.data.id = response.data.id || 'chatcmpl-' + Date.now();
            
            const message = response.data.choices?.[0]?.message;
            const hasToolCalls = Array.isArray(message?.tool_calls) && message.tool_calls.length > 0;

            // 🚨 НЕ отправляем content если есть tool_calls
            if (
                typeof onChunk === 'function' &&
                message?.content &&
                !response.hasStreamedChunks &&
                !hasToolCalls
            ) {
                onChunk(message.content);
            }
            
            return response.data;
        }

        return handleApiError(response, tokenObj, message, model, chatId, parentId, files, retryCount, chatType, size, waitForCompletion, onChunk);
    } catch (error) {
        logError('Ошибка при отправке сообщения', error);
        return { error: error.toString(), chatId };
    } finally {
        if (page) {
            pagePool.releasePage(page);
        }
    }
}

// ─── Task response helpers ───────────────────────────────────────────────────

function extractTaskId(data) {
    const firstMsg = data.data?.messages?.[0];
    if (firstMsg?.extra?.wanx?.task_id) return firstMsg.extra.wanx.task_id;
    return data.id || data.task_id || data.response_id || data.data?.message_id || null;
}

function extractVideoUrl(taskData) {
    if (taskData.content) return taskData.content;
    if (typeof taskData.result === 'string') return taskData.result;
    if (taskData.result?.url) return taskData.result.url;
    if (taskData.result?.video_url) return taskData.result.video_url;
    return null;
}

export async function clearPagePool() {
    await pagePool.clear();
}

export function getAuthToken() {
    return authToken;
}

// ─── createChatV2 ────────────────────────────────────────────────────────────

export async function createChatV2(model = DEFAULT_MODEL, title = 'Новый чат', retryCount = 0) {
    const browserContext = getBrowserContext();
    if (!browserContext) return { error: 'Браузер не инициализирован' };

    const tokenObj = await getAvailableToken();
    if (tokenObj?.token) {
        authToken = tokenObj.token;
        logInfo(`Используется аккаунт для создания чата: ${tokenObj.id}`);
    }

    if (!authToken) {
        logInfo('Получение токена авторизации для создания чата...');
        authToken = await extractAuthToken(browserContext);
        if (!authToken) return { error: 'Не удалось получить токен авторизации' };
    }

    let page = null;
    try {
        page = await pagePool.getPage(browserContext);

        const payload = { title, models: [model], chat_mode: 'normal', chat_type: 't2t', timestamp: Date.now() };
        const requestBody = { apiUrl: CREATE_CHAT_URL, payload, token: authToken };

        const result = await page.evaluate(async (data) => {
            try {
                const response = await fetch(data.apiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${data.token}` },
                    body: JSON.stringify(data.payload)
                });
                if (response.ok) return { success: true, data: await response.json() };
                return { success: false, status: response.status, errorBody: await response.text() };
            } catch (error) {
                return {
                    success: false,
                    error: error?.message || String(error),
                    details: error?.stack || null
                };
            }
        }, requestBody);

        pagePool.releasePage(page);
        page = null;

        if (result.success && result.data.success) {
            logInfo(`Чат создан: ${result.data.data.id}`);
            return { success: true, chatId: result.data.data.id, requestId: result.data.request_id };
        }

        const isTransient = result.status >= 500 && result.status < 600;
        if (isTransient && retryCount < MAX_RETRY_COUNT) {
            logWarn(`Создание чата: ${result.status}, ретрай ${retryCount + 1}/${MAX_RETRY_COUNT} через ${RETRY_DELAY}мс...`);
            await delay(RETRY_DELAY);
            return createChatV2(model, title, retryCount + 1);
        }

        const cleanError = isTransient
            ? `Qwen API недоступен (${result.status}). Повторите позже.`
            : (result.errorBody || result.error || 'Неизвестная ошибка');
        logError(`Ошибка при создании чата: ${result.status || 'unknown'} (попытка ${retryCount + 1})`);
        return { error: cleanError };
    } catch (error) {
        logError('Ошибка при создании чата', error);
        return { error: error.toString() };
    } finally {
        if (page) {
            pagePool.releasePage(page);
        }
    }
}

// ─── testToken ───────────────────────────────────────────────────────────────

export async function testToken(token) {
    const browserContext = getBrowserContext();
    if (!browserContext) return 'ERROR';

    let page;
    let shouldClosePage = false;
    try {
        page = await getPage(browserContext);
        shouldClosePage = page !== browserContext;
        await page.goto(CHAT_PAGE_URL, { waitUntil: 'domcontentloaded' });

        const requestBody = {
            apiUrl: CHAT_API_URL,
            token,
            payload: { chat_type: 't2t', messages: [{ role: 'user', content: 'ping', chat_type: 't2t' }], model: DEFAULT_MODEL, stream: false }
        };

        const result = await page.evaluate(async (data) => {
            try {
                const res = await fetch(data.apiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${data.token}` },
                    body: JSON.stringify(data.payload)
                });
                return { ok: res.ok, status: res.status };
            } catch (e) {
                return { ok: false, status: 0, error: e.toString() };
            }
        }, requestBody);

        if (result.ok || result.status === 400) return 'OK';
        if (result.status === 401 || result.status === 403) return 'UNAUTHORIZED';
        if (result.status === 429) return 'RATELIMIT';
        return 'ERROR';
    } catch (e) {
        logError('testToken error', e);
        return 'ERROR';
    } finally {
        if (page) {
            try { if (shouldClosePage) await page.close(); } catch { }
        }
    }
}

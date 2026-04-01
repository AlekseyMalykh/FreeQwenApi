import http from 'http';

function request(path, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'localhost',
            port: 3264,
            path,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...headers
            }
        };
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
                catch { resolve({ status: res.statusCode, body: data }); }
            });
        });
        req.on('error', reject);
        req.write(JSON.stringify(body));
        req.end();
    });
}

async function test(name, path, body, headers = {}) {
    try {
        const res = await request(path, body, headers);
        const ok = res.status === 200 && !res.body.error;
        console.log(`${ok ? '✅' : '❌'} ${name} — status: ${res.status}${res.body.error ? `, error: ${res.body.error}` : ''}`);
        if (!ok && res.body) console.log('   Response:', JSON.stringify(res.body).substring(0, 200));
    } catch (e) {
        console.log(`❌ ${name} — ${e.message}`);
    }
}

await test('1. /chat/completions без tools', '/api/chat/completions', {
    model: 'qwen-max-latest',
    messages: [{ role: 'user', content: 'Скажи привет' }]
});

await test('2. /chat/completions с tools', '/api/chat/completions', {
    model: 'qwen-max-latest',
    messages: [{ role: 'user', content: 'Какие файлы есть в проекте?' }],
    tools: [{
        type: 'function',
        function: {
            name: 'bash',
            description: 'Execute shell command',
            parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
        }
    }]
});

await test('3. /chat/completions stream=true + tools', '/api/chat/completions', {
    model: 'qwen-max-latest',
    stream: true,
    messages: [{ role: 'user', content: 'Скажи привет' }],
    tools: [{
        type: 'function',
        function: {
            name: 'bash',
            description: 'Execute shell command',
            parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
        }
    }]
});

await test('4. /v1/chat/completions с tools', '/api/v1/chat/completions', {
    model: 'qwen-max-latest',
    messages: [{ role: 'user', content: 'Скажи привет' }],
    tools: [{
        type: 'function',
        function: {
            name: 'bash',
            description: 'Execute shell command',
            parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
        }
    }]
});

await test('5. Без x-working-directory', '/api/chat/completions', {
    model: 'qwen-max-latest',
    messages: [{ role: 'user', content: 'Скажи привет' }]
});

await test('6. С x-working-directory', '/api/chat/completions', {
    model: 'qwen-max-latest',
    messages: [{ role: 'user', content: 'Скажи привет' }]
}, { 'X-Working-Directory': 'C:/AIinst/FreeQwenApi' });

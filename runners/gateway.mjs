import http from 'node:http';
import { readFile, mkdir, realpath } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { fork } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const keyPattern = /^[A-Za-z0-9_-]{1,100}$/;
const actions = new Set(['init', 'search', 'detail', 'play']);
const bodyLimit = 64 * 1024;
const responseLimit = 4 * 1024 * 1024;

class RunnerError extends Error {
  constructor(code, status = 502) { super(code); this.code = code; this.status = status; }
}

async function readLimited(stream, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw new RunnerError('body_too_large', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function validToken(actual, expected) {
  const a = createHash('sha256').update(actual || '').digest();
  const b = createHash('sha256').update(`Bearer ${expected}`).digest();
  return timingSafeEqual(a, b);
}

function bridgeUrl(raw) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('CSP_BRIDGE_URL 必须是无凭据的 HTTP(S) 地址');
  }
  return url.href.replace(/\/$/, '');
}

export async function createGateway({ config, token, configDirectory = directory, bridge = {}, timeoutMs = 20000 }) {
  if (typeof token !== 'string' || token.length < 24) throw new Error('RUNNER_TOKEN 至少需要24个字符');
  if (!Array.isArray(config.sites)) throw new Error('sites 必须是数组');
  const sites = new Map();
  for (const site of config.sites) {
    if (!keyPattern.test(site.key) || sites.has(site.key) || !['catjs', 'csp'].includes(site.kind)) {
      throw new Error('源注册配置无效或重复');
    }
    if (site.kind === 'catjs' && !keyPattern.test(site.upstreamKey || site.key)) throw new Error('upstreamKey 无效');
    sites.set(site.key, site);
  }
  const bridgeBase = bridge.url ? bridgeUrl(bridge.url) : null;
  if (bridgeBase && !bridge.token) throw new Error('配置桥接地址时必须配置 CSP_BRIDGE_TOKEN');
  const childStates = new Map();
  const cspInitialized = new Map();
  const cspReady = new Set();
  let activeRequests = 0;
  let closing = false;

  async function catRuntime(id) {
    if (closing) throw new RunnerError('runtime_unavailable', 503);
    if (childStates.has(id)) return childStates.get(id).promise;
    const runtime = config.runtimes?.[id];
    if (!runtime || !/^[a-f0-9]{64}$/i.test(runtime.sha256 || '') || typeof runtime.scriptPath !== 'string') {
      throw new RunnerError('runtime_unconfigured', 503);
    }
    const state = { child: null, promise: null, initialized: new Map() };
    state.promise = (async () => {
      let scriptPath;
      try {
        scriptPath = await realpath(resolve(configDirectory, runtime.scriptPath));
        const bytes = await readFile(scriptPath);
        if (createHash('sha256').update(bytes).digest('hex') !== runtime.sha256.toLowerCase()) {
          throw new RunnerError('script_hash_mismatch', 503);
        }
      } catch (error) {
        if (error instanceof RunnerError) throw error;
        throw new RunnerError('runtime_unconfigured', 503);
      }
      const workDirectory = resolve(configDirectory, runtime.workDirectory || `data/${id}`);
      const dependencyDirectory = runtime.dependencyDirectory
        ? await realpath(resolve(configDirectory, runtime.dependencyDirectory)) : null;
      await mkdir(workDirectory, { recursive: true });
      return new Promise((accept, reject) => {
        // 不向来源脚本继承网关、桥接凭据和 NODE_OPTIONS。
        const env = { NODE_ENV: 'production', CATVOD_DISABLE_AUTOSTART: '1', HOST: '127.0.0.1',
          ...(dependencyDirectory ? { NODE_PATH: dependencyDirectory } : {}) };
        for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'HOME']) {
          if (process.env[name]) env[name] = process.env[name];
        }
        const child = fork(resolve(directory, 'cat-host.cjs'), [scriptPath, runtime.sha256.toLowerCase()], {
          cwd: workDirectory, env, execArgv: ['--max-old-space-size=256', '--no-addons'],
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
        state.child = child;
        const timer = setTimeout(() => {
          child.kill(); reject(new RunnerError('runtime_unavailable', 503));
        }, timeoutMs);
        child.once('error', () => { clearTimeout(timer); reject(new RunnerError('runtime_unavailable', 503)); });
        child.once('exit', () => {
          clearTimeout(timer); childStates.delete(id);
          reject(new RunnerError('runtime_unavailable', 503));
        });
        child.on('message', (message) => {
          if (message?.type === 'ready' && Number.isInteger(message.port) && message.port > 0 && message.port <= 65535) {
            clearTimeout(timer); accept({ base: `http://127.0.0.1:${message.port}`, initialized: state.initialized });
          } else if (message?.type === 'failed') {
            clearTimeout(timer); child.kill(); reject(new RunnerError('runtime_unavailable', 503));
          }
        });
        child.send({ type: 'start', config: runtime.config || { color: [] } });
      });
    })();
    childStates.set(id, state);
    try { return await state.promise; } catch (error) { childStates.delete(id); throw error; }
  }

  async function upstream(base, key, action, body, secret) {
    let response;
    try {
      response = await fetch(`${base}/spider/${encodeURIComponent(key)}/3/${action}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
        body: JSON.stringify(body),
      });
      const bytes = await readLimited(response.body, responseLimit);
      let data;
      try { data = JSON.parse(bytes.toString('utf8')); } catch { throw new RunnerError('invalid_upstream_response'); }
      if (!response.ok) throw new RunnerError('source_error');
      return data;
    } catch (error) {
      if (error instanceof RunnerError) throw error;
      throw new RunnerError('runtime_unavailable', 503);
    }
  }

  async function invoke(site, action, body) {
    const upstreamKey = site.upstreamKey || site.key;
    if (site.kind === 'catjs') {
      const runtime = await catRuntime(site.runtime);
      if (!runtime.initialized.has(site.key)) {
        const init = upstream(runtime.base, upstreamKey, 'init', site.init || {});
        runtime.initialized.set(site.key, init);
        init.catch(() => runtime.initialized.delete(site.key));
      }
      const initialized = await runtime.initialized.get(site.key);
      if (action === 'init') return { ...initialized, capabilities: { catjs: true, csp: false } };
      return upstream(runtime.base, upstreamKey, action, body);
    }
    if (!bridgeBase) throw new RunnerError('runtime_unconfigured', 503);
    if (!cspInitialized.has(site.key)) {
      // Android 桥必须真正注册这些参数并初始化 Spider，不能仅保存元数据。
      const registration = { siteKey: site.key, type: 3, api: site.api, ext: site.ext, spider: site.spider,
        parses: site.parses || [], flags: site.flags || [], baseUrl: site.baseUrl };
      const init = upstream(bridgeBase, upstreamKey, 'init', registration, bridge.token).then((result) => {
        if (result?.capabilities?.csp !== true) throw new RunnerError('unsupported_runtime', 503);
        cspReady.add(site.key);
        return result;
      });
      cspInitialized.set(site.key, init);
      init.catch(() => cspInitialized.delete(site.key));
    }
    const initialized = await cspInitialized.get(site.key);
    if (action === 'init') return initialized;
    try {
      return await upstream(bridgeBase, upstreamKey, action, body, bridge.token);
    } catch (error) {
      if (error.code === 'runtime_unavailable') { cspInitialized.delete(site.key); cspReady.delete(site.key); }
      throw error;
    }
  }

  const server = http.createServer(async (request, response) => {
    const send = (status, data) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(JSON.stringify(data));
    };
    let counted = false;
    try {
      if (!validToken(request.headers.authorization, token)) return send(401, { error: 'unauthorized' });
      if (activeRequests >= 16) return send(429, { error: 'runner_busy' });
      activeRequests += 1;
      counted = true;
      if (request.method === 'GET' && request.url === '/health') {
        return send(200, { version: 1, capabilities: { catjs: true, csp: cspReady.size > 0 },
          sites: [...sites.values()].map((site) => ({ key: site.key, kind: site.kind,
            state: site.kind === 'csp' ? (!bridgeBase ? 'runtime_unconfigured' : cspReady.has(site.key) ? 'initialized' : 'unverified')
              : childStates.has(site.runtime) ? 'started' : 'not_started' })) });
      }
      const match = /^\/spider\/([A-Za-z0-9_-]{1,100})\/3\/(init|search|detail|play)$/.exec(request.url || '')
        || /^\/v1\/sites\/([A-Za-z0-9_-]{1,100})\/(init|search|detail|play)$/.exec(request.url || '');
      if (request.method !== 'POST' || !match || !actions.has(match[2])) return send(404, { error: 'not_found' });
      const site = sites.get(match[1]);
      if (!site) return send(404, { error: 'unknown_site' });
      const bytes = await readLimited(request, bodyLimit);
      let body;
      try { body = JSON.parse(bytes.toString('utf8')); } catch { throw new RunnerError('invalid_json', 400); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RunnerError('invalid_body', 400);
      // 仅转发动作参数，不允许请求覆盖配置、脚本路径或桥接地址。
      let payload;
      if (match[2] === 'init') {
        if (Object.keys(body).length !== 0) throw new RunnerError('init_configuration_is_server_managed', 400);
        payload = {};
      } else if (match[2] === 'search') {
        if (typeof body.wd !== 'string' || !body.wd.trim() || body.wd.length > 300) throw new RunnerError('invalid_search', 400);
        payload = { wd: body.wd, page: body.page ?? 1 };
      } else {
        if (!(typeof body.id === 'string' || typeof body.id === 'number' || (match[2] === 'detail' && Array.isArray(body.id) && body.id.every((id) => typeof id === 'string')))) {
          throw new RunnerError('invalid_id', 400);
        }
        payload = { id: body.id };
        if (match[2] === 'play') {
          if (body.flag !== undefined && typeof body.flag !== 'string') throw new RunnerError('invalid_flag', 400);
          payload.flag = body.flag || '';
        }
      }
      const result = await invoke(site, match[2], payload);
      if (match[2] === 'play') {
        const checkPlayback = (value) => {
          if (typeof value === 'string') {
            try {
              const host = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, '');
              if (host === 'localhost' || host === '::1' || host === '0.0.0.0' || host.startsWith('127.') || host.startsWith('::ffff:127.')) {
                throw new RunnerError('local_media_proxy_required', 502);
              }
            } catch (error) { if (error instanceof RunnerError) throw error; }
          } else if (Array.isArray(value)) value.forEach(checkPlayback);
          else if (value && typeof value === 'object') Object.values(value).forEach(checkPlayback);
        };
        checkPlayback(result);
      }
      send(200, result);
    } catch (error) {
      send(error instanceof RunnerError ? error.status : 500, { error: error instanceof RunnerError ? error.code : 'internal_error' });
    } finally {
      if (counted) activeRequests -= 1;
    }
  });
  server.requestTimeout = timeoutMs + 5000;
  server.headersTimeout = Math.min(10000, server.requestTimeout);
  server.maxRequestsPerSocket = 100;
  async function close() {
    closing = true;
    for (const state of childStates.values()) state.child?.kill();
    server.closeAllConnections();
    if (server.listening) await new Promise((accept) => server.close(accept));
  }
  return { server, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const configPath = resolve(process.env.RUNNER_CONFIG || resolve(directory, 'config.json'));
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    const gateway = await createGateway({ config, configDirectory: dirname(configPath), token: process.env.RUNNER_TOKEN,
      bridge: { url: process.env.CSP_BRIDGE_URL, token: process.env.CSP_BRIDGE_TOKEN } });
    gateway.server.listen(Number(process.env.PORT || 8787), process.env.HOST || '127.0.0.1', () => console.log('源运行网关已启动'));
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => gateway.close().then(() => process.exit(0)));
  } catch { console.error('源运行网关启动失败，请检查服务端配置与凭据'); process.exitCode = 1; }
}

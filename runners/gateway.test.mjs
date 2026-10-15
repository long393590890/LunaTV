import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createGateway } from './gateway.mjs';

const token = 'test-gateway-token-at-least-24-characters';
async function listen(server) {
  await new Promise((accept) => server.listen(0, '127.0.0.1', accept));
  return `http://127.0.0.1:${server.address().port}`;
}
async function call(base, path, body, secret = token) {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() };
}

// 测试只执行此处原创假宿主，不下载或执行第三方源。
const fakeSource = `
const http = require('node:http');
let server;
exports.start = async (config) => {
  if (!config.marker || globalThis.catDartServerPort() !== 0) throw Error('宿主契约不匹配');
  server = globalThis.catServerFactory(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw || '{}');
    res.setHeader('Content-Type', 'application/json');
    if (body.wd === 'upstream-failure') { res.statusCode=500; res.end('{}'); return; }
    if (body.wd === 'invalid-response') { res.end('not json'); return; }
    if (body.id === 'loopback') { res.end(JSON.stringify({url:'http://127.0.0.1:9999/media.m3u8',parse:0})); return; }
    res.end(JSON.stringify({route:req.url,body,secretPresent:!!process.env.RUNNER_TOKEN}));
  });
  await new Promise((accept) => server.listen({port:9988,host:'0.0.0.0'},accept));
};
exports.stop = async () => { if(server) await new Promise(resolve=>server.close(resolve)); };
`;

test('真实HTTP验证鉴权、宿主启动、固定源映射和错误', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'lunatv-runner-test-'));
  const scriptPath = join(temp, 'source.cjs');
  const dependencyDirectory = join(temp, 'dependencies');
  await mkdir(join(dependencyDirectory, 'runner-test-dependency'), { recursive: true });
  await writeFile(join(dependencyDirectory, 'runner-test-dependency', 'index.js'), 'module.exports = true;');
  const sourceWithDependency = "if(!require('runner-test-dependency')) throw Error('依赖解析失败');\n" + fakeSource;
  await writeFile(scriptPath, sourceWithDependency);
  const sha256 = createHash('sha256').update(sourceWithDependency).digest('hex');
  const gateway = await createGateway({ token, configDirectory: temp, config: {
    runtimes: { fake: { scriptPath, sha256, dependencyDirectory, config: { marker: true } }, bad: { scriptPath, sha256: '0'.repeat(64) } },
    sites: [ { key: 'public', kind: 'catjs', runtime: 'fake', upstreamKey: 'actual' },
      { key: 'android', kind: 'csp', api: 'csp_Demo' }, { key: 'bad', kind: 'catjs', runtime: 'bad' } ],
  } });
  try {
    const base = await listen(gateway.server);
    assert.equal((await call(base, '/health', undefined, 'wrong')).status, 401);
    const health = await call(base, '/health');
    assert.equal(health.data.capabilities.csp, false);
    assert.equal(health.data.sites.find((x) => x.key === 'android').state, 'runtime_unconfigured');
    assert.equal((await call(base, '/spider/missing/3/search', { wd: 'test' })).status, 404);
    assert.equal((await call(base, '/spider/public/3/search', { wd: '' })).status, 400);
    const init = await call(base, '/spider/public/3/init', {});
    assert.equal(init.status, 200);
    assert.equal(init.data.route, '/spider/actual/3/init');
    assert.equal(init.data.capabilities.catjs, true);
    assert.equal((await call(base, '/spider/public/3/init', { scriptPath: '/evil' })).status, 400);
    const search = await call(base, '/spider/public/3/search', { wd: 'test', page: 2, scriptPath: '/evil' });
    assert.equal(search.status, 200);
    assert.equal(search.data.route, '/spider/actual/3/search');
    assert.deepEqual(search.data.body, { wd: 'test', page: 2 });
    assert.equal(search.data.secretPresent, false);
    const detail = await call(base, '/spider/public/3/detail', { id: 'opaque$id' });
    assert.equal(detail.data.route, '/spider/actual/3/detail');
    assert.deepEqual(detail.data.body, { id: 'opaque$id' });
    const play = await call(base, '/spider/public/3/play', { id: 'opaque?id=2', flag: 'line2' });
    assert.deepEqual(play.data.body, { id: 'opaque?id=2', flag: 'line2' });
    assert.equal((await call(base, '/spider/public/3/play', { id: 'loopback' })).data.error, 'local_media_proxy_required');
    assert.equal((await call(base, '/v1/sites/public/search', { wd: 'alias' })).status, 200);
    assert.equal((await call(base, '/spider/android/3/search', { wd: 'test' })).data.error, 'runtime_unconfigured');
    assert.equal((await call(base, '/spider/bad/3/search', { wd: 'test' })).data.error, 'script_hash_mismatch');
    assert.equal((await call(base, '/spider/public/3/search', { wd: 'upstream-failure' })).data.error, 'source_error');
    assert.equal((await call(base, '/spider/public/3/search', { wd: 'invalid-response' })).data.error, 'invalid_upstream_response');
  } finally { await gateway.close(); await rm(temp, { recursive: true, force: true }); }
});

test('Android桥真实HTTP注册、鉴权、能力验证与动作转发', async () => {
  const received = [];
  const bridge = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    received.push({ route: req.url, auth: req.headers.authorization, body: JSON.parse(raw) });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url.endsWith('/init') ? { capabilities: { csp: true } } : { list: [] }));
  });
  const bridgeBase = await listen(bridge);
  const gateway = await createGateway({ token, bridge: { url: bridgeBase, token: 'android-secret' }, config: {
    sites: [{ key: 'android', kind: 'csp', api: 'csp_Demo', ext: { example: true }, spider: 'https://example.invalid/source.jar;md5;example', flags: ['demo'] }],
  } });
  try {
    const base = await listen(gateway.server);
    assert.equal((await call(base, '/health')).data.capabilities.csp, false);
    const init = await call(base, '/spider/android/3/init', {});
    assert.equal(init.status, 200);
    assert.equal(init.data.capabilities.csp, true);
    assert.equal((await call(base, '/spider/android/3/search', { wd: 'test' })).status, 200);
    assert.equal(received[0].route, '/spider/android/3/init');
    assert.equal(received[0].auth, 'Bearer android-secret');
    assert.equal(received[0].body.api, 'csp_Demo');
    assert.deepEqual(received[0].body.ext, { example: true });
    assert.equal(received[1].route, '/spider/android/3/search');
    assert.equal((await call(base, '/health')).data.capabilities.csp, true);
    await call(base, '/spider/android/3/detail', { id: 'opaque' });
    assert.equal(received.filter((x) => x.route.endsWith('/init')).length, 1);
  } finally {
    await gateway.close(); bridge.closeAllConnections(); await new Promise((accept) => bridge.close(accept));
  }
});

test('桥未报告真实CSP能力时拒绝执行', async () => {
  let calls = 0;
  const bridge = http.createServer(async (req, res) => {
    for await (const part of req) void part;
    calls += 1;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ saved: true }));
  });
  const bridgeBase = await listen(bridge);
  const gateway = await createGateway({ token, bridge: { url: bridgeBase, token: 'bridge-secret' },
    config: { sites: [{ key: 'android', kind: 'csp', api: 'csp_Demo' }] } });
  try {
    const base = await listen(gateway.server);
    const result = await call(base, '/spider/android/3/search', { wd: 'test' });
    assert.equal(result.status, 503);
    assert.equal(result.data.error, 'unsupported_runtime');
    assert.equal(calls, 1);
    assert.equal((await call(base, '/health')).data.capabilities.csp, false);
  } finally {
    await gateway.close(); bridge.closeAllConnections(); await new Promise((accept) => bridge.close(accept));
  }
});

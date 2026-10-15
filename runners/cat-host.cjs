'use strict';

const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');

// 子进程仅补齐猫源已验证的宿主回调，不加载 Android DEX 或原生库。
const [scriptPath, expectedHash] = process.argv.slice(2);
let source;
let server;
let stopping = false;

async function stop() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(0), 2000);
  deadline.unref();
  try { await source?.stop?.(); } finally { process.exit(0); }
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('disconnect', stop);
process.once('message', async (message) => {
  try {
    if (message?.type !== 'start') throw new Error('invalid_start');
    const bytes = fs.readFileSync(scriptPath);
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (hash !== expectedHash) throw new Error('script_hash_mismatch');
    globalThis.catDartServerPort = () => 0;
    globalThis.catServerFactory = (handler) => {
      if (server) throw new Error('multiple_servers');
      server = http.createServer(handler);
      const listen = server.listen;
      server.listen = function (options, ...args) {
        if (!options || typeof options !== 'object') throw new Error('unknown_listen_contract');
        return listen.call(this, { ...options, host: '127.0.0.1', port: 0 }, ...args);
      };
      server.once('listening', () => {
        const address = server.address();
        if (address?.address !== '127.0.0.1') throw new Error('unexpected_listen_address');
        process.send?.({ type: 'ready', port: address.port });
      });
      return server;
    };
    source = require(scriptPath);
    if (typeof source.start !== 'function' || typeof source.stop !== 'function') {
      throw new Error('unsupported_host_contract');
    }
    await source.start(message.config);
  } catch {
    process.send?.({ type: 'failed' });
    process.exitCode = 1;
    if (server) server.close();
    setTimeout(() => process.exit(1), 50).unref();
  }
});

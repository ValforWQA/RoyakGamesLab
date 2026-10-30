'use strict';
// Local, destination-pinned RFC6455 binary WebSocket <-> TCP relay.
const net = require('net');
const crypto = require('crypto');
const MAX_FRAME = 8 * 1024 * 1024;
function startSocketBridge({host, port, onLog = console.log}) {
  if (typeof host !== 'string' || !host || !Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid bridge destination');
  return new Promise((resolve, reject) => {
    const server = net.createServer(ws => {
      let tcp, upgraded = false, closed = false, buffer = Buffer.alloc(0), fragment = null, fragmentSize = 0;
      const cleanup = () => { if (closed) return; closed = true; ws.destroy(); tcp?.destroy(); };
      const sendFrame = (opcode, payload = Buffer.alloc(0)) => {
        if (closed || !upgraded || !ws.writable) return;
        const n = payload.length;
        const header = Buffer.alloc(n < 126 ? 2 : n <= 65535 ? 4 : 10);
        header[0] = 0x80 | opcode;
        if (n < 126) header[1] = n;
        else if (n <= 65535) { header[1] = 126; header.writeUInt16BE(n, 2); }
        else { header[1] = 127; header.writeBigUInt64BE(BigInt(n), 2); }
        if (!ws.write(Buffer.concat([header, payload]))) tcp?.pause();
      };
      const handleData = data => {
        if (!tcp || tcp.destroyed) return cleanup();
        if (!tcp.write(data)) ws.pause();
      };
      const consumeFrames = () => {
        while (buffer.length >= 2 && !closed) {
          const first = buffer[0], second = buffer[1], opcode = first & 15, fin = !!(first & 128);
          if ((first & 0x70) || !(second & 128)) return cleanup();
          let size = second & 127, pos = 2;
          if (size === 126) { if (buffer.length < 4) return; size = buffer.readUInt16BE(2); pos = 4; }
          if (size === 127) { if (buffer.length < 10) return; const big = buffer.readBigUInt64BE(2); if (big > BigInt(MAX_FRAME)) return cleanup(); size = Number(big); pos = 10; }
          if (size > MAX_FRAME || buffer.length < pos + 4 + size) return size > MAX_FRAME ? cleanup() : undefined;
          const mask = buffer.subarray(pos, pos + 4); pos += 4;
          const data = Buffer.from(buffer.subarray(pos, pos + size)); buffer = buffer.subarray(pos + size);
          for (let i = 0; i < size; i++) data[i] ^= mask[i % 4];
          if (opcode >= 8) {
            if (!fin || size > 125) return cleanup();
            if (opcode === 8) { sendFrame(8, data); return cleanup(); }
            if (opcode === 9) sendFrame(10, data);
            else if (opcode !== 10) return cleanup();
            continue;
          }
          if (opcode === 0) {
            if (!fragment) return cleanup(); fragment.push(data); fragmentSize += size;
            if (fragmentSize > MAX_FRAME) return cleanup();
            if (fin) { handleData(Buffer.concat(fragment)); fragment = null; fragmentSize = 0; }
          } else if (opcode === 2) {
            if (fragment) return cleanup();
            if (fin) handleData(data); else { fragment = [data]; fragmentSize = size; }
          } else return cleanup(); // no text protocol
        }
      };
      ws.on('data', chunk => {
        if (closed) return;
        buffer = Buffer.concat([buffer, chunk]);
        if (!upgraded) {
          if (buffer.length > 16384) return cleanup();
          const end = buffer.indexOf('\r\n\r\n'); if (end === -1) return;
          const request = buffer.subarray(0, end).toString('latin1'); buffer = buffer.subarray(end + 4);
          const lines = request.split('\r\n');
          const headers = Object.fromEntries(lines.slice(1).map(line => { const p = line.indexOf(':'); return p < 0 ? ['', ''] : [line.slice(0,p).trim().toLowerCase(),line.slice(p+1).trim()]; }));
          const key = headers['sec-websocket-key'];
          if (!/^GET \/ HTTP\/1\.[01]$/.test(lines[0]) || !key || Buffer.from(key, 'base64').length !== 16 || headers['upgrade']?.toLowerCase() !== 'websocket' || !headers['connection']?.toLowerCase().split(',').map(x=>x.trim()).includes('upgrade') || headers['sec-websocket-version'] !== '13') return cleanup();
          // This bridge is reachable only on loopback and accepts only local file:// Ruffle pages.
          if (headers['origin'] && headers['origin'] !== 'null' && !headers['origin'].startsWith('file://')) return cleanup();
          const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
          ws.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
          upgraded = true;
          tcp = net.connect({host, port});
          tcp.setTimeout(30000, () => { onLog('[RoyakSocketBridge] TCP idle timeout before traffic'); cleanup(); });
          tcp.once('connect', () => { tcp.setTimeout(0); onLog(`[RoyakSocketBridge] Connected to ${host}:${port}`); });
          tcp.on('data', data => sendFrame(2, data));
          tcp.on('drain', () => ws.resume());
          tcp.on('error', err => { onLog(`[RoyakSocketBridge] TCP error ${err.message}`); cleanup(); });
          tcp.on('close', cleanup);
          ws.on('drain', () => tcp?.resume());
        }
        if (upgraded) consumeFrames();
      });
      ws.on('error', cleanup); ws.on('close', cleanup); ws.on('end', cleanup);
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const localPort = server.address().port;
      onLog(`[RoyakSocketBridge] Listening on 127.0.0.1:${localPort} -> ${host}:${port}`);
      resolve({url: `ws://127.0.0.1:${localPort}/`, close: () => server.close(), server});
    });
  });
}
module.exports = {startSocketBridge};

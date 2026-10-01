'use strict';
// 测试专用：Node 标准 HTTP/2 调用既有 StatsService，不引入 gRPC 运行依赖。
const http2 = require('node:http2');
function varint(value) { const bytes = []; let n = BigInt(value); do { let b = Number(n & 127n); n >>= 7n; if (n) b |= 128; bytes.push(b); } while (n); return Buffer.from(bytes); }
function readVarint(buffer, state) { let value = 0n; let shift = 0n; for (let i = 0; i < 10; i++) { if (state.at >= buffer.length) throw Error('Truncated protobuf'); const byte = buffer[state.at++]; value |= BigInt(byte & 127) << shift; if (!(byte & 128)) return value; shift += 7n; } throw Error('Invalid protobuf varint'); }
function fields(buffer) {
  const values = []; const state = { at: 0 };
  while (state.at < buffer.length) { const tag = Number(readVarint(buffer, state)); const wire = tag & 7; let value;
    if (wire === 0) value = readVarint(buffer, state);
    else if (wire === 2) { const n = Number(readVarint(buffer, state)); if (state.at + n > buffer.length) throw Error('Truncated protobuf field'); value = buffer.subarray(state.at, state.at + n); state.at += n; }
    else throw Error('Unexpected stats wire type');
    values.push({ field: tag >> 3, value });
  }
  return values;
}
async function queryStats(port) {
  const text = Buffer.from('user>>>'); const payload = Buffer.concat([Buffer.from([26]), varint(text.length), text]);
  const header = Buffer.alloc(5); header.writeUInt32BE(payload.length, 1);
  const session = http2.connect(`http://127.0.0.1:${port}`);
  try {
    const body = await new Promise((resolve, reject) => {
      const chunks = []; let size = 0; let grpcStatus = null;
      const req = session.request({ ':method': 'POST', ':path': '/v2ray.core.app.stats.command.StatsService/QueryStats', 'content-type': 'application/grpc', te: 'trailers' });
      const timer = setTimeout(() => { req.destroy(); reject(Error('Stats request timed out')); }, 3000);
      session.once('error', reject); req.once('error', reject);
      req.on('trailers', (trailers) => { grpcStatus = trailers['grpc-status']; });
      req.on('data', (chunk) => { size += chunk.length; if (size > 1024 * 1024) { req.destroy(); reject(Error('Stats response exceeds limit')); } else chunks.push(chunk); });
      req.once('end', () => { clearTimeout(timer); if (String(grpcStatus) !== '0') reject(Error('Stats gRPC failed')); else resolve(Buffer.concat(chunks)); });
      req.end(Buffer.concat([header, payload]));
    });
    if (body.length < 5 || body[0] !== 0 || body.readUInt32BE(1) !== body.length - 5) throw Error('Invalid gRPC stats frame');
    const counters = fields(body.subarray(5)).filter(f => f.field === 1).map(f => {
      const stat = fields(f.value); return { name: stat.find(v => v.field === 1)?.value.toString() || '', value: stat.find(v => v.field === 2)?.value || 0n };
    });
    const records = new Map();
    for (const { name, value } of counters) { const parts = name.split('>>>'); if (parts.length !== 4 || parts[0] !== 'user' || parts[2] !== 'traffic') continue;
      const row = records.get(parts[1]) || { userUuid: parts[1], uploadTotal: '0', downloadTotal: '0' };
      if (parts[3] === 'uplink') row.uploadTotal = String(value); if (parts[3] === 'downlink') row.downloadTotal = String(value); records.set(parts[1], row);
    }
    return [...records.values()];
  } finally { session.destroy(); }
}
module.exports = { queryStats };

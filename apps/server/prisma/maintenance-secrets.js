'use strict';
const { decryptSecret } = require('./secret-crypto');
const { EXIT, fail } = require('./maintenance-errors');
// 只检查存储契约中的密文字段，不能把普通昵称/文档中的 enc:v1 示例当作密文。
const SECRET_FIELDS = {
  Node: ['agentToken'], Certificate: ['privateKeyPem'], CertificateRevision: ['privateKeyPem'],
  SystemSetting: ['value'], Line: ['egressProxyJson', 'paramsJson'], NodeInbound: ['paramsJson'],
  UpstreamSubscription: ['url', 'content', 'customHeadersJson'], UpstreamNode: ['paramsJson', 'rawConfigJson'],
  LineCredential: ['encryptedPayload']
};
function checkValue(value) {
  if (typeof value !== 'string' || !value.startsWith('enc:v1:')) return;
  try { decryptSecret(value); } catch { fail('KEY_MISMATCH', 'The encryption key cannot decrypt stored configuration.', EXIT.KEY_MISMATCH); }
}
function identifier(name) { return String.fromCharCode(34) + name + String.fromCharCode(34); }
async function verifyStoredSecrets(client) {
  const tables = new Set((await client.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE type='table'")).map((row) => row.name));
  for (const [table, expected] of Object.entries(SECRET_FIELDS)) {
    if (!tables.has(table)) continue;
    const tableName = identifier(table);
    const columns = new Set((await client.$queryRawUnsafe(`PRAGMA table_info(${tableName})`)).map((column) => column.name));
    const fields = expected.filter((column) => columns.has(column));
    if (!fields.length) continue;
    const predicate = fields.map((field) => `instr(${identifier(field)}, 'enc:v1:') > 0`).join(' OR ');
    const settingsFilter = table === 'SystemSetting' ? " AND key IN ('smtpPass', 'turnstileSecretKey')" : '';
    let cursor = -1n;
    while (true) {
      // 小批次扫描真实密文字段；不输出 SQL 行、明文或异常对象。
      const rows = await client.$queryRawUnsafe(`SELECT rowid AS _maintenance_rowid, ${fields.map(identifier).join(', ')} FROM ${tableName} WHERE rowid > ? AND (${predicate})${settingsFilter} ORDER BY rowid LIMIT 16`, cursor);
      if (!rows.length) break;
      for (const row of rows) {
        cursor = BigInt(row._maintenance_rowid);
        for (const field of fields) {
          if (field === 'paramsJson' && (table === 'Line' || table === 'NodeInbound')) {
            let params;
            try { params = JSON.parse(row[field]); } catch { fail('INVALID_SECRET_CONFIG', 'Stored inbound secret configuration is invalid.', EXIT.DATABASE); }
            checkValue(params?.tls?.reality?.privateKey);
          } else checkValue(row[field]);
        }
      }
    }
  }
}
module.exports = { verifyStoredSecrets };

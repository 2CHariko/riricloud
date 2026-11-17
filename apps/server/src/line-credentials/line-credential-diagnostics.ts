// 只保留可由已下发配置脱敏的诊断；未知版本不能借回执回显任意凭据。
export interface ConfigDiagnosticSecrets { values: string[]; complete: boolean }
export function configDiagnosticSecrets(config: unknown): ConfigDiagnosticSecrets {
  const values = new Set<string>();
  let complete = true;
  let size = 0;
  function visit(value: unknown, sensitive = false, depth = 0) {
    if (depth > 32 || values.size > 10_000 || size > 2 * 1024 * 1024) { complete = false; return; }
    if (typeof value === 'string') {
      if (sensitive || value.startsWith('relay-')) { if (!values.has(value)) size += value.length; if (value) values.add(value); }
      return;
    }
    if (Array.isArray(value)) { for (const item of value) visit(item, sensitive, depth + 1); return; }
    if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) visit(item, sensitive || /password|private.?key|secret|token|uuid|username/i.test(key) || key === 'key', depth + 1);
  }
  visit(config);
  return { values: [...values].sort((a, b) => b.length - a.length), complete };
}
export function redactConfigDiagnostic(message: string, secrets?: ConfigDiagnosticSecrets): string {
  if (!secrets?.complete || message.length > 32_768) return 'Agent rejected node configuration';
  let safe = message;
  for (const secret of secrets.values) safe = safe.split(secret).join('[REDACTED]');
  return safe.slice(0, 8192);
}

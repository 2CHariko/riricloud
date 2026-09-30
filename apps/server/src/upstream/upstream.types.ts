export interface ParsedUpstreamNode {
  name: string;
  protocolType: string;
  serverHost: string;
  serverPort: number;
  params: Record<string, unknown>;
  rawConfig: { kind: 'URI'; value: string } | { kind: 'STRUCTURED'; value: Record<string, unknown> };
  sourceKey?: string;
  connectionHash: string;
  configHash: string;
  tags: string[];
}

export interface UpstreamUserInfo {
  uploadBytes?: bigint;
  downloadBytes?: bigint;
  usedBytes?: bigint;
  totalBytes?: bigint;
  expireAt?: Date;
}

export interface ParseResult {
  format: 'CLASH_META' | 'SINGBOX' | 'URI_LIST';
  nodes: ParsedUpstreamNode[];
  diagnostics: { recognized: number; duplicates: number; skipped: number };
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().filter((key) => object[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

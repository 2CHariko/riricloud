import { ProtocolType } from '../common/constants';

export interface ParsedUpstreamNode {
  name: string;
  protocolType: ProtocolType | string;
  serverHost: string;
  serverPort: number;
  params: Record<string, unknown>;
  rawConfig: Record<string, unknown> | string;
  fingerprint: string;
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
}

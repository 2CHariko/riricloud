import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { LineCredential, LineCredentialRotation } from '@prisma/client';
import type { InboundUserCredential } from '../common/inbound';
import { decryptSecret, encryptSecret, isEncryptedSecret } from '../common/secret-crypto';

export const ROTATION_STAGE_TIMEOUT_MS = 120_000;
export const RUNNING_ROTATION_STAGES = ['STOPPING_PREVIOUS_ENTRY', 'STOPPING_ENTRY', 'APPLYING_LANDING', 'RESTORING_ENTRY', 'RETIRING_PREVIOUS_LANDING'];
export interface RelayCredentialView {
  lineId: string;
  rotationId: string;
  operationId: string;
  stage: string;
  targetVersion: number;
  entryNodeId: string;
  landingNodeId: string;
  previousEntryNodeId: string | null;
  previousLandingNodeId: string | null;
  targetLineId: string | null;
  entryEnabled: boolean;
  credential: InboundUserCredential | null;
}
export const credentialFingerprint = (value: string) => createHash('sha256').update(value).digest('hex');

function validVersion(version: number | null): version is number {
  return typeof version === 'number' && Number.isSafeInteger(version) && version > 0;
}

export function newRelayCredential(lineId: string, version: number) {
  if (typeof lineId !== 'string' || !lineId.trim() || !validVersion(version)) throw new Error('LINE_CREDENTIAL_UNAVAILABLE');
  try {
    const value: InboundUserCredential = {
      uuid: randomUUID(), email: 'relay-' + randomBytes(24).toString('hex'), credential: randomBytes(32).toString('base64url')
    };
    return { lineId, version, encryptedPayload: encryptSecret(JSON.stringify(value)), uuidHash: credentialFingerprint(value.uuid), nameHash: credentialFingerprint(value.email), status: 'PENDING' };
  } catch {
    throw new Error('LINE_CREDENTIAL_UNAVAILABLE');
  }
}

function validEncryptedPayload(payload: string): boolean {
  if (!isEncryptedSecret(payload) || payload.length > 4096) return false;
  const parts = payload.split(':');
  if (parts.length !== 5) return false;
  const [, , iv, tag, ciphertext] = parts;
  // Node 的 Base64 解码会忽略非法字符；应用层信封必须唯一且使用完整 128 位 GCM 标签。
  const canonical = (value: string) => value.length > 0 && Buffer.from(value, 'base64').toString('base64') === value;
  return [iv, tag, ciphertext].every(canonical) &&
    Buffer.from(iv, 'base64').length === 12 && Buffer.from(tag, 'base64').length === 16;
}

export function revealRelayCredential(record: Pick<LineCredential, 'encryptedPayload' | 'status'>): InboundUserCredential {
  try {
    if (!['PENDING', 'ACTIVE'].includes(record.status) || typeof record.encryptedPayload !== 'string' || !validEncryptedPayload(record.encryptedPayload)) {
      throw new Error();
    }
    const value: unknown = JSON.parse(decryptSecret(record.encryptedPayload));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const v = value as Record<string, unknown>;
    if (Object.keys(v).length !== 3 ||
        typeof v.uuid !== 'string' || v.uuid.length !== 36 || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v.uuid) ||
        typeof v.email !== 'string' || v.email.length !== 54 || !/^relay-[a-f0-9]{48}$/.test(v.email) ||
        typeof v.credential !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(v.credential) ||
        Buffer.from(v.credential, 'base64url').toString('base64url') !== v.credential) throw new Error();
    // 完整数据库记录的两枚指纹必须与密文一致，拒绝只替换密文的跨线路错配。
    // 仍兼容原接口的仅密文/状态视图；作用域授权由服务端查询与拓扑核对负责。
    if ('uuidHash' in record || 'nameHash' in record) {
      if (!('uuidHash' in record) || !('nameHash' in record) ||
          record.uuidHash !== credentialFingerprint(v.uuid) || record.nameHash !== credentialFingerprint(v.email)) throw new Error();
    }
    return { uuid: v.uuid, email: v.email, credential: v.credential };
  } catch {
    // 不携带 cause，避免底层解密/解析错误把秘密带入 API 或日志。
    throw new Error('LINE_CREDENTIAL_UNAVAILABLE');
  }
}

export function credentialVersionForRotation(rotation: LineCredentialRotation): number | null {
  const stage = rotation.stage === 'FAILED' ? rotation.failedStage : rotation.stage;
  if (!stage || !(rotation.stage === 'FAILED' ? RUNNING_ROTATION_STAGES : [...RUNNING_ROTATION_STAGES, 'CONFIRMED']).includes(stage)) return null;
  if (stage === 'STOPPING_PREVIOUS_ENTRY' || stage === 'RETIRING_PREVIOUS_LANDING') return null;
  const version = stage === 'STOPPING_ENTRY' ? (rotation.landingCredentialVersion ?? null) : rotation.targetVersion;
  return validVersion(version) ? version : null;
}

export function expectedRotationNode(rotation: Pick<LineCredentialRotation, 'stage' | 'entryNodeId' | 'landingNodeId' | 'previousEntryNodeId' | 'previousLandingNodeId'>): string {
  const nodeId = rotation.stage === 'STOPPING_PREVIOUS_ENTRY' ? rotation.previousEntryNodeId :
    rotation.stage === 'RETIRING_PREVIOUS_LANDING' ? rotation.previousLandingNodeId :
    rotation.stage === 'APPLYING_LANDING' ? rotation.landingNodeId : rotation.entryNodeId;
  if (!nodeId) throw new Error('LINE_CREDENTIAL_TARGET_UNAVAILABLE');
  return nodeId;
}

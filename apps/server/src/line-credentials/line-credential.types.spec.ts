import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import type { LineCredentialRotation } from '@prisma/client';
import { decryptSecret, encryptSecret } from '../common/secret-crypto';
import { buildServerInbound, normalizeShadowsocksPassword } from '../common/inbound';
import {
  credentialFingerprint, credentialVersionForRotation, expectedRotationNode,
  newRelayCredential, revealRelayCredential, ROTATION_STAGE_TIMEOUT_MS
} from './line-credential.types';

const material = () => ({
  uuid: '4c0b494f-d32e-427a-91e9-aa02b479a0cc',
  email: 'relay-' + 'ab'.repeat(24), credential: Buffer.alloc(32, 7).toString('base64url')
});
function encrypted(value: unknown) { return { status: 'ACTIVE', encryptedPayload: encryptSecret(JSON.stringify(value)) }; }
function expectUnavailable(record: Parameters<typeof revealRelayCredential>[0] & { uuidHash?: string; nameHash?: string }) {
  try { revealRelayCredential(record); } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('LINE_CREDENTIAL_UNAVAILABLE');
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    return;
  }
  throw new Error('Expected invalid credential material to be rejected');
}

describe('relay credential encrypted material', () => {
  const priorKey = process.env.RIRICLOUD_ENCRYPTION_KEY;
  beforeEach(() => { process.env.RIRICLOUD_ENCRYPTION_KEY = 'isolated-test-key-no-production-use'; });
  afterAll(() => {
    if (priorKey === undefined) delete process.env.RIRICLOUD_ENCRYPTION_KEY;
    else process.env.RIRICLOUD_ENCRYPTION_KEY = priorKey;
  });

  it('returns only encrypted persistence data and independent identities for every line and version', () => {
    const records = Array.from({ length: 24 }, (_, index) => newRelayCredential(index % 2 ? 'source-a' : 'source-b', 1 + Math.floor(index / 2)));
    const values = records.map(revealRelayCredential);
    for (const field of ['uuid', 'email', 'credential'] as const) expect(new Set(values.map(value => value[field])).size).toBe(records.length);
    records.forEach((record, index) => {
      expect(Object.keys(record).sort()).toEqual(['encryptedPayload', 'lineId', 'nameHash', 'status', 'uuidHash', 'version']);
      expect(record.status).toBe('PENDING');
      expect(record.encryptedPayload).toMatch(/^enc:v1:/);
      expect(JSON.parse(decryptSecret(record.encryptedPayload))).toEqual(values[index]);
      expect(record.uuidHash).toBe(credentialFingerprint(values[index].uuid));
      expect(record.nameHash).toBe(credentialFingerprint(values[index].email));
      for (const raw of Object.values(values[index])) expect(JSON.stringify(record)).not.toContain(raw);
      expect(Buffer.from(values[index].credential, 'base64url')).toHaveLength(32);
    });
  });

  it.each(['aes-256-gcm', '2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm'])('compiles independent shared SS landing secrets for %s', method => {
    const records = [newRelayCredential('source-a', 1), newRelayCredential('source-b', 1), newRelayCredential('source-a', 2)];
    const inbounds = records.map(record => {
      const credential = revealRelayCredential(record);
      const inbound = buildServerInbound({
        type: 'SHADOWSOCKS', tag: record.lineId, lineId: record.lineId, listen: '127.0.0.1', port: 24100,
        params: { method, mode: 'shared', password: credential.credential }, users: [credential]
      });
      expect(inbound.password).toBe(normalizeShadowsocksPassword(method, credential.credential));
      expect(inbound.users).toBeUndefined();
      return inbound;
    });
    expect(new Set(inbounds.map(inbound => inbound.password)).size).toBe(3);
  });

  it('rejects copied ciphertext when the stored line identity fingerprints do not match', () => {
    const sourceA = newRelayCredential('source-a', 1);
    const sourceB = newRelayCredential('source-b', 1);
    expectUnavailable({ ...sourceA, encryptedPayload: sourceB.encryptedPayload });
  });

  it('rejects mismatched or incomplete supplied identity fingerprints', () => {
    const record = newRelayCredential('source-a', 1);
    expectUnavailable({ ...record, uuidHash: '0'.repeat(64) });
    expectUnavailable({ ...record, nameHash: '0'.repeat(64) });
    const incomplete = { status: record.status, encryptedPayload: record.encryptedPayload, uuidHash: record.uuidHash };
    expectUnavailable(incomplete);
  });

  it('does not use a predictable line ID or version as a credential', () => {
    const first = newRelayCredential('same-source', 5);
    const second = newRelayCredential('same-source', 5);
    expect(revealRelayCredential(first)).not.toEqual(revealRelayCredential(second));
    expect(first.encryptedPayload).not.toBe(second.encryptedPayload);
  });

  it.each(['ACTIVE', 'PENDING'])('accepts only defined usable status %s', status => {
    expect(revealRelayCredential({ ...encrypted(material()), status })).toEqual(material());
  });
  it.each(['REVOKED', 'UNKNOWN', 'FAILED', '', 'active'])('rejects unusable status %s', status => {
    expectUnavailable({ ...encrypted(material()), status });
  });
  it.each([null, '', 'plain-secret', JSON.stringify(material()), 'enc:v2:opaque', 'enc:v1:broken'])('rejects non-GCM or broken envelope', encryptedPayload => {
    expectUnavailable({ status: 'ACTIVE', encryptedPayload });
  });

  it('rejects modified IV, authentication tag, ciphertext and an incorrect application key', () => {
    const record = encrypted(material());
    for (const field of [2, 3, 4]) {
      const parts = record.encryptedPayload.split(':');
      const bytes = Buffer.from(parts[field], 'base64');
      bytes[0] ^= 1;
      parts[field] = bytes.toString('base64');
      expectUnavailable({ ...record, encryptedPayload: parts.join(':') });
    }
    process.env.RIRICLOUD_ENCRYPTION_KEY = 'different-isolated-test-key';
    expectUnavailable(record);
  });

  it('rejects trailing fields and noncanonical Base64 that Node would otherwise decode', () => {
    const record = encrypted(material());
    expectUnavailable({ ...record, encryptedPayload: record.encryptedPayload + ':unexpected' });
    for (const field of [2, 3, 4]) {
      const parts = record.encryptedPayload.split(':');
      parts[field] = '!' + parts[field];
      expectUnavailable({ ...record, encryptedPayload: parts.join(':') });
    }
    const parts = record.encryptedPayload.split(':');
    parts[3] = parts[3].replace(/=+$/, '');
    expectUnavailable({ ...record, encryptedPayload: parts.join(':') });
  });

  it('rejects authenticated GCM envelopes with shortened tags or nonstandard IV lengths', () => {
    for (const [ivLength, tagLength] of [[12, 12], [16, 16]]) {
      const iv = randomBytes(ivLength);
      const key = createHash('sha256').update(process.env.RIRICLOUD_ENCRYPTION_KEY!).digest();
      const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: tagLength });
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(material()), 'utf8'), cipher.final()]);
      const encryptedPayload = ['enc', 'v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(':');
      expectUnavailable({ status: 'ACTIVE', encryptedPayload });
    }
  });

  it.each([
    null, [], 1, 'secret', {},
    { ...material(), uuid: '-'.repeat(36) },
    { ...material(), uuid: material().uuid + String.fromCharCode(10) },
    { ...material(), email: material().email + String.fromCharCode(13, 10) },
    { ...material(), uuid: '00000000-0000-0000-0000-000000000000' },
    { ...material(), uuid: '4c0b494f-d32e-127a-91e9-aa02b479a0cc' },
    { ...material(), uuid: '4c0b494f-d32e-427a-71e9-aa02b479a0cc' },
    { ...material(), email: 'relay-known' },
    { ...material(), email: 'relay-' + 'ab'.repeat(24) + String.fromCharCode(10) },
    { ...material(), credential: 'guessable' },
    { ...material(), credential: 'A'.repeat(42) + 'B' },
    { ...material(), credential: Buffer.alloc(32).toString('base64') },
    { ...material(), unexpectedSecret: 'do-not-forward' }
  ])('fails closed on invalid decrypted material %#', value => {
    expectUnavailable(encrypted(value));
  });

  it('keeps the raw parse error and corrupted secret out of the error response', () => {
    expectUnavailable({ status: 'ACTIVE', encryptedPayload: encryptSecret('{"credential":"sensitive-fixture"') });
  });

  it.each([['', 1], ['  ', 1], ['source-a', 0], ['source-a', -1], ['source-a', 1.5], ['source-a', NaN], ['source-a', Number.MAX_SAFE_INTEGER + 1]] as Array<[string, number]>)('rejects invalid persistence scope %#', (lineId, version) => {
    expect(() => newRelayCredential(lineId, version)).toThrow('LINE_CREDENTIAL_UNAVAILABLE');
  });
});

describe('relay maintenance credential selection', () => {
  const rotation = (stage: string, failedStage: string | null = null) => ({ stage, failedStage, fromVersion: 1, targetVersion: 2, landingCredentialVersion: 1, entryNodeId: 'entry', landingNodeId: 'landing', previousEntryNodeId: 'old-entry', previousLandingNodeId: 'old-landing' }) as LineCredentialRotation;
  it.each([
    ['STOPPING_PREVIOUS_ENTRY', null, null], ['RETIRING_PREVIOUS_LANDING', null, null],
    ['FAILED', 'STOPPING_PREVIOUS_ENTRY', null], ['FAILED', 'RETIRING_PREVIOUS_LANDING', null],
    ['STOPPING_ENTRY', null, 1], ['APPLYING_LANDING', null, 2], ['RESTORING_ENTRY', null, 2], ['CONFIRMED', null, 2],
    ['FAILED', 'STOPPING_ENTRY', 1], ['FAILED', 'APPLYING_LANDING', 2], ['FAILED', 'RESTORING_ENTRY', 2]
  ])('selects the documented version for %s/%s', (stage, failedStage, expected) => {
    expect(credentialVersionForRotation(rotation(stage as string, failedStage as string | null))).toBe(expected);
  });
  it('keeps first enrollment stopped without inventing an old version', () => {
    expect(credentialVersionForRotation({ ...rotation('STOPPING_ENTRY'), landingCredentialVersion: null })).toBeNull();
  });
  it.each([['UNKNOWN', null], ['FAILED', null], ['FAILED', 'CONFIRMED'], ['FAILED', 'UNKNOWN']] as Array<[string, string | null]>)('does not select a secret from an invalid state %s/%s', (stage, failedStage) => {
    expect(credentialVersionForRotation(rotation(stage, failedStage))).toBeNull();
  });
  it('rejects invalid selected credential versions', () => {
    expect(credentialVersionForRotation({ ...rotation('APPLYING_LANDING'), targetVersion: 0 })).toBeNull();
  });
  it('never confirms a new node when a required previous-node identity is missing', () => {
    expect(() => expectedRotationNode({ ...rotation('STOPPING_PREVIOUS_ENTRY'), previousEntryNodeId: null })).toThrow('LINE_CREDENTIAL_TARGET_UNAVAILABLE');
    expect(() => expectedRotationNode({ ...rotation('RETIRING_PREVIOUS_LANDING'), previousLandingNodeId: null })).toThrow('LINE_CREDENTIAL_TARGET_UNAVAILABLE');
  });
  it('selects only the intended node and retains the 120-second maintenance budget', () => {
    expect(expectedRotationNode(rotation('APPLYING_LANDING'))).toBe('landing');
    expect(expectedRotationNode(rotation('STOPPING_PREVIOUS_ENTRY'))).toBe('old-entry');
    expect(expectedRotationNode(rotation('RETIRING_PREVIOUS_LANDING'))).toBe('old-landing');
    for (const stage of ['STOPPING_ENTRY', 'RESTORING_ENTRY', 'FAILED']) expect(expectedRotationNode(rotation(stage))).toBe('entry');
    expect(ROTATION_STAGE_TIMEOUT_MS).toBe(120_000);
  });
});

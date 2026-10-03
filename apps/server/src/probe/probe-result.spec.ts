import { readLastDebugProbe, readLastProbe, safeProbeResult } from './probe-result';
import type { ProbeResult } from './probe.types';

function result(): ProbeResult {
  return { schemaVersion: 2, subjectType: 'UPSTREAM_NODE', subjectId: 'node', status: 'SUCCESS', errorCode: null, message: 'URL_TEST_OK', engine: 'MIHOMO', engineVersion: '1.19.30', fallbackReason: null, mihomoCompatibility: 'SUPPORTED', measurement: 'MIHOMO_URL_TEST', perspective: 'MASTER', routeKind: 'UPSTREAM_DIRECT', targetId: 'target', targetHost: 'example.com', testedAt: new Date(1).toISOString(), durationMs: 20, latencyMs: 10, stage: 'DIAL_HTTP', configHash: 'hash', applied: true };
}
const debug = (): ProbeResult => ({ ...result(), schemaVersion: 1, measurement: 'PROXY_HTTP_DELAY' });

describe('安全测量结果与分离的历史快照', () => {
  it('仅接受普通 schema2 与严格 schema1 的匹配组合', () => {
    expect(safeProbeResult(result())).toEqual(result());
    expect(safeProbeResult(debug())).toEqual(debug());
    expect(safeProbeResult({ ...result(), schemaVersion: 1 })).toBeNull();
    expect(safeProbeResult({ ...debug(), schemaVersion: 2 })).toBeNull();
    expect(safeProbeResult({ ...result(), measurement: 'TCP' })).toBeNull();
    expect(safeProbeResult({ status: 'SUCCESS', latencyMs: 10 })).toBeNull();
  });
  it.each(['SUCCESS', 'ERROR', 'UNSUPPORTED'])('普通 %s 不能伪装 Sing-box 或回退结果', (status) => {
    expect(safeProbeResult({ ...result(), status, engine: 'SINGBOX' })).toBeNull();
    expect(safeProbeResult({ ...result(), status, fallbackReason: 'MIHOMO_UNSUPPORTED' })).toBeNull();
  });
  it.each([0, -1, 1.5, 65536, null, undefined, Number.NaN, Number.POSITIVE_INFINITY, '10'])('普通成功拒绝无效延迟 %s', (latencyMs) => {
    expect(safeProbeResult({ ...result(), latencyMs })).toBeNull();
  });
  it.each([null, undefined, 'TCP'])('成功拒绝无效内核 %s', (engine) => {
    expect(safeProbeResult({ ...result(), engine })).toBeNull();
    expect(safeProbeResult({ ...debug(), engine })).toBeNull();
  });
  it.each(['ERROR', undefined])('成功必须显式 errorCode=null，拒绝 %s', (errorCode) => {
    expect(safeProbeResult({ ...result(), errorCode })).toBeNull();
    expect(safeProbeResult({ ...debug(), errorCode })).toBeNull();
  });
  it('严格结果保留零延迟与明确兼容回退；失败延迟置空', () => {
    expect(safeProbeResult({ ...debug(), latencyMs: 0, engine: 'SINGBOX', fallbackReason: 'MIHOMO_UNSUPPORTED' })).toMatchObject({ latencyMs: 0, engine: 'SINGBOX' });
    expect(safeProbeResult({ ...debug(), latencyMs: -1 })).toBeNull();
    expect(safeProbeResult({ ...result(), status: 'ENVIRONMENT_UNAVAILABLE', errorCode: 'KERNEL_UNAVAILABLE', engine: null })).toMatchObject({ latencyMs: null, engine: null });
  });
  it('普通读取拒绝严格/TCP 历史，内部严格读取拒绝普通历史', () => {
    expect(readLastProbe(JSON.stringify(debug()))).toBeNull();
    expect(readLastProbe('{"status":"SUCCESS","latencyMs":10}')).toBeNull();
    expect(readLastDebugProbe(JSON.stringify(result()))).toBeNull();
    expect(readLastDebugProbe(JSON.stringify(debug()))).toEqual(debug());
    expect(readLastProbe('invalid')).toBeNull();
    expect(readLastDebugProbe(null)).toBeNull();
  });
  it.each([result(), debug()])('各自读取沿用资源可用性与配置 hash 失效规则', (value) => {
    const read = value.schemaVersion === 2 ? readLastProbe : readLastDebugProbe;
    const json = JSON.stringify(value);
    expect(read(json, true, 'hash')).toEqual(value);
    expect(read(json, false)).toMatchObject({ status: 'STALE', errorCode: 'RESOURCE_UNAVAILABLE', latencyMs: null, applied: false, stage: 'PERSIST' });
    expect(read(json, true, 'changed')).toMatchObject({ status: 'STALE', latencyMs: null });
  });
  it('只投影安全字段，不输出原始 JSON 或嵌套秘密', () => {
    const safe = safeProbeResult({ ...result(), connection: { password: 'secret' }, lastDebugProbeJson: 'secret', resourceVersion: 'secret' });
    expect(safe).toEqual(result());
    expect(JSON.stringify(safe)).not.toContain('secret');
  });
});

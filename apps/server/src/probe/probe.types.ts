import type { UpstreamConnection } from '../common/upstream-connection';

export type ProbeEngine = 'MIHOMO' | 'SINGBOX';
export type ProbePolicy = 'MIHOMO_PREFERRED' | 'MIHOMO_ONLY';
export type ProbeStatus = 'SUCCESS' | 'TIMEOUT' | 'ERROR' | 'UNSUPPORTED' | 'ENVIRONMENT_UNAVAILABLE' | 'CANCELED' | 'STALE' | 'SKIPPED';
export type ProbeSubjectType = 'UPSTREAM_NODE' | 'LINE';
export type ProbeRouteKind = 'UPSTREAM_DIRECT' | 'MANAGED_DIRECT' | 'MANAGED_RELAY';
export interface ProbeConnectionRequest {
  subjectType: ProbeSubjectType;
  subjectId: string;
  connection: UpstreamConnection;
  configHash: string;
  routeKind: ProbeRouteKind;
  allowPrivateEndpoint?: boolean;
}
export interface ProbeResult {
  schemaVersion: 1;
  subjectType: ProbeSubjectType;
  subjectId: string;
  status: ProbeStatus;
  errorCode: string | null;
  message: string;
  engine: ProbeEngine | null;
  engineVersion: string | null;
  fallbackReason: string | null;
  mihomoCompatibility: 'SUPPORTED' | 'UNSUPPORTED';
  measurement: 'PROXY_HTTP_DELAY';
  perspective: 'MASTER';
  routeKind: ProbeRouteKind;
  targetId: string;
  targetHost: string;
  testedAt: string;
  durationMs: number;
  latencyMs: number | null;
  stage: 'VALIDATE' | 'START_KERNEL' | 'DIAL_HTTP' | 'PERSIST';
  configHash: string;
  applied: boolean;
}
export interface ProbeTarget {
  id: string;
  url: string;
  expectedStatus: number;
}
export interface KernelCheckResult {
  engine: ProbeEngine;
  engineVersion: string | null;
  status: 'PASSED' | 'FAILED' | 'UNAVAILABLE' | 'UNSUPPORTED' | 'EXTERNAL_RESOURCES_REQUIRED';
  executed: boolean;
  scope: 'FULL' | 'PARTIAL';
  diagnostics: string[];
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveE2eAgentVersion } from './dev-e2e-agent-version.mjs';

test('默认使用 Agent VERSION，而不是 Master package 版本', () => {
  assert.equal(resolveE2eAgentVersion({ declaredVersion: '0.8.5', buildVersion: '0.9.6' }), '0.8.5');
});

test('Agent VERSION 缺失时回退到构建版本', () => {
  assert.equal(resolveE2eAgentVersion({ buildVersion: '0.9.6' }), '0.9.6');
});

test('E2E_AGENT_VERSION 同时作为构建和默认资源版本', () => {
  assert.equal(resolveE2eAgentVersion({ agentVersion: '0.8.7', declaredVersion: '0.8.5' }), '0.8.7');
});

test('兼容 E2E_RESOURCE_VERSION 作为 Agent 构建版本覆盖', () => {
  assert.equal(resolveE2eAgentVersion({ resourceVersion: '0.8.8', declaredVersion: '0.8.5' }), '0.8.8');
});

test('明确拒绝构建版本和资源版本覆盖不一致', () => {
  assert.throws(
    () => resolveE2eAgentVersion({ agentVersion: '0.8.5', resourceVersion: '0.9.6', declaredVersion: '0.8.5' }),
    /必须使用同一版本/
  );
});

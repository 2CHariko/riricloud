import { UnauthorizedException } from '@nestjs/common';
import { BinariesController } from './binaries.controller';

describe('BinariesController', () => {
  it('按安装器 User-Agent 通过 Header 鉴权后直接流式返回 Agent 二进制', async () => {
    const response = { setHeader: jest.fn() };
    const binaries = {
      authorizeDownload: jest.fn().mockResolvedValue(undefined),
      resolveAgentTarget: jest.fn(() => 'agent-linux-amd64'),
      getAsset: jest.fn(() => ({ path: process.execPath, size: 3, filename: 'riri-agent' }))
    };
    const controller = new BinariesController(binaries as never);

    const result = await controller.downloadAgent('riri-agent-installer/linux-amd64', 'secret', response as never);

    expect(binaries.authorizeDownload).toHaveBeenCalledWith('secret');
    expect(binaries.resolveAgentTarget).toHaveBeenCalledWith('riri-agent-installer/linux-amd64');
    expect(binaries.getAsset).toHaveBeenCalledWith('agent-linux-amd64');
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(result).toBeDefined();
  });

  it('agentInstaller 支持 Header Token 鉴权与 format=bat 预编排渲染', async () => {
    const response = { setHeader: jest.fn() };
    const binaries = {
      findNodeByToken: jest.fn().mockResolvedValue({ id: 'node-1', communicationMode: 'WS' }),
      resolveAgentTarget: jest.fn(() => 'agent-windows-amd64')
    };
    const installer = {
      renderWindowsInstallBat: jest.fn().mockResolvedValue('@echo off\r\n')
    };
    const request = {
      headers: { host: 'panel.example.com' },
      protocol: 'https'
    };
    const controller = new BinariesController(binaries as never, installer as never);

    const result = await controller.agentInstaller(
      undefined,
      'token-from-header',
      undefined,
      'ws',
      'bat',
      'windows-amd64',
      '1',
      request as never,
      response as never
    );

    expect(binaries.findNodeByToken).toHaveBeenCalledWith('token-from-header');
    expect(installer.renderWindowsInstallBat).toHaveBeenCalledWith('windows-amd64', 'https://panel.example.com', {
      agentToken: 'token-from-header', masterUrl: 'wss://panel.example.com/ws/agent', mode: 'ws'
    });
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(response.setHeader).toHaveBeenCalledWith('Pragma', 'no-cache');
    expect(response.setHeader).toHaveBeenCalledWith('Content-Disposition', 'attachment; filename="riri-install.bat"');
    expect(result).toContain('@echo off');
  });

  it.each([
    [undefined, 'token-from-query'],
    ['token-from-header', 'token-from-query'],
    [undefined, ''],
    ['token-from-header', '']
  ])('agentInstaller 拒绝 Query Token（Header=%s，Query=%s）且不查询节点', async (headerToken, queryToken) => {
    const binaries = { findNodeByToken: jest.fn().mockResolvedValue({ id: 'node-1', communicationMode: 'WS' }) };
    const installer = { renderShellScript: jest.fn().mockResolvedValue('#!/bin/sh\n') };
    const response = { setHeader: jest.fn() };
    const request = { headers: { host: 'panel.example.com' }, protocol: 'https' };
    const controller = new BinariesController(binaries as never, installer as never);

    await expect(controller.agentInstaller(
      undefined, headerToken, queryToken, 'ws', undefined, 'linux-amd64', undefined, request as never, response as never
    )).rejects.toThrow(UnauthorizedException);

    expect(binaries.findNodeByToken).not.toHaveBeenCalled();
    expect(installer.renderShellScript).not.toHaveBeenCalled();
    expect(response.setHeader).not.toHaveBeenCalled();
  });

  it.each([
    ['linux-amd64', 'WS', 'ws', undefined, 'renderShellScript', 'wss://panel.example.com/ws/agent'],
    ['macos-arm64', 'HTTP', undefined, undefined, 'renderShellScript', 'https://panel.example.com'],
    ['windows-amd64', 'HTTP', 'ws', 'ps1', 'renderPowershellScript', 'wss://panel.example.com/ws/agent']
  ] as const)('agentInstaller 通过 Header 鉴权保留 %s/%s/%s/%s 的预编排脚本', async (platform, communicationMode, mode, format, renderer, masterUrl) => {
    const binaries = { findNodeByToken: jest.fn().mockResolvedValue({ id: 'node-1', communicationMode }) };
    const installer = {
      renderShellScript: jest.fn().mockResolvedValue('#!/bin/sh\n'),
      renderPowershellScript: jest.fn().mockResolvedValue('# powershell')
    };
    const response = { setHeader: jest.fn() };
    const request = { headers: { host: 'panel.example.com' }, protocol: 'https' };
    const controller = new BinariesController(binaries as never, installer as never);

    const result = await controller.agentInstaller(
      undefined, 'token-from-header', undefined, mode, format, platform, undefined, request as never, response as never
    );

    expect(binaries.findNodeByToken).toHaveBeenCalledWith('token-from-header');
    expect(installer[renderer]).toHaveBeenCalledWith(platform, 'https://panel.example.com', {
      agentToken: 'token-from-header', masterUrl, mode: masterUrl.startsWith('wss:') ? 'ws' : 'http'
    });
    expect(result).toBeTruthy();
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });

  it.each([undefined, 'invalid-header-token'])('agentInstaller 仍将缺失或无效的 Header 交由节点凭据鉴权拒绝', async (headerToken) => {
    const binaries = { findNodeByToken: jest.fn().mockRejectedValue(new UnauthorizedException('无效的 AgentToken')) };
    const installer = { renderShellScript: jest.fn() };
    const controller = new BinariesController(binaries as never, installer as never);

    await expect(controller.agentInstaller(
      undefined, headerToken, undefined, 'ws', undefined, 'linux-amd64', undefined, {} as never, {} as never
    )).rejects.toThrow(UnauthorizedException);

    expect(binaries.findNodeByToken).toHaveBeenCalledWith(headerToken);
    expect(installer.renderShellScript).not.toHaveBeenCalled();
  });
});

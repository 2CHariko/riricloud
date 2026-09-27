import { Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as net from 'node:net';
import * as tls from 'node:tls';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../system/settings.service';
import { sanitizeInboundParams } from '../common/inbound';
import {
  INTERNAL_SPEEDTEST_EMAIL,
  INTERNAL_SPEEDTEST_SECRET,
  INTERNAL_SPEEDTEST_UUID,
  type ProtocolType
} from '../common/constants';
import {
  buildSingboxOutbound,
  buildShadowtlsTransportOutbound,
  type SubEntry,
  type SubLine,
  type SubUser
} from '../subscription/builders';

export interface SpeedTestStage {
  id: 'master_ready' | 'entry_handshake' | 'relay_transit' | 'target_http';
  name: string;
  target: string;
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED';
  latencyMs?: number | null;
  message?: string;
}

export interface SpeedTestExecutionResult {
  lineId: string;
  lineName: string;
  latencyMs: number | null;
  status: 'SUCCESS' | 'TIMEOUT' | 'ERROR';
  message: string;
  testedAt: Date;
  mode: 'END_TO_END' | 'TCP_HANDSHAKE';
  targetUrl: string;
  protocolType: string;
  topology: {
    isRelay: boolean;
    relayMode?: string | null;
    masterHost: string;
    entryNode: { id: string; name: string; host: string; port: number };
    landingNode?: { id: string; name: string; host: string; port?: number | null } | null;
  };
  stages: SpeedTestStage[];
}

@Injectable()
export class LineSpeedtestService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LineSpeedtestService.name);
  private schedulerTimer?: NodeJS.Timeout;
  private lastAutoSpeedtestAt = Date.now();
  private isBatchTesting = false;
  private singboxBinaryChecked = false;
  private cachedSingboxPath: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settingsService: SettingsService
  ) {}

  onModuleInit() {
    this.startScheduler();
  }

  onModuleDestroy() {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = undefined;
    }
  }

  /**
   * 启动后台定时测速调度器（每 30 秒自省一次设置与运行间隔）
   */
  private startScheduler() {
    this.schedulerTimer = setInterval(() => {
      void this.checkScheduledSpeedtest();
    }, 30_000);
    this.schedulerTimer.unref?.();
  }

  private async checkScheduledSpeedtest(): Promise<void> {
    try {
      const settings = await this.settingsService.getSettings();
      if (!settings.lineSpeedtestEnabled) return;

      const intervalMs = Math.max(1, settings.lineSpeedtestIntervalMins) * 60 * 1000;
      if (Date.now() - this.lastAutoSpeedtestAt >= intervalMs) {
        this.logger.log('触发线路定时自动测速...');
        await this.testAllActiveLines();
      }
    } catch (err) {
      this.logger.warn(`定时测速调度检查失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 测试单条线路（严格全链路模式：任一阶段失败均判定为未跑通，不保留降级成功或伪造延迟）
   */
  async testLine(lineId: string): Promise<SpeedTestExecutionResult> {
    const line = await this.prisma.line.findUnique({
      where: { id: lineId },
      include: {
        entryNode: true,
        landingNode: true,
        targetLine: {
          include: {
            entryNode: true,
            landingNode: true
          }
        }
      }
    });

    if (!line) {
      throw new NotFoundException(`线路 ${lineId} 不存在`);
    }

    const settings = await this.settingsService.getSettings();
    const targetUrl = settings.lineSpeedtestTargetUrl || 'http://cp.cloudflare.com/generate_204';
    const timeoutMs = Math.min(Math.max(settings.lineSpeedtestTimeoutMs || 3000, 500), 30000);

    const serverHost = (line.endpointOverrideEnabled && line.serverHost ? line.serverHost : line.entryNode.serverHost).trim();
    const serverPort = line.endpointOverrideEnabled && line.serverPort ? line.serverPort : line.entryPort;

    const isRelay = line.type === 'RELAY';
    const topology = {
      isRelay,
      relayMode: line.relayMode,
      masterHost: 'Master 主控',
      entryNode: {
        id: line.entryNode.id,
        name: line.entryNode.name,
        host: serverHost,
        port: serverPort
      },
      landingNode: isRelay
        ? (line.relayMode === 'TARGET_LINE' && line.targetLine
            ? {
                id: line.targetLine.entryNode.id,
                name: line.targetLine.entryNode.name,
                host: line.targetLine.serverHost || line.targetLine.entryNode.serverHost,
                port: line.targetLine.entryPort
              }
            : line.landingNode
              ? {
                  id: line.landingNode.id,
                  name: line.landingNode.name,
                  host: line.landingNode.serverHost,
                  port: line.landingPort
                }
              : null)
        : null
    };

    const stages: SpeedTestStage[] = [];
    let latencyMs: number | null = null;
    let status: 'SUCCESS' | 'TIMEOUT' | 'ERROR' = 'ERROR';
    let message = '';
    const mode: 'END_TO_END' | 'TCP_HANDSHAKE' = 'END_TO_END';

    // 阶段一：主控探测引擎准备
    const singboxBin = await this.resolveSingboxBinary();
    if (singboxBin) {
      stages.push({
        id: 'master_ready',
        name: '主控探测引擎',
        target: 'Master 服务端',
        status: 'SUCCESS',
        message: 'Sing-box 探针引擎就绪'
      });
    } else {
      stages.push({
        id: 'master_ready',
        name: '主控探测引擎',
        target: 'Master 服务端',
        status: 'FAILED',
        message: '未检测到 Sing-box 探针内核，无法执行端到端代理拨测'
      });
    }

    // 阶段二：入口节点网络握手（TCP / UDP）
    const isUdpOnly = this.isUdpOnlyProtocol(line.protocolType);
    let tcpLatency: number | null = null;
    let tcpErr: unknown = null;

    if (isUdpOnly) {
      stages.push({
        id: 'entry_handshake',
        name: '入口网络联通',
        target: `${serverHost}:${serverPort}`,
        status: 'SKIPPED',
        message: `纯 UDP 协议（${line.protocolType}）跳过 TCP 握手，由端到端阶段直接验证 QUIC 连通性`
      });
    } else {
      try {
        tcpLatency = await this.tcpPing(serverHost, serverPort, timeoutMs);
        stages.push({
          id: 'entry_handshake',
          name: '入口网络握手',
          target: `${serverHost}:${serverPort}`,
          status: 'SUCCESS',
          latencyMs: tcpLatency,
          message: `TCP 握手成功 (${tcpLatency}ms)`
        });
      } catch (err) {
        tcpErr = err;
        stages.push({
          id: 'entry_handshake',
          name: '入口网络握手',
          target: `${serverHost}:${serverPort}`,
          status: 'FAILED',
          message: `入口连接失败: ${err instanceof Error ? err.message : String(err)}`
        });
      }
    }

    // 阶段三：中继链路状态判定（若为中继线路）
    let relayOk = true;
    let relayErrMessage = '';
    if (isRelay) {
      if (line.relayMode === 'TARGET_LINE') {
        if (!line.targetLine) {
          relayOk = false;
          relayErrMessage = '未配置或找不到目标桥接线路';
          stages.push({
            id: 'relay_transit',
            name: '中继桥接目标',
            target: '未绑定目标线路',
            status: 'FAILED',
            message: relayErrMessage
          });
        } else if (line.targetLine.status !== 'ACTIVE') {
          relayOk = false;
          relayErrMessage = `桥接目标线路 [${line.targetLine.name}] 未启用 (${line.targetLine.status})`;
          stages.push({
            id: 'relay_transit',
            name: '中继桥接目标',
            target: `${line.targetLine.entryNode.name} (${line.targetLine.protocolType}:${line.targetLine.entryPort})`,
            status: 'FAILED',
            message: relayErrMessage
          });
        } else if (line.targetLine.entryNode?.status && line.targetLine.entryNode.status !== 'ONLINE') {
          relayOk = false;
          relayErrMessage = `桥接目标入口节点 [${line.targetLine.entryNode.name}] 离线 (${line.targetLine.entryNode.status})`;
          stages.push({
            id: 'relay_transit',
            name: '中继桥接目标',
            target: `${line.targetLine.entryNode.name} (${line.targetLine.protocolType}:${line.targetLine.entryPort})`,
            status: 'FAILED',
            message: relayErrMessage
          });
        } else {
          stages.push({
            id: 'relay_transit',
            name: '中继桥接目标',
            target: `${line.targetLine.entryNode.name} (${line.targetLine.protocolType}:${line.targetLine.entryPort})`,
            status: 'SUCCESS',
            message: `桥接目标就绪: [${line.targetLine.entryNode.name}] ${line.targetLine.name}`
          });
        }
      } else if (line.landingNode) {
        if (line.landingNode.status && line.landingNode.status !== 'ONLINE') {
          relayOk = false;
          relayErrMessage = `落地节点 [${line.landingNode.name}] 离线 (${line.landingNode.status})`;
          stages.push({
            id: 'relay_transit',
            name: '中继落地转发',
            target: `${line.landingNode.name} (${line.landingNode.serverHost}:${line.landingPort ?? '—'})`,
            status: 'FAILED',
            message: relayErrMessage
          });
        } else {
          const isNat = (line.landingNode as { reachability?: string }).reachability === 'NAT';
          stages.push({
            id: 'relay_transit',
            name: '中继落地转发',
            target: `${line.landingNode.name} (${line.landingNode.serverHost}:${line.landingPort ?? '—'})`,
            status: 'SUCCESS',
            message: isNat
              ? `反向隧道穿透落地就绪（节点在线，模式: ${line.relayMode === 'BLIND_FORWARD' ? '盲转发' : '协议代理'}）`
              : `公网中继转发就绪（节点在线，模式: ${line.relayMode === 'BLIND_FORWARD' ? '盲转发' : '协议代理'}）`
          });
        }
      } else {
        relayOk = false;
        relayErrMessage = '未配置或找不到落地节点';
        stages.push({
          id: 'relay_transit',
          name: '中继落地转发',
          target: '未绑定落地节点',
          status: 'FAILED',
          message: relayErrMessage
        });
      }
    }

    // 阶段四：测试目标端到端请求
    if (!singboxBin) {
      stages.push({
        id: 'target_http',
        name: '端到端请求',
        target: targetUrl,
        status: 'FAILED',
        message: '因主控缺少 Sing-box 探针内核，无法发起端到端代理请求'
      });
    } else if (tcpErr) {
      stages.push({
        id: 'target_http',
        name: '端到端请求',
        target: targetUrl,
        status: 'FAILED',
        message: `前置入口握手失败，终止端到端探测 (${tcpErr instanceof Error ? tcpErr.message : String(tcpErr)})`
      });
    } else if (isRelay && !relayOk) {
      stages.push({
        id: 'target_http',
        name: '端到端请求',
        target: targetUrl,
        status: 'FAILED',
        message: `前置中继链路异常，终止端到端探测 (${relayErrMessage})`
      });
    } else {
      try {
        const rawE2e = await this.runSingboxProbe(singboxBin, line, targetUrl, timeoutMs);
        const e2eLatency = typeof rawE2e === 'number' ? rawE2e : rawE2e.latencyMs;
        const e2eStatusCode = typeof rawE2e === 'object' && rawE2e && 'statusCode' in rawE2e ? rawE2e.statusCode : 204;
        stages.push({
          id: 'target_http',
          name: '端到端请求',
          target: targetUrl,
          status: 'SUCCESS',
          latencyMs: e2eLatency,
          message: `HTTP ${e2eStatusCode} OK (往返 ${e2eLatency}ms)`
        });
      } catch (e2eErr) {
        stages.push({
          id: 'target_http',
          name: '端到端请求',
          target: targetUrl,
          status: 'FAILED',
          message: `代理请求失败: ${e2eErr instanceof Error ? e2eErr.message : String(e2eErr)}`
        });
      }
    }

    // 综合判定：全链路所有必要阶段 100% 跑通才算 SUCCESS；任一阶段失败则综合延迟置空为 null
    const failedStage = stages.find((s) => s.status === 'FAILED');
    const targetStage = stages.find((s) => s.id === 'target_http');

    if (!failedStage && targetStage?.status === 'SUCCESS' && targetStage.latencyMs != null) {
      status = 'SUCCESS';
      latencyMs = targetStage.latencyMs;
      message = `204 OK (端到端 ${latencyMs}ms)`;
    } else {
      latencyMs = null;
      const firstFailure = failedStage?.message || '链路测速未全量跑通';
      status = this.isTimeoutError(firstFailure) ? 'TIMEOUT' : 'ERROR';
      message = firstFailure;
    }

    if (status !== 'SUCCESS' && line.entryNode?.isLocal) {
      message += '（Master 本机节点：请检查主机防火墙/UDP端口开放及云厂商 NAT 回环策略）';
    }

    const testedAt = new Date();

    // 更新持久化快照
    await this.prisma.line.update({
      where: { id: lineId },
      data: {
        lastLatencyMs: latencyMs,
        lastTestedAt: testedAt,
        lastTestStatus: status,
        lastTestMessage: message
      }
    });

    return {
      lineId: line.id,
      lineName: line.name,
      latencyMs,
      status,
      message,
      testedAt,
      mode,
      targetUrl,
      protocolType: line.protocolType,
      topology,
      stages
    };
  }

  /**
   * 批量测试全部已启用线路（并发受控）
   */
  async testAllActiveLines(): Promise<{ total: number; success: number; failed: number }> {
    if (this.isBatchTesting) {
      this.logger.warn('已有测速任务正在执行中，跳过本次批量请求');
      return { total: 0, success: 0, failed: 0 };
    }

    this.isBatchTesting = true;
    try {
      const activeLines = await this.prisma.line.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true, name: true }
      });

      let success = 0;
      let failed = 0;
      const chunkSize = 4; // 限制并发度为 4

      for (let i = 0; i < activeLines.length; i += chunkSize) {
        const chunk = activeLines.slice(i, i + chunkSize);
        const results = await Promise.allSettled(chunk.map((item) => this.testLine(item.id)));
        for (const res of results) {
          if (res.status === 'fulfilled' && res.value.status === 'SUCCESS') {
            success++;
          } else {
            failed++;
          }
        }
      }

      this.lastAutoSpeedtestAt = Date.now();
      return { total: activeLines.length, success, failed };
    } finally {
      this.isBatchTesting = false;
    }
  }

  /**
   * TCP 握手 RTT 检测
   */
  private tcpPing(host: string, port: number, timeoutMs: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const socket = net.createConnection({ host, port, timeout: timeoutMs });

      socket.once('connect', () => {
        const latency = Math.max(1, Date.now() - started);
        socket.destroy();
        resolve(latency);
      });

      socket.once('timeout', () => {
        socket.destroy();
        reject(new Error(`连接超时（${timeoutMs}ms）`));
      });

      socket.once('error', (err) => {
        socket.destroy();
        reject(err);
      });
    });
  }

  /**
   * 获取本地随机可用端口
   */
  private getAvailableLocalPort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        server.close(() => {
          if (port > 0) resolve(port);
          else reject(new Error('无法分配本地临时探测端口'));
        });
      });
    });
  }

  /**
   * 端到端 Sing-box 代理探测
   */
  private async runSingboxProbe(
    singboxBin: string,
    line: {
      id: string;
      name: string;
      protocolType: string;
      paramsJson: string;
      serverHost: string | null;
      serverPort: number | null;
      entryPort: number;
      endpointOverrideEnabled: boolean;
      serverName: string | null;
      host: string | null;
      trafficRate: number;
      entryNode: { name: string; serverHost: string };
      landingNode?: { name: string; serverHost: string } | null;
    },
    targetUrl: string,
    timeoutMs: number
  ): Promise<{ latencyMs: number; statusCode: number }> {
    const subLine: SubLine = {
      id: line.id,
      name: line.name,
      protocolType: line.protocolType as ProtocolType,
      params: sanitizeInboundParams(this.parseJson(line.paramsJson)),
      serverHost: line.endpointOverrideEnabled && line.serverHost ? line.serverHost : line.entryNode.serverHost,
      serverPort: line.endpointOverrideEnabled && line.serverPort ? line.serverPort : line.entryPort,
      serverName: line.endpointOverrideEnabled ? line.serverName : null,
      host: line.endpointOverrideEnabled ? line.host : null,
      trafficRate: line.trafficRate
    };

    const subEntry: SubEntry = {
      label: 'probe-out',
      node: {
        name: line.landingNode?.name ?? line.entryNode.name,
        serverHost: line.landingNode?.serverHost ?? line.entryNode.serverHost,
        inbounds: []
      },
      inbound: {
        type: line.protocolType as ProtocolType,
        tag: 'probe-out',
        port: subLine.serverPort,
        params: subLine.params ?? {}
      },
      line: subLine
    };

    const probeUser: SubUser = {
      uuid: INTERNAL_SPEEDTEST_UUID,
      email: INTERNAL_SPEEDTEST_EMAIL,
      credential: INTERNAL_SPEEDTEST_SECRET
    };

    const outboundConfig = buildSingboxOutbound(probeUser, subEntry);
    if (!outboundConfig || Object.keys(outboundConfig).length === 0) {
      throw new Error(`暂不支持对协议 ${line.protocolType} 执行端到端代理拨测`);
    }
    outboundConfig.tag = 'probe-out';

    const extraOutbounds: Record<string, unknown>[] = [];
    if (line.protocolType === 'SHADOWTLS') {
      extraOutbounds.push(buildShadowtlsTransportOutbound(subEntry, probeUser));
    }

    const localPort = await this.getAvailableLocalPort();
    const configObj = {
      log: { level: 'warn', disabled: false },
      inbounds: [
        {
          type: 'mixed',
          listen: '127.0.0.1',
          listen_port: localPort
        }
      ],
      outbounds: [outboundConfig, ...extraOutbounds, { type: 'direct', tag: 'direct' }],
      route: {
        rules: [{ outbound: 'probe-out' }]
      }
    };

    const tmpDir = process.env.TEMP || process.env.TMP || os.tmpdir();
    const tmpConfigFile = path.join(tmpDir, `riri-probe-${line.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
    await fs.writeFile(tmpConfigFile, JSON.stringify(configObj), 'utf8');

    let childProc: ReturnType<typeof spawn> | null = null;
    let stderrOutput = '';
    try {
      childProc = spawn(singboxBin, ['run', '-c', tmpConfigFile], {
        stdio: ['ignore', 'ignore', 'pipe']
      });

      childProc.stderr?.on('data', (chunk: Buffer) => {
        if (stderrOutput.length < 4096) {
          stderrOutput += chunk.toString('utf8');
        }
      });

      // 等待 sing-box 启动并监听本地端口（最多等待 2000ms）
      await this.waitForPortReady('127.0.0.1', localPort, 2000, childProc, () => stderrOutput);

      // 发起 HTTP 204/200 请求测速
      const result = await this.httpGetViaHttpProxy('127.0.0.1', localPort, targetUrl, timeoutMs, () => stderrOutput);
      return result;
    } finally {
      if (childProc) {
        try {
          childProc.kill('SIGTERM');
        } catch {
          // ignore
        }
      }
      await fs.unlink(tmpConfigFile).catch(() => undefined);
    }
  }

  private waitForPortReady(
    host: string,
    port: number,
    timeoutMs: number,
    childProc: ReturnType<typeof spawn>,
    getStderr: () => string
  ): Promise<void> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      let isDone = false;

      const finish = (err?: Error) => {
        if (isDone) return;
        isDone = true;
        if (err) reject(err);
        else resolve();
      };

      const checkExit = () => {
        if (childProc.exitCode !== null) {
          const stderr = getStderr().trim();
          finish(new Error(`Sing-box 探针进程提前退出 (code ${childProc.exitCode})${stderr ? `: ${stderr}` : ''}`));
          return true;
        }
        return false;
      };

      const attempt = () => {
        if (isDone) return;
        if (checkExit()) return;
        if (Date.now() - started > timeoutMs) {
          const stderr = getStderr().trim();
          return finish(new Error(`等待 Sing-box 探针就绪超时 (${timeoutMs}ms)${stderr ? `: ${stderr}` : ''}`));
        }
        const socket = net.createConnection({ host, port });
        socket.once('connect', () => {
          socket.destroy();
          finish();
        });
        socket.once('error', () => {
          socket.destroy();
          if (!isDone) setTimeout(attempt, 50);
        });
      };

      attempt();
    });
  }

  /**
   * 通过 HTTP/Mixed Proxy 代理请求测试目标并测量往返延迟（严格校验 HTTP 204 或 200）
   */
  private httpGetViaHttpProxy(
    proxyHost: string,
    proxyPort: number,
    targetUrl: string,
    timeoutMs: number,
    getStderr: () => string
  ): Promise<{ latencyMs: number; statusCode: number }> {
    return new Promise((resolve, reject) => {
      let url: URL;
      try {
        url = new URL(targetUrl);
      } catch {
        return reject(new Error(`无效的测速目标 URL: ${targetUrl}`));
      }

      const isHttps = url.protocol === 'https:';
      const targetPort = Number(url.port) || (isHttps ? 443 : 80);
      const targetPath = (url.pathname || '/') + (url.search || '');

      let isFinished = false;
      const cleanupAndReject = (err: Error) => {
        if (isFinished) return;
        isFinished = true;
        try {
          socket.destroy();
        } catch {
          // ignore
        }
        const extraErr = getStderr().trim();
        const fullMsg = extraErr ? `${err.message} (${extraErr})` : err.message;
        reject(new Error(fullMsg));
      };

      const cleanupAndResolve = (result: { latencyMs: number; statusCode: number }) => {
        if (isFinished) return;
        isFinished = true;
        try {
          socket.destroy();
        } catch {
          // ignore
        }
        resolve(result);
      };

      const socket = net.createConnection({ host: proxyHost, port: proxyPort });
      socket.setTimeout(timeoutMs);

      socket.once('timeout', () => {
        cleanupAndReject(new Error(`代理探测超时（${timeoutMs}ms）`));
      });

      socket.once('error', (err) => {
        cleanupAndReject(new Error(`代理连接失败: ${err.message}`));
      });

      socket.once('connect', () => {
        const started = Date.now();

        if (isHttps) {
          // HTTPS: 1. 发送 HTTP CONNECT 隧道请求
          const connectPayload = `CONNECT ${url.hostname}:${targetPort} HTTP/1.1\r\nHost: ${url.hostname}:${targetPort}\r\nUser-Agent: RiriCloud-Speedtest/1.0\r\nProxy-Connection: keep-alive\r\n\r\n`;
          socket.write(connectPayload);

          let connectBuffer = '';
          const onConnectData = (chunk: Buffer) => {
            connectBuffer += chunk.toString('utf8');
            if (connectBuffer.includes('\r\n\r\n')) {
              socket.removeListener('data', onConnectData);
              const firstLine = connectBuffer.split('\r\n')[0] || '';
              const match = /^HTTP\/1\.[01]\s+(\d{3})(?:\s+(.*))?$/i.exec(firstLine.trim());
              const connectStatus = match ? Number(match[1]) : 0;
              if (connectStatus !== 200) {
                return cleanupAndReject(new Error(`代理 CONNECT 隧道失败: ${firstLine || '无响应'}`));
              }

              // 2. 升级为 TLS 连接并在隧道内发送真正目标 HTTP 请求
              const tlsSocket = tls.connect({
                socket,
                servername: url.hostname,
                rejectUnauthorized: false
              });

              tlsSocket.setTimeout(Math.max(1000, timeoutMs - (Date.now() - started)));
              tlsSocket.once('timeout', () => {
                tlsSocket.destroy();
                cleanupAndReject(new Error(`目标 TLS/HTTP 请求超时`));
              });
              tlsSocket.once('error', (tlsErr) => {
                tlsSocket.destroy();
                cleanupAndReject(new Error(`目标 TLS 握手异常: ${tlsErr.message}`));
              });

              tlsSocket.once('secureConnect', () => {
                const getRequest = `GET ${targetPath} HTTP/1.1\r\nHost: ${url.hostname}\r\nUser-Agent: RiriCloud-Speedtest/1.0\r\nConnection: close\r\nAccept: */*\r\n\r\n`;
                tlsSocket.write(getRequest);

                let httpResponseBuffer = '';
                tlsSocket.on('data', (dataChunk: Buffer) => {
                  httpResponseBuffer += dataChunk.toString('utf8');
                  if (httpResponseBuffer.includes('\r\n\r\n')) {
                    tlsSocket.destroy();
                    const statusLine = httpResponseBuffer.split('\r\n')[0] || '';
                    const statusMatch = /^HTTP\/1\.[01]\s+(\d{3})(?:\s+(.*))?$/i.exec(statusLine.trim());
                    if (!statusMatch) {
                      return cleanupAndReject(new Error(`目标返回无效响应: ${statusLine.slice(0, 80)}`));
                    }
                    const statusCode = Number(statusMatch[1]);
                    if (statusCode !== 204 && statusCode !== 200) {
                      return cleanupAndReject(new Error(`目标响应非预期状态码 HTTP ${statusCode} ${statusMatch[2] || ''}`.trim()));
                    }
                    const latencyMs = Math.max(1, Date.now() - started);
                    cleanupAndResolve({ latencyMs, statusCode });
                  }
                });
              });
            }
          };

          socket.on('data', onConnectData);
        } else {
          // HTTP: 直接通过代理请求 GET
          const request = `GET ${targetUrl} HTTP/1.1\r\nHost: ${url.host}\r\nUser-Agent: RiriCloud-Speedtest/1.0\r\nConnection: close\r\nAccept: */*\r\n\r\n`;
          socket.write(request);

          let responseBuffer = '';
          const onData = (chunk: Buffer) => {
            responseBuffer += chunk.toString('utf8');
            if (responseBuffer.includes('\r\n\r\n')) {
              socket.removeListener('data', onData);
              const statusLine = responseBuffer.split('\r\n')[0] || '';
              const match = /^HTTP\/1\.[01]\s+(\d{3})(?:\s+(.*))?$/i.exec(statusLine.trim());
              if (!match) {
                return cleanupAndReject(new Error(`代理返回无效响应: ${statusLine.slice(0, 80)}`));
              }
              const statusCode = Number(match[1]);
              if (statusCode !== 204 && statusCode !== 200) {
                return cleanupAndReject(new Error(`代理或目标返回非预期状态码 HTTP ${statusCode} ${match[2] || ''}`.trim()));
              }
              const latencyMs = Math.max(1, Date.now() - started);
              cleanupAndResolve({ latencyMs, statusCode });
            }
          };

          socket.on('data', onData);
          socket.once('end', () => {
            if (!isFinished) {
              cleanupAndReject(new Error('代理连接过早中断，未收到完整响应'));
            }
          });
        }
      });
    });
  }

  private async resolveSingboxBinary(): Promise<string | null> {
    if (this.singboxBinaryChecked) return this.cachedSingboxPath;
    this.singboxBinaryChecked = true;

    const isWindows = process.platform === 'win32';
    const binaryName = isWindows ? 'sing-box.exe' : 'sing-box';
    const arch = process.arch === 'x64' ? 'amd64' : process.arch;

    const candidates = [
      process.env.SINGBOX_BINARY_PATH,
      '/usr/local/bin/sing-box',
      '/usr/bin/sing-box',
      `/app/binaries/singbox-linux-${arch}`,
      path.resolve(process.cwd(), 'binaries', `singbox-linux-${arch}`),
      path.resolve(process.cwd(), '.tools/sing-box', binaryName),
      path.resolve(process.cwd(), '../../.tools/sing-box', binaryName),
      path.resolve(process.cwd(), '..', '..', '.tools', 'sing-box', binaryName),
      path.resolve(process.cwd(), '.cache/sing-box-v2ray-api', binaryName),
      path.resolve(process.cwd(), '../../.cache/sing-box-v2ray-api', binaryName)
    ].filter((p): p is string => Boolean(p));

    // 1. 检查候选文件路径
    for (const candidate of candidates) {
      try {
        const stat = await fs.stat(candidate);
        if (stat.isFile()) {
          this.cachedSingboxPath = candidate;
          return candidate;
        }
      } catch {
        // ignore
      }
    }

    // 2. 检查系统 PATH
    const pathEnv = process.env.PATH || '';
    const pathDirs = pathEnv.split(path.delimiter).map((p) => p.trim()).filter(Boolean);
    for (const dir of pathDirs) {
      try {
        const candidate = path.join(dir, binaryName);
        const stat = await fs.stat(candidate);
        if (stat.isFile()) {
          this.cachedSingboxPath = candidate;
          return candidate;
        }
      } catch {
        // ignore
      }
    }

    this.cachedSingboxPath = null;
    return null;
  }

  private isUdpOnlyProtocol(protocolType: string): boolean {
    const upper = protocolType?.toUpperCase() || '';
    return upper === 'HYSTERIA2' || upper === 'TUIC';
  }

  private isTimeoutError(err: unknown): boolean {
    const msg = String(err instanceof Error ? err.message : err).toLowerCase();
    return msg.includes('timeout') || msg.includes('etimedout') || msg.includes('超时');
  }

  private parseJson(str: string | null | undefined): Record<string, unknown> {
    if (!str) return {};
    try {
      const parsed = JSON.parse(str);
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
}

import { assertEgressOverride, egressOverrideConflict } from '../common/line-egress';
import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AgentService, type UpgradeTaskOptions } from '../agent-gateway/agent.service';
import { BinariesService, normalizeOsArch } from '../binaries/binaries.service';
import { BinaryResourcesService } from '../binaries/binary-resources.service';
import type { QueryBinaryDeploymentDto } from '../binaries/dto/query-binary-resource.dto';
import { generateRealityKeypair } from '../common/inbound';
import { formatBinaryVersion } from '../common/binary-version';
import { generateAgentToken } from '../common/utils';
import { hashAgentToken } from '../common/agent-token';
import { PrismaService } from '../prisma/prisma.service';
import { ProbeNodeDto } from './dto/probe-node.dto';
import { CreateNodeDto } from './dto/create-node.dto';
import { UpdateNodeDto } from './dto/update-node.dto';
import { UpgradeNodeDto } from './dto/upgrade-node.dto';
import { BatchUpgradeNodeDto } from './dto/batch-upgrade-node.dto';
import { SettingsService } from '../system/settings.service';
import { appendPublicPath, resolvePublicBaseUrl, toWebSocketBaseUrl } from '../common/public-url';
import { decryptSecret, encryptSecret } from '../common/secret-crypto';
import { OfflinePackageService } from '../binaries/offline-package.service';
import { BinariesInstallerService } from '../binaries/installer.service';
import { SystemLogsService } from '../system-logs/system-logs.service';

const nodeSummary = { select: { id: true, name: true, serverHost: true, status: true, isLocal: true } } as const;
const nodeLinesInclude = {
  entryLines: { include: { landingNode: nodeSummary, targetLine: { include: { entryNode: nodeSummary } } }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
  landingLines: { include: { entryNode: nodeSummary }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }
} satisfies Prisma.NodeInclude;
type NodeWithLines = Prisma.NodeGetPayload<{ include: typeof nodeLinesInclude }>;

@Injectable()
export class NodesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agentGateway: AgentService,
    @Optional() private readonly binaries?: BinariesService,
    @Optional() private readonly resources?: BinaryResourcesService,
    @Optional() private readonly settingsService?: SettingsService,
    @Optional() private readonly offlinePackage?: OfflinePackageService,
    @Optional() private readonly installer?: BinariesInstallerService,
    @Optional() private readonly systemLogsService?: SystemLogsService
  ) {}

  async list() {
    const nodes = await this.prisma.node.findMany({ include: nodeLinesInclude, orderBy: [{ createdAt: 'asc' }] });
    return nodes.map((node) => this.sanitize(node));
  }

  async detail(id: string, requestBaseUrl?: string) {
    const node = await this.prisma.node.findUnique({ where: { id }, include: nodeLinesInclude });
    if (!node) throw new NotFoundException('节点不存在');
    const settings = await this.settingsService?.getSettings();
    const publicBaseUrl = resolvePublicBaseUrl({
      configuredBaseUrl: settings?.publicBaseUrl,
      requestBaseUrl
    });
    const agentImage = process.env.AGENT_IMAGE || '2chariko/riricloud-agent:latest';
    const decryptedToken = decryptSecret(node.agentToken);
    return {
      node: {
        ...this.sanitize(node),
        // 升级任务已完成但心跳版本尚未确认（Agent 重启可能失败）时的待确认信息
        pendingVersionConfirm: this.agentGateway.getPendingVersionConfirmation(id),
        installCommands: this.buildInstallCommands(node.osArch, publicBaseUrl, node.id, decryptedToken, node.communicationMode),
        agentImage,
        uninstallCommand: this.buildUninstallCommand(),
        windowsUninstallCommand: this.buildWindowsUninstallCommand()
      }
    };
  }

  async create(dto: CreateNodeDto, _operatorId: string, requestBaseUrl?: string) {
    const communicationMode = dto.communicationMode ?? 'WS';
    const settings = await this.settingsService?.getSettings();
    const publicBaseUrl = resolvePublicBaseUrl({
      configuredBaseUrl: settings?.publicBaseUrl,
      requestBaseUrl
    });
    const reachability = dto.reachability ?? 'PUBLIC';
    const serverHost = dto.serverHost?.trim() || (reachability === 'NAT' ? '127.0.0.1' : '');
    if (!serverHost) throw new BadRequestException('节点公网主机地址不能为空');
    const agentToken = generateAgentToken();
    const node = await this.prisma.node.create({
      data: {
        name: dto.name?.trim() || `节点 ${serverHost}`,
        serverHost,
        reachability,
        agentToken: encryptSecret(agentToken),
        agentTokenHash: hashAgentToken(agentToken),
        communicationMode,
        pollIntervalSecs: settings?.defaultPollIntervalSecs ?? 15
      },
      include: nodeLinesInclude
    });
    const agentImage = process.env.AGENT_IMAGE || '2chariko/riricloud-agent:latest';
    return {
      node: this.sanitize(node),
      // Token 只在创建成功响应中返回一次；数据库字段保存的是加密密文。
      agentToken,
      installCommand: this.buildInstallCommand(communicationMode, node.osArch, publicBaseUrl),
      installCommands: this.buildInstallCommands(node.osArch, publicBaseUrl, node.id, agentToken, communicationMode),
      agentImage,
      uninstallCommand: this.buildUninstallCommand(),
      windowsUninstallCommand: this.buildWindowsUninstallCommand()
    };
  }

  async rotateToken(id: string, operatorId?: string, requestBaseUrl?: string) {
    const node = await this.requireNode(id);
    if (node.isLocal) throw new ConflictException('主控本机节点请通过重置主控配置轮换凭证');
    const settings = await this.settingsService?.getSettings();
    const publicBaseUrl = resolvePublicBaseUrl({
      configuredBaseUrl: settings?.publicBaseUrl,
      requestBaseUrl
    });
    const token = generateAgentToken();
    await this.prisma.node.update({ where: { id }, data: { agentToken: encryptSecret(token), agentTokenHash: hashAgentToken(token), status: 'OFFLINE' } });
    this.agentGateway.disconnectNode(id);
    this.systemLogsService?.enqueue({
      source: 'SERVER',
      level: 'WARN',
      module: 'Nodes',
      message: 'AgentToken rotated',
      metadata: { nodeId: id, operatorId: operatorId ?? null },
      nodeId: id
    });
    const agentImage = process.env.AGENT_IMAGE || '2chariko/riricloud-agent:latest';
    const installCommands = this.buildInstallCommands(node.osArch, publicBaseUrl, id, token, node.communicationMode);
    return {
      nodeId: id,
      agentToken: token,
      installCommand: installCommands[node.communicationMode === 'HTTP' ? 'http' : 'ws'],
      installCommands,
      agentImage,
      uninstallCommand: this.buildUninstallCommand(),
      windowsUninstallCommand: this.buildWindowsUninstallCommand()
    };
  }

  async enableLogDiagnostics(id: string, level: 'INFO' | 'DEBUG', operatorId?: string) {
    await this.requireNode(id);
    return this.agentGateway.enableSingboxLogDiagnostics(id, level, operatorId);
  }

  async disableLogDiagnostics(id: string, operatorId?: string) {
    await this.requireNode(id);
    return this.agentGateway.disableSingboxLogDiagnostics(id, operatorId);
  }

  async requestReload(id: string) {
    await this.requireNode(id);
    const pushed = await this.agentGateway.pushConfig(id);
    return { requested: pushed, nodeId: id };
  }

  async requestUpgrade(id: string, dto: UpgradeNodeDto, requestBaseUrl?: string, operatorId?: string, operation: 'UPGRADE' | 'ROLLBACK' = 'UPGRADE') {
    const node = await this.requireNode(id);
    try {
      const hasCustomUrl = dto.url !== undefined;
      const hasCustomSha = dto.sha256 !== undefined;
      if (hasCustomUrl !== hasCustomSha) throw new Error('自定义升级地址与 SHA-256 必须同时提供');
      if (dto.resourceId && hasCustomUrl) throw new Error('资源版本与自定义升级地址不能同时提供');
      let version = dto.version?.trim() ?? '';
      let url = dto.url?.trim() ?? '';
      let sha256 = dto.sha256?.trim().toLowerCase() ?? '';
      const target = dto.target ?? 'agent';
      let managed: Awaited<ReturnType<BinaryResourcesService['resolveForNode']>> | undefined;
      if (!hasCustomUrl) {
        if (this.resources) {
          managed = await this.resources.resolveForNode(target, node.osArch, node.agentToken, requestBaseUrl, dto.resourceId, node);
        } else if (this.binaries) {
          managed = await this.binaries.resolveForNode(target, node.osArch, node.agentToken, requestBaseUrl) as Awaited<ReturnType<BinaryResourcesService['resolveForNode']>>;
        } else {
          throw new Error('二进制资源服务不可用');
        }
        version = version || managed.version;
        url = managed.url;
        sha256 = managed.sha256;
      }
      if (!version) throw new Error('升级版本不能为空');
      const options: UpgradeTaskOptions = {
        resourceId: managed?.resourceId,
        assetId: managed?.assetId,
        releaseId: managed?.resourceId,
        previousAssetId: target === 'agent' ? node.currentAgentAssetId : node.currentSingboxAssetId,
        operation,
        files: managed && 'files' in managed
          ? managed.files.map((file) => ({ ...file, role: file.role === 'auxiliary' ? 'auxiliary' as const : 'main' as const }))
          : undefined,
        requestedById: operatorId
      };
      if (!options.resourceId && !options.assetId && !options.files?.length) {
        // 自定义 URL 升级：无关联资产，仅保留任务时间线与操作人
        return await this.agentGateway.requestUpgrade(id, target, version, url, sha256, { previousAssetId: options.previousAssetId, operation, requestedById: operatorId });
      }
      return await this.agentGateway.requestUpgrade(id, target, version, url, sha256, options);
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : '升级任务参数无效');
    }
  }

  async requestBatchUpgrade(dto: BatchUpgradeNodeDto, requestBaseUrl?: string, operatorId?: string) {
    const results: Array<{
      nodeId: string;
      taskId?: string;
      status: 'DISPATCHED' | 'QUEUED' | 'FAILED';
      requested?: boolean;
      message?: string;
    }> = [];
    const concurrency = 4;

    for (let offset = 0; offset < dto.ids.length; offset += concurrency) {
      const chunk = dto.ids.slice(offset, offset + concurrency);
      const settled = await Promise.allSettled(chunk.map(async (nodeId) => {
        const node = await this.requireNode(nodeId);
        if (node.status === 'DISABLED') {
          return { nodeId, status: 'FAILED' as const, message: '节点已禁用，未下发升级任务' };
        }
        const task = await this.requestUpgrade(nodeId, { target: 'agent', resourceId: dto.resourceId }, requestBaseUrl, operatorId);
        const status = task.requested && node.status === 'ONLINE' && node.communicationMode === 'WS' ? 'DISPATCHED' as const : 'QUEUED' as const;
        return { nodeId, taskId: task.taskId, status, requested: task.requested };
      }));

      settled.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          results.push(result.value);
          return;
        }
        const reason = result.reason instanceof Error ? result.reason.message : '升级任务创建失败';
        const message = reason
          .replace(/https?:\/\/\S+/gi, '[URL]')
          .replace(/\b[a-f0-9]{64}\b/gi, '[REDACTED]')
          .slice(0, 240);
        results.push({ nodeId: chunk[index], status: 'FAILED', message });
      });
    }

    const succeeded = results.filter((result) => result.status !== 'FAILED').length;
    const failed = results.length - succeeded;
    return { total: results.length, succeeded, failed, results };
  }

  async requestProbe(id: string, dto: ProbeNodeDto) {
    await this.requireNode(id);
    try {
      return await this.agentGateway.requestProbe(id, dto.probes);
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : '探针任务参数无效');
    }
  }

  async requestRestart(id: string) {
    await this.requireNode(id);
    return this.agentGateway.requestRestart(id);
  }

  async taskStatus(nodeId: string, taskId: string) {
    await this.requireNode(nodeId);
    return this.agentGateway.getPersistedTaskStatus(nodeId, taskId);
  }

  async listTasks(nodeId: string, query: QueryBinaryDeploymentDto = {}) {
    await this.requireNode(nodeId);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const where = {
      nodeId,
      ...(query.status ? { status: query.status } : {})
    };
    const [rows, total] = await Promise.all([
      this.prisma.binaryDeploymentTask.findMany({
        where,
        include: {
          asset: {
            select: {
              id: true,
              target: true,
              size: true,
              release: { select: { id: true, kind: true, upstreamVersion: true, revision: true } }
            }
          }
        },
        orderBy: { requestedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize
      }),
      this.prisma.binaryDeploymentTask.count({ where })
    ]);
    return {
      data: rows.map((row) => {
        // 管理资源任务用资源版本摘要；自定义 URL 任务回退到任务 payload 中的版本
        let version: string | null = row.asset?.release ? formatBinaryVersion(row.asset.release.kind, row.asset.release.upstreamVersion, row.asset.release.revision) : null;
        if (!version) {
          try {
            version = (JSON.parse(row.payloadJson) as { version?: string }).version ?? null;
          } catch {
            version = null;
          }
        }
        return { ...row, version };
      }),
      total,
      page,
      pageSize
    };
  }

  async retryUpgrade(nodeId: string, taskId: string, operatorId?: string) {
    await this.requireNode(nodeId);
    return this.agentGateway.retryUpgrade(nodeId, taskId, operatorId);
  }

  async rollbackUpgrade(nodeId: string, taskId: string, requestBaseUrl?: string, operatorId?: string) {
    await this.requireNode(nodeId);
    const task = await this.prisma.binaryDeploymentTask.findFirst({
      where: { id: taskId, nodeId },
      include: { previousAsset: true }
    });
    if (!task?.previousAsset) throw new BadRequestException('该升级任务没有可回滚的上一版本');
    return this.requestUpgrade(
      nodeId,
      { target: task.kind.toLowerCase() as 'agent' | 'singbox', resourceId: task.previousAsset.releaseId },
      requestBaseUrl,
      operatorId,
      'ROLLBACK'
    );
  }

  async update(id: string, dto: UpdateNodeDto) {
    await this.requireNode(id);
    const data: { name?: string; serverHost?: string; reachability?: string; configOverride?: string | null; communicationMode?: 'WS' | 'HTTP'; pollIntervalSecs?: number } = {};
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) throw new BadRequestException('节点名称不能为空');
      data.name = name;
    }
    if (dto.serverHost !== undefined) {
      const serverHost = dto.serverHost.trim();
      if (!serverHost) throw new BadRequestException('服务器地址不能为空');
      data.serverHost = serverHost;
    }
    if (dto.reachability !== undefined) {
      if (dto.reachability === 'NAT') {
        const activeEntryLines = await this.prisma.line.count({
          where: { entryNodeId: id }
        });
        if (activeEntryLines > 0) {
          throw new BadRequestException('该节点正在作为直连线路或中继入口节点使用，无法变更为 NAT 节点，请先调整相关线路');
        }
      }
      data.reachability = dto.reachability;
    }
    if (dto.configOverride !== undefined) {
      data.configOverride = dto.configOverride === null || dto.configOverride.trim() === ''
        ? null
        : this.validateConfigOverride(dto.configOverride);
      if (egressOverrideConflict(data.configOverride)) {
        const egressLine = await this.prisma.line.findFirst({ where: { egressProxyJson: { not: null }, OR: [{ type: 'DIRECT', entryNodeId: id }, { type: 'RELAY', relayMode: { in: ['BLIND_FORWARD', 'PROTOCOL_PROXY'] }, landingNodeId: id }] }, select: { id: true } });
        if (egressLine) assertEgressOverride(data.configOverride, egressLine.id);
      }
    }
    if (dto.communicationMode !== undefined) data.communicationMode = dto.communicationMode;
    if (dto.pollIntervalSecs !== undefined) data.pollIntervalSecs = dto.pollIntervalSecs;
    if (Object.keys(data).length === 0) throw new BadRequestException('未提供任何更新字段');
    const updated = await this.prisma.node.update({ where: { id }, data, include: nodeLinesInclude });
    void (dto.serverHost !== undefined ? this.agentGateway.pushConfigToAll() : this.agentGateway.pushConfig(id));
    return { node: this.sanitize(updated) };
  }

  async remove(id: string) {
    const node = await this.requireNode(id);
    if (node.isLocal) throw new ConflictException('主控本机节点不可删除');
    this.agentGateway.disconnectNode(id);
    await this.prisma.node.delete({ where: { id } });
    return { deleted: true, id };
  }

  realityKeypair() {
    return generateRealityKeypair();
  }

  private async requireNode(id: string) {
    const node = await this.prisma.node.findUnique({ where: { id } });
    if (!node) throw new NotFoundException('节点不存在');
    return node;
  }

  private validateConfigOverride(raw: string): string {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new BadRequestException('configOverride 不是合法 JSON');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new BadRequestException('configOverride 须为 JSON 对象');
    }
    return raw;
  }

  async generateOfflinePackage(id: string, rawPlatform?: string, requestBaseUrl?: string) {
    const node = await this.requireNode(id);
    if (!this.offlinePackage) {
      throw new BadRequestException('离线安装包服务未启用');
    }
    const settings = await this.settingsService?.getSettings();
    const publicBaseUrl = resolvePublicBaseUrl({
      configuredBaseUrl: settings?.publicBaseUrl,
      requestBaseUrl
    });
    const decryptedToken = decryptSecret(node.agentToken);
    return this.offlinePackage.generateOfflinePackageStream(
      {
        id: node.id,
        name: node.name,
        agentToken: decryptedToken,
        communicationMode: node.communicationMode,
        pollIntervalSecs: node.pollIntervalSecs,
        reachability: node.reachability,
        serverHost: node.serverHost,
        osArch: node.osArch
      },
      rawPlatform,
      publicBaseUrl
    );
  }

  async generateInstallScript(id: string, rawPlatform?: string, format?: string, requestBaseUrl?: string) {
    const node = await this.requireNode(id);
    if (!this.installer) throw new BadRequestException('安装脚本服务不可用');
    const settings = await this.settingsService?.getSettings();
    const publicBaseUrl = resolvePublicBaseUrl({
      configuredBaseUrl: settings?.publicBaseUrl,
      requestBaseUrl
    });
    const decryptedToken = decryptSecret(node.agentToken);
    const targetOs = rawPlatform?.startsWith('win') ? 'windows' : (rawPlatform?.startsWith('mac') || rawPlatform?.startsWith('darwin') ? 'macos' : 'linux');
    const platform = this.resolveTargetPlatform(targetOs, rawPlatform || node.osArch);
    const mode = node.communicationMode === 'HTTP' ? 'HTTP' : 'WS';
    const { master } = this.resolveModeUrls(mode, publicBaseUrl);
    const preset = {
      agentToken: decryptedToken,
      masterUrl: master,
      mode: mode.toLowerCase() as 'ws' | 'http'
    };
    const isWindows = targetOs === 'windows';
    const resolvedFormat = format?.toLowerCase() || (isWindows ? 'bat' : 'sh');
    if (resolvedFormat === 'bat') {
      const content = await this.installer.renderWindowsInstallBat(platform, publicBaseUrl, preset);
      return {
        content,
        filename: 'riri-install.bat',
        mimeType: 'text/plain; charset=utf-8'
      };
    }
    if (resolvedFormat === 'ps1') {
      const content = '﻿' + await this.installer.renderPowershellScript(platform, publicBaseUrl, preset);
      return {
        content,
        filename: 'riri-install.ps1',
        mimeType: 'text/plain; charset=utf-8'
      };
    }
    const content = await this.installer.renderShellScript(platform, publicBaseUrl, preset);
    return {
      content,
      filename: 'riri-install.sh',
      mimeType: 'text/x-shellscript; charset=utf-8'
    };
  }

  /**
   * 组装节点安装命令全集：ws/http/dockerWs/dockerHttp 为兼容保留的旧键，
   * native/portable 按目标操作系统区分（native=注册系统服务，portable=免安装直接运行）。
   */
  private buildInstallCommands(
    osArch?: string | null,
    publicBaseUrl?: string,
    nodeId?: string,
    agentToken?: string,
    _communicationMode?: string | null
  ) {
    const baseUrl = publicBaseUrl ?? resolvePublicBaseUrl();
    const offlineDownloadUrl = appendPublicPath(baseUrl, 'api/v1/downloads/agent-offline-package');
    const adminPackageUrl = nodeId ? appendPublicPath(baseUrl, `api/v1/admin/nodes/${nodeId}/offline-package`) : undefined;
    const adminScriptUrl = nodeId ? appendPublicPath(baseUrl, `api/v1/admin/nodes/${nodeId}/install-script`) : undefined;
    return {
      ws: this.buildInstallCommand('WS', osArch, publicBaseUrl),
      http: this.buildInstallCommand('HTTP', osArch, publicBaseUrl),
      dockerWs: this.buildDockerCommand('WS', publicBaseUrl, agentToken),
      dockerHttp: this.buildDockerCommand('HTTP', publicBaseUrl, agentToken),
      native: {
        linux: { ws: this.buildPosixInstallCommand('WS', 'linux', osArch, publicBaseUrl, agentToken), http: this.buildPosixInstallCommand('HTTP', 'linux', osArch, publicBaseUrl, agentToken) },
        macos: { ws: this.buildPosixInstallCommand('WS', 'macos', osArch, publicBaseUrl, agentToken), http: this.buildPosixInstallCommand('HTTP', 'macos', osArch, publicBaseUrl, agentToken) },
        windows: { ws: this.buildWindowsInstallCommand('WS', osArch, publicBaseUrl, agentToken), http: this.buildWindowsInstallCommand('HTTP', osArch, publicBaseUrl, agentToken) }
      },
      portable: {
        linux: { ws: this.buildPosixPortableCommand('WS', 'linux', osArch, publicBaseUrl, agentToken), http: this.buildPosixPortableCommand('HTTP', 'linux', osArch, publicBaseUrl, agentToken) },
        macos: { ws: this.buildPosixPortableCommand('WS', 'macos', osArch, publicBaseUrl, agentToken), http: this.buildPosixPortableCommand('HTTP', 'macos', osArch, publicBaseUrl, agentToken) },
        windows: { ws: this.buildWindowsPortableCommand('WS', osArch, publicBaseUrl, agentToken), http: this.buildWindowsPortableCommand('HTTP', osArch, publicBaseUrl, agentToken) }
      },
      offline: {
        packageDownloadUrl: offlineDownloadUrl,
        adminPackageUrl,
        windows: `curl -fsSL --progress-bar -H "X-Agent-Token: $RIRI_AGENT_TOKEN" '${offlineDownloadUrl}?platform=windows-amd64' -o riri-agent-offline.zip; tar -xf riri-agent-offline.zip; cd riri-agent-offline; .\\install.bat`,
        linux: `read -r -s -p 'AgentToken: ' RIRI_AGENT_TOKEN; echo; curl -fsSL --progress-bar -H "X-Agent-Token: $RIRI_AGENT_TOKEN" '${offlineDownloadUrl}?platform=linux-amd64' -o riri-agent-offline.tar.gz && tar -xzf riri-agent-offline.tar.gz && cd riri-agent-offline && sudo sh install.sh`
      },
      adminScriptUrl
    };
  }

  // 旧版键：POSIX 语法 + 随节点 osArch 变化的下载 UA（保持历史行为不变）。
  private buildInstallCommand(mode: 'WS' | 'HTTP', osArch?: string | null, publicBaseUrl?: string) {
    return this.renderLegacyPosixCommand(mode, normalizeOsArch(osArch) ?? 'linux-amd64', publicBaseUrl);
  }

  // POSIX 原生安装：拉取主控渲染的安装脚本（免交互预编排，自动 sudo 提权）
  private buildPosixInstallCommand(mode: 'WS' | 'HTTP', targetOs: 'linux' | 'macos', osArch?: string | null, publicBaseUrl?: string, agentToken?: string) {
    const { master } = this.resolveModeUrls(mode, publicBaseUrl);
    const platform = this.resolveTargetPlatform(targetOs, osArch);
    const scriptUrl = this.buildInstallerScriptUrl(publicBaseUrl);
    const modeParam = mode === 'HTTP' ? 'http' : 'ws';
    const temp = '/tmp/riri-agent-install.sh';
    if (agentToken) {
      const fullUrl = `${scriptUrl}?token=${encodeURIComponent(agentToken)}&mode=${modeParam}&platform=${platform}`;
      return `curl -fsSL --location -A 'riri-agent-installer/${platform}' '${fullUrl}' -o ${temp} && sudo sh ${temp}`;
    }
    return `read -r -s -p 'AgentToken: ' RIRI_AGENT_TOKEN; echo; export RIRI_AGENT_TOKEN; curl -fsSL --location -A 'riri-agent-installer/${platform}' -H "X-Agent-Token: $RIRI_AGENT_TOKEN" '${scriptUrl}?mode=${modeParam}' -o ${temp} && sh ${temp} --master='${master}' && rm -f ${temp}`;
  }

  // Windows 原生安装：拉取主控渲染的安装脚本（CMD 与 PowerShell 通用执行命令，拉取 .bat 执行）
  private buildWindowsInstallCommand(mode: 'WS' | 'HTTP', osArch?: string | null, publicBaseUrl?: string, agentToken?: string) {
    const { master } = this.resolveModeUrls(mode, publicBaseUrl);
    const platform = this.resolveTargetPlatform('windows', osArch);
    const scriptUrl = this.buildInstallerScriptUrl(publicBaseUrl);
    const modeParam = mode === 'HTTP' ? 'http' : 'ws';
    if (agentToken) {
      const fullUrl = `${scriptUrl}?token=${encodeURIComponent(agentToken)}&mode=${modeParam}&platform=${platform}&format=bat`;
      return `powershell -NoProfile -ExecutionPolicy Bypass -Command "curl.exe -fsSL --location -A 'riri-agent-installer/${platform}' '${fullUrl}' -o \\"$env:TEMP\\\\riri-install.bat\\"; & \\"$env:TEMP\\\\riri-install.bat\\""`;
    }
    return `$Token = Read-Host 'AgentToken'; curl.exe -fsSL --location -A 'riri-agent-installer/${platform}' -H "X-Agent-Token: $Token" '${scriptUrl}?mode=${modeParam}' -o "$env:TEMP\\riri-install.ps1"; powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\\riri-install.ps1" -MasterUrl '${master}' -AgentToken $Token; Remove-Item "$env:TEMP\\riri-install.ps1" -ErrorAction SilentlyContinue`;
  }

  // 安装脚本下载地址（脚本由主控按镜像设置与 UA 平台渲染，下载顺序 GitHub Release/镜像测速 → 主控兜底）
  private buildInstallerScriptUrl(publicBaseUrl?: string) {
    const baseUrl = publicBaseUrl ?? resolvePublicBaseUrl();
    return appendPublicPath(baseUrl, 'api/v1/downloads/agent-installer');
  }

  private buildPosixPortableCommand(mode: 'WS' | 'HTTP', targetOs: 'linux' | 'macos', osArch?: string | null, publicBaseUrl?: string, agentToken?: string) {
    const { master, downloadUrl } = this.resolveModeUrls(mode, publicBaseUrl);
    const platform = this.resolveTargetPlatform(targetOs, osArch);
    const temp = '/tmp/riri-agent-download';
    if (agentToken) {
      return `curl -fsSL --location -A 'riri-agent-installer/${platform}' -H "X-Agent-Token: ${agentToken}" '${downloadUrl}' -o ${temp} && chmod +x ${temp} && RIRICLOUD_DATA_DIR="$HOME/.riri-cloud" AGENT_TOKEN="${agentToken}" MASTER_URL='${master}' ${temp} run`;
    }
    return `read -r -s -p 'AgentToken: ' RIRI_AGENT_TOKEN; echo; curl -fsSL --location -A 'riri-agent-installer/${platform}' -H "X-Agent-Token: $RIRI_AGENT_TOKEN" '${downloadUrl}' -o ${temp} && chmod +x ${temp} && RIRICLOUD_DATA_DIR="$HOME/.riri-cloud" AGENT_TOKEN="$RIRI_AGENT_TOKEN" MASTER_URL='${master}' ${temp} run`;
  }

  private buildWindowsPortableCommand(mode: 'WS' | 'HTTP', osArch?: string | null, publicBaseUrl?: string, agentToken?: string) {
    const { master, downloadUrl } = this.resolveModeUrls(mode, publicBaseUrl);
    const platform = this.resolveTargetPlatform('windows', osArch);
    const dir = '$env:LOCALAPPDATA\\RiriCloud';
    const exe = `${dir}\\riri-agent.exe`;
    if (agentToken) {
      return `powershell -NoProfile -ExecutionPolicy Bypass -Command "New-Item -ItemType Directory -Force '${dir}' | Out-Null; curl.exe -fsSL --location -A 'riri-agent-installer/${platform}' -H 'X-Agent-Token: ${agentToken}' '${downloadUrl}' -o '${exe}'; \\$env:RIRICLOUD_DATA_DIR = '${dir}'; \\$env:AGENT_TOKEN = '${agentToken}'; \\$env:MASTER_URL = '${master}'; & '${exe}' run"`;
    }
    return `$Token = Read-Host 'AgentToken'; New-Item -ItemType Directory -Force "${dir}" | Out-Null; curl.exe -fsSL --location -A 'riri-agent-installer/${platform}' -H "X-Agent-Token: $Token" '${downloadUrl}' -o "${exe}"; $env:RIRICLOUD_DATA_DIR = "${dir}"; $env:AGENT_TOKEN = "$Token"; $env:MASTER_URL = '${master}'; & "${exe}" run`;
  }

  // 下载 UA 按目标 OS 归一；节点已上报的 arch 仅在 OS 匹配时复用，否则回退 amd64。
  private resolveTargetPlatform(targetOs: 'linux' | 'macos' | 'windows', osArch?: string | null): string {
    const normalized = normalizeOsArch(osArch);
    if (normalized?.startsWith(`${targetOs}-`)) return normalized;
    return `${targetOs}-amd64`;
  }

  private resolveModeUrls(mode: 'WS' | 'HTTP', publicBaseUrl?: string) {
    const baseUrl = publicBaseUrl ?? resolvePublicBaseUrl();
    return {
      master: mode === 'HTTP' ? baseUrl : appendPublicPath(toWebSocketBaseUrl(baseUrl), 'ws/agent'),
      downloadUrl: appendPublicPath(baseUrl, 'api/v1/downloads/agent')
    };
  }

  // 旧版 ws/http 键专用：直接下载主控裸二进制的原始内联命令（保持历史行为不变）。
  private renderLegacyPosixCommand(mode: 'WS' | 'HTTP', platform: string, publicBaseUrl?: string, agentToken?: string) {
    const { master, downloadUrl } = this.resolveModeUrls(mode, publicBaseUrl);
    const temp = '/tmp/riri-agent-download';
    if (agentToken) {
      return `curl -fsSL --location -A 'riri-agent-installer/${platform}' -H "X-Agent-Token: ${agentToken}" '${downloadUrl}' -o ${temp} && install -m 0755 ${temp} /usr/local/bin/riri-agent && rm -f ${temp} && /usr/local/bin/riri-agent install --token="${agentToken}" --master=${master}`;
    }
    return `read -r -s -p 'AgentToken: ' RIRI_AGENT_TOKEN; echo; curl -fsSL --location -A 'riri-agent-installer/${platform}' -H "X-Agent-Token: $RIRI_AGENT_TOKEN" '${downloadUrl}' -o ${temp} && install -m 0755 ${temp} /usr/local/bin/riri-agent && rm -f ${temp} && /usr/local/bin/riri-agent install --token="$RIRI_AGENT_TOKEN" --master=${master}`;
  }

  private buildDockerCommand(mode: 'WS' | 'HTTP', publicBaseUrl?: string, agentToken?: string) {
    const baseUrl = publicBaseUrl ?? resolvePublicBaseUrl();
    const master = mode === 'HTTP'
      ? baseUrl
      : appendPublicPath(toWebSocketBaseUrl(baseUrl), 'ws/agent');
    const agentMode = mode === 'HTTP' ? 'http' : 'ws';
    const agentImage = process.env.AGENT_IMAGE || '2chariko/riricloud-agent:latest';
    if (agentToken) {
      return `docker run -d --name riri-agent --restart unless-stopped --network host --cap-add=NET_ADMIN --cap-add=NET_BIND_SERVICE -v /var/lib/riri-agent:/var/lib/riri-agent -e AGENT_TOKEN="${agentToken}" -e AGENT_MASTER_URL='${master}' -e AGENT_MODE='${agentMode}' ${agentImage}`;
    }
    return `read -r -s -p 'AgentToken: ' RIRI_AGENT_TOKEN; echo; docker run -d --name riri-agent --restart unless-stopped --network host --cap-add=NET_ADMIN --cap-add=NET_BIND_SERVICE -v /var/lib/riri-agent:/var/lib/riri-agent -e AGENT_TOKEN="$RIRI_AGENT_TOKEN" -e AGENT_MASTER_URL='${master}' -e AGENT_MODE='${agentMode}' ${agentImage}`;
  }

  private buildUninstallCommand() {
    return 'sudo /usr/local/bin/riri-agent uninstall --purge --yes';
  }

  private buildWindowsUninstallCommand() {
    return '& "$env:ProgramFiles\\RiriCloud\\riri-agent.exe" uninstall --purge --yes';
  }

  private sanitize(node: NodeWithLines): Record<string, unknown> {
    const { entryLines, landingLines, lastProbeResult, capabilitiesJson, agentToken: _agentToken, agentTokenHash: _agentTokenHash, ...rest } = node;
    const safeRelation = (line: (typeof entryLines)[number] | (typeof landingLines)[number]) => ({ ...line, egressProxyJson: undefined, lastDebugProbeJson: undefined, ...('targetLine' in line ? { targetLine: line.targetLine ? { ...line.targetLine, egressProxyJson: undefined, lastDebugProbeJson: undefined } : null } : {}) });
    const toLine = (line: (typeof entryLines)[number] | (typeof landingLines)[number], role: 'DIRECT' | 'TRANSIT' | 'LANDING') => ({
      id: line.id,
      name: line.name,
      type: line.type,
      relayMode: line.relayMode,
      protocolType: line.protocolType,
      entryNodeId: line.entryNodeId,
      entryPort: line.entryPort,
      landingNodeId: line.landingNodeId,
      landingPort: line.landingPort,
      targetLineId: line.targetLineId,
      serverHost: line.serverHost,
      serverPort: line.serverPort,
      landingEndpointOverrideEnabled: 'landingEndpointOverrideEnabled' in line ? Boolean(line.landingEndpointOverrideEnabled) : false,
      landingServerHost: 'landingServerHost' in line ? (line.landingServerHost as string | null) : null,
      landingServerPort: 'landingServerPort' in line ? (line.landingServerPort as number | null) : null,
      trafficRate: line.trafficRate,
      tags: this.parseTags(line.tagsJson),
      level: line.level,
      sortOrder: line.sortOrder,
      isPublic: line.isPublic,
      status: line.status,
      role,
      entryNode: 'entryNode' in line ? line.entryNode : undefined,
      landingNode: 'landingNode' in line ? line.landingNode : undefined,
      targetLine: 'targetLine' in line && line.targetLine ? { ...line.targetLine, egressProxyJson: undefined, lastDebugProbeJson: undefined } : undefined
    });

    const linesMap = new Map<string, ReturnType<typeof toLine>>();
    const servicePorts: Array<{ lineId: string; lineName: string; protocolType: string; role: 'DIRECT' | 'TRANSIT' | 'LANDING'; port: number }> = [];

    for (const line of entryLines) {
      if (line.type === 'EXTERNAL' || line.entryPort === null) continue;
      if (line.type === 'DIRECT') {
        const item = toLine(line, 'DIRECT');
        linesMap.set(line.id, item);
        servicePorts.push({ lineId: line.id, lineName: line.name, protocolType: line.protocolType, role: 'DIRECT', port: line.entryPort });
      } else {
        const item = toLine(line, 'TRANSIT');
        linesMap.set(line.id, item);
        servicePorts.push({ lineId: line.id, lineName: line.name, protocolType: line.protocolType, role: 'TRANSIT', port: line.entryPort });
      }
    }

    for (const line of landingLines) {
      if (!linesMap.has(line.id)) {
        const item = toLine(line, 'LANDING');
        linesMap.set(line.id, item);
      }
      if (line.type === 'RELAY' && line.relayMode !== 'TARGET_LINE' && line.landingPort) {
        servicePorts.push({ lineId: line.id, lineName: line.name, protocolType: line.protocolType, role: 'LANDING', port: line.landingPort });
      }
    }

    const lines = [...linesMap.values()];
    const capabilities = this.parseStringArray(capabilitiesJson);
    const diagnosticActive = rest.singboxLogMode !== 'NORMAL' && Boolean(rest.singboxLogModeUntil) && new Date(rest.singboxLogModeUntil as Date).getTime() > Date.now();
    return {
      ...rest,
      singboxLogMode: diagnosticActive ? rest.singboxLogMode : 'NORMAL',
      singboxLogModeUntil: diagnosticActive && rest.singboxLogModeUntil ? new Date(rest.singboxLogModeUntil as Date).toISOString() : null,
      capabilities,
      supportsMirrorProxy: capabilities.includes('mirror_proxy'),
      supportsSingboxLogCapture: capabilities.includes('singbox_log_capture'),
      supportsAgentLogRotation: capabilities.includes('agent_log_rotation'),
      lastProbeResult: this.parseJson(lastProbeResult),
      lines,
      entryLines: entryLines.map(safeRelation),
      landingLines: landingLines.map(safeRelation),
      servicePorts
    };
  }

  private parseTags(value: string) {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }

  private parseJson(value: string | null): unknown {
    if (!value) return null;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  private parseStringArray(value: string): string[] {
    try {
      const parsed: unknown = JSON.parse(value || '[]');
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }
}

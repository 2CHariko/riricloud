import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { parseDocument } from 'yaml';
import { SETTING_KEYS, SettingsService } from '../system/settings.service';
import { LinesService } from '../lines/lines.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTemplateDto } from './dto/create-template.dto';
import { PreviewTemplateDto } from './dto/preview-template.dto';
import { ClientKernelsService } from '../client-kernels/client-kernels.service';
import { UpdateTemplateDto } from './dto/update-template.dto';
import { buildClashYaml, buildSingboxJson, type SubLine, type SubUser, type SubscriptionTemplateConfig } from '../subscription/builders';

import { bindManagedConnection } from '../subscription/compilers/managed-connection';
import { getProxyCapabilities } from '../common/proxy-capabilities';
type TemplateViewInput = {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  isBuiltin: boolean;
  proxyGroupsJson: string;
  ruleSetsJson: string;
  dnsConfigJson: string;
  customInjectYaml: string | null;
  customInjectJson: string | null;
  [key: string]: unknown;
};

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

@Injectable()
export class TemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(SettingsService) private readonly settingsService: SettingsService | undefined,
    @Optional() @Inject(LinesService) private readonly linesService: LinesService | undefined,
    private readonly kernels: ClientKernelsService
  ) {}

  async create(dto: CreateTemplateDto) {
    const data = { ...this.toData(dto), name: dto.name.trim() };
    const template = dto.isDefault
      ? await this.prisma.$transaction(async (tx) => {
          const created = await tx.subscriptionTemplate.create({ data });
          await this.syncDefaultTemplate(tx, created.id);
          return created;
        })
      : await this.prisma.subscriptionTemplate.create({ data });
    return this.toView(template);
  }

  async list() {
    const templates = await this.prisma.subscriptionTemplate.findMany({
      include: { _count: { select: { plans: true } } },
      orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }]
    });
    return templates.map((template) => this.toView(template));
  }

  async get(id: string) {
    const template = await this.prisma.subscriptionTemplate.findUnique({
      where: { id },
      include: { _count: { select: { plans: true } } }
    });
    if (!template) throw new NotFoundException('订阅模板不存在');
    return this.toView(template);
  }

  async getDefault() {
    const settings = await this.settingsService?.getSettings();
    const configured = settings?.defaultTemplateId
      ? await this.prisma.subscriptionTemplate.findUnique({ where: { id: settings.defaultTemplateId } })
      : null;
    const template = configured ?? await this.prisma.subscriptionTemplate.findFirst({ where: { isDefault: true }, orderBy: { createdAt: 'asc' } });
    if (!template) throw new NotFoundException('尚未配置订阅模板');
    return this.toView(template);
  }

  async update(id: string, dto: UpdateTemplateDto) {
    const current = await this.prisma.subscriptionTemplate.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('订阅模板不存在');
    const data = this.toData(dto);
    const shouldSyncDefault = dto.isDefault === true || (dto.isDefault === false && current.isDefault);
    const template = shouldSyncDefault
      ? await this.prisma.$transaction(async (tx) => {
          const updated = await tx.subscriptionTemplate.update({ where: { id }, data });
          if (dto.isDefault === true) {
            await this.syncDefaultTemplate(tx, id);
          } else {
            await this.clearConfiguredDefault(tx, id);
          }
          return updated;
        })
      : await this.prisma.subscriptionTemplate.update({ where: { id }, data });
    return this.toView(template);
  }

  async duplicate(id: string) {
    const source = await this.prisma.subscriptionTemplate.findUnique({ where: { id } });
    if (!source) throw new NotFoundException('订阅模板不存在');
    const template = await this.prisma.subscriptionTemplate.create({
      data: {
        name: `${source.name} (副本)`,
        description: source.description,
        isDefault: false,
        isBuiltin: false,
        proxyGroupsJson: source.proxyGroupsJson,
        ruleSetsJson: source.ruleSetsJson,
        dnsConfigJson: source.dnsConfigJson,
        customInjectYaml: source.customInjectYaml,
        customInjectJson: source.customInjectJson
      }
    });
    return this.toView(template);
  }

  async previewTemplate(dto: PreviewTemplateDto) {
    const sources = await this.getPreviewSources();
    const template = this.toTemplateConfig(dto.template);
    const user: SubUser = {
      uuid: '00000000-0000-4000-8000-000000000001',
      email: 'preview@riricloud.local',
      credential: 'preview-credential'
    };
    const warnings: string[] = [];
    const engine = dto.format === 'clash' ? 'mihomo' : 'singbox';
    const compatible = sources.filter((line) => {
      const connection = line.externalConnection ?? bindManagedConnection({ protocolType: line.protocolType ?? 'VLESS', serverHost: line.serverHost, serverPort: line.serverPort, params: line.params ?? {}, lineId: line.id, serverName: line.serverName ?? undefined, host: line.host ?? undefined }, user);
      const capability = getProxyCapabilities(connection)[engine];
      if (!capability.supported) warnings.push(`PREVIEW_NODE_OMITTED:${line.id ?? 'unknown'}:${capability.reason}`);
      return capability.supported;
    });
    const content = dto.format === 'clash'
      ? buildClashYaml(user, compatible, template)
      : buildSingboxJson(user, compatible, template);
    const stats = { ...this.previewStats(dto.format, content, compatible.length), totalNodes: sources.length };
    const kernelCheck = await this.kernels.validate(dto.format === 'clash' ? 'MIHOMO' : 'SINGBOX', content);
    return { format: dto.format, content, stats, warnings, kernelCheck };
  }

  async remove(id: string) {
    const template = await this.prisma.subscriptionTemplate.findUnique({
      where: { id },
      include: { _count: { select: { plans: true } } }
    });
    if (!template) throw new NotFoundException('订阅模板不存在');
    if (template.isBuiltin) throw new ConflictException('内嵌默认模板不能删除，只能修改');
    if (template.isDefault) throw new ConflictException('默认模板不能删除，请先指定其他默认模板');
    if (template._count.plans > 0) throw new ConflictException('套餐仍在使用该模板');
    await this.prisma.subscriptionTemplate.delete({ where: { id } });
    return { deleted: true };
  }

  private toData(dto: CreateTemplateDto | UpdateTemplateDto) {
    this.validateYaml(dto.customInjectYaml);
    this.validateJson(dto.customInjectJson);
    return {
      ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
      ...(dto.description !== undefined ? { description: dto.description?.trim() || null } : {}),
      ...(dto.proxyGroups !== undefined ? { proxyGroupsJson: JSON.stringify(dto.proxyGroups) } : {}),
      ...(dto.ruleSets !== undefined ? { ruleSetsJson: JSON.stringify(dto.ruleSets) } : {}),
      ...(dto.dnsConfig !== undefined ? { dnsConfigJson: JSON.stringify(dto.dnsConfig) } : {}),
      ...(dto.customInjectYaml !== undefined ? { customInjectYaml: dto.customInjectYaml?.trim() || null } : {}),
      ...(dto.customInjectJson !== undefined ? { customInjectJson: dto.customInjectJson?.trim() || null } : {}),
      ...(dto.isDefault !== undefined ? { isDefault: dto.isDefault } : {})
    };
  }

  private toTemplateConfig(template: PreviewTemplateDto['template']): SubscriptionTemplateConfig {
    this.validateYaml(template.customInjectYaml);
    this.validateJson(template.customInjectJson);
    return {
      proxyGroupsJson: JSON.stringify(template.proxyGroups ?? []),
      ruleSetsJson: JSON.stringify(template.ruleSets ?? []),
      dnsConfigJson: JSON.stringify(template.dnsConfig ?? {}),
      customInjectYaml: template.customInjectYaml?.trim() || null,
      customInjectJson: template.customInjectJson?.trim() || null
    };
  }

  private async getPreviewSources(): Promise<SubLine[]> {
    if (this.linesService) {
      try {
        const lines = await this.linesService.getAvailableForPlan({ lineMatchMode: 'ALL', lineTagsJson: '[]', lineIdsJson: '[]' });
        if (lines.length) return lines.map((line) => this.toSubLine(line));
      } catch {
        // Preview remains useful during first boot or while the line tables are being migrated.
      }
    }
    return this.mockPreviewSources();
  }

  private toSubLine(line: Awaited<ReturnType<LinesService['getAvailableForPlan']>>[number]): SubLine {
    return {
      id: typeof line.id === 'string' ? line.id : undefined,
      name: typeof line.name === 'string' ? line.name : 'Preview line',
      type: typeof line.type === 'string' ? line.type : 'DIRECT',
      relayMode: typeof line.relayMode === 'string' ? line.relayMode : null,
      endpointOverrideEnabled: line.endpointOverrideEnabled !== false,
      serverHost: typeof line.serverHost === 'string' ? line.serverHost : '127.0.0.1',
      serverPort: typeof line.serverPort === 'number' ? line.serverPort : 443,
      serverName: typeof line.serverName === 'string' ? line.serverName : null,
      host: typeof line.host === 'string' ? line.host : null,
      trafficRate: typeof line.trafficRate === 'number' ? line.trafficRate : 1,
      tags: Array.isArray(line.tags) ? line.tags.filter((tag): tag is string => typeof tag === 'string') : [],
      level: typeof line.level === 'number' ? line.level : 0,
      protocolType: typeof line.protocolType === 'string' ? line.protocolType as SubLine['protocolType'] : 'VLESS',
      params: line.params,
      externalConnection: line.externalConnection
    };
  }

  private mockPreviewSources(): SubLine[] {
    const tls = (serverName: string) => ({ enabled: true, mode: 'tls', serverName, alpn: ['h2'], insecure: false });
    return [
      { id: 'preview-hk-vless', name: '香港 · VLESS Reality', serverHost: 'hk.preview.invalid', serverPort: 443, protocolType: 'VLESS', tags: ['hk', 'premium'], params: { transport: { type: 'tcp' }, flow: 'xtls-rprx-vision', tls: { enabled: true, mode: 'reality', serverName: 'www.apple.com', reality: { publicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', shortIds: ['0123456789abcdef'] } } } },
      { id: 'preview-jp-hy2', name: '日本 · Hysteria2', serverHost: 'jp.preview.invalid', serverPort: 8443, protocolType: 'HYSTERIA2', tags: ['jp', 'udp'], params: { tls: tls('jp.preview.invalid'), upMbps: 100, downMbps: 300 } },
      { id: 'preview-us-trojan', name: '美国 · Trojan', serverHost: 'us.preview.invalid', serverPort: 443, protocolType: 'TROJAN', tags: ['us', 'premium'], params: { transport: { type: 'tcp' }, tls: tls('us.preview.invalid') } },
      { id: 'preview-sg-vmess', name: '新加坡 · VMess', serverHost: 'sg.preview.invalid', serverPort: 443, protocolType: 'VMESS', tags: ['sg'], params: { transport: { type: 'ws', path: '/preview', host: 'sg.preview.invalid' }, tls: tls('sg.preview.invalid') } },
      { id: 'preview-hk-ss', name: '香港 · Shadowsocks', serverHost: 'hk-ss.preview.invalid', serverPort: 8388, protocolType: 'SHADOWSOCKS', tags: ['hk', 'economy'], params: { method: 'aes-128-gcm', password: 'preview-password', mode: 'single' } },
      { id: 'preview-us-naive', name: '美国 · NaiveProxy', serverHost: 'us-naive.preview.invalid', serverPort: 443, protocolType: 'NAIVE', tags: ['us', 'economy'], params: { username: 'preview', password: 'preview-password', tls: tls('us-naive.preview.invalid') } }
    ];
  }

  private previewStats(format: PreviewTemplateDto['format'], content: string, sourceCount: number) {
    try {
      const parsed = format === 'clash' ? parseDocument(content).toJS() as Record<string, unknown> : JSON.parse(content) as Record<string, unknown>;
      const proxies = format === 'clash' && Array.isArray(parsed.proxies) ? parsed.proxies.length : sourceCount;
      const nodeNames = new Set(
        format === 'clash' && Array.isArray(parsed.proxies)
          ? parsed.proxies.flatMap((item) => item && typeof item === 'object' && typeof (item as Record<string, unknown>).name === 'string' ? [(item as Record<string, unknown>).name as string] : [])
          : format === 'singbox' && Array.isArray(parsed.outbounds)
            ? parsed.outbounds.flatMap((item) => item && typeof item === 'object' && !['direct', 'block', 'selector', 'urltest'].includes((item as Record<string, unknown>).type as string) && typeof (item as Record<string, unknown>).tag === 'string' ? [(item as Record<string, unknown>).tag as string] : [])
            : []
      );
      const groups = format === 'clash' && Array.isArray(parsed['proxy-groups'])
        ? parsed['proxy-groups'].length
        : format === 'singbox' && Array.isArray(parsed.outbounds)
          ? parsed.outbounds.filter((item) => item && typeof item === 'object' && ['selector', 'urltest'].includes((item as Record<string, unknown>).type as string)).length
          : 0;
      const rules = format === 'clash' && Array.isArray(parsed.rules)
        ? parsed.rules.length
        : format === 'singbox' && parsed.route && typeof parsed.route === 'object' && Array.isArray((parsed.route as Record<string, unknown>).rules)
          ? ((parsed.route as Record<string, unknown>).rules as unknown[]).length
          : 0;
      const matchedNodes = format === 'clash' && Array.isArray(parsed['proxy-groups'])
        ? new Set(parsed['proxy-groups'].flatMap((group) => group && typeof group === 'object' && Array.isArray((group as Record<string, unknown>).proxies) ? ((group as Record<string, unknown>).proxies as unknown[]).filter((name): name is string => typeof name === 'string' && nodeNames.has(name)) : [])).size
        : format === 'singbox' && Array.isArray(parsed.outbounds)
          ? new Set(parsed.outbounds.flatMap((outbound) => outbound && typeof outbound === 'object' && Array.isArray((outbound as Record<string, unknown>).outbounds) ? ((outbound as Record<string, unknown>).outbounds as unknown[]).filter((name): name is string => typeof name === 'string' && nodeNames.has(name)) : [])).size
          : proxies;
      return { totalNodes: proxies, matchedNodes, proxyGroupsCount: groups, rulesCount: rules };
    } catch {
      return { totalNodes: sourceCount, matchedNodes: sourceCount, proxyGroupsCount: 0, rulesCount: 0 };
    }
  }

  private async syncDefaultTemplate(tx: Prisma.TransactionClient, id: string) {
    await tx.subscriptionTemplate.updateMany({ where: { id: { not: id } }, data: { isDefault: false } });
    await tx.systemSetting.upsert({
      where: { key: SETTING_KEYS.DEFAULT_TEMPLATE_ID },
      update: { value: id },
      create: { key: SETTING_KEYS.DEFAULT_TEMPLATE_ID, value: id, description: '全局默认订阅模板' }
    });
  }

  private async clearConfiguredDefault(tx: Prisma.TransactionClient, id: string) {
    const configured = await tx.systemSetting.findUnique({ where: { key: SETTING_KEYS.DEFAULT_TEMPLATE_ID } });
    if (configured?.value !== id) return;
    await tx.systemSetting.upsert({
      where: { key: SETTING_KEYS.DEFAULT_TEMPLATE_ID },
      update: { value: '' },
      create: { key: SETTING_KEYS.DEFAULT_TEMPLATE_ID, value: '', description: '全局默认订阅模板' }
    });
  }

  private validateYaml(value: string | null | undefined) {
    if (!value?.trim()) return;
    const doc = parseDocument(value);
    if (doc.errors.length) throw new BadRequestException(`customInjectYaml 语法错误: ${doc.errors[0].message}`);
    if (!doc.toJS() || Array.isArray(doc.toJS()) || typeof doc.toJS() !== 'object') {
      throw new BadRequestException('customInjectYaml 必须是 YAML 对象');
    }
  }

  private validateJson(value: string | null | undefined) {
    if (!value?.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new BadRequestException('customInjectJson 必须是合法 JSON');
    }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new BadRequestException('customInjectJson 必须是 JSON 对象');
    }
  }

  private toView(template: TemplateViewInput) {
    return {
      ...template,
      proxyGroups: parseJson(template.proxyGroupsJson, []),
      ruleSets: parseJson(template.ruleSetsJson, []),
      dnsConfig: parseJson(template.dnsConfigJson, {}),
      proxyGroupsJson: undefined,
      ruleSetsJson: undefined,
      dnsConfigJson: undefined
    };
  }

}

import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { isIP } from 'node:net';
import { decryptSecret } from '../common/secret-crypto';
import { PrismaService } from '../prisma/prisma.service';
import { resolveManagedTlsName, resolveRelayTlsName } from '../subscription/compilers/managed-connection';
import { assertCertificateUsable, certificateMatchesHost, parseCertificateChain } from './certificate-validation';
const bindingLineInclude = { entryNode: true, landingNode: true, targetLine: { include: { entryNode: true } } } as const;
type AssociatedLine = Prisma.LineGetPayload<{ include: typeof bindingLineInclude }>;
export type BindingLine = {
  id?: string;
  name?: string;
  type?: string;
  relayMode?: string | null;
  paramsJson?: string;
  certificateId?: string | null;
  targetLineId?: string | null;
  endpointOverrideEnabled?: boolean;
  serverHost?: string | null;
  serverName?: string | null;
  entryNodeId?: string | null;
  landingNodeId?: string | null;
  landingEndpointOverrideEnabled?: boolean;
  landingServerHost?: string | null;
  status?: string;
  entryNode?: {
    serverHost: string;
  } | null;
  landingNode?: {
    serverHost: string;
    reachability?: string;
  } | null;
};
function protocolRelayServerName(line: BindingLine): string {
  const host = line.landingNode?.serverHost ?? '';
  const dial = line.landingNode?.reachability === 'NAT' ? '127.0.0.1' : line.landingEndpointOverrideEnabled && line.landingServerHost ? line.landingServerHost : host;
  return resolveRelayTlsName(JSON.parse(line.paramsJson ?? '{}') as Record<string, unknown>, host, null, dial);
}
export function bridgeServerName(target: BindingLine, relay?: BindingLine): string {
  const explicit = target.endpointOverrideEnabled ? target.serverName?.trim() : null;
  const host = target.endpointOverrideEnabled && target.serverHost ? target.serverHost.trim() : target.entryNode?.serverHost ?? '';
  const inferred = !isIP(host) ? host : target.entryNode?.serverHost && !isIP(target.entryNode.serverHost) ? target.entryNode.serverHost : undefined;
  const dial = relay?.landingEndpointOverrideEnabled && relay.landingServerHost ? relay.landingServerHost.trim() : host;
  return resolveRelayTlsName(JSON.parse(target.paramsJson ?? '{}') as Record<string, unknown>, host, explicit || inferred, dial);
}
export function certificateHostingNodes(line: BindingLine): string[] {
  const nodes = line.type === 'RELAY' && line.relayMode === 'BLIND_FORWARD' ? [line.landingNodeId] : line.relayMode === 'PROTOCOL_PROXY' ? [line.entryNodeId, line.landingNodeId] : [line.entryNodeId];
  return nodes.filter((id): id is string => Boolean(id));
}
export function certificateBindingChanged(before: BindingLine, after: BindingLine): boolean {
  const fields = ['certificateId', 'type', 'relayMode', 'entryNodeId', 'landingNodeId', 'targetLineId', 'endpointOverrideEnabled', 'serverHost', 'serverName', 'landingEndpointOverrideEnabled', 'landingServerHost'] as const;
  if (fields.some(key => (before[key] ?? null) !== (after[key] ?? null)))
    return true;
  try {
    const a = JSON.parse(before.paramsJson ?? '{}') as {
      tls?: {
        serverName?: string;
      };
    };
    const b = JSON.parse(after.paramsJson ?? '{}') as {
      tls?: {
        serverName?: string;
      };
    };
    return (a.tls?.serverName?.trim() ?? '') !== (b.tls?.serverName?.trim() ?? '');
  }
  catch {
    return true;
  }
}
export function bindingServerName(line: BindingLine): string {
  let params: Record<string, unknown> = {};
  try {
    params = JSON.parse(line.paramsJson ?? '{}') as Record<string, unknown>;
  }
  catch { /* 历史异常由校验显示 */ }
  const host = line.endpointOverrideEnabled && line.serverHost ? line.serverHost : line.entryNode?.serverHost ?? '';
  return resolveManagedTlsName(host, params, line.endpointOverrideEnabled ? line.serverName : null);
}
@Injectable()
export class CertificateBindingsService {
  constructor(private readonly prisma: PrismaService) { }
  async counts(ids: string[]) {
    const rows = await this.prisma.line.findMany({ where: { OR: [{ certificateId: { in: ids } }, { targetLine: { certificateId: { in: ids } } }] }, select: { certificateId: true, targetLine: { select: { certificateId: true } } } });
    const result = new Map(ids.map(id => [id, { directLineCount: 0, inheritedLineCount: 0, associatedLineCount: 0 }]));
    for (const row of rows) {
      for (const id of new Set([row.certificateId, row.targetLine?.certificateId])) {
        const count = id ? result.get(id) : undefined;
        if (!count) continue;
        count.associatedLineCount++;
        if (row.certificateId === id) count.directLineCount++;
        else count.inheritedLineCount++;
      }
    }
    return result;
  }
  async associations(ids: string[]) {
    return this.prisma.line.findMany({ where: { OR: [{ certificateId: { in: ids } }, { targetLine: { certificateId: { in: ids } } }] }, include: bindingLineInclude, orderBy: { createdAt: 'asc' } });
  }
  async lines(id: string, pem: string, client: Prisma.TransactionClient = this.prisma, associations?: AssociatedLine[]) {
    const rows = associations?.filter(line => line.certificateId === id || line.targetLine?.certificateId === id) ?? await client.line.findMany({ where: { OR: [{ certificateId: id }, { targetLine: { certificateId: id } }] }, include: bindingLineInclude, orderBy: { createdAt: 'asc' } });
    return rows.map(line => {
      const own = line.certificateId === id;
      const source = own ? line : line.targetLine!;
      const serverName = own ? bindingServerName(source) : bridgeServerName(source, line);
      const serverNames = [serverName];
      if (own && line.relayMode === 'PROTOCOL_PROXY')
        serverNames.push(protocolRelayServerName(line));
      if (own && line.targetLine?.certificateId === id)
        serverNames.push(bridgeServerName(line.targetLine, line));
      const hostingNodeIds = [...new Set([...certificateHostingNodes(source), ...(own && line.targetLine?.certificateId === id ? certificateHostingNodes(line.targetLine) : [])])];
      let validationError: string | null = null;
      try {
        serverNames.forEach(name => assertCertificateUsable(pem, name));
      }
      catch (error) {
        validationError = error instanceof Error ? error.message : '证书不可用于此线路';
      }
      const candidates = own ? [line.entryNode, line.landingNode, line.targetLine?.entryNode] : [line.targetLine?.entryNode];
      const hostingNodes = hostingNodeIds.map(id => candidates.find(node => node?.id === id)).filter((node): node is NonNullable<typeof node> => Boolean(node)).map(node => ({ id: node.id, name: node.name }));
      return { id: line.id, name: line.name, type: line.type, relayMode: line.relayMode, targetLine: line.targetLine ? { id: line.targetLine.id, name: line.targetLine.name } : null, protocolType: line.protocolType, status: line.status, inherited: !own, serverName, serverNames, matched: serverNames.every(name => certificateMatchesHost(pem, name)), validationError, entryNode: line.entryNode ? { id: line.entryNode.id, name: line.entryNode.name } : null, landingNode: line.landingNode ? { id: line.landingNode.id, name: line.landingNode.name } : null, hostingNodeId: hostingNodeIds[0] ?? null, hostingNodeIds, hostingNodes, nodeIds: [line.entryNodeId, line.landingNodeId].filter((id): id is string => Boolean(id)) };
    });
  }
  async assertReplacement(id: string, pem: string, client: Prisma.TransactionClient = this.prisma) {
    const rows = await this.lines(id, pem, client);
    const invalid = rows.filter(row => row.validationError);
    if (invalid.length)
      throw new BadRequestException({ message: '证书不适用于关联线路，请先调整线路或解除关联', affectedLines: invalid.map(row => ({ id: row.id, name: row.name, serverName: row.serverName, reason: row.validationError })) });
    return rows;
  }
  async assertLine(line: BindingLine, client: Prisma.TransactionClient = this.prisma) {
    if (line.certificateId) {
      const certificate = await client.certificate.findUnique({ where: { id: line.certificateId } });
      if (!certificate)
        throw new BadRequestException('证书不存在');
      parseCertificateChain(certificate.certificatePem, decryptSecret(certificate.privateKeyPem));
      const node = line.entryNode ?? (line.entryNodeId ? await client.node.findUnique({ where: { id: line.entryNodeId }, select: { serverHost: true } }) : null);
      assertCertificateUsable(certificate.certificatePem, bindingServerName({ ...line, entryNode: node }));
      if (line.relayMode === 'PROTOCOL_PROXY') {
        const landing = line.landingNode ?? await client.node.findUnique({ where: { id: line.landingNodeId! } });
        assertCertificateUsable(certificate.certificatePem, protocolRelayServerName({ ...line, landingNode: landing }));
      }
    }
    if (line.relayMode === 'TARGET_LINE' && line.targetLineId) {
      const target = await client.line.findUnique({ where: { id: line.targetLineId }, include: { certificate: true, entryNode: true } });
      if (target?.certificate) {
        parseCertificateChain(target.certificate.certificatePem, decryptSecret(target.certificate.privateKeyPem));
        assertCertificateUsable(target.certificate.certificatePem, bridgeServerName(target, line));
      }
    }
  }
}

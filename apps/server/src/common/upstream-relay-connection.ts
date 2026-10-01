import { readUpstreamConnection, type UpstreamAvailabilityNode } from './upstream-availability';
import { validateUpstreamConnection, type UpstreamConnection } from './upstream-connection';

export type UpstreamRelayEndpoint = { landingEndpointOverrideEnabled?: boolean; landingServerHost?: string | null; landingServerPort?: number | null };
// 保存、容量分配与Agent下发必须使用同一覆盖后的连接，避免导出无法下发的入口。
export function readUpstreamRelayConnection(line: UpstreamRelayEndpoint, node: Pick<UpstreamAvailabilityNode, 'protocolType' | 'serverHost' | 'serverPort' | 'paramsJson'>): UpstreamConnection {
  const connection = readUpstreamConnection(node);
  if (line.landingEndpointOverrideEnabled && line.landingServerHost) {
    connection.serverHost = line.landingServerHost;
    connection.serverPort = line.landingServerPort ?? connection.serverPort;
  }
  validateUpstreamConnection(connection);
  return connection;
}

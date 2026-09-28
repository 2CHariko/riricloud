import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api, extractErrorMessage } from '@/lib/api';

// 支持的入站协议（与 server common/constants.ts 对齐）
export const PROTOCOL_TYPES = [
  'VLESS',
  'VMESS',
  'TROJAN',
  'HYSTERIA2',
  'TUIC',
  'SHADOWSOCKS',
  'NAIVE',
  'SHADOWTLS',
  'MIXED',
  'SOCKS',
  'HTTP',
  'DIRECT'
] as const;
export type ProtocolType = (typeof PROTOCOL_TYPES)[number];

export const PROTOCOL_LABELS: Record<ProtocolType, string> = {
  VLESS: 'VLESS',
  VMESS: 'VMess',
  TROJAN: 'Trojan',
  HYSTERIA2: 'Hysteria 2',
  TUIC: 'TUIC v5',
  SHADOWSOCKS: 'Shadowsocks',
  NAIVE: 'NaiveProxy',
  SHADOWTLS: 'ShadowTLS',
  MIXED: 'Mixed (SOCKS5/HTTP)',
  SOCKS: 'SOCKS5',
  HTTP: 'HTTP',
  DIRECT: 'Direct'
};

export type TransportType = 'tcp' | 'ws' | 'grpc' | 'http' | 'httpupgrade';
export type CommunicationMode = 'WS' | 'HTTP';
export type SingboxLogMode = 'NORMAL' | 'INFO' | 'DEBUG';

export type ProbeResult = {
  type: 'tcp' | 'dns' | 'icmp';
  target: string;
  success: boolean;
  latencyMs?: number;
  addresses?: string[];
  packetLossPercent?: number;
  message?: string;
};

export type ProbeSnapshot = {
  taskId: string;
  success: boolean;
  results: ProbeResult[];
  completedAt: string;
};

export type BinaryTargetInfo = {
  target: string;
  kind: 'agent' | 'singbox';
  os: string;
  arch: string;
  filename: string;
  version: string;
  sha256: string;
  size: number;
  imported: boolean;
  available: boolean;
};

export type AdminBinaryInfo = {
  masterVersion: string;
  refreshedAt: string | null;
  targets: BinaryTargetInfo[];
};

export interface InboundTransport {
  type: TransportType;
  path?: string;
  host?: string;
  serviceName?: string;
  headers?: Record<string, string>;
  maxEarlyData?: number;
  earlyDataHeaderName?: string;
}

export type TlsMode = 'none' | 'tls' | 'reality' | 'acme';

export interface InboundRealityConfig {
  dest: string;
  serverNames: string[];
  privateKey?: string;
  publicKey: string;
  shortIds: string[];
}

export interface InboundAcmeConfig {
  domain: string;
  email: string;
  provider?: string;
}

export interface InboundTlsConfig {
  enabled: boolean;
  mode: TlsMode;
  serverName?: string;
  certificatePath?: string;
  keyPath?: string;
  acme?: InboundAcmeConfig;
  reality?: InboundRealityConfig;
  alpn?: string[];
  insecure?: boolean;
  min_version?: string;
  max_version?: string;
  cipher_suites?: string[];
}

// 入站协议专属参数（响应已剥离 privateKey）
export interface InboundParams {
  flow?: string;
  transport?: InboundTransport;
  tls?: InboundTlsConfig;
  multiplex?: {
    enabled?: boolean;
    protocol?: 'smux' | 'yamux' | 'h2mux';
    max_connections?: number;
    min_streams?: number;
    max_streams?: number;
    padding?: boolean;
    brutal?: {
      enabled?: boolean;
      up_mbps?: number;
      down_mbps?: number;
    };
  };
  masquerade?: {
    type: 'none' | 'file' | 'proxy' | 'string';
    file?: string;
    dir?: string;
    url?: string;
    string?: string;
    text?: string;
  };
  udp_over_tcp?: boolean;
  alterId?: number;
  upMbps?: number;
  downMbps?: number;
  ignoreClientBandwidth?: boolean;
  obfs?: {
    type: string;
    password?: string;
  };
  congestionControl?: string;
  zeroRttHandshake?: boolean;
  heartbeat?: string;
  method?: string;
  password?: string;
  mode?: 'shared' | 'multi-user';
  network?: string;
  version?: number;
  handshakeDest?: string;
  strictMode?: boolean;
  inner?: {
    type: 'SHADOWSOCKS';
    method: string;
    password: string;
  };
  allowLan?: boolean;
  usersEnabled?: boolean;
  overrideAddress?: string;
  overridePort?: number;
}

export interface NodeLine {
  id: string;
  name: string;
  type: 'DIRECT' | 'RELAY';
  relayMode: 'BLIND_FORWARD' | 'PROTOCOL_PROXY' | 'TARGET_LINE' | null;
  protocolType: ProtocolType;
  entryNodeId: string;
  entryPort: number;
  landingNodeId?: string | null;
  landingPort?: number | null;
  allowLanAccess?: boolean;
  tunnelType?: string | null;
  tunnelPort?: number | null;
  tunnelSecret?: string | null;
  serverHost: string | null;
  serverPort: number | null;
  trafficRate: number;
  tags: string[];
  level: number;
  sortOrder: number;
  isPublic: boolean;
  status: 'ACTIVE' | 'DISABLED';
  role: 'ENTRY' | 'LANDING' | 'DIRECT';
  entryNode?: { id: string; name: string; serverHost: string; status: string; isLocal: boolean; reachability?: 'PUBLIC' | 'NAT' };
  landingNode?: { id: string; name: string; serverHost: string; status: string; isLocal: boolean; reachability?: 'PUBLIC' | 'NAT' } | null;
}

export interface AdminNode {
  id: string;
  name: string;
  serverHost: string;
  reachability?: 'PUBLIC' | 'NAT';
  isLocal: boolean;
  configOverride: string | null;
  singboxLogMode: SingboxLogMode;
  singboxLogModeUntil: string | null;
  communicationMode: CommunicationMode;
  pollIntervalSecs: number;
  status: string;
  lastSeenAt: string | null;
  cpuUsage: number | null;
  memoryUsage: number | null;
  bandwidthRate: number | null;
  uploadRate: number | null;
  downloadRate: number | null;
  kernelRunning: boolean | null;
  configError: string | null;
  lastProbeResult: ProbeSnapshot | null;
  agentVersion: string | null;
  osArch: string | null;
  kernelVersion: string | null;
  capabilities: string[];
  supportsMirrorProxy?: boolean;
  supportsSingboxLogCapture?: boolean;
  supportsAgentLogRotation?: boolean;
  agentProtocolVersion?: number | null;
  currentAgentAssetId?: string | null;
  currentSingboxAssetId?: string | null;
  pendingVersionConfirm?: { taskId: string; expectedVersion: string; completedAt: string } | null;
  lines: NodeLine[];
  entryLines: NodeLine[];
  landingLines: NodeLine[];
  servicePorts: Array<{ lineId: string; lineName: string; protocolType: ProtocolType; role: 'DIRECT' | 'TRANSIT' | 'LANDING'; port: number }>;
  installCommands?: NodeInstallCommands;
  agentImage?: string;
  uninstallCommand?: string;
  windowsUninstallCommand?: string;
  createdAt: string;
  updatedAt: string;
}

export interface NodeInstallCommandPair {
  ws: string;
  http: string;
}

export interface NodeInstallCommands {
  ws: string;
  http: string;
  dockerWs?: string;
  dockerHttp?: string;
  // native/portable 按目标操作系统区分；旧版主控可能不返回，需兜底到 ws/http 旧键
  native?: Partial<Record<'linux' | 'macos' | 'windows', NodeInstallCommandPair>>;
  portable?: Partial<Record<'linux' | 'macos' | 'windows', NodeInstallCommandPair>>;
  offline?: {
    packageDownloadUrl: string;
    adminPackageUrl?: string;
    windows: string;
    linux: string;
  };
  adminScriptUrl?: string;
}

export interface CreateNodeResult {
  node: { id: string; name: string; communicationMode?: CommunicationMode };
  agentToken: string;
  installCommand: string;
  installCommands?: NodeInstallCommands;
  agentImage?: string;
  uninstallCommand?: string;
  windowsUninstallCommand?: string;
}

export interface RotateNodeTokenResult {
  nodeId: string;
  agentToken: string;
  installCommand: string;
  installCommands: NodeInstallCommands;
  agentImage?: string;
  uninstallCommand: string;
  windowsUninstallCommand?: string;
}

export interface NodeTaskStatus {
  taskId: string;
  status: 'PENDING' | 'QUEUED' | 'DISPATCHED' | 'COMPLETED' | 'FAILED';
  success?: boolean;
  message?: string;
  completedAt?: string | null;
}

export interface NodeDeploymentTask {
  id: string;
  nodeId: string;
  assetId: string | null; // 自定义 URL 升级无关联资产
  previousAssetId: string | null;
  releaseId: string | null;
  kind: 'AGENT' | 'SINGBOX' | string;
  operation: 'UPGRADE' | 'ROLLBACK' | string;
  status: 'QUEUED' | 'DISPATCHED' | 'COMPLETED' | 'FAILED' | string;
  attempts: number;
  errorMessage: string | null;
  requestedAt: string;
  dispatchedAt: string | null;
  completedAt: string | null;
  version?: string | null;
  asset?: {
    id: string;
    target: string;
    size: number;
    release?: { id: string; kind: string; upstreamVersion: string; revision: number };
  } | null;
}

export interface BatchNodeUpgradeResult {
  total: number;
  succeeded: number;
  failed: number;
  results: Array<{
    nodeId: string;
    taskId?: string;
    status: 'DISPATCHED' | 'QUEUED' | 'FAILED';
    requested?: boolean;
    message?: string;
  }>;
}


// 节点列表：5 秒轮询实时观察 Agent 在线状态与负载
export function useAdminNodes() {
  return useQuery({
    queryKey: ['admin', 'nodes'],
    queryFn: async () => (await api.get<AdminNode[]>('/admin/nodes')).data,
    refetchInterval: 5_000
  });
}

// 节点详情：入站编辑期间高频刷新（配置错误回执 / 内核状态实时可见）
export function useAdminNodeDetail(id: string) {
  return useQuery({
    queryKey: ['admin', 'nodes', 'detail', id],
    queryFn: async () => (await api.get<{ node: AdminNode }>(`/admin/nodes/${id}`)).data.node,
    refetchInterval: 5_000
  });
}

export function useAdminBinaryInfo() {
  return useQuery({
    queryKey: ['admin', 'binaries', 'info'],
    queryFn: async () => (await api.get<AdminBinaryInfo>('/admin/binaries/info')).data,
    staleTime: 60_000,
    refetchInterval: 60_000
  });
}

// 节点升级分发任务列表：15 秒轮询观察 QUEUED/DISPATCHED → 终态流转
export function useNodeTasks(nodeId: string, query: { page?: number; status?: string } = {}) {
  return useQuery({
    queryKey: ['admin', 'nodes', nodeId, 'tasks', query],
    queryFn: async () => {
      const params: Record<string, string | number | undefined> = {
        page: query.page ?? 1,
        pageSize: 10,
        status: query.status || undefined
      };
      return (await api.get<{ data: NodeDeploymentTask[]; total: number; page: number; pageSize: number }>(`/admin/nodes/${nodeId}/tasks`, { params })).data;
    },
    placeholderData: keepPreviousData,
    refetchInterval: 15_000
  });
}

export function useNodeMutations() {
  const { t } = useTranslation(['admin', 'common']);
  const queryClient = useQueryClient();
  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ['admin', 'nodes'] });
  const invalidateDetail = (id: string) =>
    void queryClient.invalidateQueries({ queryKey: ['admin', 'nodes', 'detail', id] });

  const invalidateSub = {
    onSuccess: () => {
      toast.success(t('admin:nodes.toastSaved'));
      invalidate();
    },
    onError: (e: unknown) => toast.error(extractErrorMessage(e, t('admin:nodes.toastFailed')))
  };

  // 创建成功不弹 toast：弹窗内切换到 AgentToken 与安装命令展示页
  const createNode = useMutation({
    mutationFn: async (payload: { name?: string; serverHost?: string; reachability?: 'PUBLIC' | 'NAT'; communicationMode?: CommunicationMode }) =>
      (await api.post<CreateNodeResult>('/admin/nodes', payload)).data,
    onSuccess: () => invalidate(),
    onError: (e: unknown) => toast.error(extractErrorMessage(e, t('admin:nodes.toastCreateFailed')))
  });

  const rotateToken = useMutation({
    mutationFn: async ({ id }: { id: string }) =>
      (await api.post<RotateNodeTokenResult>(`/admin/nodes/${id}/rotate-token`)).data,
    onSuccess: (_data, variables) => {
      toast.success(t('admin:nodes.toastTokenRotated'));
      invalidate();
      invalidateDetail(variables.id);
    },
    onError: (e: unknown) => toast.error(extractErrorMessage(e, t('admin:nodes.toastTokenRotateFailed')))
  });

  const updateNode = useMutation({
    mutationFn: async ({
      id,
      ...payload
    }: {
      id: string;
      name?: string;
      serverHost?: string;
      reachability?: 'PUBLIC' | 'NAT';
      configOverride?: string | null;
      communicationMode?: CommunicationMode;
      pollIntervalSecs?: number;
    }) => (await api.patch(`/admin/nodes/${id}`, payload)).data,
    ...invalidateSub
  });

  const deleteNode = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/admin/nodes/${id}`)).data,
    onSuccess: () => {
      toast.success(t('admin:nodes.toastNodeDeleted'));
      invalidate();
    },
    onError: (e: unknown) => toast.error(extractErrorMessage(e, t('admin:nodes.toastDeleteFailed')))
  });

  const enableLogDiagnostics = useMutation({
    mutationFn: async ({ id, level }: { id: string; level: 'INFO' | 'DEBUG' }) =>
      (await api.post<{ nodeId: string; enabled: boolean; level: 'INFO' | 'DEBUG'; expiresAt: string; requested: boolean }>(`/admin/nodes/${id}/log-diagnostics`, { level })).data,
    onSuccess: (data, variables) => {
      toast.success(t('admin:nodes.toastDiagLogEnabled', { level: data.level }));
      invalidateDetail(variables.id);
    },
    onError: (e: unknown) => toast.error(extractErrorMessage(e, t('admin:nodes.toastEnableDiagLogFailed')))
  });

  const disableLogDiagnostics = useMutation({
    mutationFn: async (id: string) =>
      (await api.delete<{ nodeId: string; enabled: boolean }>(`/admin/nodes/${id}/log-diagnostics`)).data,
    onSuccess: (_data, id) => {
      toast.success(t('admin:nodes.toastDiagLogDisabled'));
      invalidateDetail(id);
    },
    onError: (e: unknown) => toast.error(extractErrorMessage(e, t('admin:nodes.toastDisableDiagLogFailed')))
  });

  const reloadNode = useMutation({
    mutationFn: async (id: string) => (await api.post<{ requested: boolean }>(`/admin/nodes/${id}/reload`)).data,
    onSuccess: (data) => {
      toast.success(data.requested ? t('admin:nodes.toastConfigReloadDispatched') : t('admin:nodes.toastOfflineReloadPending'));
      invalidate();
    },
    onError: (e: unknown) => toast.error(extractErrorMessage(e, t('admin:nodes.toastReloadFailed')))
  });

  const upgradeNode = useMutation({
    mutationFn: async ({ id, ...payload }: { id: string; target: 'singbox' | 'agent'; resourceId?: string; version?: string; url?: string; sha256?: string }) =>
      (await api.post(`/admin/nodes/${id}/upgrade`, payload)).data,
    onSuccess: (data, variables) => {
      toast.success(data.requested ? t('admin:nodes.toastUpgradeDispatched') : t('admin:nodes.toastOfflineUpgradePending'));
      invalidateDetail(variables.id);
    },
    onError: (e: unknown) => toast.error(extractErrorMessage(e, t('admin:nodes.toastUpgradeDispatchFailed')))
  });

  const batchUpgradeNodes = useMutation({
    mutationFn: async (payload: { ids: string[]; resourceId?: string }) =>
      (await api.post<BatchNodeUpgradeResult>('/admin/nodes/batch-upgrade', payload)).data,
    onSuccess: (data) => {
      if (data.failed) toast.warning(t('admin:nodes.toastBatchUpgradePartial', { succeeded: data.succeeded, failed: data.failed }));
      else toast.success(t('admin:nodes.toastBatchUpgradeAccepted', { count: data.succeeded }));
      invalidate();
      void queryClient.invalidateQueries({ queryKey: ['admin', 'nodes'], predicate: (query) => query.queryKey.includes('tasks') });
    },
    onError: (e: unknown) => toast.error(extractErrorMessage(e, t('admin:nodes.toastUpgradeDispatchFailed')))
  });


  const probeNode = useMutation({
    mutationFn: async ({ id, probes }: { id: string; probes: Array<{ type: 'tcp' | 'dns' | 'icmp'; target: string; port?: number; timeoutMs?: number }> }) =>
      (await api.post(`/admin/nodes/${id}/probe`, { probes })).data,
    onSuccess: (data, variables) => {
      toast.success(data.requested ? t('admin:nodes.toastProbeDispatched') : t('admin:nodes.toastOfflineProbePending'));
      invalidateDetail(variables.id);
    },
    onError: (e: unknown) => toast.error(extractErrorMessage(e, t('admin:nodes.toastProbeDispatchFailed')))
  });

  const restartAgent = useMutation({
    mutationFn: async (id: string) => (await api.post<{ taskId: string; requested: boolean }>(`/admin/nodes/${id}/restart-agent`)).data,
    onSuccess: (data, id) => {
      toast.success(data.requested ? t('admin:nodes.toastRestartDispatched') : t('admin:nodes.toastOfflineRestartPending'));
      invalidateDetail(id);
    },
    onError: (e: unknown) => toast.error(extractErrorMessage(e, t('admin:nodes.toastRestartFailed')))
  });

  const importBinary = useMutation({
    mutationFn: async (payload: { target: string; version: string; url: string; sha256: string }) =>
      (await api.post('/admin/binaries/import', payload)).data,
    onSuccess: () => {
      toast.success(t('admin:nodes.toastBinaryImported'));
      void queryClient.invalidateQueries({ queryKey: ['admin', 'binaries', 'info'] });
    },
    onError: (e: unknown) => toast.error(extractErrorMessage(e, t('admin:nodes.toastBinaryImportFailed')))
  });

  const retryTask = useMutation({
    mutationFn: async ({ nodeId, taskId }: { nodeId: string; taskId: string }) =>
      (await api.post(`/admin/nodes/${nodeId}/tasks/${taskId}/retry`)).data,
    onSuccess: (_data, variables) => {
      toast.success(t('admin:nodes.toastTaskRetried'));
      void queryClient.invalidateQueries({ queryKey: ['admin', 'nodes', variables.nodeId, 'tasks'] });
    },
    onError: (e: unknown) => toast.error(extractErrorMessage(e, t('admin:nodes.toastTaskRetryFailed')))
  });

  const rollbackTask = useMutation({
    mutationFn: async ({ nodeId, taskId }: { nodeId: string; taskId: string }) =>
      (await api.post(`/admin/nodes/${nodeId}/tasks/${taskId}/rollback`)).data,
    onSuccess: (_data, variables) => {
      toast.success(t('admin:nodes.toastTaskRollbackDispatched'));
      void queryClient.invalidateQueries({ queryKey: ['admin', 'nodes', variables.nodeId, 'tasks'] });
    },
    onError: (e: unknown) => toast.error(extractErrorMessage(e, t('admin:nodes.toastTaskRollbackFailed')))
  });

  const waitForTask = async ({ nodeId, taskId, label }: { nodeId: string; taskId: string; label: string }) => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const status = (await api.get<NodeTaskStatus>(`/admin/nodes/${nodeId}/tasks/${taskId}`)).data;
      if (status.status === 'COMPLETED' || status.status === 'FAILED') {
        if (status.success) toast.success(t('admin:nodes.toastTaskCompleted', { label }));
        else toast.error(t('admin:nodes.toastTaskFailed', { label }), { description: status.message ?? t('admin:nodes.toastTaskFailedAgentMsg') });
        invalidateDetail(nodeId);
        return status;
      }
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    toast.info(t('admin:nodes.toastTaskRunning', { label }), { description: t('admin:nodes.toastTaskRunningDesc') });
    return undefined;
  };

  return { createNode, rotateToken, updateNode, deleteNode, reloadNode, upgradeNode, batchUpgradeNodes, probeNode, restartAgent, importBinary, retryTask, rollbackTask, waitForTask, enableLogDiagnostics, disableLogDiagnostics };
}

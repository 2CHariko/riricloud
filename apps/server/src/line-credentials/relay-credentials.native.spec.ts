import { relayNativeCases } from './relay-credentials.native-fixture-cases';

// 常规单元 CI 明确跳过；原生任务设置为 1 后内核缺失/启动失败均失败。
const native = process.env.RUN_NATIVE_CLIENT_TESTS === '1' ? describe : describe.skip;
native('real Sing-box relay inbounds with Mihomo clients', () => {
  relayNativeCases(['VLESS', 'VMESS', 'TROJAN', 'HYSTERIA2', 'TUIC']);
});

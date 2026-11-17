import { relayNativeCases } from './relay-credentials.native-fixture-cases';

// Cronet 动态库只随 Linux 原生资源交付，其他平台由原生发现器明确排除本文件。
const native = process.env.RUN_NATIVE_CLIENT_TESTS === '1' && process.platform === 'linux' ? describe : describe.skip;
native('Linux real Sing-box Naive relay authentication through Cronet', () => {
  relayNativeCases(['NAIVE']);
});

import { randomBytes } from 'node:crypto';
import { legacyRelay, legacySpeedtest, randomCredential, RelayNativeFixture, type NativeRelayProtocol } from './relay-credentials.native-fixture';

// 所有用例共享真实网络 fixture；仅测试数据和生命周期组织，不替换任何内核/编译器实现。
export function relayNativeCases(protocols: NativeRelayProtocol[]): void {
  describe.each(protocols)('%s relay credential authentication', protocol => {
    let fixture: RelayNativeFixture | undefined;
    let encryptionKey: string | undefined;
    beforeAll(async () => {
      encryptionKey = process.env.RIRICLOUD_ENCRYPTION_KEY;
      process.env.RIRICLOUD_ENCRYPTION_KEY = randomBytes(32).toString('hex');
      fixture = new RelayNativeFixture(protocol);
      await fixture.start();
    }, 30_000);
    afterAll(async () => {
      try { await fixture?.close(); }
      finally {
        if (encryptionKey === undefined) delete process.env.RIRICLOUD_ENCRYPTION_KEY;
        else process.env.RIRICLOUD_ENCRYPTION_KEY = encryptionKey;
      }
    }, 15_000);

    it('accepts the encrypted random credential through the compiled inbound and returns HTTP 204', async () => {
      await fixture!.assertCandidate(fixture!.current, true);
    }, 30_000);
    it('rejects the removed public relay identity while authorized traffic still succeeds', async () => {
      await fixture!.assertCandidate(legacyRelay, false, true);
    }, 30_000);
    it('rejects the removed public speedtest identity while authorized traffic still succeeds', async () => {
      await fixture!.assertCandidate(legacySpeedtest, false, true);
    }, 30_000);
    it('rejects unregistered random credentials before they can reach the HTTP target', async () => {
      await fixture!.assertCandidate(randomCredential('unregistered-native-identity'), false);
    }, 30_000);
    it('rejects another line identity that succeeds at its own independent inbound', async () => {
      await fixture!.assertCandidate(fixture!.other, false, false, fixture!.otherLineId);
    }, 30_000);
    if (protocol === 'TUIC' || protocol === 'NAIVE') {
      it('rejects a valid UUID or username paired with an incorrect password', async () => {
        const wrong = randomCredential('wrong-native-password');
        await fixture!.assertCandidate({ ...fixture!.current, credential: wrong.credential }, false);
      }, 30_000);
      it('rejects a valid password paired with an incorrect UUID or username', async () => {
        const wrong = randomCredential('wrong-native-name');
        await fixture!.assertCandidate({ ...wrong, credential: fixture!.current.credential }, false);
      }, 30_000);
    }
    it('checks HTTP status instead of treating a connection or non-204 response as success', async () => {
      await fixture!.assertHttpStatusIsChecked();
    }, 30_000);
    it('accepts the replacement and rejects the formerly working credential after rotation on the same ports', async () => {
      await fixture!.assertCandidate(fixture!.current, true);
      const old = await fixture!.rotate();
      await fixture!.assertCandidate(old, false);
      await fixture!.assertCandidate(fixture!.current, true);
    }, 45_000);
  });
}

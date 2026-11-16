import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as nodemailer from 'nodemailer';
import { MailService } from './mail.service';
import type { MailContext } from './mail.service';
import { SettingsService } from '../system/settings.service';
import { SystemLogsService } from '../system-logs/system-logs.service';

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));

describe('MailService', () => {
  let service: MailService;
  const settingsService = { getSettings: jest.fn() };
  const systemLogsService = { enqueueMail: jest.fn() };
  const transporter = { sendMail: jest.fn(), verify: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [MailService, { provide: SettingsService, useValue: settingsService }, { provide: SystemLogsService, useValue: systemLogsService }]
    }).compile();
    service = moduleRef.get(MailService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.mocked(nodemailer.createTransport).mockReturnValue(transporter as unknown as nodemailer.Transporter);
  });

  beforeEach(() => {
    jest.resetAllMocks();
    settingsService.getSettings.mockResolvedValue(enabledSettings);
    transporter.verify.mockResolvedValue(true);
    transporter.sendMail.mockResolvedValue({});
    jest.mocked(nodemailer.createTransport).mockReturnValue(transporter as unknown as nodemailer.Transporter);
  });

  const enabledSettings = {
    siteName: '测试站点',
    logoUrl: 'https://example.com/logo.png',
    footerCopyright: '© 测试站点',
    smtpEnabled: true,
    smtpHost: 'smtp.example.com',
    smtpPort: 587,
    smtpSecure: false,
    smtpUser: 'noreply@example.com',
    smtpPass: 'secret',
    smtpFrom: 'RiriCloud <noreply@example.com>'
  };

  it('发送验证码 HTML 邮件并包含站点信息', async () => {
    settingsService.getSettings.mockResolvedValue(enabledSettings);
    transporter.sendMail.mockResolvedValue({ messageId: 'mail-1' });
    await expect(service.sendVerificationCode('user@example.com', '123456', 'REGISTER')).resolves.toEqual({ messageId: 'mail-1' });
    expect(transporter.sendMail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'user@example.com',
      html: expect.stringContaining('123456')
    }));
  });

  it('验证码发送成功只记录一次 SMTP 接受终态且不采集验证码与正文', async () => {
    settingsService.getSettings.mockResolvedValue(enabledSettings);
    transporter.sendMail.mockResolvedValue({ messageId: 'mail-1', response: '250 accepted', accepted: ['user@example.com'], rejected: [] });
    await service.sendVerificationCode('user@example.com', '928471', 'REGISTER');
    expect(systemLogsService.enqueueMail).toHaveBeenCalledTimes(1);
    expect(systemLogsService.enqueueMail).toHaveBeenCalledWith({ level: 'INFO', metadata: expect.objectContaining({
      event: 'MAIL_SEND_ACCEPTED', mailType: 'VERIFICATION', action: 'REGISTER', stage: 'SEND',
      operationId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      to: 'user@example.com', from: enabledSettings.smtpFrom, subject: '【测试站点】注册验证码',
      smtpHost: 'smtp.example.com', smtpPort: 587, smtpSecure: false,
      messageId: 'mail-1', smtpResponse: '250 accepted', accepted: ['user@example.com'], rejected: []
    }) });
    expect(JSON.stringify(systemLogsService.enqueueMail.mock.calls)).not.toContain('928471');
    expect(JSON.stringify(systemLogsService.enqueueMail.mock.calls)).not.toContain('html');
  });

  it('SMTP 未启用时拒绝发信', async () => {
    settingsService.getSettings.mockResolvedValue({ ...enabledSettings, smtpEnabled: false });
    await expect(service.sendVerificationCode('user@example.com', '123456', 'REGISTER')).rejects.toThrow(BadRequestException);
    expect(transporter.sendMail).not.toHaveBeenCalled();
  });
  it('证书汇总仅含名称、到期时间与线路数，使用站点时区且不带秘密', async () => {
    settingsService.getSettings.mockResolvedValue(enabledSettings);
    transporter.sendMail.mockResolvedValue({});
    await service.sendCertificateSummary('admin@example.com', [{ name: 'certificate', validTo: new Date('2026-10-06T23:00:00Z'), days: 1, lineCount: 2 }], 'Asia/Shanghai');
    expect(transporter.sendMail).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('2026年10月7日'), to: 'admin@example.com' }));
    expect(JSON.stringify(transporter.sendMail.mock.calls)).not.toContain('PRIVATE KEY');
    expect(jest.mocked(nodemailer.createTransport)).toHaveBeenCalledWith(expect.objectContaining({ socketTimeout: 30000 }));
  });

  it('发送流量预警邮件，包含 BigInt 流量、转义信息和退订入口', async () => {
    settingsService.getSettings.mockResolvedValue({ ...enabledSettings, siteName: 'Riri & Cloud', publicBaseUrl: 'https://panel.example.com' });
    transporter.sendMail.mockResolvedValue({});
    await service.sendTrafficWarning('user@example.com', {
      planName: '<Professional>', usedBytes: BigInt(85) * BigInt(1024 ** 3), limitBytes: BigInt(100) * BigInt(1024 ** 3), percentage: 95
    });
    expect(transporter.sendMail).toHaveBeenCalledWith(expect.objectContaining({
      subject: '【Riri & Cloud】流量使用提醒',
      to: 'user@example.com',
      html: expect.stringContaining('85 GB')
    }));
    const payload = JSON.stringify(transporter.sendMail.mock.calls);
    expect(payload).toContain('&lt;Professional&gt;');
    expect(payload).toContain('https://panel.example.com/profile');
    expect(payload).toContain('95%');
    expect(payload).not.toContain('subscriptionToken');
  });

  it('发送套餐到期邮件并使用站点时区', async () => {
    settingsService.getSettings.mockResolvedValue({ ...enabledSettings, publicBaseUrl: 'https://panel.example.com' });
    transporter.sendMail.mockResolvedValue({});
    await service.sendSubscriptionExpiry('user@example.com', {
      planName: 'Pro', expireAt: new Date('2026-11-07T00:00:00Z'), daysRemaining: 1, timezone: 'Asia/Shanghai'
    });
    expect(transporter.sendMail).toHaveBeenCalledWith(expect.objectContaining({
      subject: '【测试站点】套餐即将到期',
      text: expect.stringContaining('2026年11月7日')
    }));
  });

  it('测试 SMTP 连接后发送测试邮件', async () => {
    settingsService.getSettings.mockResolvedValue(enabledSettings);
    transporter.verify.mockResolvedValue(undefined);
    transporter.sendMail.mockResolvedValue({ messageId: 'test-mail' });
    await expect(service.testSmtp('admin@example.com')).resolves.toMatchObject({ success: true, messageId: 'test-mail' });
    expect(transporter.verify).toHaveBeenCalledTimes(1);
  });

  const context: MailContext = {
    userId: 'user-1', subscriptionId: 'subscription-1', deliveryId: 'delivery-1',
    certificateIds: ['certificate-1'], certificateRevisions: [{ certificateId: 'certificate-1', revision: 3 }], certificateCount: 1
  };
  const cases = [
    { mailType: 'CERTIFICATE_EXPIRY', subject: '证书到期提醒', send: (ctx?: MailContext) => service.sendCertificateSummary('user@example.com', [{ name: 'BodyOnlyCertificate', validTo: new Date('2026-11-18T00:00:00Z'), days: 1, lineCount: 2 }], 'Asia/Shanghai', ctx) },
    { mailType: 'TRAFFIC_WARNING', subject: '流量使用提醒', send: (ctx?: MailContext) => service.sendTrafficWarning('user@example.com', { planName: 'BodyOnlyPlan', usedBytes: 95n, limitBytes: 100n, percentage: 95 }, ctx) },
    { mailType: 'SUBSCRIPTION_EXPIRY', subject: '套餐即将到期', send: (ctx?: MailContext) => service.sendSubscriptionExpiry('user@example.com', { planName: 'BodyOnlyPlan', expireAt: new Date('2026-11-18T00:00:00Z'), daysRemaining: 1, timezone: 'Asia/Shanghai' }, ctx) },
    { mailType: 'VERIFICATION', subject: '注册验证码', send: (ctx?: MailContext) => service.sendVerificationCode('user@example.com', '928471', 'REGISTER', ctx) },
    { mailType: 'SMTP_TEST', subject: 'SMTP 测试邮件', send: (ctx?: MailContext) => service.testSmtp('user@example.com', ctx) }
  ];

  function lastLog() { return systemLogsService.enqueueMail.mock.calls.at(-1)![0]; }

  it.each(cases)('$mailType 成功保持返回契约、业务关联且只有一次终态', async ({ mailType, subject, send }) => {
    const info = { messageId: 'mail-accepted', response: '250 SMTP accepted for user@example.com at smtp.example.com', accepted: ['user@example.com'], rejected: [], envelope: { from: 'ignored' } };
    transporter.sendMail.mockResolvedValue(info);
    const result = await send(context);
    if (mailType === 'VERIFICATION') expect(result).toEqual({ messageId: info.messageId });
    else if (mailType === 'SMTP_TEST') expect(result).toEqual({ success: true, messageId: info.messageId, durationMs: expect.any(Number) });
    else expect(result).toBe(info);
    expect(transporter.sendMail).toHaveBeenCalledTimes(1);
    expect(transporter.verify).toHaveBeenCalledTimes(mailType === 'SMTP_TEST' ? 1 : 0);
    expect(systemLogsService.enqueueMail).toHaveBeenCalledTimes(1);
    const { userId, ...businessContext } = context;
    expect(lastLog()).toEqual({ level: 'INFO', userId, metadata: expect.objectContaining({
      ...businessContext, event: 'MAIL_SEND_ACCEPTED', mailType, subject: '【测试站点】' + subject,
      to: 'user@example.com', from: enabledSettings.smtpFrom, smtpHost: 'smtp.example.com',
      stage: 'SEND', durationMs: expect.any(Number), messageId: info.messageId, smtpResponse: info.response,
      accepted: info.accepted, rejected: []
    }) });
    expect(lastLog().metadata.durationMs).toBeGreaterThanOrEqual(0);
    const payload = JSON.stringify(lastLog());
    for (const forbidden of ['BodyOnlyPlan', 'BodyOnlyCertificate', '928471', 'envelope', 'html', 'text', 'secret']) expect(payload).not.toContain(forbidden);
  });

  it.each(cases)('$mailType 发送失败保留原始诊断及原有异常转换', async ({ mailType, send }) => {
    const error = Object.assign(new Error('550 user@example.com rejected by smtp.example.com'), {
      code: 'EENVELOPE', responseCode: 550, command: 'RCPT TO', response: '550 user@example.com refused',
      html: 'body-must-not-log', configuration: enabledSettings
    });
    transporter.sendMail.mockRejectedValue(error);
    if (mailType === 'SMTP_TEST') await expect(send(context)).rejects.toThrow('SMTP 测试失败，请检查服务器、端口、加密方式和账号密码');
    else await expect(send(context)).rejects.toBe(error);
    expect(transporter.sendMail).toHaveBeenCalledTimes(1);
    expect(systemLogsService.enqueueMail).toHaveBeenCalledTimes(1);
    expect(lastLog()).toMatchObject({ level: 'ERROR', userId: 'user-1', metadata: {
      event: 'MAIL_SEND_FAILED', mailType, stage: 'SEND', error: {
        name: 'Error', message: error.message, code: 'EENVELOPE', responseCode: 550, command: 'RCPT TO', response: error.response
      }
    } });
    expect(JSON.stringify(lastLog())).not.toContain('body-must-not-log');
    expect(JSON.stringify(lastLog())).not.toContain('configuration');
  });

  const configFailures = [
    { name: '读取配置失败', prepare: () => settingsService.getSettings.mockRejectedValue(new Error('settings unavailable')), message: 'settings unavailable' },
    { name: 'SMTP未启用', prepare: () => settingsService.getSettings.mockResolvedValue({ ...enabledSettings, smtpEnabled: false }), message: 'SMTP 发信服务未启用' },
    { name: '缺SMTP主机', prepare: () => settingsService.getSettings.mockResolvedValue({ ...enabledSettings, smtpHost: '' }), message: 'SMTP 服务器未配置' },
    { name: '缺发件人', prepare: () => settingsService.getSettings.mockResolvedValue({ ...enabledSettings, smtpFrom: '', smtpUser: '' }), message: '请配置发信人地址或 SMTP 账号' },
    { name: '创建连接失败', prepare: () => jest.mocked(nodemailer.createTransport).mockImplementation(() => { throw new Error('transport setup failed'); }), message: 'transport setup failed' }
  ];
  describe.each(cases)('$mailType 配置阶段', ({ mailType, send }) => {
    it.each(configFailures)('$name 生成CONFIG终态并保持原异常', async ({ prepare, message }) => {
      prepare();
      await expect(send(context)).rejects.toThrow(message);
      expect(transporter.verify).not.toHaveBeenCalled();
      expect(transporter.sendMail).not.toHaveBeenCalled();
      expect(systemLogsService.enqueueMail).toHaveBeenCalledTimes(1);
      expect(lastLog()).toMatchObject({ level: 'ERROR', metadata: { event: 'MAIL_SEND_FAILED', mailType, stage: 'CONFIG', error: { message } } });
    });
  });

  it.each([
    { code: 'EAUTH', command: 'AUTH PLAIN', responseCode: 535, response: '535 Authentication failed at smtp.example.com' },
    { code: 'ETIMEDOUT', command: 'CONN', responseCode: 421, response: '421 smtp.example.com timed out' },
    { code: 'ECONNECTION', command: 'CONN', responseCode: 421, response: '421 smtp.example.com unavailable' }
  ])('SMTP verify $code 保留原始诊断且不发信', async details => {
    const error = Object.assign(new Error('SMTP verify failed for user@example.com'), details);
    transporter.verify.mockRejectedValue(error);
    await expect(service.testSmtp('user@example.com', context)).rejects.toThrow(BadRequestException);
    expect(transporter.sendMail).not.toHaveBeenCalled();
    expect(systemLogsService.enqueueMail).toHaveBeenCalledTimes(1);
    expect(lastLog()).toMatchObject({ level: 'ERROR', metadata: {
      event: 'MAIL_SEND_FAILED', mailType: 'SMTP_TEST', stage: 'VERIFY', subject: '【测试站点】SMTP 测试邮件',
      error: { ...details, command: details.code === 'EAUTH' ? expect.stringContaining('AUTH PLAIN') : details.command, name: 'Error', message: error.message }
    } });
    expect(JSON.stringify(lastLog())).not.toContain('SMTP 测试失败');
  });

  it('发送超时没有重发并保留错误身份', async () => {
    const error = Object.assign(new Error('Timeout at smtp.example.com for user@example.com'), { code: 'ETIMEDOUT', command: 'DATA' });
    transporter.sendMail.mockRejectedValue(error);
    await expect(cases[0].send()).rejects.toBe(error);
    expect(lastLog()).toMatchObject({ level: 'ERROR', metadata: { stage: 'SEND', error: { code: 'ETIMEDOUT', command: 'DATA', message: error.message } } });
    expect(transporter.sendMail).toHaveBeenCalledTimes(1);
  });

  it.each([null, undefined, 'smtp.example.com refused user@example.com', 42, { message: 'plain error at smtp.example.com', code: 'EPLAIN' }])('非标准异常 %p 仍记录终态并保留原始拒绝', async error => {
    transporter.sendMail.mockRejectedValue(error);
    await expect(cases[1].send()).rejects.toBe(error);
    expect(systemLogsService.enqueueMail).toHaveBeenCalledTimes(1);
    expect(lastLog()).toMatchObject({ level: 'ERROR', metadata: { event: 'MAIL_SEND_FAILED', stage: 'SEND' } });
    expect(() => JSON.stringify(lastLog())).not.toThrow();
  });

  describe.each(cases)('$mailType 日志异常隔离', ({ mailType, send }) => {
    it.each(['sync', 'async'])('%s 入队失败不改变成功或重发', async mode => {
      systemLogsService.enqueueMail.mockImplementation(() => {
        if (mode === 'sync') throw new Error('log failed');
        return Promise.reject(new Error('async log failed'));
      });
      const info = { messageId: 'mail-accepted', response: '250 accepted' };
      transporter.sendMail.mockResolvedValue(info);
      const result = await send();
      if (mailType === 'VERIFICATION') expect(result).toEqual({ messageId: info.messageId });
      else if (mailType === 'SMTP_TEST') expect(result).toMatchObject({ success: true, messageId: info.messageId });
      else expect(result).toBe(info);
      expect(transporter.sendMail).toHaveBeenCalledTimes(1);
      expect(systemLogsService.enqueueMail).toHaveBeenCalledTimes(1);
    });

    it('入队失败不遮蔽原始发送错误', async () => {
      const error = new Error('SMTP refused');
      transporter.sendMail.mockRejectedValue(error);
      systemLogsService.enqueueMail.mockImplementation(() => { throw new Error('log failed'); });
      if (mailType === 'SMTP_TEST') await expect(send()).rejects.toThrow('SMTP 测试失败');
      else await expect(send()).rejects.toBe(error);
      expect(transporter.sendMail).toHaveBeenCalledTimes(1);
    });
  });

  it('每次重试使用新的operationId，投递关联保持一致', async () => {
    transporter.sendMail.mockRejectedValueOnce(new Error('retry later')).mockResolvedValueOnce({});
    await expect(cases[1].send(context)).rejects.toThrow('retry later');
    await cases[1].send(context);
    const [failed, accepted] = systemLogsService.enqueueMail.mock.calls.map(([input]) => input.metadata);
    expect(failed.operationId).not.toBe(accepted.operationId);
    expect(failed.deliveryId).toBe(accepted.deliveryId);
    expect(failed.subscriptionId).toBe(accepted.subscriptionId);
  });

  it.each(['REGISTER', 'CHANGE_EMAIL', 'VERIFY_CURRENT_EMAIL', 'RESET_PASSWORD'] as const)('验证码操作 %s 原样关联', async action => {
    await service.sendVerificationCode('user@example.com', '928471', action, { userId: 'user-1' });
    expect(lastLog()).toMatchObject({ userId: 'user-1', metadata: { action, mailType: 'VERIFICATION' } });
  });

  it('SMTP成功字段按白名单采集，不序列化正文、凭据、额外对象', async () => {
    const dangerous = { toJSON: () => { throw new Error('must not serialize'); } };
    transporter.sendMail.mockResolvedValue({ messageId: 'accepted', response: '250 accepted', accepted: ['user@example.com', dangerous], rejected: ['other@example.com'], text: dangerous, html: dangerous, auth: enabledSettings });
    await service.testSmtp('user@example.com', { ...context, ...{ text: 'context-body', code: '928471' } });
    expect(lastLog()).toMatchObject({ metadata: { accepted: ['user@example.com'], rejected: ['other@example.com'] } });
    const payload = JSON.stringify(lastLog());
    for (const forbidden of ['context-body', '928471', 'auth', 'html', 'text', 'smtpPass']) expect(payload).not.toContain(forbidden);
  });

  it('日志结果字段getter异常不改变已被SMTP接受的结果', async () => {
    const info = { messageId: 'accepted', get response(): string { throw new Error('getter failed'); } };
    transporter.sendMail.mockResolvedValue(info);
    await expect(cases[1].send()).resolves.toBe(info);
    expect(transporter.sendMail).toHaveBeenCalledTimes(1);
    expect(systemLogsService.enqueueMail).toHaveBeenCalledTimes(1);
    expect(lastLog()).toMatchObject({ level: 'INFO', metadata: { event: 'MAIL_SEND_ACCEPTED', messageId: 'accepted' } });
  });

  it.each(['success', 'failure'])('%s 日志payload不含验证码、密码及其编码和AUTH载荷', async outcome => {
    const password = 'p@ss:<&"/\\t';
    const code = '928471';
    const encodings = (value: string) => [value, encodeURIComponent(value), Buffer.from(value).toString('base64'), Buffer.from(value).toString('hex'), JSON.stringify(value).slice(1, -1), [...value].map(c => '&#' + c.charCodeAt(0) + ';').join('')];
    const sensitive = [...encodings(password), ...encodings(code)];
    const authPayload = Buffer.from('\0smtp-user\0' + password).toString('base64');
    const diagnostic = sensitive.join(' | ') + ' AUTH PLAIN ' + authPayload + '\n535 user@example.com at smtp.example.com';
    settingsService.getSettings.mockResolvedValue({ ...enabledSettings, smtpPass: password });
    if (outcome === 'failure') {
      const error = Object.assign(new Error(diagnostic), { code: 'EAUTH', command: 'AUTH PLAIN ' + authPayload, response: diagnostic, password, codeValue: code, body: 'body-must-not-log' });
      transporter.sendMail.mockRejectedValue(error);
      await expect(service.sendVerificationCode('user@example.com', code, 'REGISTER')).rejects.toBe(error);
    } else {
      transporter.sendMail.mockResolvedValue({ messageId: diagnostic, response: diagnostic, accepted: [diagnostic], rejected: [diagnostic], html: 'body-must-not-log', password });
      await service.sendVerificationCode('user@example.com', code, 'REGISTER');
    }
    expect(systemLogsService.enqueueMail).toHaveBeenCalledTimes(1);
    const payload = JSON.stringify(lastLog());
    for (const secret of [...sensitive, authPayload, 'body-must-not-log']) expect(payload).not.toContain(JSON.stringify(secret).slice(1, -1));
    expect(payload).toContain('user@example.com');
    expect(payload).toContain('smtp.example.com');
  });


  it.each(cases)('$mailType resolved但全部拒收只记录失败，不改变返回或重发', async ({ mailType, send }) => {
    const info = { messageId: 'rejected-result', accepted: [], rejected: ['user@example.com'], response: '550 user@example.com rejected by smtp.example.com' };
    transporter.sendMail.mockResolvedValue(info);
    const result = await send();
    if (mailType === 'VERIFICATION') expect(result).toEqual({ messageId: info.messageId });
    else if (mailType === 'SMTP_TEST') expect(result).toMatchObject({ success: true, messageId: info.messageId });
    else expect(result).toBe(info);
    expect(transporter.sendMail).toHaveBeenCalledTimes(1);
    expect(systemLogsService.enqueueMail).toHaveBeenCalledTimes(1);
    expect(lastLog()).toMatchObject({ level: 'ERROR', metadata: {
      event: 'MAIL_SEND_FAILED', stage: 'SEND', accepted: [], rejected: ['user@example.com'], smtpResponse: info.response
    } });
    expect(lastLog().metadata.error).toBeUndefined();
  });

  it('resolved部分拒收且仍有接受时保留接受终态与两个列表', async () => {
    const info = { accepted: ['user@example.com'], rejected: ['other@example.com'], response: '250 user@example.com accepted' };
    transporter.sendMail.mockResolvedValue(info);
    await expect(cases[0].send()).resolves.toBe(info);
    expect(lastLog()).toMatchObject({ level: 'INFO', metadata: { event: 'MAIL_SEND_ACCEPTED', accepted: info.accepted, rejected: info.rejected } });
    expect(transporter.sendMail).toHaveBeenCalledTimes(1);
  });

  it('测试接口耗时继续排除配置耗时，日志耗时覆盖完整操作', async () => {
    let clock = 1_000;
    const now = jest.spyOn(Date, 'now').mockImplementation(() => clock);
    settingsService.getSettings.mockImplementation(async () => { clock += 300; return enabledSettings; });
    jest.mocked(nodemailer.createTransport).mockImplementation(() => { clock += 30; return transporter as unknown as nodemailer.Transporter; });
    transporter.verify.mockImplementation(async () => { clock += 20; });
    transporter.sendMail.mockImplementation(async () => { clock += 70; return { messageId: 'accepted' }; });
    try {
      await expect(service.testSmtp('user@example.com')).resolves.toEqual({ success: true, messageId: 'accepted', durationMs: 90 });
      expect(lastLog().metadata.durationMs).toBe(420);
    } finally { now.mockRestore(); }
  });

});

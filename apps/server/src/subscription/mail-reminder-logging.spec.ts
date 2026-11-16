import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../system/settings.service';
import { SystemLogsService } from '../system-logs/system-logs.service';
import { CertificateRemindersService } from '../certificates/certificate-reminders.service';
import { CertificatesService } from '../certificates/certificates.service';
import { SubscriptionEmailRemindersService } from './subscription-email-reminders.service';

describe('邮件巡检系统日志', () => {
  it('证书汇总已发送但日限额事务失败时记录关联证书的巡检异常', async () => {
    const error = new Error('certificate reminder transaction failed');
    const row = { id: 'cert-1', name: 'Example', currentRevision: 2, validTo: new Date(Date.now() - 1000), _count: { lines: 1 } };
    const prisma = {
      certificate: { findMany: jest.fn().mockResolvedValue([row]) },
      systemSetting: { findUnique: jest.fn().mockResolvedValue(null) },
      certificateReminder: {
        findFirst: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({ id: 'reminder-1', state: 'PENDING', attemptedAt: null }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      $transaction: jest.fn().mockRejectedValue(error)
    };
    const settings = { getSettings: jest.fn().mockResolvedValue({ certificateMailEnabled: true, smtpEnabled: true, systemTimezone: 'Asia/Shanghai', certificateExpiryWarningDays: 30, certificateMailRecipients: ['admin@example.com'] }) };
    const mail = { sendCertificateSummary: jest.fn().mockResolvedValue({}) };
    const certificates = { list: jest.fn().mockResolvedValue({ total: 1 }) };
    const logs = { enqueueMail: jest.fn() };
    const service = new CertificateRemindersService(prisma as unknown as PrismaService, settings as unknown as SettingsService, mail as unknown as MailService, certificates as unknown as CertificatesService, logs as unknown as SystemLogsService);
    await service.check();
    expect(mail.sendCertificateSummary).toHaveBeenCalledTimes(1);
    expect(logs.enqueueMail).toHaveBeenCalledTimes(1);
    expect(logs.enqueueMail).toHaveBeenCalledWith(expect.objectContaining({ level: 'ERROR', metadata: expect.objectContaining({
      event: 'MAIL_SWEEP_FAILED', mailType: 'CERTIFICATE_SWEEP', to: 'admin@example.com', certificateIds: ['cert-1'],
      certificateRevisions: [{ certificateId: 'cert-1', revision: 2 }], error: expect.objectContaining({ message: error.message })
    }) }));
    expect(prisma.certificateReminder.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: { state: 'FAILED' } }));
  });
  it.each(['subscription', 'certificate'])('%s 巡检异常写入 Mail 且日志异常不会破坏后续巡检', async (kind) => {
    const error = new Error('Database at mail.example.com unavailable');
    const settings = { getSettings: jest.fn().mockRejectedValue(error) };
    const logs = { enqueueMail: jest.fn() };
    const service = kind === 'subscription'
      ? new SubscriptionEmailRemindersService({} as PrismaService, settings as unknown as SettingsService, {} as MailService, logs as unknown as SystemLogsService)
      : new CertificateRemindersService({} as PrismaService, settings as unknown as SettingsService, {} as MailService, {} as CertificatesService, logs as unknown as SystemLogsService);
    await expect(service.check()).resolves.toBeUndefined();
    expect(logs.enqueueMail).toHaveBeenCalledWith(expect.objectContaining({
      level: 'ERROR',
      metadata: expect.objectContaining({
        event: 'MAIL_SWEEP_FAILED', stage: 'SWEEP',
        mailType: kind === 'subscription' ? 'SUBSCRIPTION_SWEEP' : 'CERTIFICATE_SWEEP',
        operationId: expect.any(String), error: expect.objectContaining({ message: error.message })
      })
    }));
    logs.enqueueMail.mockImplementation(() => { throw new Error('logger unavailable'); });
    await expect(service.check()).resolves.toBeUndefined();
    expect(settings.getSettings).toHaveBeenCalledTimes(2);
  });
});

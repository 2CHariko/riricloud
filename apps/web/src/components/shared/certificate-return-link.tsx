import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { certificateReturnPath } from '@/lib/certificate-navigation';

export function CertificateReturnLink() {
  const location = useLocation();
  const { t } = useTranslation(['admin']);
  const path = certificateReturnPath(location.state);
  return path ? <Button className="self-start" variant="outline" size="sm" asChild><Link to={path}><ArrowLeft />{t('admin:certificateManagement.backToCertificate')}</Link></Button> : null;
}

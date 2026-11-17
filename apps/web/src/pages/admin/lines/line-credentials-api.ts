import { api } from '@/lib/api';
import i18n from '@/i18n/config';
import {
  credentialErrorKey, credentialResponseErrorCode, parseCredentialJson,
  parseLineCredentialStatus, type LineCredentialStatus
} from './line-credentials-contract';

function transformResponse(lineId: string) {
  return (raw: unknown, _headers: unknown, httpStatus?: number) => {
    const data = parseCredentialJson(raw);
    if (httpStatus && httpStatus >= 400) {
      const code = credentialResponseErrorCode(data);
      const key = credentialErrorKey({ response: { status: httpStatus, data: { code } } });
      // 在统一客户端的错误拦截器之前收敛原文，避免 Toast 或前端日志泄露诊断中的凭据。
      return { code, message: i18n.t(`admin:lineCredentials.errors.${key}`) };
    }
    return parseLineCredentialStatus(data, lineId);
  };
}

export async function getLineCredentialStatus(lineId: string, signal?: AbortSignal) {
  return (await api.get<LineCredentialStatus>('/admin/lines/' + lineId + '/credentials/status', {
    signal, transformResponse: transformResponse(lineId)
  })).data;
}

export async function rotateLineCredentials(lineId: string) {
  const response = await api.post<LineCredentialStatus>('/admin/lines/' + lineId + '/credentials/rotate', undefined, {
    transformResponse: transformResponse(lineId)
  });
  if (response.status !== 202) throw new Error('LINE_CREDENTIAL_INVALID_RESPONSE');
  return response.data;
}

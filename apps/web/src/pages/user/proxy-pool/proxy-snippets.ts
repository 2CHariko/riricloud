import type { ProxyPoolExportProtocol } from './use-proxy-pool';

export interface ProxySnippetInput {
  protocol: ProxyPoolExportProtocol;
  host: string;
  port: number;
  username: string;
  password: string;
  tls?: boolean;
  serverName?: string | null;
}
export interface ProxyCodeSnippet { id: string; label: string; code: string; }
export interface MultiProxySnippetEndpoint extends Omit<ProxySnippetInput, 'protocol'> { lineId: string; name: string; }
export interface MultiProxySnippetInput { protocol: ProxyPoolExportProtocol; endpoints: MultiProxySnippetEndpoint[]; }

export const proxyAuthority = (host: string, port: number) => `${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
const scheme = (input: ProxySnippetInput) => input.protocol === 'http' ? (input.tls ? 'https' : 'http') : 'socks5h';
export function buildProxyUri(input: ProxySnippetInput): string {
  if (input.protocol === 'socks5' && input.tls) throw new Error('PROXY_POOL_PROTOCOL_UNSUPPORTED');
  return `${scheme(input)}://${encodeURIComponent(input.username)}:${encodeURIComponent(input.password)}@${proxyAuthority(input.host, input.port)}`;
}

// 所有语言只使用服务端导出的逐端点凭据；字符串通过序列化转义。
export function buildProxyCodeSnippets(input: ProxySnippetInput): ProxyCodeSnippet[] {
  return buildMultiProxyCodeSnippets({ protocol: input.protocol, endpoints: [{ ...input, lineId: 'single', name: 'single' }] });
}

export function buildMultiProxyCodeSnippets(input: MultiProxySnippetInput): ProxyCodeSnippet[] {
  const { protocol, endpoints } = input;
  const uris = endpoints.map((endpoint) => buildProxyUri({ ...endpoint, protocol }));
  const browsers = endpoints.map((endpoint) => ({
    server: `${protocol === 'socks5' ? 'socks5' : endpoint.tls ? 'https' : 'http'}://${proxyAuthority(endpoint.host, endpoint.port)}`,
    username: endpoint.username, password: endpoint.password
  }));
  const pythonRequests = `# pip install ${protocol === 'socks5' ? '"requests[socks]"' : 'requests'}
import random
import requests

PROXIES_POOL = ${JSON.stringify(uris, null, 4)}
proxy_url = random.choice(PROXIES_POOL)
resp = requests.get("https://httpbin.org/ip", proxies={"http": proxy_url, "https": proxy_url}, timeout=15)
print(resp.json())`;
  const playwright = protocol === 'socks5'
    ? '# Chromium does not support SOCKS5 username/password authentication.\n# Use HTTP export for Playwright, or use requests / axios / cURL for authenticated SOCKS5.'
    : `# pip install playwright
import random
from playwright.sync_api import sync_playwright

PROXIES_POOL = ${JSON.stringify(browsers, null, 4)}
with sync_playwright() as p:
    browser = p.chromium.launch(proxy=random.choice(PROXIES_POOL))
    page = browser.new_page()
    page.goto("https://httpbin.org/ip")
    print(page.text_content("body"))
    browser.close()`;
  const nodeAxios = `// npm i axios ${protocol === 'socks5' ? 'socks-proxy-agent' : 'https-proxy-agent'}
const axios = require('axios');
const { ${protocol === 'socks5' ? 'SocksProxyAgent' : 'HttpsProxyAgent'} } = require('${protocol === 'socks5' ? 'socks-proxy-agent' : 'https-proxy-agent'}');
const PROXIES_POOL = ${JSON.stringify(uris, null, 2)};
const chosen = PROXIES_POOL[Math.floor(Math.random() * PROXIES_POOL.length)];
const agent = new ${protocol === 'socks5' ? 'SocksProxyAgent' : 'HttpsProxyAgent'}(chosen);
axios.get('https://httpbin.org/ip', { httpAgent: agent, httpsAgent: agent, proxy: false, timeout: 15000 })
  .then((res) => console.log(res.data));`;
  const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
  const curl = `# Bash proxy pool rotation
PROXIES=(
${uris.map((uri) => `  ${shellQuote(uri)}`).join('\n')}
)
RANDOM_PROXY="\${PROXIES[$RANDOM % \${#PROXIES[@]}]}"
curl -x "$RANDOM_PROXY" --max-time 15 https://httpbin.org/ip`;
  return [
    { id: 'python-requests', label: 'Python requests', code: pythonRequests },
    { id: 'playwright', label: 'Playwright', code: playwright },
    { id: 'node-axios', label: 'Node.js axios', code: nodeAxios },
    { id: 'curl', label: 'Shell cURL', code: curl }
  ];
}

// Vite 只将 URL 映射放入模块，禁止将整套 SVG 内联进 JS；资源随前端离线分发。
const files = import.meta.glob<string>('../assets/flags/*.svg', {
  eager: true,
  query: '?url&no-inline',
  import: 'default'
});

export const flagAssets: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(files).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1, -4), url])
);

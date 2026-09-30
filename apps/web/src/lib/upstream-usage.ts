// 十进制字节字符串始终经 BigInt 计算，避免上游账户用量超过安全整数时丢精度。
export function formatUpstreamBytes(value: string | null, unknownLabel: string): string {
  if (value === null || !/^\d+$/.test(value)) return unknownLabel;
  const bytes = BigInt(value);
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'];
  let unit = 0;
  let divisor = 1n;
  while (unit < units.length - 1 && bytes >= divisor * 1024n) { divisor *= 1024n; unit++; }
  const hundredths = bytes * 100n / divisor;
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, '0')} ${units[unit]}`;
}

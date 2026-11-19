#!/usr/bin/env bash
# 只判断本次启动的日志与进程，不能用其他实例短暂成功的 HTTP 响应冒充就绪。
e2e_server_start_state() {
  local log="$1"
  local pid="$2"
  if grep -q '^{"ok":false,"code":"MAINTENANCE_LOCKED",' "$log" 2>/dev/null; then
    printf 'LOCKED\n'
  elif grep -q '^{"ok":false,"code":"MASTER_PORT_IN_USE",' "$log" 2>/dev/null; then
    printf 'PORT_CONFLICT\n'
  elif grep -E 'Error:|MODULE_NOT_FOUND|Found [1-9][0-9]* errors?\.' "$log" 2>/dev/null | grep -qv 'EADDRINUSE'; then
    printf 'FAILED\n'
  elif ! kill -0 "$pid" 2>/dev/null; then
    printf 'EXITED\n'
  elif grep -q 'HTTP listener ready' "$log" 2>/dev/null && server_up; then
    printf 'READY\n'
  else
    printf 'WAIT\n'
  fi
}

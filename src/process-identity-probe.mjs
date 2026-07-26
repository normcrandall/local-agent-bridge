import { spawnSync } from "node:child_process";
import process from "node:process";

const win32Cache = new Map();
const CACHE_TTL_MS = 1_000;

function queryWin32Process(numericPid, timeoutMs = 5_000) {
  const cached = win32Cache.get(numericPid);
  if (cached && (Date.now() - cached.at < CACHE_TTL_MS)) {
    return cached.data;
  }

  const psScript = `Get-CimInstance Win32_Process -Filter "ProcessId = ${numericPid}" | Select-Object -Property CommandLine, @{Name='CreationDate';Expression={$_.CreationDate.ToString('o')}} | ConvertTo-Json -Compress`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psScript], {
    encoding: "utf8",
    timeout: timeoutMs,
  });

  let data = null;
  if (result.status === 0 && result.stdout?.trim()) {
    try {
      const parsed = JSON.parse(result.stdout.trim());
      data = {
        command: parsed.CommandLine?.trim() || null,
        lstart: parsed.CreationDate?.trim() || null,
      };
    } catch {}
  }

  win32Cache.set(numericPid, { at: Date.now(), data });
  return data;
}

export function processProbe(pid, field, { probeBinary = process.env.BRIDGE_SUPERVISOR_PS_BIN, timeoutMs = 5_000 } = {}) {
  const numericPid = typeof pid === "number" ? pid : Number.parseInt(pid, 10);
  if (!Number.isInteger(numericPid) || numericPid <= 1) {
    return { available: false, value: null, attempts: 1, error: "Invalid process PID" };
  }

  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let result;
    if (probeBinary) {
      result = spawnSync(probeBinary, ["-p", String(numericPid), "-o", `${field}=`], {
        encoding: "utf8",
        timeout: 2_000,
      });
      const value = result.status === 0 ? result.stdout?.trim() : "";
      if (value) return { available: true, value, attempts: attempt + 1 };
      lastError = result.error?.message || result.stderr?.trim() || `exit ${result.status ?? "unknown"}`;
    } else if (process.platform === "win32") {
      const info = queryWin32Process(numericPid, timeoutMs);
      const value = field === "command" ? info?.command : field === "lstart" ? info?.lstart : null;
      if (value) return { available: true, value, attempts: attempt + 1 };
      lastError = info ? `field ${field} not present` : "win32 process query returned no data";
    } else {
      result = spawnSync("/bin/ps", ["-p", String(numericPid), "-o", `${field}=`], {
        encoding: "utf8",
        timeout: 2_000,
      });
      const value = result.status === 0 ? result.stdout?.trim() : "";
      if (value) return { available: true, value, attempts: attempt + 1 };
      lastError = result.error?.message || result.stderr?.trim() || `exit ${result.status ?? "unknown"}`;
    }
  }
  return { available: false, value: null, attempts: 3, error: lastError };
}

export function killProcessSafely(pid, signal = "SIGTERM") {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  if (process.platform === "win32") {
    try {
      const res = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 5_000 });
      if (res.status === 0) return true;
    } catch {}
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

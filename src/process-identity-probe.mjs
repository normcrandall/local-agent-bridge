import { spawnSync } from "node:child_process";
import process from "node:process";

const win32Cache = new Map();
const CACHE_TTL_MS = 1_000;

function pruneWin32Cache(now) {
  for (const [key, entry] of win32Cache) {
    if (now - entry.at >= CACHE_TTL_MS) win32Cache.delete(key);
  }
}

// Windows identity is read through a single Win32_Process query so command and start
// time come from one atomic observation and one PowerShell start-up cost. Only
// successful lookups are cached: caching a miss would turn the caller's retry loop
// into a no-op and fail closed on a transient probe error that POSIX recovers from.
function queryWin32Process(numericPid, { timeoutMs, powershellBinary }) {
  const now = Date.now();
  const cached = win32Cache.get(numericPid);
  if (cached && (now - cached.at < CACHE_TTL_MS)) return cached.data;

  const psScript = `Get-CimInstance Win32_Process -Filter "ProcessId = ${numericPid}" | Select-Object -Property CommandLine, @{Name='CreationDate';Expression={$_.CreationDate.ToString('o')}} | ConvertTo-Json -Compress`;
  const result = spawnSync(powershellBinary, ["-NoProfile", "-NonInteractive", "-Command", psScript], {
    encoding: "utf8",
    timeout: timeoutMs,
  });

  let data = null;
  if (result.status === 0 && result.stdout?.trim()) {
    try {
      const parsed = JSON.parse(result.stdout.trim());
      const record = Array.isArray(parsed) ? parsed[0] : parsed;
      const command = typeof record?.CommandLine === "string" ? record.CommandLine.trim() : "";
      const lstart = typeof record?.CreationDate === "string" ? record.CreationDate.trim() : "";
      if (command || lstart) data = { command: command || null, lstart: lstart || null };
    } catch {}
  }

  if (data) {
    pruneWin32Cache(now);
    win32Cache.set(numericPid, { at: now, data });
  }
  return data;
}

export function processProbe(pid, field, {
  probeBinary = process.env.BRIDGE_SUPERVISOR_PS_BIN,
  timeoutMs = 5_000,
  // platform and powershellBinary are call-site seams for tests only. They are
  // deliberately not env-overridable: this is a fail-closed identity path and an
  // ambient variable must not be able to reroute it.
  platform = process.platform,
  powershellBinary = "powershell.exe",
} = {}) {
  const numericPid = typeof pid === "number" ? pid : Number.parseInt(pid, 10);
  if (!Number.isInteger(numericPid) || numericPid <= 1) {
    return { available: false, value: null, attempts: 1, error: "Invalid process PID" };
  }

  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (platform === "win32" && !probeBinary) {
      const info = queryWin32Process(numericPid, { timeoutMs, powershellBinary });
      const value = field === "command" ? info?.command : field === "lstart" ? info?.lstart : null;
      if (value) return { available: true, value, attempts: attempt + 1 };
      lastError = info ? `field ${field} not present` : "win32 process query returned no data";
      continue;
    }
    const binary = probeBinary || "/bin/ps";
    const result = spawnSync(binary, ["-p", String(numericPid), "-o", `${field}=`], {
      encoding: "utf8",
      timeout: 2_000,
    });
    const value = result.status === 0 ? result.stdout?.trim() : "";
    if (value) return { available: true, value, attempts: attempt + 1 };
    lastError = result.error?.message || result.stderr?.trim() || `exit ${result.status ?? "unknown"}`;
  }
  return { available: false, value: null, attempts: 3, error: lastError };
}

export function killProcessSafely(pid, signal = "SIGTERM", {
  platform = process.platform,
  taskkillBinary = "taskkill.exe",
} = {}) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  // Windows has no process groups, so a plain kill would leave the worker's children
  // running and still holding the collaboration. /T terminates the whole tree.
  if (platform === "win32") {
    try {
      const result = spawnSync(taskkillBinary, ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 5_000 });
      if (result.status === 0) return true;
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

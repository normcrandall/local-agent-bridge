import { spawnSync } from "node:child_process";
import process from "node:process";

export function processProbe(pid, field, { probeBinary = process.env.BRIDGE_SUPERVISOR_PS_BIN } = {}) {
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
    } else if (process.platform === "win32") {
      const psScript = field === "command"
        ? `Get-CimInstance Win32_Process -Filter "ProcessId = ${numericPid}" | Select-Object -ExpandProperty CommandLine`
        : `Get-CimInstance Win32_Process -Filter "ProcessId = ${numericPid}" | ForEach-Object { $_.CreationDate.ToString('o') }`;
      result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psScript], {
        encoding: "utf8",
        timeout: 2_000,
      });
    } else {
      result = spawnSync("/bin/ps", ["-p", String(numericPid), "-o", `${field}=`], {
        encoding: "utf8",
        timeout: 2_000,
      });
    }

    const value = result.status === 0 ? result.stdout?.trim() : "";
    if (value) return { available: true, value, attempts: attempt + 1 };
    lastError = result.error?.message || result.stderr?.trim() || `exit ${result.status ?? "unknown"}`;
  }
  return { available: false, value: null, attempts: 3, error: lastError };
}

export function killProcessSafely(pid, signal = "SIGTERM") {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

#!/usr/bin/env node

/**
 * AI-agent-friendly development script for Checkpoint services.
 *
 * Unlike dev.js (which requires a long-running orchestrator process), this
 * script spawns each service as a fully independent detached process. Services
 * survive agent session shutdowns, and stop uses port-based cleanup as a
 * fallback to guarantee no orphan processes.
 *
 * Usage:
 *   node dev-agent.js start              Start all services (idempotent)
 *   node dev-agent.js stop               Stop all services (thorough)
 *   node dev-agent.js status             JSON status of all services
 *   node dev-agent.js restart            Stop then start
 *   node dev-agent.js logs [svc] [N]     Show last N lines of logs (default: 50)
 *
 * Services: app (:13000), server (:13001), daemon (:13010)
 */

const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const net = require("net");
const os = require("os");

// ─── Constants ───────────────────────────────────────────────────

const ROOT = __dirname;
const LOGS_DIR = path.join(ROOT, "logs");
const STATE_FILE = path.join(LOGS_DIR, ".dev-agent.json");
const IS_WIN = process.platform === "win32";
const YARN = IS_WIN ? "yarn.cmd" : "yarn";
const HEALTH_TIMEOUT = 120_000;
const HEALTH_INTERVAL = 2_000;
const STOP_VERIFY_RETRIES = 10;
const STOP_VERIFY_INTERVAL = 1_000;

// ─── Daemon port discovery ───────────────────────────────────────

function getDaemonPort() {
  try {
    const configPath = path.join(os.homedir(), ".checkpoint", "daemon.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return config.daemonPort || 13010;
  } catch {
    return 13010;
  }
}

// ─── Service definitions ─────────────────────────────────────────

const SERVICES = [
  {
    name: "app",
    port: 13000,
    command: YARN,
    args: ["dev"],
    cwd: path.join(ROOT, "src", "app"),
  },
  {
    name: "server",
    port: 13001,
    command: YARN,
    args: ["server"],
    cwd: path.join(ROOT, "src", "core"),
  },
  {
    name: "daemon",
    port: getDaemonPort(),
    command: YARN,
    args: ["daemon"],
    cwd: path.join(ROOT, "src", "core"),
  },
];

// ─── State file management ───────────────────────────────────────

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function writeState(state) {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function updateServiceState(name, data) {
  const state = readState();
  state[name] = { ...(state[name] || {}), ...data };
  writeState(state);
}

// ─── Port utilities ──────────────────────────────────────────────

function getPidsOnPort(port) {
  try {
    if (IS_WIN) {
      const output = execSync(
        `netstat -ano | findstr ":${port} " | findstr "LISTENING"`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      );
      const pids = new Set();
      for (const line of output.trim().split("\n")) {
        const parts = line.trim().split(/\s+/);
        const pid = parseInt(parts[parts.length - 1], 10);
        if (pid && pid !== 0) pids.add(pid);
      }
      return [...pids];
    } else {
      const output = execSync(`lsof -t -i:${port} -sTCP:LISTEN`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return output
        .trim()
        .split("\n")
        .map(Number)
        .filter(Boolean);
    }
  } catch {
    return [];
  }
}

function isPortListening(port) {
  return getPidsOnPort(port).length > 0;
}

// ─── Process utilities ───────────────────────────────────────────

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getProcessName(pid) {
  try {
    if (IS_WIN) {
      const output = execSync(
        `tasklist /FI "PID eq ${pid}" /FO CSV /NH`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      );
      const match = output.match(/"([^"]+)"/);
      return match ? match[1].toLowerCase() : "";
    } else {
      return execSync(`ps -p ${pid} -o comm=`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim().toLowerCase();
    }
  } catch {
    return "";
  }
}

// Process names that indicate a service we spawned
const OUR_PROCESSES = new Set([
  "node.exe", "cmd.exe",         // Windows
  "node", "sh", "bash", "yarn",  // Unix
]);

function isOurProcess(pid) {
  const name = getProcessName(pid);
  return OUR_PROCESSES.has(name);
}

function killPid(pid) {
  if (!pid) return;
  try {
    if (IS_WIN) {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        process.kill(pid, "SIGKILL");
      }
    }
  } catch {
    // Process may already be dead
  }
}

// ─── Health check (TCP connect) ──────────────────────────────────
// Uses TCP connection rather than HTTP because the daemon's tRPC server
// doesn't respond to plain GET /. A successful TCP connect means the
// service is listening and accepting connections.

function healthCheck(port, timeout = 3000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeout);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, "127.0.0.1");
  });
}

// ─── Service operations ──────────────────────────────────────────

function spawnService(service) {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }

  const logFile = path.join(LOGS_DIR, `${service.name}.log`);

  // Add root node_modules/.bin to PATH so workspace-hoisted binaries
  // (like config-env, next, etc.) are found — mimics what `yarn run` does.
  const binDir = path.join(ROOT, "node_modules", ".bin");
  const sep = IS_WIN ? ";" : ":";
  const env = {
    ...process.env,
    FORCE_COLOR: "0",
    PATH: binDir + sep + (process.env.PATH || ""),
  };

  // On Windows, yarn.cmd output isn't captured through file descriptor stdio.
  // Workaround: spawn a node wrapper that pipes yarn's output to a log file.
  // On Unix, fd-based stdio works directly.
  let proc;
  if (IS_WIN) {
    const wrapperCode = [
      'const {spawn}=require("child_process");',
      'const fs=require("fs");',
      'const log=fs.createWriteStream(process.env._LOG_FILE);',
      'const args=process.env._ARGS.split("\\x00");',
      'const p=spawn("yarn.cmd",args,{stdio:["ignore","pipe","pipe"],shell:true});',
      'p.stdout.pipe(log);p.stderr.pipe(log);',
      'p.on("exit",(c)=>process.exit(c||0));',
    ].join("");
    proc = spawn("node", ["-e", wrapperCode], {
      cwd: service.cwd,
      detached: true,
      stdio: "ignore",
      env: { ...env, _LOG_FILE: logFile, _ARGS: service.args.join("\x00") },
      windowsHide: true,
    });
  } else {
    const cmd = `${service.command} ${service.args.join(" ")}`;
    proc = spawn("/bin/sh", ["-c", `${cmd} > "${logFile}" 2>&1`], {
      cwd: service.cwd,
      detached: true,
      stdio: "ignore",
      env,
    });
  }

  const pid = proc.pid;
  proc.unref();

  updateServiceState(service.name, {
    pid,
    port: service.port,
    startedAt: new Date().toISOString(),
  });

  return pid;
}

async function stopService(service) {
  const state = readState();
  const savedPid = state[service.name]?.pid;

  // Step 1: Kill by saved PID (always safe — we started it)
  if (savedPid && isPidAlive(savedPid)) {
    killPid(savedPid);
  }

  await sleep(1000);

  // Step 2: If port still in use, try to kill orphaned Node processes on it
  const pidsOnPort = getPidsOnPort(service.port);
  let foreignProcess = null;

  for (const pid of pidsOnPort) {
    if (isOurProcess(pid)) {
      killPid(pid);
    } else {
      foreignProcess = { pid, name: getProcessName(pid) };
    }
  }

  // Step 3: Verify port is free with retries
  for (let i = 0; i < STOP_VERIFY_RETRIES; i++) {
    if (!isPortListening(service.port)) {
      updateServiceState(service.name, {
        pid: null,
        stoppedAt: new Date().toISOString(),
      });
      return { stopped: true };
    }

    await sleep(STOP_VERIFY_INTERVAL);

    // Retry killing our processes still on the port
    for (const pid of getPidsOnPort(service.port)) {
      if (isOurProcess(pid)) {
        killPid(pid);
      }
    }
  }

  // Port still in use — is it a foreign process?
  if (foreignProcess) {
    return {
      stopped: false,
      reason: `port ${service.port} held by ${foreignProcess.name} (PID ${foreignProcess.pid})`,
    };
  }
  return { stopped: false, reason: `port ${service.port} still in use` };
}

async function getServiceStatus(service) {
  const state = readState();
  const savedPid = state[service.name]?.pid;
  const portInUse = isPortListening(service.port);
  const pidAlive = isPidAlive(savedPid);
  const healthy = portInUse ? await healthCheck(service.port) : false;

  let status;
  if (healthy) status = "healthy";
  else if (portInUse) status = "unhealthy";
  else if (pidAlive) status = "starting";
  else status = "stopped";

  return {
    name: service.name,
    status,
    port: service.port,
    pid: savedPid || null,
    portInUse,
    pidAlive,
    healthy,
  };
}

// ─── Commands ────────────────────────────────────────────────────

async function cmdStart() {
  console.log("Starting Checkpoint services...\n");

  const started = [];
  const skipped = [];

  for (const service of SERVICES) {
    if (isPortListening(service.port)) {
      const pids = getPidsOnPort(service.port);
      const holder = pids.length > 0 ? ` by ${getProcessName(pids[0]) || "?"}` : "";
      console.log(
        `  ${service.name.padEnd(8)} skipped  (port ${service.port} in use${holder})`,
      );
      skipped.push(service.name);
      continue;
    }

    const pid = spawnService(service);
    console.log(
      `  ${service.name.padEnd(8)} started  (PID ${pid}, port ${service.port})`,
    );
    started.push(service.name);
  }

  if (started.length === 0) {
    console.log("\nAll services already running.");
    return 0;
  }

  console.log("\nWaiting for services to become healthy...");

  const startTime = Date.now();
  const pending = new Set(started);
  const failed = new Set();

  while (pending.size > 0 && Date.now() - startTime < HEALTH_TIMEOUT) {
    await sleep(HEALTH_INTERVAL);

    for (const name of [...pending]) {
      const service = SERVICES.find((s) => s.name === name);
      const state = readState();
      const savedPid = state[name]?.pid;

      // Check if process died before becoming healthy
      if (!isPidAlive(savedPid) && !isPortListening(service.port)) {
        console.log(`  ${name.padEnd(8)} FAILED   (process exited)`);
        pending.delete(name);
        failed.add(name);
        continue;
      }

      if (await healthCheck(service.port)) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`  ${name.padEnd(8)} healthy  (${elapsed}s)`);
        pending.delete(name);
      }
    }
  }

  // Report timeouts
  for (const name of pending) {
    console.log(`  ${name.padEnd(8)} TIMEOUT`);
    failed.add(name);
  }

  if (failed.size > 0) {
    console.log(`\nFailed: ${[...failed].join(", ")}`);
    console.log("Check logs with: node dev-agent.js logs <service>");
    return 1;
  }

  console.log("\nAll services healthy.");
  return 0;
}

async function cmdStop() {
  console.log("Stopping Checkpoint services...\n");

  let allStopped = true;

  for (const service of SERVICES) {
    const portInUse = isPortListening(service.port);
    const state = readState();
    const savedPid = state[service.name]?.pid;

    if (!portInUse && !isPidAlive(savedPid)) {
      console.log(`  ${service.name.padEnd(8)} already stopped`);
      continue;
    }

    // If port is in use by a foreign process and we never started this service, skip
    if (portInUse && !savedPid) {
      const pids = getPidsOnPort(service.port);
      const allForeign = pids.length > 0 && pids.every((p) => !isOurProcess(p));
      if (allForeign) {
        const name = pids.length > 0 ? getProcessName(pids[0]) : "unknown";
        console.log(
          `  ${service.name.padEnd(8)} skipped  (port ${service.port} held by ${name}, not ours)`,
        );
        continue;
      }
    }

    process.stdout.write(`  ${service.name.padEnd(8)} stopping...`);
    const result = await stopService(service);

    if (result.stopped) {
      process.stdout.write(" done\n");
    } else {
      process.stdout.write(` FAILED (${result.reason})\n`);
      allStopped = false;
    }
  }

  if (allStopped) {
    console.log("\nAll services stopped.");
    return 0;
  } else {
    console.log("\nSome services failed to stop.");
    return 1;
  }
}

async function cmdStatus() {
  const result = { services: {}, allHealthy: true };

  for (const service of SERVICES) {
    const status = await getServiceStatus(service);
    result.services[service.name] = status;
    if (status.status !== "healthy") {
      result.allHealthy = false;
    }
  }

  console.log(JSON.stringify(result, null, 2));
  return result.allHealthy ? 0 : 1;
}

async function cmdRestart() {
  const stopCode = await cmdStop();
  console.log("");
  return await cmdStart();
}

function cmdLogs(serviceName, lineCount = 50) {
  if (serviceName) {
    const service = SERVICES.find((s) => s.name === serviceName);
    if (!service) {
      console.error(`Unknown service: ${serviceName}`);
      console.error(`Available: ${SERVICES.map((s) => s.name).join(", ")}`);
      return 1;
    }
    showServiceLogs(service.name, lineCount);
  } else {
    for (const service of SERVICES) {
      console.log(`\n=== ${service.name} (port ${service.port}) ===\n`);
      showServiceLogs(service.name, lineCount);
    }
  }
  return 0;
}

function showServiceLogs(name, lineCount) {
  const logFile = path.join(LOGS_DIR, `${name}.log`);
  if (!fs.existsSync(logFile)) {
    console.log("(no log file)");
    return;
  }

  const content = fs.readFileSync(logFile, "utf-8");
  const lines = content.split("\n");
  const tail = lines.slice(-lineCount).join("\n");
  console.log(tail);
}

// ─── Utility ─────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case "start":
      process.exit(await cmdStart());
      break;
    case "stop":
      process.exit(await cmdStop());
      break;
    case "status":
      process.exit(await cmdStatus());
      break;
    case "restart":
      process.exit(await cmdRestart());
      break;
    case "logs":
      process.exit(cmdLogs(args[1], parseInt(args[2]) || 50));
      break;
    default:
      console.log(
        "Checkpoint dev-agent: AI-friendly development service manager\n",
      );
      console.log("Usage: node dev-agent.js <command>\n");
      console.log("Commands:");
      console.log("  start              Start all services (idempotent)");
      console.log("  stop               Stop all services (thorough)");
      console.log("  status             JSON status of all services");
      console.log("  restart            Stop then start");
      console.log("  logs [svc] [N]     Show last N lines of logs");
      console.log("");
      console.log(
        `Services: ${SERVICES.map((s) => `${s.name} (:${s.port})`).join(", ")}`,
      );
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});

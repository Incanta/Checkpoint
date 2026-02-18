#!/usr/bin/env node

/**
 * Development script to start all Checkpoint services
 * Usage:
 *   node dev.js              - Start all services
 *   node dev.js --background - Start all services in the background (detached)
 *   node dev.js -b           - Same as --background
 *   node dev.js stop         - Stop running services
 *
 * Starts: app, daemon, server
 * Features:
 * - Colored prefixed logging (like Docker Compose)
 * - Individual log files in ./logs/
 * - Combined log file in ./logs/all.log
 * - Waits for all services to report healthy
 * - Graceful shutdown on SIGINT
 */

const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// PID file location
const pidFile = path.join(__dirname, "logs", ".dev.pid");

// ANSI color codes
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
};

// Service configurations
const allColor = colors.magenta;
const services = [
  {
    name: "app",
    color: colors.cyan,
    command: process.platform === "win32" ? "yarn.cmd" : "yarn",
    args: ["dev"],
    cwd: path.join(__dirname, "src/app"),
    healthPattern: /\[healthy\]|Ready in/i,
  },
  {
    name: "daemon",
    color: colors.green,
    command: process.platform === "win32" ? "yarn.cmd" : "yarn",
    args: ["daemon"],
    cwd: path.join(__dirname, "src/core"),
    healthPattern: /\[healthy\]/i,
  },
  {
    name: "server",
    color: colors.yellow,
    command: process.platform === "win32" ? "yarn.cmd" : "yarn",
    args: ["server"],
    cwd: path.join(__dirname, "src/core"),
    healthPattern: /\[healthy\]/i,
  },
];

// Track running processes and health status
const processes = new Map();
const healthStatus = new Map();
let shuttingDown = false;
let allHealthyReported = false;

// Ensure logs directory exists
const logsDir = path.join(__dirname, "logs");
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// All log file for combined output
const allLogFile = path.join(logsDir, "all.log");

// Calculate max service name length for alignment
const maxNameLength = Math.max(...services.map((s) => s.name.length));

/**
 * Strip ANSI color codes from a string
 */
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Format and log a line with colored prefix
 */
function logLine(service, line, isError = false) {
  const timestamp = new Date().toISOString().substr(11, 8);
  const paddedName = service.name.padEnd(maxNameLength);
  const prefix = `${service.color}${paddedName}${colors.reset}`;
  const pipe = `${colors.dim}|${colors.reset}`;

  // Log to console
  const output = isError ? process.stderr : process.stdout;
  output.write(`${prefix} ${pipe} ${line}\n`);

  // Strip ANSI codes for log files
  const cleanLine = stripAnsi(line);

  // Log to service-specific file (without colors)
  const logFile = path.join(logsDir, `${service.name}.log`);
  fs.appendFileSync(logFile, `[${timestamp}] ${cleanLine}\n`);

  // Log to combined all.log file
  fs.appendFileSync(
    allLogFile,
    `[${timestamp}] [${service.name}] ${cleanLine}\n`,
  );
}

/**
 * Log a system message
 */
function logSystem(message) {
  const timestamp = new Date().toISOString().substr(11, 8);
  const paddedName = "all".padEnd(maxNameLength);
  const prefix = `${allColor}${colors.bright}${paddedName}${colors.reset}`;
  const pipe = `${colors.dim}|${colors.reset}`;
  console.log(`${prefix} ${pipe} ${message}`);

  // Log to combined all.log file (strip ANSI codes for file)
  const cleanMessage = stripAnsi(message);
  fs.appendFileSync(allLogFile, `[${timestamp}] [all] ${cleanMessage}\n`);
}

/**
 * Check if all services are healthy
 */
function checkAllHealthy() {
  if (allHealthyReported) return;

  const allHealthy = services.every((s) => healthStatus.get(s.name) === true);
  if (allHealthy) {
    allHealthyReported = true;
    logSystem(`${colors.bright}All services healthy${colors.reset}`);
  }
}

/**
 * Start a service
 */
function startService(service) {
  // Clear previous log file
  const logFile = path.join(logsDir, `${service.name}.log`);
  fs.writeFileSync(logFile, `=== Started at ${new Date().toISOString()} ===\n`);

  healthStatus.set(service.name, false);

  logSystem(`Starting ${service.name}...`);

  const proc = spawn(service.command, service.args, {
    cwd: service.cwd,
    env: { ...process.env, FORCE_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
    windowsHide: true,
  });

  processes.set(service.name, proc);

  // Handle stdout
  let stdoutBuffer = "";
  proc.stdout.on("data", (data) => {
    stdoutBuffer += data.toString();
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() || "";

    for (const line of lines) {
      if (line.trim()) {
        logLine(service, line);

        // Check for health pattern
        if (
          !healthStatus.get(service.name) &&
          service.healthPattern.test(line)
        ) {
          healthStatus.set(service.name, true);
          logSystem(`${service.name} is healthy`);
          checkAllHealthy();
        }
      }
    }
  });

  // Handle stderr
  let stderrBuffer = "";
  proc.stderr.on("data", (data) => {
    stderrBuffer += data.toString();
    const lines = stderrBuffer.split("\n");
    stderrBuffer = lines.pop() || "";

    for (const line of lines) {
      if (line.trim()) {
        logLine(service, line, true);
      }
    }
  });

  // Handle process exit
  proc.on("exit", (code, signal) => {
    processes.delete(service.name);
    healthStatus.set(service.name, false);

    if (!shuttingDown) {
      logSystem(
        `${service.name} exited with code ${code}${signal ? ` (signal: ${signal})` : ""}`,
      );
    } else {
      logSystem(`${service.name} stopped`);
    }
  });

  proc.on("error", (err) => {
    logSystem(`${service.name} error: ${err.message}`);
  });

  return proc;
}

/**
 * Kill a process tree on Windows using taskkill
 */
function killProcessTree(pid) {
  if (process.platform === "win32") {
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
      return true;
    } catch (e) {
      return false;
    }
  } else {
    try {
      process.kill(-pid, "SIGKILL"); // Kill process group
      return true;
    } catch (e) {
      try {
        process.kill(pid, "SIGKILL");
        return true;
      } catch (e2) {
        return false;
      }
    }
  }
}

/**
 * Gracefully shutdown all services
 */
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  logSystem("Shutting down all services...");

  // On Windows, use taskkill to kill process trees
  // On Unix, send SIGINT first for graceful shutdown
  const shutdownPromises = [];
  for (const [name, proc] of processes) {
    const pid = proc.pid;
    shutdownPromises.push(
      new Promise((resolve) => {
        if (process.platform === "win32") {
          // Windows: use taskkill to kill process tree
          killProcessTree(pid);
          // Give it a moment to terminate
          setTimeout(() => {
            processes.delete(name);
            logSystem(`${name} stopped`);
            resolve();
          }, 500);
        } else {
          // Unix: try graceful shutdown first
          const timeout = setTimeout(() => {
            logSystem(`Force killing ${name}...`);
            killProcessTree(pid);
            resolve();
          }, 10000); // 10 second timeout

          proc.on("exit", () => {
            clearTimeout(timeout);
            resolve();
          });

          proc.kill("SIGINT");
        }
      }),
    );
  }

  await Promise.all(shutdownPromises);
  logSystem("All services stopped");
  process.exit(0);
}

// Handle SIGINT
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

/**
 * Check if a process is running
 */
function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Stop an existing dev.js process
 */
async function stopExisting() {
  // Ensure logs directory exists for PID file
  if (!fs.existsSync(logsDir)) {
    console.log("No dev.js process is running (logs directory not found)");
    process.exit(0);
  }

  if (!fs.existsSync(pidFile)) {
    console.log("No dev.js process is running (no PID file)");
    process.exit(0);
  }

  const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);

  if (!isProcessRunning(pid)) {
    console.log("No dev.js process is running (stale PID file)");
    fs.unlinkSync(pidFile);
    process.exit(0);
  }

  console.log(`Stopping dev.js process (PID: ${pid})...`);

  // On Windows, use taskkill to kill the process tree
  // On Unix, send SIGINT first, then SIGKILL if needed
  if (process.platform === "win32") {
    try {
      // /T kills the process tree, /F forces termination
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
    } catch (e) {
      // Process may already be dead
    }
  } else {
    // Send SIGINT first for graceful shutdown
    try {
      process.kill(pid, "SIGINT");
    } catch (e) {
      console.log("Process already stopped");
      fs.unlinkSync(pidFile);
      process.exit(0);
    }

    // Wait for process to exit
    const maxWait = 10000; // 10 seconds
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      if (!isProcessRunning(pid)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // If still running, force kill
    if (isProcessRunning(pid)) {
      console.log("Timeout waiting for graceful shutdown, force killing...");
      try {
        process.kill(pid, "SIGKILL");
      } catch (e) {
        // Already dead
      }
    }
  }

  // Wait a moment for processes to fully terminate
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Clean up PID file
  if (fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }

  console.log("dev.js stopped");
  process.exit(0);
}

/**
 * Write PID file
 */
function writePidFile() {
  fs.writeFileSync(pidFile, process.pid.toString());
}

/**
 * Remove PID file
 */
function removePidFile() {
  if (fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }
}

/**
 * Wait for all services to be healthy by monitoring the all.log file
 */
async function waitForHealthy(timeout = 120000) {
  const startTime = Date.now();
  const healthyPattern = /All services healthy/;

  while (Date.now() - startTime < timeout) {
    if (fs.existsSync(allLogFile)) {
      const content = fs.readFileSync(allLogFile, "utf-8");
      if (healthyPattern.test(content)) {
        return true;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

// Handle command line arguments
const args = process.argv.slice(2);
const command = args.find((arg) => !arg.startsWith("-"));
const backgroundMode = args.includes("--background") || args.includes("-b");

if (command === "stop") {
  stopExisting();
} else if (backgroundMode && !process.env.__DEV_BACKGROUND_CHILD__) {
  // Spawn detached child process
  const child = spawn(process.execPath, [__filename], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, __DEV_BACKGROUND_CHILD__: "1" },
    windowsHide: true,
  });

  console.log(`Starting dev.js in background (PID: ${child.pid})...`);
  console.log(`Logs: ${logsDir}`);

  // Wait for services to be healthy before exiting
  waitForHealthy().then((healthy) => {
    if (healthy) {
      console.log(`All services healthy!`);
      console.log(`Stop with: node dev.js stop`);
      child.unref();
      process.exit(0);
    } else {
      console.error(`Timeout waiting for services to become healthy.`);
      console.error(`Check logs at: ${logsDir}`);
      // Kill the child process since it didn't become healthy
      try {
        process.kill(-child.pid); // Kill process group on Unix
      } catch (e) {
        try {
          child.kill();
        } catch (e2) {
          // Already dead
        }
      }
      process.exit(1);
    }
  });
} else {
  // Main startup
  // Clear all.log file at startup
  fs.writeFileSync(
    allLogFile,
    `=== Started at ${new Date().toISOString()} ===\n`,
  );

  console.log("");
  logSystem(
    `${colors.bright}Checkpoint Development Environment${colors.reset}`,
  );
  logSystem(`Logs directory: ${logsDir}`);
  console.log("");

  // Write PID file
  writePidFile();

  // Clean up PID file on exit
  process.on("exit", removePidFile);

  // Start all services
  for (const service of services) {
    startService(service);
  }
}

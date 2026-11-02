#!/usr/bin/env bun

import { join } from "node:path";

const root = join(import.meta.dir, "..");
const web = join(root, "web");
const url = "http://localhost:5173/";
const shouldOpen = !process.argv.includes("--no-open");

const backend = Bun.spawn(["bun", "--watch", "server/index.ts"], {
  cwd: root,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

const frontend = Bun.spawn(["bun", "run", "dev"], {
  cwd: web,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

let stopping = false;

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  backend.kill();
  frontend.kill();
  process.exitCode = exitCode;
}

process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());

async function waitUntilReady(): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {}
    await Bun.sleep(200);
  }
  return false;
}

function openBrowser() {
  if (process.platform === "win32") {
    Bun.spawn(["cmd", "/c", "start", "", url], { stdout: "ignore", stderr: "ignore" });
  } else if (process.platform === "darwin") {
    Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
  } else {
    Bun.spawn(["xdg-open", url], { stdout: "ignore", stderr: "ignore" });
  }
}

const ready = await waitUntilReady();
if (ready) {
  console.log(`\nContext Visualizer is ready at ${url}`);
  console.log("Press Ctrl+C to stop it.\n");
  if (shouldOpen) openBrowser();
} else {
  console.error(`\nContext Visualizer did not become ready at ${url}`);
  stop(1);
}

const [backendCode, frontendCode] = await Promise.all([backend.exited, frontend.exited]);
if (!stopping) {
  console.error(`Context Visualizer stopped (backend: ${backendCode}, frontend: ${frontendCode}).`);
  stop(backendCode || frontendCode || 1);
}

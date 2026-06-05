#!/usr/bin/env node
import { Command } from "commander";

import { loadCirroConfig } from "./config/index.js";
import { startCirroServer } from "./server/index.js";

const program = new Command();

program
  .name("cirro")
  .description("Self-hostable Alto service for remote coding-agent runs.")
  .command("serve")
  .description("Start the Cirro HTTP service and worker")
  .option("--host <host>", "Host to bind")
  .option("--port <port>", "Port to bind")
  .option("--data-dir <path>", "Directory for run records and artifacts")
  .action(async (options: { host?: string; port?: string; dataDir?: string }) => {
    const config = loadCirroConfig({
      ...process.env,
      ...(options.host ? { CIRRO_HOST: options.host } : {}),
      ...(options.port ? { CIRRO_PORT: options.port } : {}),
      ...(options.dataDir ? { CIRRO_DATA_DIR: options.dataDir } : {}),
    });
    await startCirroServer({ config });
    console.log(`Cirro listening on http://${config.host}:${config.port}`);
  });

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

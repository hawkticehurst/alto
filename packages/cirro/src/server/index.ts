import type { Server } from "node:http";

import type { AltoRunRequest } from "alto";

import { loadCirroConfig, type CirroConfig } from "../config/index.js";
import { InMemoryRunQueue } from "../queue/in-memory.js";
import { CirroService } from "../service.js";
import { FileRunStore } from "../store/file-store.js";
import { CirroWorker } from "../worker/index.js";
import { createCirroHttpServer } from "./http.js";

export interface StartedCirroServer {
  server: Server;
  service: CirroService;
  worker: CirroWorker;
  stop(): Promise<void>;
}

export interface StartCirroOptions {
  config?: CirroConfig;
  altoDefaults?: Partial<AltoRunRequest>;
}

export async function startCirroServer(options: StartCirroOptions = {}): Promise<StartedCirroServer> {
  const config = options.config ?? loadCirroConfig();
  const store = new FileRunStore(config.dataDir);
  const queue = new InMemoryRunQueue();
  const service = new CirroService({ config, store, queue });
  const worker = new CirroWorker({ config, store, queue, altoDefaults: options.altoDefaults });
  const server = createCirroHttpServer({ config, service, store });

  worker.start();
  await new Promise<void>((resolve) => {
    server.listen(config.port, config.host, resolve);
  });

  return {
    server,
    service,
    worker,
    async stop() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
      await worker.stop();
    },
  };
}

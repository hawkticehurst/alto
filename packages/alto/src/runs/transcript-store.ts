import { writeJson } from "../utils/index.js";

export interface TranscriptStore {
  save(snapshot: Record<string, unknown>): Promise<void>;
}

export class FileTranscriptStore implements TranscriptStore {
  constructor(readonly path: string) {}

  async save(snapshot: Record<string, unknown>): Promise<void> {
    await writeJson(this.path, snapshot);
  }
}

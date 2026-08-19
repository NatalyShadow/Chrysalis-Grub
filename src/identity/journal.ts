import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { warn } from "../util/logger.js";

/**
 * Append-only run journal (ADR-001 §4, reconciliation.md §6.6): one JSONL line
 * per op — intent before, result after. Gitignored; never load-bearing for
 * correctness (plans are always recomputed).
 *
 * Best-effort by design: in a read-only container (security.md §9) the journal
 * cannot be written; `append` catches the failure, warns, and continues so a
 * read-only root FS never breaks a sync.
 */

export interface JournalEntry {
  seq: number;
  ts: string;
  op: string; // e.g. "onboarding.update"
  logicalKey?: string;
  discordId?: string;
  intent: "before" | "after";
  status: "pending" | "done" | "failed";
  detail?: string;
}

export class Journal {
  private seq = 0;
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async append(entry: Omit<JournalEntry, "seq" | "ts">): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      this.seq += 1;
      const line: JournalEntry = {
        ...entry,
        seq: this.seq,
        ts: new Date().toISOString(),
      };
      await writeFile(this.filePath, `${JSON.stringify(line)}\n`, { flag: "a" });
    } catch (error) {
      warn(`journal append failed (non-fatal): ${(error as Error).message}`);
    }
  }
}

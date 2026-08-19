import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Journal } from "../../src/identity/journal.js";

describe("Journal", () => {
  let dir: string;
  let journal: Journal;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "chrysalis-journal-"));
    journal = new Journal(join(dir, "journal.jsonl"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("appends JSONL lines with seq and ts", async () => {
    await journal.append({ op: "onboarding.update", intent: "before", status: "pending" });
    await journal.append({ op: "onboarding.update", intent: "after", status: "done" });

    const lines = (await readFile(join(dir, "journal.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(lines).toHaveLength(2);
    expect(lines[0]?.seq).toBe(1);
    expect(lines[1]?.seq).toBe(2);
    expect(typeof lines[0]?.ts).toBe("string");
    expect(lines[0]?.status).toBe("pending");
    expect(lines[1]?.status).toBe("done");
  });

  it("carries detail fields through", async () => {
    await journal.append({
      op: "onboarding.update",
      logicalKey: "onboarding",
      intent: "before",
      status: "pending",
      detail: "onboarding:onboarding:UPDATE",
    });
    const [line] = (await readFile(join(dir, "journal.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((entry) => JSON.parse(entry) as Record<string, unknown>);
    expect(line?.logicalKey).toBe("onboarding");
    expect(line?.detail).toBe("onboarding:onboarding:UPDATE");
  });

  it("creates the parent directory automatically", async () => {
    const nested = new Journal(join(dir, "nested", "deep", "journal.jsonl"));
    await nested.append({ op: "x", intent: "before", status: "pending" });
    const contents = await readFile(join(dir, "nested", "deep", "journal.jsonl"), "utf8");
    expect(contents).toContain("pending");
  });

  it("is best-effort: append never throws when the journal cannot be written", async () => {
    // A regular file at the target path makes mkdir fail (ENOTDIR) — simulates
    // a read-only root FS where the journal is not writable (Docker §9).
    await writeFile(join(dir, "blocker"), "file");
    const blocked = new Journal(join(dir, "blocker", "journal.jsonl"));

    await expect(
      blocked.append({ op: "onboarding.update", intent: "before", status: "pending" }),
    ).resolves.toBeUndefined();
    // seq advances regardless; a later write to a valid path still works.
    const valid = new Journal(join(dir, "ok", "journal.jsonl"));
    await valid.append({ op: "x", intent: "before", status: "pending" });
    await expect(
      valid.append({ op: "y", intent: "after", status: "done" }),
    ).resolves.toBeUndefined();
  });
});

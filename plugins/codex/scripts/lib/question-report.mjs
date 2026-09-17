import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export async function claimQuestion(stateDir, jobId, requestId) {
  const directory = path.join(stateDir, "job-history", jobId, "reported-questions");
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, createHash("sha256").update(String(requestId)).digest("hex"));
  try {
    const handle = await fs.open(file, "wx");
    await handle.close();
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
}

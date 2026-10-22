import fs from "node:fs";
import { createHash } from "node:crypto";

// Claude's request hashes sort object keys and omit cache_control recursively
// (2.1.307 request-replay's B3/Sue). Adjacent user records form one input.
const canonical = value => JSON.stringify(value, (key, item) => key === "cache_control" ? undefined
  : item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item);
const blocksOf = content => typeof content === "string" ? [{ type: "text", text: content }]
  : Array.isArray(content) ? content : [];

function directorIds(content, sessionId) {
  const ids = new Set();
  for (const block of blocksOf(content)) {
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    for (const [, attributes] of block.text.matchAll(/<channel\b([^>]*)>/g)) {
      const meta = Object.fromEntries([...attributes.matchAll(/\b(\w+)="([^"]*)"/g)].map(match => match.slice(1)));
      if (meta.source === "plugin:codex:director" && /^[a-f0-9]{64}$/.test(meta.id)
        && (!meta.session || meta.session === sessionId)) ids.add(meta.id);
    }
  }
  return [...ids];
}

// Only request inputs are evidence of consumption. Transcript user/attachment
// rows can be written before prompt.submit drops them. Their hashes and blobs
// are not used until an api-request references them. Persist identities only.
export function scanConsumedDirectorEvents(source, sessionId, previous) {
  const fd = fs.openSync(source, "r");
  try {
    const stat = fs.fstatSync(fd);
    const resume = previous?.source === source && previous.dev === stat.dev && previous.ino === stat.ino
      && previous.offset <= stat.size;
    const cursor = { source, dev: stat.dev, ino: stat.ino, offset: resume ? previous.offset : 0,
      blobs: resume ? { ...previous.blobs } : {}, run: resume ? previous.run ?? null : null };
    const eventIds = new Set();
    let user;
    let restoredBytes = 0;
    const appendUser = content => {
      user ??= { hash: createHash("sha256").update('{"content":['), blocks: 0, ids: new Set() };
      for (const block of blocksOf(content)) {
        if (user.blocks++) user.hash.update(",");
        user.hash.update(canonical(block));
      }
      for (const id of directorIds(content, sessionId)) user.ids.add(id);
      if (user.ids.size) cursor.blobs[user.hash.copy().update('],"role":"user"}').digest("hex")] = [...user.ids];
    };
    let position = cursor.offset;
    let buffered = Buffer.alloc(0);
    const chunk = Buffer.alloc(65536);
    while (position < stat.size) {
      const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - position), position);
      if (!count) break;
      position += count;
      buffered = Buffer.concat([buffered, chunk.subarray(0, count)]);
      let end;
      while ((end = buffered.indexOf(10)) !== -1) {
        const start = cursor.offset;
        const line = buffered.subarray(0, end).toString("utf8");
        buffered = buffered.subarray(end + 1);
        cursor.offset += end + 1;
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        if (row?.sessionId !== sessionId || row.agentId != null) continue;
        if (row.type === "user" && row.message?.role === "user") {
          if (cursor.run === null) cursor.run = start;
          else if (!user) {
            // A process restarted inside an adjacent-user run. Rebuild only
            // that open run when another user record extends it, not history
            // on every request. No conversation text is copied into the cursor.
            const prefix = Buffer.alloc(start - cursor.run);
            for (let read = 0; read < prefix.length;) {
              const count = fs.readSync(fd, prefix, read, prefix.length - read, cursor.run + read);
              if (!count) throw new Error("Director transcript changed during recovery");
              read += count;
            }
            restoredBytes += prefix.length;
            for (const line of prefix.toString("utf8").split("\n")) {
              let earlier;
              try { earlier = JSON.parse(line); } catch { continue; }
              if (earlier.type === "user" && earlier.sessionId === sessionId && earlier.agentId == null
                && earlier.message?.role === "user") appendUser(earlier.message.content);
            }
          }
          appendUser(row.message.content);
        } else if (row.type === "assistant" || row.type === "system" && row.subtype === "compact_boundary") {
          cursor.run = null;
          user = undefined;
        } else if (row.type === "api-request-blob" && /^[a-f0-9]{64}$/.test(row.hash)
          && ["user", "system"].includes(row.message?.role)) {
          const ids = directorIds(row.message.content, sessionId);
          if (ids.length) cursor.blobs[row.hash] = ids;
        } else if (row.type === "api-request" && Array.isArray(row.tail)) {
          for (const hash of row.tail) {
            if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) continue;
            for (const id of cursor.blobs[hash] ?? []) eventIds.add(id);
            delete cursor.blobs[hash];
          }
        }
      }
    }
    // An incomplete final line is read again on the next pass, including its
    // UTF-8 bytes. A restart resumes at the last complete record.
    return { cursor, eventIds: [...eventIds], bytesRead: position - (resume ? previous.offset : 0) + restoredBytes };
  } finally { fs.closeSync(fd); }
}

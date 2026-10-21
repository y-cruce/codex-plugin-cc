#!/usr/bin/env node
// The delivery record as the hooks module reads and writes it. Claude Code lets
// a hooks module import only its own files and "claude-code", and the record
// lives on disk, so the hooks run this through $.process.run:
//
//   node director-ingress.mjs <command> '<json>'
//
// check   { refs, sessionId }       which tagged items are this session's and still pending
// accept  { events, route }         the ingress let them through: write their receipts
// reserve { items, route }          the pane is about to submit them (items are events,
//                                   or { job, type, stateDir } for an ending it reconciled)
// release { events, route }         the pane's submit was refused
import path from "node:path";
import { fileURLToPath } from "node:url";
import { commitDirectorEvents, directorEvent, eventFromRef, isDirectorEventPending, releaseDirectorEvents,
  reserveDirectorEvents } from "./lib/director-delivery.mjs";

export async function runIngress(command, input) {
  if (command === "check") {
    const known = input.refs.map((ref) => ({ ref, event: eventFromRef(ref) })).filter(({ event }) => event?.sessionId === input.sessionId);
    return { known: known.length, pending: known.filter(({ event }) => isDirectorEventPending(event)) };
  }
  if (command === "accept") {
    await commitDirectorEvents(input.events, input.route);
    return {};
  }
  if (command === "reserve") {
    const events = input.items.map((item) => item?.eventId ? item : item && directorEvent(item.job, item.type, item.payload ?? {}, item.stateDir));
    const reserved = new Set((await reserveDirectorEvents(events, input.route)).map((event) => event.eventId));
    return { items: events.map((event) => ({ event, reserved: Boolean(event && reserved.has(event.eventId)),
      pending: Boolean(event && (reserved.has(event.eventId) || isDirectorEventPending(event))) })) };
  }
  if (command === "release") {
    releaseDirectorEvents(input.events, input.route);
    return {};
  }
  throw new Error(`Unknown director-ingress command: ${command}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, json] = process.argv.slice(2);
  runIngress(command, JSON.parse(json ?? "{}"))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

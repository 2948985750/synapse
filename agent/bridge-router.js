"use strict";

const crypto = require("crypto");

// This router only receives sockets after mutual authentication has completed.
// Deadlines limit dispatch; a timeout cannot undo a command already executed.
function createBridgeRouter({
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let extension = null;
  const clients = new Map();
  const pending = new Map();
  const queue = [];
  const captureOwners = new Map();
  const cleanups = new Map();
  const lateStarts = new Map();
  const earlyEvents = new Map();

  function send(socket, message) {
    if (!socket || socket.readyState !== 1) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch (_) {
      return false;
    }
  }
  function finish(entry, reply) {
    if (!pending.delete(entry.wireId)) return;
    clearTimer(entry.timer);
    const index = queue.indexOf(entry);
    if (index !== -1) queue.splice(index, 1);
    if (reply)
      send(entry.socket, { ...reply, type: "agent.result", id: entry.id });
  }
  function expire(entry) {
    if (entry.dispatched) {
      send(extension, { type: "cancel", id: entry.wireId });
      if (entry.command.cmd === "capture.start") {
        lateStarts.set(entry.wireId, entry.command);
        if (lateStarts.size > 200)
          lateStarts.delete(lateStarts.keys().next().value);
      }
    }
    finish(entry, {
      ok: false,
      error:
        "Command deadline exceeded; any operation already dispatched may have executed",
      code: "COMMAND_TIMEOUT",
    });
  }
  function forward(entry) {
    if (!clients.has(entry.socket) || entry.socket.readyState !== 1) {
      finish(entry);
      return;
    }
    if (entry.deadlineAt <= now()) {
      expire(entry);
      return;
    }
    if (
      send(extension, {
        ...entry.command,
        id: entry.wireId,
        deadlineAt: entry.deadlineAt,
      })
    )
      entry.dispatched = true;
  }
  function attachExtension(socket) {
    if (extension && extension !== socket && extension.readyState === 1) {
      // Keep a stable browser identity instead of silently switching profiles.
      socket.close(1008, "An extension is already connected");
      return false;
    }
    extension = socket;
    for (const entry of [...queue]) {
      const index = queue.indexOf(entry);
      if (index !== -1) queue.splice(index, 1);
      forward(entry);
    }
    return true;
  }
  function addClient(socket) {
    clients.set(socket, { clientId: null, transientClient: true });
  }
  function clientMessage(socket, message) {
    const client = clients.get(socket);
    if (!client || !message || message.id == null) return;
    if (message.type === "client.disconnect") {
      cleanupClient(socket, client, message.id);
      return;
    }
    if (client.cleaning) {
      send(socket, {
        type: "agent.result",
        id: message.id,
        ok: false,
        error: "Client cleanup is still in progress",
        code: "CLIENT_CLOSING",
      });
      return;
    }
    if (message.type === "cancel") {
      for (const entry of [...pending.values()])
        if (entry.socket === socket && entry.id === message.id) expire(entry);
      return;
    }
    if (!["cmd", "agent.cmd"].includes(message.type)) return;
    if (
      typeof message.clientId !== "string" ||
      !message.clientId ||
      message.clientId.length > 128
    ) {
      send(socket, {
        type: "agent.result",
        id: message.id,
        ok: false,
        error: "A valid clientId is required",
        code: "INVALID_CLIENT",
      });
      return;
    }
    if (client.clientId && client.clientId !== message.clientId) {
      send(socket, {
        type: "agent.result",
        id: message.id,
        ok: false,
        error: "A connection cannot change clientId",
        code: "INVALID_CLIENT",
      });
      return;
    }
    if (
      [...clients.entries()].some(
        ([other, value]) =>
          other !== socket && value.clientId === message.clientId,
      )
    ) {
      send(socket, {
        type: "agent.result",
        id: message.id,
        ok: false,
        error: "clientId is already active on another connection",
        code: "CLIENT_BUSY",
      });
      return;
    }
    client.clientId = message.clientId;
    client.transientClient = message.transientClient !== false;
    const timeoutMs =
      Number.isFinite(message.timeoutMs) && message.timeoutMs > 0
        ? Math.min(message.timeoutMs, 300000)
        : 30000;
    const deadlineAt = Math.min(
      now() + timeoutMs,
      Number.isFinite(message.deadlineAt) ? message.deadlineAt : Infinity,
    );
    const entry = {
      socket,
      id: message.id,
      wireId: crypto.randomUUID(),
      command: { ...message, clientId: client.clientId },
      deadlineAt,
      dispatched: false,
      timer: null,
    };
    pending.set(entry.wireId, entry);
    entry.timer = setTimer(
      () => expire(entry),
      Math.max(0, deadlineAt - now()),
    );
    if (deadlineAt <= now()) {
      expire(entry);
      return;
    }
    if (extension && extension.readyState === 1) forward(entry);
    else if (queue.length >= 200)
      finish(entry, {
        ok: false,
        error: "Bridge command queue is full",
        code: "QUEUE_FULL",
      });
    else queue.push(entry);
  }
  function extensionMessage(socket, message) {
    if (socket !== extension || !message) return;
    if (message.type === "agent.result") {
      const cleanup = cleanups.get(message.id);
      if (cleanup) {
        cleanups.delete(message.id);
        clients.delete(cleanup.socket);
        if (cleanup.replyId)
          send(cleanup.socket, { ...message, id: cleanup.replyId });
        return;
      }
      const late = lateStarts.get(message.id);
      if (late) {
        lateStarts.delete(message.id);
        if (message.ok && message.result?.captureId)
          send(extension, {
            type: "cmd",
            id: crypto.randomUUID(),
            cmd: "capture.stop",
            args: {
              tabId: late.args?.tabId,
              captureId: message.result.captureId,
            },
            clientId: late.clientId,
            transientClient: late.transientClient,
            timeoutMs: 5000,
            deadlineAt: now() + 5000,
          });
        return;
      }
      const entry = pending.get(message.id);
      if (!entry) return;
      if (entry.deadlineAt <= now()) {
        expire(entry);
        return;
      }
      if (
        message.ok &&
        entry.command.cmd === "capture.start" &&
        message.result?.captureId
      ) {
        captureOwners.set(message.result.captureId, {
          socket: entry.socket,
          clientId: entry.command.clientId,
        });
      }
      if (
        message.ok &&
        entry.command.cmd === "capture.stop" &&
        entry.command.args?.captureId
      )
        captureOwners.delete(entry.command.args.captureId);
      finish(entry, message);
      if (message.ok && entry.command.cmd === "capture.start") {
        const early = earlyEvents.get(message.result?.captureId);
        earlyEvents.delete(message.result?.captureId);
        if (early) for (const event of early) extensionMessage(socket, event);
      }
    } else if (message.type === "event.push") {
      const owner = captureOwners.get(message.captureId);
      if (
        owner &&
        message.clientId === owner.clientId &&
        clients.has(owner.socket)
      )
        send(owner.socket, message);
      else if (
        !owner &&
        [...pending.values()].some(
          (entry) =>
            entry.command.cmd === "capture.start" &&
            entry.command.clientId === message.clientId &&
            entry.command.args?.tabId === message.tabId,
        )
      ) {
        let buffer = earlyEvents.get(message.captureId);
        if (!buffer && earlyEvents.size < 200) {
          buffer = [];
          earlyEvents.set(message.captureId, buffer);
        }
        if (buffer && buffer.length < 100) buffer.push(message);
      }
    }
  }
  function cleanupClient(socket, client, replyId) {
    if (client.cleaning) return;
    client.cleaning = true;
    for (const entry of [...pending.values()])
      if (entry.socket === socket) {
        if (entry.dispatched) {
          send(extension, { type: "cancel", id: entry.wireId });
          if (entry.command.cmd === "capture.start")
            lateStarts.set(entry.wireId, entry.command);
        }
        finish(entry);
      }
    for (const [captureId, owner] of captureOwners)
      if (owner.socket === socket) captureOwners.delete(captureId);
    for (const [captureId, events] of earlyEvents)
      if (events[0]?.clientId === client.clientId)
        earlyEvents.delete(captureId);
    if (!client.clientId || !extension || extension.readyState !== 1) {
      clients.delete(socket);
      if (replyId)
        send(socket, {
          type: "agent.result",
          id: replyId,
          ok: true,
          result: { disconnected: true },
        });
      return;
    }
    const id = crypto.randomUUID();
    cleanups.set(id, { socket, client, replyId });
    send(extension, {
      type: "client.disconnect",
      id,
      clientId: client.clientId,
      releaseLeases: client.transientClient,
    });
    // Keep the identity reserved until the worker acknowledges cleanup. Releasing
    // it on a timer would let an old cleanup destroy a newly opened session.
  }
  function disconnect(socket) {
    if (socket === extension) {
      extension = null;
      captureOwners.clear();
      earlyEvents.clear();
      lateStarts.clear();
      for (const entry of [...pending.values()])
        if (entry.dispatched)
          finish(entry, {
            ok: false,
            error:
              "Extension disconnected; the dispatched operation may have executed",
            code: "EXTENSION_DISCONNECTED",
          });
      for (const cleanup of cleanups.values()) {
        clients.delete(cleanup.socket);
        if (cleanup.replyId)
          send(cleanup.socket, {
            type: "agent.result",
            id: cleanup.replyId,
            ok: false,
            error: "Extension disconnected during cleanup",
            code: "EXTENSION_DISCONNECTED",
          });
      }
      cleanups.clear();
    }
    const client = clients.get(socket);
    if (client) cleanupClient(socket, client);
  }
  function close() {
    for (const socket of [...clients.keys()]) disconnect(socket);
    for (const entry of [...pending.values()]) finish(entry);
    captureOwners.clear();
    earlyEvents.clear();
    lateStarts.clear();
    cleanups.clear();
    clients.clear();
  }
  return {
    addClient,
    clientMessage,
    attachExtension,
    extensionMessage,
    disconnect,
    close,
  };
}

module.exports = { createBridgeRouter };

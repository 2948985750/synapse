"use strict";
// transport：WS 连接、桥级联故障转移、命令执行。
const { WebSocketServer, WebSocket } = require("./vendor/ws");
const { authenticateClient, authenticateServer } = require("./bridge-auth");
const { failReply, failEvaluation } = require("./lib/ui");
const { doCaptureMany } = require("./capture");
const {
  PORT_RANGE_START,
  PORT_RANGE_END,
  CMD_TIMEOUT_MS,
} = require("./config");

function bindAgentWs() {
  if (
    !Number.isInteger(PORT_RANGE_START) ||
    !Number.isInteger(PORT_RANGE_END) ||
    PORT_RANGE_START < 1 ||
    PORT_RANGE_END > 65535 ||
    PORT_RANGE_START > PORT_RANGE_END
  )
    throw new Error("Invalid WebSocket port range");
  async function attempt(port) {
    if (port > PORT_RANGE_END) throw new Error("No available bridge port");
    return new Promise((resolve, reject) => {
      const srv = new WebSocketServer({
        port,
        host: "127.0.0.1",
        maxPayload: 32 * 1024 * 1024,
      });
      srv.once("listening", () => resolve({ srv, port }));
      srv.once("error", (error) => {
        if (error.code === "EADDRINUSE") resolve(attempt(port + 1));
        else reject(error);
      });
    });
  }
  return attempt(PORT_RANGE_START);
}

async function connectBridgeChain(candidates, token, opts, timeoutMs = 5000) {
  let lastError = null;
  for (const b of candidates) {
    try {
      const channel = await connectBridge(b, token, opts, timeoutMs);
      return { channel, bridge: b };
    } catch (error) {
      lastError = error;
    }
  }
  const error = new Error(
    lastError
      ? "No live bridge reachable (" +
          candidates.length +
          " tried: " +
          lastError.message +
          ")"
      : "No live bridge discovery record",
  );
  error.code = "NO_BRIDGE";
  throw error;
}

function createChannel(socket, opts) {
  const pending = new Map();
  const eventsByCapture = new Map();
  const clientId = opts.clientId;
  function settle(id, error, reply) {
    const entry = pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(id);
    if (error) entry.reject(error);
    else entry.resolve(reply);
  }
  function onClose() {
    for (const id of [...pending.keys()])
      settle(
        id,
        new Error("Connection closed; dispatched operations may have executed"),
      );
  }
  function onMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch (_) {
      return;
    }
    if (message.type === "agent.result") {
      if (message.ok) settle(message.id, null, message);
      else {
        const error = new Error(message.error || "Extension command failed");
        error.code = message.code || "COMMAND_FAILED";
        settle(message.id, error);
      }
    } else if (message.type === "event.push" && message.clientId === clientId) {
      let events = eventsByCapture.get(message.captureId);
      if (!events) {
        events = [];
        eventsByCapture.set(message.captureId, events);
      }
      events.push(message);
      if (events.length > 2000) events.shift();
    }
  }
  socket.on("message", onMessage);
  socket.on("close", onClose);
  socket.on("error", onClose);
  function sendCmd(obj, timeoutMs = CMD_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (socket.readyState !== 1) {
        reject(new Error("Connection is not open"));
        return;
      }
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        try {
          socket.send(JSON.stringify({ type: "cancel", id, clientId }));
        } catch (_) {}
        const error = new Error(
          "Command timed out; any operation already dispatched may have executed",
        );
        error.code = "COMMAND_TIMEOUT";
        settle(id, error);
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        socket.send(
          JSON.stringify({
            type: "cmd",
            id,
            cmd: obj.cmd,
            args: obj.args,
            clientId,
            transientClient: opts.transientClient,
            timeoutMs,
            deadlineAt: Date.now() + timeoutMs,
          }),
        );
      } catch (error) {
        settle(id, error);
      }
    });
  }
  async function close(direct) {
    if (!opts.skipGracefulDisconnect && socket.readyState === 1) {
      const id = crypto.randomUUID();
      await new Promise((resolve) => {
        const timer = setTimeout(() => settle(id, null, {}), 1500);
        pending.set(id, { resolve, reject: resolve, timer });
        try {
          socket.send(
            JSON.stringify({
              type: "client.disconnect",
              id,
              clientId,
              releaseLeases: opts.transientClient,
            }),
          );
        } catch (_) {
          settle(id, null, {});
        }
      });
    }
    for (const id of [...pending.keys()])
      settle(id, new Error("Channel closed"));
    socket.off("message", onMessage);
    socket.off("close", onClose);
    socket.off("error", onClose);
    if (socket.readyState < 2) socket.close();
    if (socket.readyState !== 3) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          socket.terminate();
          resolve();
        }, 200);
        socket.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
  return { sendCmd, eventsByCapture, close };
}

async function connectBridge(b, token, opts, timeoutMs = 5000) {
  const socket = new WebSocket("ws://127.0.0.1:" + b.port, {
    handshakeTimeout: timeoutMs,
  });
  socket.on("error", () => {});
  // Install proof listeners before open: the server sends its challenge immediately.
  try {
    await authenticateClient(socket, token, timeoutMs);
  } catch (error) {
    socket.terminate();
    error.code = "BRIDGE_AUTH_OR_CONNECT";
    throw error;
  }
  return createChannel(socket, opts);
}

async function connectDirect(token, opts) {
  const { srv, port } = await bindAgentWs();
  console.error(
    "[collect] Waiting for a paired extension on 127.0.0.1:" + port,
  );
  let timer;
  try {
    const socket = await new Promise((resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              "Paired extension did not connect within " + opts.waitMs + "ms",
            ),
          ),
        opts.waitMs,
      );
      srv.on("connection", (peer, request) =>
        authenticateServer(peer, request, token, (role) => {
          if (role !== "extension") {
            peer.close(1008, "This endpoint accepts an extension only");
            return;
          }
          resolve(peer);
        }),
      );
    });
    clearTimeout(timer);
    // A one-shot endpoint owns one extension. Reject later connections.
    srv.removeAllListeners("connection");
    srv.on("connection", (peer) =>
      peer.close(1008, "An extension is already connected"),
    );
    const channel = createChannel(socket, opts);
    const closeChannel = channel.close;
    channel.close = async () => {
      await closeChannel(true);
      for (const peer of srv.clients) peer.terminate();
      await new Promise((resolve) => srv.close(resolve));
    };
    return channel;
  } catch (error) {
    clearTimeout(timer);
    for (const peer of srv.clients) peer.terminate();
    srv.close();
    throw error;
  }
}

async function executeCommand(channel, command, opts) {
  if (command.cmd === "capture")
    return (
      await doCaptureMany(
        channel.sendCmd,
        [command.args],
        opts,
        channel.eventsByCapture,
      )
    )[0];
  if (command.cmd === "capture-many")
    return doCaptureMany(
      channel.sendCmd,
      command.args.pairs,
      opts,
      channel.eventsByCapture,
    );
  const result = failReply(await channel.sendCmd(command));
  if (command.cmd === "cdp" && command.args?.method === "Runtime.evaluate")
    failEvaluation(result);
  return result;
}

module.exports = {
  bindAgentWs,
  createChannel,
  connectBridge,
  connectDirect,
  connectBridgeChain,
  executeCommand,
};

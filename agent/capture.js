"use strict";
// capture：网络响应体捕获的结果整形与多标签编排。
const { failReply, failEvaluation, wait } = require("./lib/ui");

async function buildCaptureSessionResult(sendCmd, s, events, opts, bodyStore) {
  const { tabId, action, captureId } = s;
  const durationMs = opts.durationMs || 12000;

  // 合并事件：requestId -> 请求信息（buffer 已按 captureId 分流，无需再按 tabId 过滤）
  const reqs = new Map();
  for (const ev of events) {
    const p = ev.params || {};
    if (ev.method === "Network.requestWillBeSent") {
      reqs.set(p.requestId, {
        requestId: p.requestId,
        url: p.request && p.request.url,
        method: p.request && p.request.method,
        type: p.type || "",
        status: 0,
        mimeType: "",
        size: 0,
      });
    } else if (ev.method === "Network.responseReceived") {
      const r = reqs.get(p.requestId) || {
        requestId: p.requestId,
        url: p.response && p.response.url,
        method: "",
        type: "",
        status: 0,
        mimeType: "",
        size: 0,
      };
      r.status = p.response ? p.response.status : 0;
      r.mimeType = p.response ? p.response.mimeType : "";
      reqs.set(p.requestId, r);
    } else if (ev.method === "Network.loadingFinished") {
      const r = reqs.get(p.requestId);
      if (r) r.size = p.encodedDataLength || p.totalBytes || 0;
    }
  }

  // 过滤（与 doCapture 一致：默认只留 xhr/fetch 或 json；--all 全留；--filter 正则再筛）
  let cands = [...reqs.values()].filter(
    (c) => c.url && c.status && c.status < 500,
  );
  if (!opts.all) {
    cands = cands.filter(
      (c) =>
        String(c.type).toLowerCase() === "xhr" ||
        String(c.type).toLowerCase() === "fetch" ||
        /json/i.test(c.mimeType || ""),
    );
  }
  if (opts.filter) {
    let re;
    re = new RegExp(opts.filter, "i");
    if (re) cands = cands.filter((c) => re.test(c.url || ""));
  }
  cands.sort((a, b) => (b.size || 0) - (a.size || 0));
  cands = cands.slice(0, 40); // 与 doCapture 一致：最多 40 条

  // 逐条取响应体（body 截断到 bodyMaxKb，防输出膨胀）。窗口内已 eager 取到的
  // 直接用（T-30：窗口关完再取，顶层文档体可能已被浏览器回收）。
  const bodyLimit = (opts.bodyMaxKb || 200) * 1024;
  const decodeBody = (rawBody, base64Encoded) => {
    let body = base64Encoded
      ? Buffer.from(rawBody, "base64").toString("utf8")
      : rawBody;
    let bodyTruncated = false;
    if (body.length > bodyLimit) {
      body = body.slice(0, bodyLimit);
      bodyTruncated = true;
    }
    return { body, bodyTruncated };
  };
  const out = [];
  for (const c of cands) {
    let body = "";
    let bodyTruncated = false;
    let bodyError = "";
    const pre = bodyStore && bodyStore.get(captureId + ":" + c.requestId);
    if (pre) {
      ({ body, bodyTruncated } = decodeBody(pre.body, pre.base64Encoded));
    } else {
      try {
        const r = await sendCmd(
          {
            cmd: "cdp",
            args: {
              tabId,
              method: "Network.getResponseBody",
              params: { requestId: c.requestId },
            },
          },
          20000,
        );
        if (r.ok && r.result && typeof r.result.body === "string") {
          ({ body, bodyTruncated } = decodeBody(
            r.result.body,
            r.result.base64Encoded,
          ));
        } else if (!r.ok) {
          bodyError = r.error || "getResponseBody failed";
        }
      } catch (e) {
        bodyError = e.message;
      }
    }
    out.push({
      url: c.url,
      method: c.method,
      type: c.type,
      status: c.status,
      mimeType: c.mimeType,
      size: c.size,
      body,
      bodyTruncated,
      bodyError,
    });
  }

  return {
    tabId,
    action,
    durationMs,
    totalRequestsSeen: reqs.size,
    returned: out.length,
    requests: out,
    captureId,
  };
}

async function triggerCapture(sendCmd, session, opts) {
  if (session.action === "reload")
    failReply(
      await sendCmd(
        {
          cmd: "cdp",
          args: { tabId: session.tabId, method: "Page.reload", params: {} },
        },
        20000,
      ),
    );
  else if (session.action !== "wait")
    failReply(
      await sendCmd({
        cmd: "navigate",
        args: { tabId: session.tabId, url: session.action, waitMs: 8000 },
      }),
    );
  if (opts.triggerJs)
    failEvaluation(
      failReply(
        await sendCmd({
          cmd: "cdp",
          args: {
            tabId: session.tabId,
            method: "Runtime.evaluate",
            params: {
              expression: opts.triggerJs,
              awaitPromise: true,
              returnByValue: true,
            },
          },
        }),
      ),
    );
}

async function doCaptureMany(sendCmd, pairs, opts, eventsByCapture) {
  const sessions = [];
  try {
    for (const pair of pairs) {
      const started = failReply(
        await sendCmd({
          cmd: "capture.start",
          args: {
            tabId: pair.tabId,
            domains: ["Network"],
            durationMs: opts.durationMs + 900000,
          },
        }),
      );
      sessions.push({ ...pair, captureId: started.captureId });
    }
    await Promise.all(
      sessions.map((session) => triggerCapture(sendCmd, session, opts)),
    );
    // eager 取响应体（T-30）：loadingFinished 一到就取，不等窗口关完——
    // 顶层 octet-stream 文档体关窗后取会报 No resource。取不到的回落旧路径。
    const bodyStore = new Map(); // "captureId:requestId" -> {body, base64Encoded}
    const inflight = [];
    const fetched = new Set();
    const t0 = Date.now();
    while (Date.now() - t0 < opts.durationMs) {
      for (const session of sessions) {
        for (const ev of eventsByCapture.get(session.captureId) || []) {
          if (ev.method !== "Network.loadingFinished") continue;
          const rid = ev.params && ev.params.requestId;
          const key = session.captureId + ":" + rid;
          if (!rid || fetched.has(key)) continue;
          fetched.add(key);
          inflight.push(
            sendCmd(
              {
                cmd: "cdp",
                args: {
                  tabId: session.tabId,
                  method: "Network.getResponseBody",
                  params: { requestId: rid },
                },
              },
              20000,
            )
              .then((r) => {
                if (r.ok && r.result && typeof r.result.body === "string") {
                  bodyStore.set(key, {
                    body: r.result.body,
                    base64Encoded: !!r.result.base64Encoded,
                  });
                }
              })
              .catch(() => {}),
          );
        }
      }
      await wait(Math.min(400, opts.durationMs));
    }
    await Promise.allSettled(inflight);
    return await Promise.all(
      sessions.map((session) =>
        buildCaptureSessionResult(
          sendCmd,
          session,
          eventsByCapture.get(session.captureId) || [],
          opts,
          bodyStore,
        ),
      ),
    );
  } finally {
    await Promise.all(
      sessions.map(async (session) => {
        try {
          await sendCmd(
            {
              cmd: "capture.stop",
              args: { tabId: session.tabId, captureId: session.captureId },
            },
            5000,
          );
        } catch (_) {}
        eventsByCapture.delete(session.captureId);
      }),
    );
  }
}

module.exports = { buildCaptureSessionResult, triggerCapture, doCaptureMany };

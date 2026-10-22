"use strict";
// 运行期常量集中处。放在这里而不是各模块各写一份，避免超时值悄悄分叉。

// 端口段：扩展与 agent 必须一致（扩展侧写死同一段）。
const PORT_RANGE_START = Number(process.env.WB_AGENT_WS_START || 9521);
const PORT_RANGE_END = Number(process.env.WB_AGENT_WS_END || 9540);

// 50s：扩展端 Runtime.evaluate 有 6s 弹窗重试（最坏 2×timeout+6s，evaluate 类
// 命令扩展侧最坏 ~36-46s），CLI 上限须盖住扩展端最坏值（T-31）。
const CMD_TIMEOUT_MS = 50000;

// status 的有界探测总时限。
const STATUS_TIMEOUT_MS = 1800;

// 维护锁的陈旧判定：持锁者被强杀后，超过这个时长视为残留锁可窃取。
const MAINT_LOCK_TTL_MS = 180000;

module.exports = {
  PORT_RANGE_START,
  PORT_RANGE_END,
  CMD_TIMEOUT_MS,
  STATUS_TIMEOUT_MS,
  MAINT_LOCK_TTL_MS,
};

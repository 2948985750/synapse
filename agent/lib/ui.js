"use strict";
// 输出与错误归一化：所有命令都从这几个出口吐结果，抽出来避免散落在各模块。
//
// 约定：agent-collect 的 stdout 永远是一行 JSON（{ok:false,error,code} 或命令结果），
// 错误码给调用脚本判断用，不靠解析错误文案。

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function failReply(reply) {
  if (!reply || !reply.ok) {
    const error = new Error(reply?.error || "Extension command failed");
    error.code = reply?.code || "COMMAND_FAILED";
    throw error;
  }
  return reply.result;
}

function failEvaluation(result) {
  if (result?.exceptionDetails) {
    const error = new Error(
      result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        "JavaScript execution failed",
    );
    error.code = "EVALUATION_FAILED";
    throw error;
  }
  return result;
}

function writeFailure(error) {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      error: error.message || String(error),
      code: error.code || "COMMAND_FAILED",
    }) + "\n",
  );
  process.exitCode = 1;
}

module.exports = { wait, failReply, failEvaluation, writeFailure };

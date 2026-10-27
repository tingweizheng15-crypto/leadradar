/**
 * 子任务启动方式：开发态（node 脚本）与打包态（EXE 自调用）共用一个口径。
 * SEA 里 require 外部文件不可用、但进程可以用 --job 参数自调用，所以两种形态分开处理。
 */
import path from "node:path";
import { ROOT } from "./config.mjs";

export const IS_SEA = process.env.LR_SEA === "1";

/** 打包态：LeadRadar.exe --job pipeline；开发态：node console/job.mjs pipeline */
export function jobCommand(kind, extra = []) {
  if (IS_SEA) return { cmd: process.execPath, args: ["--job", kind, ...extra] };
  return { cmd: process.execPath, args: [path.join(ROOT, "console", "job.mjs"), kind, ...extra] };
}

/** 各 kind 对应的脚本（打包态用来定位要 import 的文件） */
export const JOB_SCRIPTS = {
  pipeline: "run.mjs",
  daily: path.join("daily", "run.mjs"),
  doctor: "doctor.mjs",
  next: "scheduler.mjs",
  scheduler: "scheduler.mjs",
};

/** 按 kind 计算要透传给脚本的额外参数 */
export function jobArgsFor(kind) {
  if (kind === "doctorLive") return { script: "doctor.mjs", args: ["--live"] };
  if (kind === "next") return { script: "scheduler.mjs", args: ["--next"] };
  return { script: JOB_SCRIPTS[kind], args: [] };
}

import { normalizeUiError } from "../../lib/uiError";
import { KnowledgeError } from "./domain";

export interface KnowledgeFailure { message: string; diagnosticId: string; category: string; stage: string }
const diagnostics: KnowledgeFailure[] = [];
export const knowledgeDiagnostics = (): readonly KnowledgeFailure[] => diagnostics.map(item => ({ ...item }));
export function knowledgeUiError(error: unknown, stage = "本机操作"): KnowledgeFailure {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code.replace(/^firestore\//, "") : "unknown";
  const domainMessages: Record<string, string> = {
    timeout: "知识库同步请求超时，提交结果尚待核对。本机内容保留，再次同步会先检查云端回执。",
    busy: "知识库正在另一个窗口同步或整理，请稍后再试。本机内容保留。",
    migration: "旧知识内容需要核对，本机原内容和草稿已保留。请在知识库的恢复管理中查看，不要重复复制。",
    cancelled: "本轮知识同步已中断，本机内容保留。再次同步会先核对云端结果。",
    corrupt: "知识库云提交校验失败，已安全停止且未跳过历史。本机内容仍保留；可重试或保全副本，持续失败需修复云端历史。",
    protected: "此恢复副本正在保全待确认内容，只能查看。请先另存可编辑副本或处理依赖操作。",
    stale: "内容已在其他位置更新。你的输入仍保留，请重新打开并比较后保存。",
    scope: "账号或知识库已变化，请重新打开当前知识库。",
    budget: "本次内容太多，请减少所选内容后重试。",
    cycle: "不能把节点移入自身或它的子节点。",
    invalid: "内容或名称未通过校验，请检查后重试；原有内容未被覆盖。",
    missing: "云端暂时不可达或数据尚未完整到达。本机内容保留，请稍后重新同步。",
    receipt: "同步结果需要核对，已停止重复提交。本机内容仍保留。",
  };
  const cloudMessages: Record<string, string> = {
    "permission-denied": "账号暂时无权访问知识库云服务，请检查云端权限或规则配置。本机内容保留，反复重试不会解决权限问题。",
    unauthenticated: "登录状态已失效，请在云同步设置中重新登录。本机内容保留。",
    unavailable: "暂时连接不到云服务，请检查网络后重试。本机内容保留。",
    "deadline-exceeded": "同步请求超时。本机内容保留，重试时会先核对提交结果。",
    "resource-exhausted": "云服务额度暂时不足，请稍后再试。本机内容保留。",
    "failed-precondition": "云服务配置尚未就绪，请检查知识库规则与索引配置。本机内容保留。",
  };
  const known = error instanceof KnowledgeError ? domainMessages[code] : cloudMessages[code];
  const failure = { message: known ?? "这次操作未能完成，输入仍保留。请重试；持续失败时可复制诊断信息。", diagnosticId: normalizeUiError(error, "generic").diagnosticId, category: known ? code : "unknown", stage };
  diagnostics.push(failure);
  if (diagnostics.length > 20) diagnostics.shift();
  return failure;
}

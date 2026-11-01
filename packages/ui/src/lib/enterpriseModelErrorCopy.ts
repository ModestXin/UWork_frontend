/** 真实退出测试曾直接显示内部码；只映射已知稳定值，保留原始诊断供排查。 */
export function enterpriseModelErrorMessageId(error: {
  code?: string;
  message: string;
}): string | undefined {
  const messages: Record<string, string> = {
    enterprise_identity_changed: "chat.error.enterpriseSessionChanged",
    enterprise_configuration_changed: "chat.error.enterpriseSessionChanged",
    enterprise_runtime_obsolete: "chat.error.enterpriseSessionChanged",
    enterprise_policy_unavailable: "chat.error.enterpriseServiceUnavailable",
    enterprise_model_relay_unavailable: "chat.error.enterpriseServiceUnavailable",
    enterprise_model_unavailable: "chat.error.enterpriseServiceUnavailable",
    // 后台撤销个人模型权限后，既有会话也应展示可操作提示，而非直接暴露内部码。
    enterprise_personal_models_denied: "chat.error.enterprisePersonalModelsDenied",
    enterprise_personal_agents_denied: "chat.error.enterprisePersonalAgentsDenied",
    enterprise_response_private: "chat.error.enterpriseResponseBlocked",
  };
  const read = (value: string) => (Object.hasOwn(messages, value) ? messages[value] : undefined);
  return (error.code ? read(error.code) : undefined) ?? read(error.message);
}

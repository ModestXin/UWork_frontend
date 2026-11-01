/** 私有分享端口只扩展确定路径和预算，不能提升其他 API 的 64KiB 限额。 */
export function uworkShareRequestLimits(
  path: string,
  method: "GET" | "POST" | "DELETE",
): { requestBytes: number; responseBytes: number } | undefined {
  const small = 65536;
  const confirm = 1024 * 1024;
  const artifact = Math.ceil((512 * 1024) / 3) * 4 + 8192;
  if (!path.startsWith("/api/client/shares/")) return undefined;
  const parts = path.slice("/api/client/shares/".length).split("/");
  if (parts.some((part) => !/^[A-Za-z0-9._~-]{1,128}$/.test(part) || part === "." || part === ".."))
    return undefined;
  if (path === "/api/client/shares/capabilities" && method === "GET")
    return { requestBytes: 0, responseBytes: small };
  if (path === "/api/client/shares/preparations" && method === "POST")
    return { requestBytes: small, responseBytes: small };
  if (parts.length === 3 && parts[0] === "preparations" && method === "POST") {
    if (parts[2] === "artifacts") return { requestBytes: artifact, responseBytes: small };
    if (parts[2] === "confirm") return { requestBytes: confirm, responseBytes: small };
  }
  if (parts.length === 2 && parts[1] === "preview" && method === "GET")
    return { requestBytes: 0, responseBytes: confirm + small };
  if (parts.length === 3 && parts[1] === "artifacts" && method === "GET")
    return { requestBytes: 0, responseBytes: artifact };
  if (parts.length === 2 && parts[1] === "continuation" && method === "POST")
    return { requestBytes: small, responseBytes: small };
  if (parts.length === 1 && method === "DELETE") return { requestBytes: 0, responseBytes: small };
  return undefined;
}

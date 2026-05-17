export function isTransientDbError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("connection terminated due to connection timeout") ||
    lower.includes("timeout") ||
    lower.includes("lock timeout") ||
    lower.includes("deadlock detected") ||
    lower.includes("econnreset") ||
    lower.includes("econnrefused") ||
    lower.includes("could not connect") ||
    lower.includes("server closed the connection unexpectedly")
  );
}

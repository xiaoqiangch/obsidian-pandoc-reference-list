/**
 * Minimal debug logger that does not depend on the obsidian module, so the RAG
 * modules stay unit-testable outside of Electron.
 */
export function ragLog(module: string, message: string, data?: any) {
  try {
    const w = globalThis as any;
    if (!w.BIB_DEBUG_LOGS) w.BIB_DEBUG_LOGS = [];
    w.BIB_DEBUG_LOGS.push({
      timestamp: new Date().toISOString(),
      module,
      message,
      data,
    });
  } catch {
    // never throw from logging
  }
}

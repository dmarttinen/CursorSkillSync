import * as vscode from "vscode";

import { getAutoRefreshIntervalHours } from "./config";

let refreshTimer: ReturnType<typeof setInterval> | undefined;
let logFn: ((message: string) => void) | undefined;

export function startAutoRefresh(
  refresh: () => void | Promise<void>,
  log: (message: string) => void
): void {
  logFn = log;
  restartAutoRefresh(refresh);
}

export function restartAutoRefresh(refresh: () => void | Promise<void>): void {
  stopAutoRefresh();

  const hours = getAutoRefreshIntervalHours();
  if (hours <= 0) return;

  const ms = hours * 60 * 60 * 1000;
  const unit = hours === 1 ? "hour" : "hours";
  logFn?.(`Auto-refresh enabled (every ${hours} ${unit})`);

  refreshTimer = setInterval(() => {
    logFn?.("Auto-refresh triggered (catalog + installed skills)");
    void refresh();
  }, ms);
}

export function stopAutoRefresh(): void {
  if (refreshTimer !== undefined) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
}

export function disposeAutoRefresh(): vscode.Disposable {
  return new vscode.Disposable(() => stopAutoRefresh());
}

import { db } from './db.js'

const numberParameter = (name, fallback) => {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

export const PARAMETERS = {
  monitoring: {
    liveAfterSeconds: numberParameter('MONITORING_LIVE_AFTER_SECONDS', 30),
    staleAfterSeconds: numberParameter('MONITORING_STALE_AFTER_SECONDS', 120),
  },
  analytics: {
    defaultWindowHours: numberParameter('ANALYTICS_DEFAULT_WINDOW_HOURS', 24),
  },
}

const ENV_NAMES = {
  'monitoring.live_after_seconds': 'MONITORING_LIVE_AFTER_SECONDS',
  'monitoring.stale_after_seconds': 'MONITORING_STALE_AFTER_SECONDS',
  'analytics.default_window_hours': 'ANALYTICS_DEFAULT_WINDOW_HOURS',
}

export function getParameter(key, fallback) {
  const envName = ENV_NAMES[key]
  if (envName && process.env[envName] !== undefined) return numberParameter(envName, fallback)
  const row = db.prepare('SELECT value_json FROM system_parameters WHERE key = ?').get(key)
  if (!row) return fallback
  try {
    const value = JSON.parse(row.value_json)
    return Number.isFinite(Number(value)) ? Number(value) : fallback
  } catch {
    return fallback
  }
}

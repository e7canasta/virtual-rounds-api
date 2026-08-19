import { db } from './db.js'
import { monitoringFreshness } from './policies.js'

export function reportSummary(period) {
  const { from, to, wingId } = period
  const rounds = db
    .prepare(
      `
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress
    FROM rounds WHERE started_at >= ? AND started_at <= ? AND (? IS NULL OR wing_id = ?)
  `,
    )
    .get(from, to, wingId, wingId)
  const tasks = db
    .prepare(
      `
    SELECT COUNT(t.id) AS total,
      SUM(CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN t.note IS NOT NULL AND t.note != '' THEN 1 ELSE 0 END) AS with_notes
    FROM round_tasks t JOIN rounds r ON r.id = t.round_id
    WHERE r.started_at >= ? AND r.started_at <= ? AND (? IS NULL OR r.wing_id = ?)
  `,
    )
    .get(from, to, wingId, wingId)
  const alerts = db
    .prepare(
      `
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN a.status = 'open' THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN a.status = 'acknowledged' THEN 1 ELSE 0 END) AS acknowledged,
      SUM(CASE WHEN a.status = 'resolved' THEN 1 ELSE 0 END) AS resolved,
      SUM(CASE WHEN a.level = 'high' THEN 1 ELSE 0 END) AS high
    FROM alerts a
    LEFT JOIN rooms rm ON rm.id = (SELECT room_id FROM beds WHERE id = a.bed_id)
    WHERE a.occurred_at >= ? AND a.occurred_at <= ?
      AND (? IS NULL OR rm.wing_id = ?)
  `,
    )
    .get(from, to, wingId, wingId)
  const notes = db
    .prepare(
      `
    SELECT COUNT(*) AS total FROM care_notes n
    LEFT JOIN resident_bed_assignments a ON a.resident_id = n.resident_id AND a.ends_at IS NULL
    LEFT JOIN beds b ON b.id = a.bed_id
    LEFT JOIN rooms rm ON rm.id = b.room_id
    WHERE n.created_at >= ? AND n.created_at <= ? AND (? IS NULL OR rm.wing_id = ?)
  `,
    )
    .get(from, to, wingId, wingId)
  const byWing = db
    .prepare(
      `
    SELECT w.id AS wing_id, w.name AS wing_name, COUNT(r.id) AS rounds,
      SUM(CASE WHEN r.status = 'completed' THEN 1 ELSE 0 END) AS completed_rounds
    FROM wings w LEFT JOIN rounds r ON r.wing_id = w.id AND r.started_at >= ? AND r.started_at <= ?
    WHERE (? IS NULL OR w.id = ?) GROUP BY w.id ORDER BY w.sort_order, w.id
  `,
    )
    .all(from, to, wingId, wingId)
  const postureRows = db
    .prepare(
      `
    SELECT e.state, COUNT(*) AS observations
    FROM sensor_events e
    JOIN beds b ON b.id = e.bed_id
    JOIN rooms rm ON rm.id = b.room_id
    WHERE e.occurred_at >= ? AND e.occurred_at <= ?
      AND (? IS NULL OR rm.wing_id = ?)
    GROUP BY e.state ORDER BY observations DESC
  `,
    )
    .all(from, to, wingId, wingId)
  const currentRows = db
    .prepare(
      `
    SELECT cs.updated_at FROM current_bed_states cs
    JOIN beds b ON b.id = cs.bed_id
    JOIN rooms rm ON rm.id = b.room_id
    WHERE (? IS NULL OR rm.wing_id = ?)
  `,
    )
    .all(wingId, wingId)
  const freshness = currentRows.reduce((counts, row) => {
    const state = monitoringFreshness(row.updated_at)
    counts[state] = (counts[state] || 0) + 1
    return counts
  }, {})
  const taskTotal = tasks.total || 0
  return {
    period: { from, to, wing_id: wingId },
    rounds: { total: rounds.total || 0, completed: rounds.completed || 0, in_progress: rounds.in_progress || 0 },
    tasks: {
      total: taskTotal,
      completed: tasks.completed || 0,
      with_notes: tasks.with_notes || 0,
      completion_rate: taskTotal ? Math.round((tasks.completed / taskTotal) * 100) : 0,
    },
    alerts: {
      total: alerts.total || 0,
      open: alerts.open || 0,
      acknowledged: alerts.acknowledged || 0,
      resolved: alerts.resolved || 0,
      high: alerts.high || 0,
    },
    notes: { total: notes.total || 0 },
    posture: {
      observations: postureRows.reduce((total, row) => total + row.observations, 0),
      by_state: postureRows,
      current_freshness: freshness,
    },
    by_wing: byWing,
  }
}

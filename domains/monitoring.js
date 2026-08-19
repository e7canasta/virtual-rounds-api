/* Dominio de monitoreo: el tablero de un ala, el estado actual de un
 * residente, su secuencia de eventos y su linea de tiempo.
 *
 * La linea de tiempo mezcla cuatro fuentes (eventos de sensor, alertas,
 * tareas de ronda y notas) filtrando por lo que el usuario puede ver: recibe
 * las capacidades ya resueltas, no el objeto de sesion. */

import { monitoringFreshness, monitoringLabel } from '../policies.js'
import { db } from '../db.js'

function stringList(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string')
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []
  } catch {
    return []
  }
}

export function mergedTraits(...values) {
  return [...new Set(values.flatMap(stringList))]
}

export function board(wingId) {
  const wing = db.prepare('SELECT id, name, floor FROM wings WHERE id = ? AND active = 1').get(wingId)
  if (!wing) return null
  const rows = db
    .prepare(
      `
    SELECT
      r.id AS room_id, r.number AS room_number, r.stream_key,
       b.id AS bed_id, b.label AS bed_label, b.monitor_key,
       b.traits_json AS bed_traits_json,
       res.id AS resident_id, res.full_name,
       res.traits_json AS resident_traits_json,
       a.starts_at,
      (SELECT COUNT(*) FROM incidents i WHERE i.bed_id = b.id AND i.kind = 'fall') AS fall_count,
      cs.state AS current_state,
       cs.substate AS current_substate,
       cs.sleeping AS current_sleeping,
      cs.room_state AS current_room_state,
      cs.alert_level AS current_alert_level,
      cs.updated_at AS current_updated_at,
      cs.source AS current_source
    FROM rooms r
    JOIN beds b ON b.room_id = r.id AND b.active = 1
    LEFT JOIN resident_bed_assignments a ON a.bed_id = b.id AND a.ends_at IS NULL
    LEFT JOIN residents res ON res.id = a.resident_id AND res.status = 'active'
    LEFT JOIN current_bed_states cs ON cs.bed_id = b.id
    WHERE r.wing_id = ? AND r.active = 1
    ORDER BY r.number, b.id
  `,
    )
    .all(wingId)

  const rooms = []
  for (const row of rows) {
    let room = rooms.find((item) => item.id === row.room_id)
    if (!room) {
      room = { id: row.room_id, number: row.room_number, stream_key: row.stream_key || null, beds: [] }
      rooms.push(room)
    }
    const state = row.current_state || (row.resident_id ? 'unknown' : 'unoccupied')
    const freshness = monitoringFreshness(row.current_updated_at)
    room.beds.push({
      id: row.bed_id,
      label: row.bed_label,
      monitor_key: row.monitor_key,
      name: row.full_name || 'Cama libre',
      resident_id: row.resident_id,
      traits: mergedTraits(row.bed_traits_json, row.resident_traits_json),
      sleeping: Boolean(row.current_sleeping),
      falls: row.fall_count,
      state,
      alerts: row.current_alert_level || 'low',
      current_state: {
        state,
        room_state: row.current_room_state,
        substate: row.current_substate,
        sleeping: Boolean(row.current_sleeping),
        alert_level: row.current_alert_level || 'low',
        updated_at: row.current_updated_at || null,
        source: row.current_source || 'assignment',
        label: monitoringLabel(state, row.current_substate),
        freshness,
      },
      ...(row.starts_at ? { assigned_at: row.starts_at } : {}),
    })
  }
  return { wing, rooms }
}

export function currentStateView(current) {
  if (!current) return null
  return {
    ...current,
    room_state: current.room_state || null,
    sleeping: Boolean(current.sleeping),
    label: monitoringLabel(current.state, current.substate),
    freshness: monitoringFreshness(current.updated_at),
  }
}

export function residentEvents(residentId, { from = null, to = null, limit }) {
  return db
    .prepare(
      `SELECT id, bed_id, resident_id, monitor_key, kind, room_state, substate, state, alert_level, occurred_at, received_at
     FROM sensor_events
     WHERE resident_id = ? AND (? IS NULL OR occurred_at >= ?) AND (? IS NULL OR occurred_at <= ?)
     ORDER BY occurred_at DESC LIMIT ?`,
    )
    .all(residentId, from, from, to, to, limit)
    .map((event) => ({
      ...event,
      state_label: monitoringLabel(event.state, event.substate),
    }))
}

export function residentTimeline(residentId, from, to, capabilities) {
  const canSee = (permission) => capabilities.includes(permission)
  const timeline = []
  if (canSee('residents.live.read')) {
    const events = db
      .prepare(
        `
      SELECT id, kind, room_state, substate, state, alert_level, occurred_at
      FROM sensor_events
      WHERE resident_id = ? AND occurred_at >= ? AND occurred_at <= ?
      `,
      )
      .all(residentId, from, to)
    events.forEach((event) => {
      timeline.push({
        id: event.id,
        type: 'sensor_event',
        occurred_at: event.occurred_at,
        title: monitoringLabel(event.state, event.substate),
        detail: event.substate || event.kind,
        metadata: {
          kind: event.kind,
          room_state: event.room_state,
          state: event.state,
          substate: event.substate,
          alert_level: event.alert_level,
        },
      })
    })
  }
  if (canSee('alerts.read')) {
    const alerts = db
      .prepare(
        `
      SELECT id, kind, level, status, title, detail, occurred_at
      FROM alerts
      WHERE resident_id = ? AND occurred_at >= ? AND occurred_at <= ?
      `,
      )
      .all(residentId, from, to)
    alerts.forEach((alert) => {
      timeline.push({
        id: alert.id,
        type: 'alert',
        occurred_at: alert.occurred_at,
        title: alert.title,
        detail: alert.detail,
        metadata: { kind: alert.kind, level: alert.level, status: alert.status },
      })
    })
  }
  if (canSee('rounds.read')) {
    const tasks = db
      .prepare(
        `
      SELECT t.id, t.round_id, t.status, t.note,
        COALESCE(t.completed_at, t.created_at) AS occurred_at
      FROM round_tasks t
      WHERE t.resident_id = ?
        AND COALESCE(t.completed_at, t.created_at) >= ?
        AND COALESCE(t.completed_at, t.created_at) <= ?
      `,
      )
      .all(residentId, from, to)
    tasks.forEach((task) => {
      timeline.push({
        id: task.id,
        type: 'round_task',
        occurred_at: task.occurred_at,
        title: task.status === 'completed' ? 'Tarea de ronda completada' : 'Tarea de ronda pendiente',
        detail: task.note,
        metadata: { round_id: task.round_id, status: task.status },
      })
    })
  }
  if (canSee('residents.notes.read')) {
    const notes = db
      .prepare(
        `
      SELECT n.id, n.kind, n.body, n.created_at, u.display_name AS author_name
      FROM care_notes n JOIN users u ON u.id = n.author_id
      WHERE n.resident_id = ? AND n.created_at >= ? AND n.created_at <= ?
      `,
      )
      .all(residentId, from, to)
    notes.forEach((note) => {
      timeline.push({
        id: note.id,
        type: 'care_note',
        occurred_at: note.created_at,
        title: 'Nota de cuidado',
        detail: note.body,
        metadata: { kind: note.kind, author_name: note.author_name },
      })
    })
  }
  return timeline
    .sort((left, right) => {
      const dateOrder = new Date(right.occurred_at).valueOf() - new Date(left.occurred_at).valueOf()
      return dateOrder || right.id.localeCompare(left.id)
    })
    .slice(0, 500)
}

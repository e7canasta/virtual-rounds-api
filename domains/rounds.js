/* Dominio de rondas: la ronda activa de un ala, sus tareas y el historial.
 *
 * Reglas que viven aca:
 * - una ala tiene una sola ronda activa (crear otra devuelve la existente);
 * - una ronda no se puede cerrar con tareas pendientes;
 * - cerrar una tarea la marca con autor y momento; la ronda avanza su
 *   `updated_at`.
 *
 * Los permisos (auth y `can`) son de la plataforma y se resuelven en el
 * transporte: este modulo no sabe quien pidio. */

import { audit, newId, timestamp } from '../platform.js'
import { db } from '../db.js'

export function roundDetails(roundId) {
  const round = db
    .prepare(
      `
    SELECT r.id, r.wing_id, w.name AS wing_name, r.status, r.scheduled_for,
      r.started_at, r.completed_at, r.started_by, r.completed_by,
      u.display_name AS started_by_name
    FROM rounds r
    JOIN wings w ON w.id = r.wing_id
    JOIN users u ON u.id = r.started_by
    WHERE r.id = ?
  `,
    )
    .get(roundId)
  if (!round) return null
  const tasks = db
    .prepare(
      `
    SELECT t.id, t.round_id, t.resident_id, t.bed_id, t.status, t.note,
      t.completed_at, t.completed_by, res.full_name, b.label AS bed_label,
      rm.number AS room_number
    FROM round_tasks t
    JOIN residents res ON res.id = t.resident_id
    JOIN beds b ON b.id = t.bed_id
    JOIN rooms rm ON rm.id = b.room_id
    WHERE t.round_id = ?
    ORDER BY rm.number, b.id
  `,
    )
    .all(roundId)
  return { ...round, tasks }
}

export function activeRound(wingId) {
  const round = db
    .prepare(
      `
    SELECT id FROM rounds
    WHERE wing_id = ? AND status = 'in_progress'
    ORDER BY started_at DESC LIMIT 1
  `,
    )
    .get(wingId)
  return round ? roundDetails(round.id) : null
}

export function listRounds(wingId, limit) {
  return db
    .prepare(
      `
    SELECT r.id, r.wing_id, w.name AS wing_name, r.status, r.scheduled_for,
      r.started_at, r.completed_at, r.started_by, u.display_name AS started_by_name,
      COUNT(t.id) AS total_tasks,
      SUM(CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END) AS completed_tasks
    FROM rounds r
    JOIN wings w ON w.id = r.wing_id
    JOIN users u ON u.id = r.started_by
    LEFT JOIN round_tasks t ON t.round_id = r.id
    WHERE (? IS NULL OR r.wing_id = ?)
    GROUP BY r.id
    ORDER BY r.started_at DESC LIMIT ?
  `,
    )
    .all(wingId, wingId, limit)
}

export function createRound(wingId, userId) {
  const wing = db.prepare('SELECT id FROM wings WHERE id = ? AND active = 1').get(wingId)
  if (!wing) return { error: { status: 404, code: 'NOT_FOUND', message: 'Ala no encontrada' } }
  const existing = activeRound(wingId)
  if (existing) return existing
  const assignments = db
    .prepare(
      `
    SELECT a.resident_id, a.bed_id
    FROM resident_bed_assignments a
    JOIN beds b ON b.id = a.bed_id AND b.active = 1
    JOIN rooms rm ON rm.id = b.room_id AND rm.active = 1
    WHERE rm.wing_id = ? AND a.ends_at IS NULL
    ORDER BY rm.number, b.id
  `,
    )
    .all(wingId)
  if (!assignments.length)
    return { error: { status: 422, code: 'NO_RESIDENTS', message: 'No hay residentes asignados en esta ala' } }
  const roundId = newId('round')
  const startedAt = timestamp()
  db.transaction(() => {
    db.prepare(
      `INSERT INTO rounds
      (id, wing_id, status, started_at, started_by, created_at, updated_at)
      VALUES (?, ?, 'in_progress', ?, ?, ?, ?)`,
    ).run(roundId, wingId, startedAt, userId, startedAt, startedAt)
    const insert = db.prepare(`INSERT INTO round_tasks
      (id, round_id, resident_id, bed_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
    assignments.forEach(({ resident_id: residentId, bed_id: bedId }) => {
      insert.run(newId('round-task'), roundId, residentId, bedId, startedAt, startedAt)
    })
  })()
  audit(userId, 'round.started', 'round', roundId, { wing_id: wingId, task_count: assignments.length })
  return roundDetails(roundId)
}

export function completeRound(roundId, userId) {
  const round = db.prepare('SELECT id, status FROM rounds WHERE id = ?').get(roundId)
  if (!round) return { error: { status: 404, code: 'NOT_FOUND', message: 'Ronda no encontrada' } }
  if (round.status === 'completed') return { round: roundDetails(round.id) }
  const pending = db
    .prepare("SELECT COUNT(*) AS total FROM round_tasks WHERE round_id = ? AND status != 'completed'")
    .get(round.id).total
  if (pending > 0)
    return {
      error: {
        status: 409,
        code: 'ROUND_INCOMPLETE',
        message: 'Completa todas las tareas antes de finalizar la ronda',
        fields: { pending: String(pending) },
      },
    }
  const completedAt = timestamp()
  db.prepare(
    "UPDATE rounds SET status = 'completed', completed_at = ?, completed_by = ?, updated_at = ? WHERE id = ?",
  ).run(completedAt, userId, completedAt, round.id)
  audit(userId, 'round.completed', 'round', round.id)
  return { round: roundDetails(round.id) }
}

export function updateRoundTask(taskId, { status, note }, userId) {
  const task = db
    .prepare(
      `
    SELECT t.id, t.round_id, r.status AS round_status
    FROM round_tasks t JOIN rounds r ON r.id = t.round_id WHERE t.id = ?
  `,
    )
    .get(taskId)
  if (!task) return { error: { status: 404, code: 'NOT_FOUND', message: 'Tarea de ronda no encontrada' } }
  if (task.round_status === 'completed')
    return { error: { status: 409, code: 'ROUND_COMPLETED', message: 'No se puede modificar una ronda finalizada' } }
  const updatedAt = timestamp()
  const completedAt = status === 'completed' ? updatedAt : null
  const cleanNote = typeof note === 'string' ? note.trim().slice(0, 2000) || null : null
  db.prepare(
    `UPDATE round_tasks SET status = ?, note = ?, completed_at = ?, completed_by = ?, updated_at = ? WHERE id = ?`,
  ).run(status, cleanNote, completedAt, status === 'completed' ? userId : null, updatedAt, task.id)
  db.prepare('UPDATE rounds SET updated_at = ? WHERE id = ?').run(updatedAt, task.round_id)
  audit(userId, 'round-task.updated', 'round_task', task.id, { status, has_note: Boolean(cleanNote) })
  return {
    task: db
      .prepare(
        `
    SELECT t.id, t.round_id, t.resident_id, t.bed_id, t.status, t.note,
      t.completed_at, t.completed_by, res.full_name, b.label AS bed_label,
      rm.number AS room_number
    FROM round_tasks t
    JOIN residents res ON res.id = t.resident_id
    JOIN beds b ON b.id = t.bed_id
    JOIN rooms rm ON rm.id = b.room_id
    WHERE t.id = ?
  `,
      )
      .get(task.id),
  }
}

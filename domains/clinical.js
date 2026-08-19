/* Dominio clinico: residentes, incidentes, resúmenes diarios, notas de
 * cuidado y asignaciones de cama.
 *
 * Reglas que viven aca:
 * - un incidente ingesta una sola vez por `source_record_id` (duplicado
 *   devuelve la fila existente);
 * - los resúmenes validan coherencia interna (una noche no puede tener mas
 *   salidas que despertares, las visitas nocturnas no superan el total, ...);
 * - al liberar una cama se borra su proyeccion de estado, para que el
 *   ocupante siguiente no herede el estado de quien se fue;
 * - `safe_to_ground` no cuenta como caida aunque haya tocado el piso.
 *
 * Los permisos (auth y `can`) son de la plataforma y se resuelven en el
 * transporte: este modulo no sabe quien pidio. La ingesta clinica solo
 * conoce el secreto compartido, que se valida antes de entrar. */

import { audit, newId, timestamp } from '../platform.js'
import { db } from '../db.js'
import { currentStateView } from './monitoring.js'
import { monitoringLabel } from '../policies.js'

export const INCIDENT_KINDS = new Set(['fall', 'bed_exit', 'wandering', 'transfer', 'other'])
export const INCIDENT_SEVERITIES = new Set(['low', 'medium', 'high', 'critical'])
export const INCIDENT_STATUSES = new Set(['open', 'under_review', 'closed'])
export const INJURY_STATUSES = new Set(['unknown', 'none', 'minor', 'serious'])

/* Veredicto de deteccion: lo que el equipo confirma que realmente paso.
 * `safe_to_ground` es un descenso controlado — el residente llego al piso sin
 * caerse — y por eso no cuenta como caida aunque haya tocado el piso. */
const DETECTION_VERDICTS = new Set(['fall', 'not_a_fall', 'uncertain', 'safe_to_ground'])

/* Estados en los que el residente esta en el piso. Definirlo una sola vez
 * evita que la revision y el motor de alarmas discrepen sobre que es "estar
 * en el piso". */
const FLOOR_STATES = new Set(['laying_on_floor', 'sitting_on_floor', 'kneeling'])

function hasField(payload, field) {
  return Object.prototype.hasOwnProperty.call(payload, field)
}

function requireFields(payload, fields) {
  const missing = Object.fromEntries(
    fields
      .filter((field) => typeof payload[field] !== 'string' || !payload[field].trim())
      .map((field) => [field, 'required']),
  )
  return Object.keys(missing).length ? missing : null
}

export function validDate(value) {
  return typeof value === 'string' && !Number.isNaN(new Date(value).valueOf())
}

function validDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
}

function validNonNegativeInteger(value, max) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max
}

function optionalClinicalText(value, max) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') return undefined
  return value.trim().slice(0, max) || null
}

function clinicalSourceMetadata(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return { error: { status: 422, code: 'VALIDATION_ERROR', message: 'El body debe ser un objeto JSON' } }
  if (typeof payload.source_record_id !== 'string' || !payload.source_record_id.trim())
    return { error: { status: 422, code: 'VALIDATION_ERROR', message: 'source_record_id es obligatorio' } }
  const source = payload.source || 'ai'
  if (source !== 'ai') return { error: { status: 422, code: 'VALIDATION_ERROR', message: 'source debe ser ai' } }
  if (typeof payload.model_version !== 'string' || !payload.model_version.trim())
    return { error: { status: 422, code: 'VALIDATION_ERROR', message: 'model_version es obligatorio' } }
  if (
    payload.confidence !== undefined &&
    (typeof payload.confidence !== 'number' || payload.confidence < 0 || payload.confidence > 1)
  )
    return { error: { status: 422, code: 'VALIDATION_ERROR', message: 'confidence debe estar entre 0 y 1' } }
  const provenance = payload.provenance === undefined ? {} : payload.provenance
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance))
    return { error: { status: 422, code: 'VALIDATION_ERROR', message: 'provenance debe ser un objeto' } }
  return {
    sourceRecordId: payload.source_record_id.trim().slice(0, 180),
    source,
    modelVersion: payload.model_version.trim().slice(0, 120),
    confidence: payload.confidence ?? null,
    provenanceJson: JSON.stringify(provenance),
  }
}

/* Cuando cambia quien ocupa una cama, lo ultimo que proyecto esa cama dejo de
 * hablar de quien la ocupa ahora. `current_bed_states` es una proyeccion
 * reconstruible desde `sensor_events`, asi que borrarla no pierde nada: el
 * proximo evento del monitor la vuelve a escribir.
 *
 * Sin esto, una cama liberada sigue mostrando el estado -- y el nivel de alerta
 * -- de quien se fue, y quien llega a una cama usada hereda el estado del
 * ocupante anterior. Con el detector apagado o la cama sin monitor, ese estado
 * viejo no se corrige nunca. */
function clearBedProjection(bedIds) {
  const unique = [...new Set(bedIds.filter(Boolean))]
  if (!unique.length) return
  const statement = db.prepare('DELETE FROM current_bed_states WHERE bed_id = ?')
  for (const bedId of unique) statement.run(bedId)
}

function incidentView(row) {
  return {
    id: row.id,
    source_record_id: row.source_record_id,
    resident_id: row.resident_id,
    bed_id: row.bed_id,
    source_alert_id: row.source_alert_id,
    kind: row.kind,
    severity: row.severity,
    status: row.status,
    occurred_at: row.occurred_at,
    location: row.location,
    activity: row.activity,
    injury_status: row.injury_status,
    self_recovery: row.self_recovery === null ? null : Boolean(row.self_recovery),
    response_seconds: row.response_seconds,
    narrative: row.narrative,
    interventions: JSON.parse(row.interventions_json || '[]'),
    source: row.source,
    model_version: row.model_version,
    confidence: row.confidence,
    detection_verdict: row.detection_verdict ?? null,
    verdict_by: row.verdict_by ?? null,
    verdict_by_name: row.verdict_by_name || null,
    verdict_at: row.verdict_at ?? null,
    review_note: row.review_note,
    reviewed_by: row.reviewed_by,
    reviewed_by_name: row.reviewed_by_name || null,
    reviewed_at: row.reviewed_at,
    resolved_at: row.resolved_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function sleepSummaryView(row) {
  const sleepMinutes = row.calm_minutes + row.restless_minutes
  const inBedMinutes = sleepMinutes + row.awake_minutes
  return {
    id: row.id,
    source_record_id: row.source_record_id,
    resident_id: row.resident_id,
    observed_on: row.observed_on,
    sleep_started_at: row.sleep_started_at,
    sleep_ended_at: row.sleep_ended_at,
    calm_minutes: row.calm_minutes,
    restless_minutes: row.restless_minutes,
    awake_minutes: row.awake_minutes,
    out_of_bed_minutes: row.out_of_bed_minutes,
    bed_exit_count: row.bed_exit_count,
    wake_count: row.wake_count ?? null,
    total_sleep_minutes: sleepMinutes,
    time_in_bed_minutes: inBedMinutes,
    sleep_efficiency: inBedMinutes ? Math.round((sleepMinutes / inBedMinutes) * 100) : null,
    source: row.source,
    model_version: row.model_version,
    confidence: row.confidence,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function mobilitySummaryView(row) {
  return {
    id: row.id,
    source_record_id: row.source_record_id,
    resident_id: row.resident_id,
    observed_on: row.observed_on,
    in_bed_minutes: row.in_bed_minutes,
    out_of_bed_minutes: row.out_of_bed_minutes,
    out_of_sight_minutes: row.out_of_sight_minutes,
    walking_minutes: row.walking_minutes,
    walking_distance_meters: row.walking_distance_meters,
    walking_speed_mps: row.walking_speed_mps,
    transfer_count: row.transfer_count,
    observed_minutes: row.in_bed_minutes + row.out_of_bed_minutes + row.out_of_sight_minutes,
    source: row.source,
    model_version: row.model_version,
    confidence: row.confidence,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

/* Uso del bano: visitas diarias, franja nocturna y asistencia registrada.
 * Las derivadas (diurnas, promedio por visita) se calculan aca y no se
 * persisten, igual que en sueño y movilidad. */
function bathroomSummaryView(row) {
  return {
    id: row.id,
    source_record_id: row.source_record_id,
    resident_id: row.resident_id,
    observed_on: row.observed_on,
    visit_count: row.visit_count,
    night_visit_count: row.night_visit_count,
    day_visit_count: Math.max(0, row.visit_count - row.night_visit_count),
    assisted_count: row.assisted_count,
    total_minutes: row.total_minutes,
    longest_visit_minutes: row.longest_visit_minutes,
    avg_visit_minutes: row.visit_count ? Math.round(row.total_minutes / row.visit_count) : null,
    source: row.source,
    model_version: row.model_version,
    confidence: row.confidence,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export function listResidents(query = '') {
  return db
    .prepare(
      `
    SELECT r.id, r.external_id, r.full_name, r.birth_date, r.admission_date, r.status,
      a.bed_id, b.label AS bed_label, rm.number AS room_number,
      w.id AS wing_id, w.name AS wing_name,
       cs.state AS current_state, cs.substate AS current_substate,
       cs.room_state AS current_room_state,
       cs.sleeping AS current_sleeping,
       cs.alert_level AS current_alert_level, cs.updated_at AS current_updated_at,
      cs.source AS current_source,
      (SELECT COUNT(*) FROM incidents i
         WHERE i.resident_id = r.id AND i.kind = 'fall'
           AND i.occurred_at >= datetime('now', '-30 days')) AS open_falls
    FROM residents r
    LEFT JOIN resident_bed_assignments a ON a.resident_id = r.id AND a.ends_at IS NULL
    LEFT JOIN beds b ON b.id = a.bed_id AND b.active = 1
    LEFT JOIN rooms rm ON rm.id = b.room_id AND rm.active = 1
    LEFT JOIN wings w ON w.id = rm.wing_id AND w.active = 1
    LEFT JOIN current_bed_states cs ON cs.bed_id = a.bed_id
    WHERE r.status = 'active' AND r.full_name LIKE ?
    ORDER BY r.full_name
  `,
    )
    .all(`%${query}%`)
    .map((resident) => ({
      id: resident.id,
      external_id: resident.external_id,
      full_name: resident.full_name,
      birth_date: resident.birth_date,
      admission_date: resident.admission_date,
      status: resident.status,
      bed_id: resident.bed_id,
      bed_label: resident.bed_label,
      room_number: resident.room_number,
      wing_id: resident.wing_id,
      wing_name: resident.wing_name,
      /* Caidas de los ultimos 30 dias: el panel filtra la lista por
       * seguridad sin tener que pedir los incidentes de cada residente. */
      recent_falls: resident.open_falls ?? 0,
      current_state: resident.current_state
        ? currentStateView({
            bed_id: resident.bed_id,
            state: resident.current_state,
            room_state: resident.current_room_state,
            substate: resident.current_substate,
            sleeping: Boolean(resident.current_sleeping),
            alert_level: resident.current_alert_level,
            updated_at: resident.current_updated_at,
            source: resident.current_source,
            bed_label: resident.bed_label,
            room_number: resident.room_number,
            wing_id: resident.wing_id,
            wing_name: resident.wing_name,
          })
        : null,
    }))
}

export function residentIncidents(residentId, { status = 'all', from = null, to = null, limit = 100 } = {}) {
  if (status !== 'all' && !INCIDENT_STATUSES.has(status))
    return {
      error: { status: 422, code: 'VALIDATION_ERROR', message: 'status no es valido', fields: { status: 'invalid' } },
    }
  if ((from && !validDate(from)) || (to && !validDate(to)))
    return { error: { status: 422, code: 'INVALID_DATE', message: 'from y to deben ser fechas validas' } }
  if (from && to && new Date(from) > new Date(to))
    return { error: { status: 422, code: 'INVALID_DATE', message: 'from no puede ser posterior a to' } }
  const incidents = db
    .prepare(
      `SELECT i.*, u.display_name AS reviewed_by_name, v.display_name AS verdict_by_name
       FROM incidents i
       LEFT JOIN users u ON u.id = i.reviewed_by
       LEFT JOIN users v ON v.id = i.verdict_by
       WHERE i.resident_id = ? AND i.status LIKE ?
         AND (? IS NULL OR i.occurred_at >= ?) AND (? IS NULL OR i.occurred_at <= ?)
       ORDER BY i.occurred_at DESC, i.rowid DESC LIMIT ?`,
    )
    .all(residentId, status === 'all' ? '%' : status, from, from, to, to, Math.min(Number(limit) || 100, 500))
    .map(incidentView)
  return { incidents }
}

function periodRange({ from = null, to = null } = {}) {
  const today = new Date().toISOString().slice(0, 10)
  const start = from || new Date(Date.now() - 13 * 86400000).toISOString().slice(0, 10)
  const end = to || today
  if (!validDateOnly(start) || !validDateOnly(end))
    return { error: { status: 422, code: 'INVALID_DATE', message: 'from y to deben tener formato YYYY-MM-DD' } }
  if (start > end) return { error: { status: 422, code: 'INVALID_DATE', message: 'from no puede ser posterior a to' } }
  return { from: start, to: end }
}

export function residentSleep(residentId, range = {}) {
  const period = periodRange(range)
  if (period.error) return period
  const summaries = db
    .prepare(
      `SELECT * FROM sleep_summaries
       WHERE resident_id = ? AND observed_on >= ? AND observed_on <= ?
       ORDER BY observed_on DESC LIMIT 366`,
    )
    .all(residentId, period.from, period.to)
    .map(sleepSummaryView)
  return { period, summaries }
}

export function residentMobility(residentId, range = {}) {
  const period = periodRange(range)
  if (period.error) return period
  const summaries = db
    .prepare(
      `SELECT * FROM mobility_summaries
       WHERE resident_id = ? AND observed_on >= ? AND observed_on <= ?
       ORDER BY observed_on DESC LIMIT 366`,
    )
    .all(residentId, period.from, period.to)
    .map(mobilitySummaryView)
  return { period, summaries }
}

export function residentBathroom(residentId, range = {}) {
  const period = periodRange(range)
  if (period.error) return period
  const summaries = db
    .prepare(
      `SELECT * FROM bathroom_summaries
       WHERE resident_id = ? AND observed_on >= ? AND observed_on <= ?
       ORDER BY observed_on DESC LIMIT 366`,
    )
    .all(residentId, period.from, period.to)
    .map(bathroomSummaryView)
  return { period, summaries }
}

export function residentCare(residentId, { days = 7 } = {}) {
  const totalDays = Math.min(90, Math.max(1, Number(days) || 7))
  const since = new Date(Date.now() - totalDays * 86400000).toISOString()
  /* Actividad de cuidado: metadatos, nunca el cuerpo de la nota. La
   * lectura clinica del texto sigue detras de `residents.notes.read`;
   * esta vista solo necesita tipo, momento, duracion y autor. */
  const notes = db
    .prepare(
      `SELECT n.id, n.kind, n.created_at, n.duration_minutes, n.author_id, u.display_name AS author_name
       FROM care_notes n
       LEFT JOIN users u ON u.id = n.author_id
       WHERE n.resident_id = ? AND n.created_at >= ?
       ORDER BY n.created_at ASC LIMIT 2000`,
    )
    .all(residentId, since)
  /* Proactivo = sin alerta del residente en la ventana previa. Es una
   * derivacion de datos que ya existen, no un campo que alguien carga. */
  const reactiveWindowMs = 30 * 60 * 1000
  const alerts = db
    .prepare(
      `SELECT occurred_at FROM alerts
       WHERE resident_id = ? AND occurred_at >= ?
       ORDER BY occurred_at ASC LIMIT 2000`,
    )
    .all(residentId, new Date(Date.now() - (totalDays * 86400000 + reactiveWindowMs)).toISOString())
    .map((row) => new Date(row.occurred_at).valueOf())
  const events = notes.map((note) => {
    const at = new Date(note.created_at).valueOf()
    const precededByAlert = alerts.some((alertAt) => alertAt <= at && at - alertAt <= reactiveWindowMs)
    return {
      id: note.id,
      kind: note.kind,
      occurred_at: note.created_at,
      duration_minutes: note.duration_minutes ?? null,
      author_id: note.author_id,
      author_name: note.author_name ?? null,
      proactive: !precededByAlert,
    }
  })
  /* Visitas de staff: las tareas de ronda completadas cuentan como
   * atencion aunque no dejen nota. */
  const roundVisits = db
    .prepare(
      `SELECT COUNT(*) AS total FROM round_tasks
       WHERE resident_id = ? AND status = 'completed' AND completed_at >= ?`,
    )
    .get(residentId, since)
  return {
    period: { from: since, to: new Date().toISOString(), days: totalDays },
    events,
    round_visits: roundVisits?.total ?? 0,
  }
}

export function residentAssignments(residentId) {
  const assignments = db
    .prepare(
      `
    SELECT a.id, a.resident_id, a.bed_id, a.starts_at, a.ends_at,
      b.label AS bed_label, rm.id AS room_id, rm.number AS room_number,
      w.id AS wing_id, w.name AS wing_name
    FROM resident_bed_assignments a
    JOIN beds b ON b.id = a.bed_id
    JOIN rooms rm ON rm.id = b.room_id
    JOIN wings w ON w.id = rm.wing_id
    WHERE a.resident_id = ? ORDER BY a.starts_at DESC
  `,
    )
    .all(residentId)
  return { assignments }
}

export function residentNotes(residentId, limit = 50) {
  const notes = db
    .prepare(
      `
    SELECT n.id, n.resident_id, n.kind, n.body, n.created_at, n.updated_at,
      u.id AS author_id, u.display_name AS author_name
    FROM care_notes n JOIN users u ON u.id = n.author_id
    WHERE n.resident_id = ? ORDER BY n.created_at DESC LIMIT ?
  `,
    )
    .all(residentId, Math.min(Number(limit) || 50, 200))
  return { notes }
}

/* Reconstruccion de un incidente: la secuencia de estados que lo rodea y
 * las dos medidas que salen de ella. Es lo que hace revisable un evento —
 * sin la secuencia, un incidente es una fila que afirma que algo paso.
 *
 * Va en su propio endpoint y no dentro del listado: solo se pide cuando
 * alguien abre la revision, y son ~7 eventos por incidente. */
export function incidentSequence(incidentId, { before = 15, after = 30 } = {}) {
  const incident = db.prepare('SELECT * FROM incidents WHERE id = ?').get(incidentId)
  if (!incident) return { error: { status: 404, code: 'NOT_FOUND', message: 'Incidente no encontrado' } }
  if (!incident.occurred_at)
    return { error: { status: 422, code: 'INVALID_STATE', message: 'El incidente no tiene momento registrado' } }

  const beforeMinutes = Math.min(60, Math.max(1, Number(before) || 15))
  const afterMinutes = Math.min(180, Math.max(1, Number(after) || 30))
  const at = new Date(incident.occurred_at).valueOf()
  const from = new Date(at - beforeMinutes * 60000).toISOString()
  const to = new Date(at + afterMinutes * 60000).toISOString()

  const rows = db
    .prepare(
      `SELECT id, occurred_at, room_state, substate, state, alert_level
       FROM sensor_events
       WHERE resident_id = ? AND kind = 'state_change'
         AND occurred_at >= ? AND occurred_at <= ?
       ORDER BY occurred_at ASC LIMIT 200`,
    )
    .all(incident.resident_id, from, to)

  const events = rows.map((row) => ({
    id: row.id,
    occurred_at: row.occurred_at,
    state: row.state,
    state_label: monitoringLabel(row.state, row.substate),
    room_state: row.room_state,
    substate: row.substate,
    alert_level: row.alert_level,
    on_floor: FLOOR_STATES.has(row.state),
    /* `assisted` es la unica marca de presencia de personal que el sensor
     * produce: cierra el tiempo en el piso. */
    staff_present: row.room_state === 'assisted',
    offset_seconds: Math.round((new Date(row.occurred_at).valueOf() - at) / 1000),
  }))

  const firstFloor = events.find((event) => event.on_floor)
  const staffArrival = events.find((event) => event.staff_present && new Date(event.occurred_at).valueOf() >= at)
  /* El tiempo en el piso se cierra con el primer estado que ya no es de
   * piso. Si la secuencia termina con el residente todavia en el piso, no
   * se completa: el dato queda abierto en vez de inventar un final. */
  let timeOnFloorSeconds = null
  if (firstFloor) {
    const floorStart = new Date(firstFloor.occurred_at).valueOf()
    const recovery = events.find((event) => !event.on_floor && new Date(event.occurred_at).valueOf() > floorStart)
    if (recovery) timeOnFloorSeconds = Math.round((new Date(recovery.occurred_at).valueOf() - floorStart) / 1000)
  }

  return {
    incident_id: incident.id,
    occurred_at: incident.occurred_at,
    window: { from, to, before_minutes: beforeMinutes, after_minutes: afterMinutes },
    events,
    derived: {
      time_on_floor_seconds: timeOnFloorSeconds,
      reached_floor: Boolean(firstFloor),
      staff_arrival_at: staffArrival?.occurred_at ?? null,
      staff_arrival_seconds: staffArrival
        ? Math.round((new Date(staffArrival.occurred_at).valueOf() - at) / 1000)
        : null,
      response_seconds: incident.response_seconds ?? null,
    },
  }
}

export function reviewIncident(incidentId, payload, userId) {
  const incident = db.prepare('SELECT * FROM incidents WHERE id = ?').get(incidentId)
  if (!incident) return { error: { status: 404, code: 'NOT_FOUND', message: 'Incidente no encontrado' } }
  const updates = []
  const values = []
  const nextStatus = payload.status === undefined ? incident.status : payload.status
  if (payload.status !== undefined) {
    if (!INCIDENT_STATUSES.has(payload.status))
      return {
        error: { status: 422, code: 'VALIDATION_ERROR', message: 'status no es valido', fields: { status: 'invalid' } },
      }
    updates.push('status = ?')
    values.push(payload.status)
  }
  if (payload.severity !== undefined) {
    if (!INCIDENT_SEVERITIES.has(payload.severity))
      return {
        error: {
          status: 422,
          code: 'VALIDATION_ERROR',
          message: 'severity no es valida',
          fields: { severity: 'invalid' },
        },
      }
    updates.push('severity = ?')
    values.push(payload.severity)
  }
  if (payload.injury_status !== undefined) {
    if (!INJURY_STATUSES.has(payload.injury_status))
      return {
        error: {
          status: 422,
          code: 'VALIDATION_ERROR',
          message: 'injury_status no es valido',
          fields: { injury_status: 'invalid' },
        },
      }
    updates.push('injury_status = ?')
    values.push(payload.injury_status)
  }
  if (payload.detection_verdict !== undefined) {
    /* null revierte a pendiente: permite deshacer una clasificacion sin
     * tener que inventar un valor. */
    if (payload.detection_verdict !== null && !DETECTION_VERDICTS.has(payload.detection_verdict))
      return {
        error: {
          status: 422,
          code: 'VALIDATION_ERROR',
          message: 'detection_verdict no es valido',
          fields: { detection_verdict: 'invalid' },
        },
      }
    updates.push('detection_verdict = ?', 'verdict_by = ?', 'verdict_at = ?')
    values.push(
      payload.detection_verdict,
      payload.detection_verdict === null ? null : userId,
      payload.detection_verdict === null ? null : timestamp(),
    )
  }
  if (payload.review_note !== undefined) {
    if (payload.review_note !== null && typeof payload.review_note !== 'string')
      return {
        error: {
          status: 422,
          code: 'VALIDATION_ERROR',
          message: 'review_note debe ser texto o null',
          fields: { review_note: 'invalid' },
        },
      }
    updates.push('review_note = ?')
    values.push(typeof payload.review_note === 'string' ? payload.review_note.trim().slice(0, 5000) || null : null)
  }
  if (payload.narrative !== undefined) {
    if (payload.narrative !== null && typeof payload.narrative !== 'string')
      return {
        error: {
          status: 422,
          code: 'VALIDATION_ERROR',
          message: 'narrative debe ser texto o null',
          fields: { narrative: 'invalid' },
        },
      }
    updates.push('narrative = ?')
    values.push(typeof payload.narrative === 'string' ? payload.narrative.trim().slice(0, 5000) || null : null)
  }
  if (payload.interventions !== undefined) {
    if (!Array.isArray(payload.interventions) || payload.interventions.some((item) => typeof item !== 'string'))
      return {
        error: {
          status: 422,
          code: 'VALIDATION_ERROR',
          message: 'interventions debe ser una lista de textos',
        },
      }
    updates.push('interventions_json = ?')
    values.push(JSON.stringify(payload.interventions.slice(0, 20).map((item) => item.trim().slice(0, 240))))
  }
  if (!updates.length)
    return { error: { status: 422, code: 'VALIDATION_ERROR', message: 'No hay campos para revisar' } }
  const reviewedAt = timestamp()
  const resolvedAt =
    nextStatus === 'closed' ? incident.resolved_at || reviewedAt : payload.status ? null : incident.resolved_at
  updates.push('reviewed_by = ?', 'reviewed_at = ?', 'resolved_at = ?', 'updated_at = ?')
  values.push(userId, reviewedAt, resolvedAt, reviewedAt, incident.id)
  db.prepare(`UPDATE incidents SET ${updates.join(', ')} WHERE id = ?`).run(...values)
  audit(userId, 'incident.reviewed', 'incident', incident.id, {
    status: nextStatus,
    fields: updates
      .map((field) => field.split(' ')[0])
      .filter((field) => !['reviewed_by', 'reviewed_at', 'resolved_at', 'updated_at'].includes(field)),
  })
  const updated = db
    .prepare(
      `SELECT i.*, u.display_name AS reviewed_by_name, v.display_name AS verdict_by_name
       FROM incidents i
       LEFT JOIN users u ON u.id = i.reviewed_by
       LEFT JOIN users v ON v.id = i.verdict_by
       WHERE i.id = ?`,
    )
    .get(incident.id)
  return { incident: incidentView(updated) }
}

export function createResident(payload, userId) {
  const fields = requireFields(payload, ['full_name'])
  if (fields) return { error: { status: 422, code: 'VALIDATION_ERROR', message: 'Faltan campos obligatorios', fields } }
  if (typeof payload.full_name !== 'string' || !payload.full_name.trim())
    return {
      error: {
        status: 422,
        code: 'VALIDATION_ERROR',
        message: 'full_name debe ser un texto no vacio',
        fields: { full_name: 'invalid' },
      },
    }
  if (hasField(payload, 'external_id') && payload.external_id !== null && typeof payload.external_id !== 'string')
    return {
      error: {
        status: 422,
        code: 'VALIDATION_ERROR',
        message: 'external_id debe ser texto o null',
        fields: { external_id: 'invalid' },
      },
    }
  /* Las fechas se validan igual que en el PATCH: sin esto el alta acepta
   * "ayer" y lo guarda tal cual, y la ficha muestra una edad imposible. */
  for (const field of ['birth_date', 'admission_date']) {
    if (!hasField(payload, field) || payload[field] === null || payload[field] === '') continue
    if (!validDate(payload[field]))
      return {
        error: {
          status: 422,
          code: 'INVALID_DATE',
          message: `${field} no es una fecha valida`,
          fields: { [field]: 'invalid' },
        },
      }
  }
  const dateOnly = (value) => (value ? new Date(value).toISOString().slice(0, 10) : null)
  const record = {
    id: newId('resident'),
    external_id:
      typeof payload.external_id === 'string' && payload.external_id.trim()
        ? payload.external_id.trim().slice(0, 120)
        : null,
    full_name: payload.full_name.trim().slice(0, 160),
    birth_date: dateOnly(payload.birth_date),
    admission_date: dateOnly(payload.admission_date),
    /* Un residente nace activo. El egreso es otro acto, con su endpoint y su
     * auditoria: no se llega a `discharged` por un campo del alta. */
    status: 'active',
  }
  db.prepare(
    'INSERT INTO residents (id, external_id, full_name, birth_date, admission_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    record.id,
    record.external_id,
    record.full_name,
    record.birth_date,
    record.admission_date,
    record.status,
    timestamp(),
  )
  /* Dar de alta a una persona es la mutacion mas importante del contexto y
   * era la unica del vecindario que no dejaba rastro. */
  audit(userId, 'resident.created', 'resident', record.id, {
    full_name: record.full_name,
    external_id: record.external_id,
  })
  return record
}

export function updateResident(residentId, payload, userId) {
  const resident = db
    .prepare('SELECT id, external_id, full_name, birth_date, admission_date, status FROM residents WHERE id = ?')
    .get(residentId)
  if (!resident) return { error: { status: 404, code: 'NOT_FOUND', message: 'Residente no encontrado' } }
  const updates = []
  const values = []
  if (hasField(payload, 'full_name')) {
    if (typeof payload.full_name !== 'string' || !payload.full_name.trim())
      return {
        error: {
          status: 422,
          code: 'VALIDATION_ERROR',
          message: 'full_name debe ser un texto no vacio',
          fields: { full_name: 'invalid' },
        },
      }
    updates.push('full_name = ?')
    values.push(payload.full_name.trim().slice(0, 160))
  }
  if (hasField(payload, 'external_id')) {
    if (payload.external_id !== null && (typeof payload.external_id !== 'string' || !payload.external_id.trim()))
      return {
        error: {
          status: 422,
          code: 'VALIDATION_ERROR',
          message: 'external_id debe ser texto o null',
          fields: { external_id: 'invalid' },
        },
      }
    updates.push('external_id = ?')
    values.push(typeof payload.external_id === 'string' ? payload.external_id.trim().slice(0, 120) : null)
  }
  for (const field of ['birth_date', 'admission_date']) {
    if (!hasField(payload, field)) continue
    if (payload[field] !== null && (!validDate(payload[field]) || typeof payload[field] !== 'string'))
      return {
        error: {
          status: 422,
          code: 'INVALID_DATE',
          message: `${field} no es una fecha valida`,
          fields: { [field]: 'invalid' },
        },
      }
    updates.push(`${field} = ?`)
    values.push(payload[field] ? new Date(payload[field]).toISOString().slice(0, 10) : null)
  }
  if (!updates.length)
    return { error: { status: 422, code: 'VALIDATION_ERROR', message: 'No hay campos para actualizar' } }
  values.push(resident.id)
  db.prepare(`UPDATE residents SET ${updates.join(', ')} WHERE id = ?`).run(...values)
  audit(userId, 'resident.updated', 'resident', resident.id, {
    fields: updates.map((field) => field.split(' ')[0]),
  })
  return {
    resident: db
      .prepare('SELECT id, external_id, full_name, birth_date, admission_date, status FROM residents WHERE id = ?')
      .get(resident.id),
  }
}

export function dischargeResident(residentId, { ended_at } = {}, userId) {
  const resident = db
    .prepare('SELECT id, external_id, full_name, birth_date, admission_date, status FROM residents WHERE id = ?')
    .get(residentId)
  if (!resident) return { error: { status: 404, code: 'NOT_FOUND', message: 'Residente no encontrado' } }
  if (resident.status !== 'active') return { resident, assignments_closed: 0 }
  const endedAt = ended_at || timestamp()
  if (!validDate(endedAt))
    return { error: { status: 422, code: 'INVALID_DATE', message: 'ended_at no es una fecha valida' } }
  const normalizedEndedAt = new Date(endedAt).toISOString()
  const assignmentsClosed = db.transaction(() => {
    const freed = db
      .prepare('SELECT bed_id FROM resident_bed_assignments WHERE resident_id = ? AND ends_at IS NULL')
      .all(resident.id)
    const result = db
      .prepare('UPDATE resident_bed_assignments SET ends_at = ? WHERE resident_id = ? AND ends_at IS NULL')
      .run(normalizedEndedAt, resident.id)
    db.prepare("UPDATE residents SET status = 'discharged' WHERE id = ?").run(resident.id)
    clearBedProjection(freed.map((row) => row.bed_id))
    return result.changes
  })()
  audit(userId, 'resident.discharged', 'resident', resident.id, {
    ended_at: normalizedEndedAt,
    assignments_closed: assignmentsClosed,
  })
  return {
    resident: db
      .prepare('SELECT id, external_id, full_name, birth_date, admission_date, status FROM residents WHERE id = ?')
      .get(resident.id),
    assignments_closed: assignmentsClosed,
  }
}

export function createCareNote(residentId, payload, userId) {
  const resident = db.prepare("SELECT id FROM residents WHERE id = ? AND status = 'active'").get(residentId)
  if (!resident) return { error: { status: 404, code: 'NOT_FOUND', message: 'Residente no encontrado' } }
  const fields = requireFields(payload, ['body'])
  if (fields) return { error: { status: 422, code: 'VALIDATION_ERROR', message: 'Faltan campos obligatorios', fields } }
  const record = {
    id: newId('note'),
    resident_id: resident.id,
    author_id: userId,
    kind: typeof payload.kind === 'string' && payload.kind.trim() ? payload.kind.trim().slice(0, 40) : 'general',
    body: payload.body.trim().slice(0, 5000),
    created_at: timestamp(),
  }
  db.prepare(
    `INSERT INTO care_notes (id, resident_id, author_id, kind, body, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(record.id, record.resident_id, record.author_id, record.kind, record.body, record.created_at, record.created_at)
  audit(userId, 'care-note.created', 'care_note', record.id, {
    resident_id: record.resident_id,
    kind: record.kind,
  })
  return { note: record }
}

export function assignBed(residentId, payload, userId) {
  const fields = requireFields(payload, ['bed_id', 'starts_at'])
  if (fields) return { error: { status: 422, code: 'VALIDATION_ERROR', message: 'Faltan campos obligatorios', fields } }
  if (!db.prepare("SELECT id FROM residents WHERE id = ? AND status = 'active'").get(residentId))
    return { error: { status: 404, code: 'NOT_FOUND', message: 'Residente no encontrado' } }
  if (!db.prepare('SELECT id FROM beds WHERE id = ? AND active = 1').get(payload.bed_id))
    return { error: { status: 404, code: 'NOT_FOUND', message: 'Cama no encontrada' } }
  const assignment = {
    id: newId('assignment'),
    resident_id: residentId,
    bed_id: payload.bed_id,
    starts_at: payload.starts_at,
  }
  const assign = db.transaction(() => {
    db.prepare('UPDATE resident_bed_assignments SET ends_at = ? WHERE bed_id = ? AND ends_at IS NULL').run(
      assignment.starts_at,
      assignment.bed_id,
    )
    /* La cama que el residente deja tambien pierde su proyeccion: mudarse es
     * un cambio de ocupante en dos camas, no en una. */
    const previous = db
      .prepare('SELECT bed_id FROM resident_bed_assignments WHERE resident_id = ? AND ends_at IS NULL')
      .all(assignment.resident_id)
    db.prepare('UPDATE resident_bed_assignments SET ends_at = ? WHERE resident_id = ? AND ends_at IS NULL').run(
      assignment.starts_at,
      assignment.resident_id,
    )
    db.prepare(
      'INSERT INTO resident_bed_assignments (id, resident_id, bed_id, starts_at, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(assignment.id, assignment.resident_id, assignment.bed_id, assignment.starts_at, timestamp())
    clearBedProjection([assignment.bed_id, ...previous.map((row) => row.bed_id)])
  })
  assign()
  audit(userId, 'resident.assignment.created', 'assignment', assignment.id, {
    resident_id: assignment.resident_id,
    bed_id: assignment.bed_id,
  })
  return assignment
}

/* Liberar una cama sin dar de alta al residente. Hasta ahora la unica forma
 * de vaciarla era el egreso, que es otra cosa: una cama queda libre cuando
 * alguien se muda de habitacion o mientras se decide donde ubicarlo, y el
 * residente sigue en la casa. */
export function releaseBed(bedId, userId) {
  const bed = db.prepare('SELECT id FROM beds WHERE id = ? AND active = 1').get(bedId)
  if (!bed) return { error: { status: 404, code: 'NOT_FOUND', message: 'Cama no encontrada' } }
  const current = db
    .prepare('SELECT id, resident_id FROM resident_bed_assignments WHERE bed_id = ? AND ends_at IS NULL')
    .get(bed.id)
  if (!current) return { error: { status: 409, code: 'CONFLICT', message: 'La cama ya esta libre' } }
  const endsAt = timestamp()
  db.prepare('UPDATE resident_bed_assignments SET ends_at = ? WHERE id = ?').run(endsAt, current.id)
  clearBedProjection([bed.id])
  audit(userId, 'resident.assignment.ended', 'assignment', current.id, {
    resident_id: current.resident_id,
    bed_id: bed.id,
  })
  return { bed_id: bed.id, resident_id: current.resident_id, ends_at: endsAt }
}

export function ingestIncident(payload) {
  const source = clinicalSourceMetadata(payload)
  if (source.error) return source
  const fields = requireFields(payload, ['resident_id', 'kind', 'severity', 'occurred_at'])
  if (fields) return { error: { status: 422, code: 'VALIDATION_ERROR', message: 'Faltan campos obligatorios', fields } }
  if (!INCIDENT_KINDS.has(payload.kind))
    return {
      error: {
        status: 422,
        code: 'VALIDATION_ERROR',
        message: 'kind no es un tipo de incidente valido',
        fields: { kind: 'invalid' },
      },
    }
  if (!INCIDENT_SEVERITIES.has(payload.severity))
    return {
      error: {
        status: 422,
        code: 'VALIDATION_ERROR',
        message: 'severity no es una severidad valida',
        fields: { severity: 'invalid' },
      },
    }
  if (!validDate(payload.occurred_at))
    return { error: { status: 422, code: 'INVALID_DATE', message: 'occurred_at no es una fecha valida' } }
  if (payload.injury_status !== undefined && !INJURY_STATUSES.has(payload.injury_status))
    return {
      error: {
        status: 422,
        code: 'VALIDATION_ERROR',
        message: 'injury_status no es valido',
        fields: { injury_status: 'invalid' },
      },
    }
  if (
    payload.self_recovery !== undefined &&
    payload.self_recovery !== null &&
    typeof payload.self_recovery !== 'boolean'
  )
    return {
      error: {
        status: 422,
        code: 'VALIDATION_ERROR',
        message: 'self_recovery debe ser boolean o null',
        fields: { self_recovery: 'invalid' },
      },
    }
  if (
    payload.response_seconds !== undefined &&
    payload.response_seconds !== null &&
    !validNonNegativeInteger(payload.response_seconds, 86400)
  )
    return {
      error: {
        status: 422,
        code: 'VALIDATION_ERROR',
        message: 'response_seconds debe ser un entero entre 0 y 86400',
        fields: { response_seconds: 'invalid' },
      },
    }
  const interventions = payload.interventions || []
  if (!Array.isArray(interventions) || interventions.some((item) => typeof item !== 'string'))
    return { error: { status: 422, code: 'VALIDATION_ERROR', message: 'interventions debe ser una lista de textos' } }
  const location = optionalClinicalText(payload.location, 120)
  const activity = optionalClinicalText(payload.activity, 120)
  const narrative = optionalClinicalText(payload.narrative, 5000)
  if (location === undefined || activity === undefined || narrative === undefined)
    return {
      error: {
        status: 422,
        code: 'VALIDATION_ERROR',
        message: 'location, activity y narrative deben ser texto o null',
      },
    }
  const resident = db.prepare("SELECT id FROM residents WHERE id = ? AND status = 'active'").get(payload.resident_id)
  if (!resident) return { error: { status: 404, code: 'NOT_FOUND', message: 'Residente no encontrado' } }
  const bedId = typeof payload.bed_id === 'string' ? payload.bed_id.trim() : null
  const sourceAlertId = typeof payload.source_alert_id === 'string' ? payload.source_alert_id.trim() : null
  if (
    payload.bed_id !== undefined &&
    payload.bed_id !== null &&
    (typeof payload.bed_id !== 'string' || !payload.bed_id.trim())
  )
    return {
      error: {
        status: 422,
        code: 'VALIDATION_ERROR',
        message: 'bed_id debe ser texto o null',
        fields: { bed_id: 'invalid' },
      },
    }
  if (payload.bed_id !== undefined && payload.bed_id !== null) {
    if (!db.prepare('SELECT id FROM beds WHERE id = ? AND active = 1').get(bedId))
      return { error: { status: 404, code: 'NOT_FOUND', message: 'Cama no encontrada' } }
  }
  if (
    payload.source_alert_id !== undefined &&
    payload.source_alert_id !== null &&
    (typeof payload.source_alert_id !== 'string' || !payload.source_alert_id.trim())
  )
    return {
      error: {
        status: 422,
        code: 'VALIDATION_ERROR',
        message: 'source_alert_id debe ser texto o null',
        fields: { source_alert_id: 'invalid' },
      },
    }
  if (payload.source_alert_id !== undefined && payload.source_alert_id !== null) {
    if (!db.prepare('SELECT id FROM alerts WHERE id = ?').get(sourceAlertId))
      return { error: { status: 404, code: 'NOT_FOUND', message: 'Alerta de origen no encontrada' } }
  }
  const existing = db
    .prepare(
      `SELECT i.*, u.display_name AS reviewed_by_name, v.display_name AS verdict_by_name
       FROM incidents i
       LEFT JOIN users u ON u.id = i.reviewed_by
       LEFT JOIN users v ON v.id = i.verdict_by
       WHERE i.source_record_id = ?`,
    )
    .get(source.sourceRecordId)
  if (existing) return { incident: incidentView(existing), duplicate: true }
  const now = timestamp()
  const incidentId = newId('incident')
  db.prepare(
    `INSERT INTO incidents
    (id, source_record_id, resident_id, bed_id, source_alert_id, kind, severity, status, occurred_at,
     location, activity, injury_status, self_recovery, response_seconds, narrative, interventions_json,
     source, model_version, confidence, provenance_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    incidentId,
    source.sourceRecordId,
    resident.id,
    bedId,
    sourceAlertId,
    payload.kind,
    payload.severity,
    new Date(payload.occurred_at).toISOString(),
    location,
    activity,
    payload.injury_status || 'unknown',
    payload.self_recovery === undefined || payload.self_recovery === null ? null : payload.self_recovery ? 1 : 0,
    payload.response_seconds ?? null,
    narrative,
    JSON.stringify(interventions.slice(0, 20).map((item) => item.trim().slice(0, 240))),
    source.source,
    source.modelVersion,
    source.confidence,
    source.provenanceJson,
    now,
    now,
  )
  audit(null, 'incident.ingested', 'incident', incidentId, {
    source: source.source,
    model_version: source.modelVersion,
    resident_id: resident.id,
  })
  const incident = db
    .prepare(
      `SELECT i.*, u.display_name AS reviewed_by_name, v.display_name AS verdict_by_name
       FROM incidents i
       LEFT JOIN users u ON u.id = i.reviewed_by
       LEFT JOIN users v ON v.id = i.verdict_by
       WHERE i.id = ?`,
    )
    .get(incidentId)
  return { incident: incidentView(incident) }
}

export function ingestSleepSummary(payload) {
  const source = clinicalSourceMetadata(payload)
  if (source.error) return source
  const fields = requireFields(payload, ['resident_id', 'observed_on'])
  if (fields) return { error: { status: 422, code: 'VALIDATION_ERROR', message: 'Faltan campos obligatorios', fields } }
  if (!validDateOnly(payload.observed_on))
    return { error: { status: 422, code: 'INVALID_DATE', message: 'observed_on debe tener formato YYYY-MM-DD' } }
  const resident = db.prepare("SELECT id FROM residents WHERE id = ? AND status = 'active'").get(payload.resident_id)
  if (!resident) return { error: { status: 404, code: 'NOT_FOUND', message: 'Residente no encontrado' } }
  const sleepStartedAt = payload.sleep_started_at ?? null
  const sleepEndedAt = payload.sleep_ended_at ?? null
  if ((sleepStartedAt && !validDate(sleepStartedAt)) || (sleepEndedAt && !validDate(sleepEndedAt)))
    return {
      error: {
        status: 422,
        code: 'INVALID_DATE',
        message: 'sleep_started_at y sleep_ended_at deben ser fechas validas',
      },
    }
  if (sleepStartedAt && sleepEndedAt && new Date(sleepEndedAt) < new Date(sleepStartedAt))
    return {
      error: { status: 422, code: 'INVALID_DATE', message: 'sleep_ended_at no puede ser anterior a sleep_started_at' },
    }
  const durations = ['calm_minutes', 'restless_minutes', 'awake_minutes', 'out_of_bed_minutes']
  for (const field of durations) {
    if (payload[field] !== undefined && !validNonNegativeInteger(payload[field], 1440))
      return {
        error: {
          status: 422,
          code: 'VALIDATION_ERROR',
          message: `${field} debe ser un entero entre 0 y 1440`,
          fields: { [field]: 'invalid' },
        },
      }
  }
  if (payload.bed_exit_count !== undefined && !validNonNegativeInteger(payload.bed_exit_count, 100))
    return {
      error: {
        status: 422,
        code: 'VALIDATION_ERROR',
        message: 'bed_exit_count debe ser un entero entre 0 y 100',
        fields: { bed_exit_count: 'invalid' },
      },
    }
  if (payload.wake_count !== undefined && !validNonNegativeInteger(payload.wake_count, 100))
    return {
      error: {
        status: 422,
        code: 'VALIDATION_ERROR',
        message: 'wake_count debe ser un entero entre 0 y 100',
        fields: { wake_count: 'invalid' },
      },
    }
  /* Una noche no puede tener mas salidas que despertares: cada salida de la
   * cama implica un despertar, pero se puede despertar sin salir. */
  if (
    Number.isFinite(payload.wake_count) &&
    Number.isFinite(payload.bed_exit_count) &&
    payload.wake_count < payload.bed_exit_count
  )
    return {
      error: {
        status: 422,
        code: 'VALIDATION_ERROR',
        message: 'wake_count no puede ser menor que bed_exit_count: cada salida implica un despertar',
        fields: { wake_count: 'invalid' },
      },
    }
  const existing = db.prepare('SELECT * FROM sleep_summaries WHERE source_record_id = ?').get(source.sourceRecordId)
  if (existing) return { summary: sleepSummaryView(existing), duplicate: true }
  const now = timestamp()
  const summaryId = newId('sleep')
  db.prepare(
    `INSERT INTO sleep_summaries
    (id, source_record_id, resident_id, observed_on, sleep_started_at, sleep_ended_at,
     calm_minutes, restless_minutes, awake_minutes, out_of_bed_minutes, bed_exit_count, wake_count,
     source, model_version, confidence, provenance_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    summaryId,
    source.sourceRecordId,
    resident.id,
    payload.observed_on,
    sleepStartedAt ? new Date(sleepStartedAt).toISOString() : null,
    sleepEndedAt ? new Date(sleepEndedAt).toISOString() : null,
    payload.calm_minutes || 0,
    payload.restless_minutes || 0,
    payload.awake_minutes || 0,
    payload.out_of_bed_minutes || 0,
    payload.bed_exit_count || 0,
    payload.wake_count || 0,
    source.source,
    source.modelVersion,
    source.confidence,
    source.provenanceJson,
    now,
    now,
  )
  audit(null, 'sleep_summary.ingested', 'sleep_summary', summaryId, {
    source: source.source,
    model_version: source.modelVersion,
    resident_id: resident.id,
    observed_on: payload.observed_on,
  })
  return {
    summary: sleepSummaryView(db.prepare('SELECT * FROM sleep_summaries WHERE id = ?').get(summaryId)),
  }
}

export function ingestMobilitySummary(payload) {
  const source = clinicalSourceMetadata(payload)
  if (source.error) return source
  const fields = requireFields(payload, ['resident_id', 'observed_on'])
  if (fields) return { error: { status: 422, code: 'VALIDATION_ERROR', message: 'Faltan campos obligatorios', fields } }
  if (!validDateOnly(payload.observed_on))
    return { error: { status: 422, code: 'INVALID_DATE', message: 'observed_on debe tener formato YYYY-MM-DD' } }
  const resident = db.prepare("SELECT id FROM residents WHERE id = ? AND status = 'active'").get(payload.resident_id)
  if (!resident) return { error: { status: 404, code: 'NOT_FOUND', message: 'Residente no encontrado' } }
  const durationFields = ['in_bed_minutes', 'out_of_bed_minutes', 'out_of_sight_minutes', 'walking_minutes']
  for (const field of durationFields) {
    if (payload[field] !== undefined && !validNonNegativeInteger(payload[field], 1440))
      return {
        error: {
          status: 422,
          code: 'VALIDATION_ERROR',
          message: `${field} debe ser un entero entre 0 y 1440`,
          fields: { [field]: 'invalid' },
        },
      }
  }
  const inBedMinutes = payload.in_bed_minutes || 0
  const outOfBedMinutes = payload.out_of_bed_minutes || 0
  const outOfSightMinutes = payload.out_of_sight_minutes || 0
  if (inBedMinutes + outOfBedMinutes + outOfSightMinutes > 1440)
    return {
      error: { status: 422, code: 'VALIDATION_ERROR', message: 'La actividad observada no puede superar 1440 minutos' },
    }
  if (
    payload.walking_distance_meters !== undefined &&
    payload.walking_distance_meters !== null &&
    (typeof payload.walking_distance_meters !== 'number' ||
      payload.walking_distance_meters < 0 ||
      payload.walking_distance_meters > 100000)
  )
    return {
      error: {
        status: 422,
        code: 'VALIDATION_ERROR',
        message: 'walking_distance_meters no es valido',
        fields: { walking_distance_meters: 'invalid' },
      },
    }
  if (
    payload.walking_speed_mps !== undefined &&
    payload.walking_speed_mps !== null &&
    (typeof payload.walking_speed_mps !== 'number' || payload.walking_speed_mps < 0 || payload.walking_speed_mps > 10)
  )
    return {
      error: {
        status: 422,
        code: 'VALIDATION_ERROR',
        message: 'walking_speed_mps no es valido',
        fields: { walking_speed_mps: 'invalid' },
      },
    }
  if (payload.transfer_count !== undefined && !validNonNegativeInteger(payload.transfer_count, 500))
    return {
      error: {
        status: 422,
        code: 'VALIDATION_ERROR',
        message: 'transfer_count debe ser un entero entre 0 y 500',
        fields: { transfer_count: 'invalid' },
      },
    }
  const existing = db.prepare('SELECT * FROM mobility_summaries WHERE source_record_id = ?').get(source.sourceRecordId)
  if (existing) return { summary: mobilitySummaryView(existing), duplicate: true }
  const now = timestamp()
  const summaryId = newId('mobility')
  db.prepare(
    `INSERT INTO mobility_summaries
    (id, source_record_id, resident_id, observed_on, in_bed_minutes, out_of_bed_minutes,
     out_of_sight_minutes, walking_minutes, walking_distance_meters, walking_speed_mps,
     transfer_count, source, model_version, confidence, provenance_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    summaryId,
    source.sourceRecordId,
    resident.id,
    payload.observed_on,
    inBedMinutes,
    outOfBedMinutes,
    outOfSightMinutes,
    payload.walking_minutes || 0,
    payload.walking_distance_meters ?? null,
    payload.walking_speed_mps ?? null,
    payload.transfer_count || 0,
    source.source,
    source.modelVersion,
    source.confidence,
    source.provenanceJson,
    now,
    now,
  )
  audit(null, 'mobility_summary.ingested', 'mobility_summary', summaryId, {
    source: source.source,
    model_version: source.modelVersion,
    resident_id: resident.id,
    observed_on: payload.observed_on,
  })
  return {
    summary: mobilitySummaryView(db.prepare('SELECT * FROM mobility_summaries WHERE id = ?').get(summaryId)),
  }
}

export function ingestBathroomSummary(payload) {
  const source = clinicalSourceMetadata(payload)
  if (source.error) return source
  const fields = requireFields(payload, ['resident_id', 'observed_on'])
  if (fields) return { error: { status: 422, code: 'VALIDATION_ERROR', message: 'Faltan campos obligatorios', fields } }
  if (!validDateOnly(payload.observed_on))
    return { error: { status: 422, code: 'INVALID_DATE', message: 'observed_on debe tener formato YYYY-MM-DD' } }
  const resident = db.prepare("SELECT id FROM residents WHERE id = ? AND status = 'active'").get(payload.resident_id)
  if (!resident) return { error: { status: 404, code: 'NOT_FOUND', message: 'Residente no encontrado' } }
  for (const field of ['visit_count', 'night_visit_count', 'assisted_count']) {
    if (payload[field] !== undefined && !validNonNegativeInteger(payload[field], 100))
      return {
        error: {
          status: 422,
          code: 'VALIDATION_ERROR',
          message: `${field} debe ser un entero entre 0 y 100`,
          fields: { [field]: 'invalid' },
        },
      }
  }
  for (const field of ['total_minutes', 'longest_visit_minutes']) {
    if (payload[field] !== undefined && !validNonNegativeInteger(payload[field], 1440))
      return {
        error: {
          status: 422,
          code: 'VALIDATION_ERROR',
          message: `${field} debe ser un entero entre 0 y 1440`,
          fields: { [field]: 'invalid' },
        },
      }
  }
  const visitCount = payload.visit_count || 0
  const nightVisitCount = payload.night_visit_count || 0
  const assistedCount = payload.assisted_count || 0
  /* Las visitas nocturnas y las asistidas son subconjuntos del total: si
   * lo superan, el resumen es incoherente y no se persiste. */
  if (nightVisitCount > visitCount)
    return {
      error: {
        status: 422,
        code: 'VALIDATION_ERROR',
        message: 'night_visit_count no puede superar visit_count',
        fields: { night_visit_count: 'invalid' },
      },
    }
  if (assistedCount > visitCount)
    return {
      error: {
        status: 422,
        code: 'VALIDATION_ERROR',
        message: 'assisted_count no puede superar visit_count',
        fields: { assisted_count: 'invalid' },
      },
    }
  const totalMinutes = payload.total_minutes || 0
  const longestVisitMinutes = payload.longest_visit_minutes || 0
  if (longestVisitMinutes > totalMinutes)
    return {
      error: {
        status: 422,
        code: 'VALIDATION_ERROR',
        message: 'longest_visit_minutes no puede superar total_minutes',
        fields: { longest_visit_minutes: 'invalid' },
      },
    }
  const existing = db.prepare('SELECT * FROM bathroom_summaries WHERE source_record_id = ?').get(source.sourceRecordId)
  if (existing) return { summary: bathroomSummaryView(existing), duplicate: true }
  const now = timestamp()
  const summaryId = newId('bathroom')
  db.prepare(
    `INSERT INTO bathroom_summaries
    (id, source_record_id, resident_id, observed_on, visit_count, night_visit_count,
     assisted_count, total_minutes, longest_visit_minutes,
     source, model_version, confidence, provenance_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    summaryId,
    source.sourceRecordId,
    resident.id,
    payload.observed_on,
    visitCount,
    nightVisitCount,
    assistedCount,
    totalMinutes,
    longestVisitMinutes,
    source.source,
    source.modelVersion,
    source.confidence,
    source.provenanceJson,
    now,
    now,
  )
  audit(null, 'bathroom_summary.ingested', 'bathroom_summary', summaryId, {
    source: source.source,
    model_version: source.modelVersion,
    resident_id: resident.id,
    observed_on: payload.observed_on,
  })
  return {
    summary: bathroomSummaryView(db.prepare('SELECT * FROM bathroom_summaries WHERE id = ?').get(summaryId)),
  }
}

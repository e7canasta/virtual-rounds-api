import http from 'node:http'
import { closeDb, db, hashPassword } from './db.js'
import { audit, newId, timestamp } from './platform.js'
import { activeRound, completeRound, createRound, listRounds, updateRoundTask } from './domains/rounds.js'
import { board, currentStateView, mergedTraits, residentEvents, residentTimeline } from './domains/monitoring.js'
import {
  assignBed,
  createCareNote,
  createResident,
  dischargeResident,
  incidentSequence,
  ingestBathroomSummary,
  ingestIncident,
  ingestMobilitySummary,
  ingestSleepSummary,
  listResidents,
  releaseBed,
  residentAssignments,
  residentBathroom,
  residentCare,
  residentIncidents,
  residentMobility,
  residentNotes,
  residentSleep,
  reviewIncident,
  updateResident,
  validDate,
} from './domains/clinical.js'
import {
  companionRooms,
  coverage,
  createBed,
  createFacility,
  createRoom,
  createStaffGroup,
  createWing,
  facilityDetail,
  facilityShiftsView,
  listBeds,
  listFacilities,
  listStaffGroups,
  planogram,
  roomBeds,
  roomPrivacyRegions,
  savePlanogram,
  saveRoomPrivacyRegions,
  saveStaffGroupMembers,
  staffGroupView,
  updateBed,
  updateCoverage,
  updateFacility,
  updateFacilityShifts,
  updateRoom,
  updateStaffGroup,
  updateWing,
  wingRooms,
  wingsOverview,
} from './domains/structure.js'
import { reportSummary } from './analytics.js'
import { authenticate, can, login, logout } from './auth.js'
import { PARAMETERS, getParameter } from './parameters.js'
import { alertDescription, projectSensorState } from './policies.js'
import { alarmDecisions, clearAlarmRulesCache, facilityTimezoneForBed, sweepDecisions } from './alarm-engine.js'
import {
  ALARM_ACTIONS,
  ALARM_SHIFTS,
  ALARM_TRANSITIONS,
  MOBILITY_AIDS,
  PRESET_MODES,
  RISK_LEVELS,
  alarmCatalog,
  alarmProfileView,
  templateById,
  transitionAvailable,
  upsertProfile,
} from './alarm-presets.js'

const configuredApiPort = Number(process.env.API_PORT)
const defaultNodePort =
  Number.isInteger(configuredApiPort) && configuredApiPort > 0 && configuredApiPort < 65535
    ? configuredApiPort + 1
    : 8781
const PORT = Number(process.env.API_NODE_PORT || defaultNodePort)
if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
  console.error(`[virtual-rounds-api] API_NODE_PORT invalido: ${process.env.API_NODE_PORT}`)
  process.exit(1)
}
const HOST = process.env.API_HOST || '0.0.0.0'
const API_PREFIX = '/api/v1'
const BRIDGE_SHARED_SECRET = process.env.BRIDGE_SHARED_SECRET || 'dev-bridge-secret'
const CLINICAL_INGEST_SECRET = process.env.CLINICAL_INGEST_SECRET || 'dev-clinical-secret'
const loginAttempts = new Map()
const LOGIN_WINDOW_MS = 60 * 1000
const LOGIN_MAX_ATTEMPTS = 5

const json = (res, status, body) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  })
  res.end(body === undefined ? '' : JSON.stringify(body))
}

const error = (res, status, code, message, fields) =>
  json(res, status, { error: { code, message, ...(fields ? { fields } : {}) } })

async function body(req) {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 1024 * 1024) throw new Error('payload too large')
  }
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('invalid json')
  }
}

function requireFields(payload, fields) {
  const missing = Object.fromEntries(
    fields
      .filter((field) => typeof payload[field] !== 'string' || !payload[field].trim())
      .map((field) => [field, 'required']),
  )
  return Object.keys(missing).length ? missing : null
}

function hasField(payload, field) {
  return Object.prototype.hasOwnProperty.call(payload, field)
}

const ADMIN_ROLES = new Set(['supervisor', 'staff'])

function adminUserRow(row) {
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    role: row.role,
    job_title: row.job_title ?? null,
    active: row.active ? 1 : 0,
  }
}

/* Residentes activos con su ubicacion y traits, en el orden en que la
 * configuracion de alarmas los muestra. Los traits de cama y residente se
 * combinan: el apoyo puede estar declarado en cualquiera de los dos. */
/* La ubicacion de un residente sale siempre de la misma cadena
 * (residente -> asignacion -> cama -> habitacion -> ala) y filtra por `active`
 * en cada eslabon: si una habitacion se da de baja, desaparece del planograma
 * y tiene que desaparecer tambien de acá, o alarmas termina ubicando gente en
 * una habitacion que el resto del sistema ya no ve.
 *
 * Las consultas historicas -- rondas, alertas, asignaciones pasadas -- no
 * llevan este filtro a proposito: borrar de la historia un ala dada de baja
 * seria reescribir lo que paso. */
const ALARM_PRESET_RESIDENTS_QUERY = `
  SELECT r.id, r.full_name, r.external_id, r.traits_json AS resident_traits_json,
    b.id AS bed_id, b.label AS bed_label, b.traits_json AS bed_traits_json,
    b.monitor_key AS monitor_key,
    rm.number AS room_number, w.id AS wing_id, w.name AS wing_name
  FROM residents r
  LEFT JOIN resident_bed_assignments a ON a.resident_id = r.id AND a.ends_at IS NULL
  LEFT JOIN beds b ON b.id = a.bed_id AND b.active = 1
  LEFT JOIN rooms rm ON rm.id = b.room_id AND rm.active = 1
  LEFT JOIN wings w ON w.id = rm.wing_id AND w.active = 1
  WHERE r.status = 'active'
`

function alarmPresetResidentRow(row) {
  return { ...row, traits: mergedTraits(row.resident_traits_json, row.bed_traits_json) }
}

function alarmPresetResidents(query = '') {
  return db
    .prepare(`${ALARM_PRESET_RESIDENTS_QUERY} AND r.full_name LIKE ? ORDER BY r.full_name`)
    .all(`%${query}%`)
    .map(alarmPresetResidentRow)
}

function alarmPresetResident(residentId) {
  const row = db.prepare(`${ALARM_PRESET_RESIDENTS_QUERY} AND r.id = ?`).get(residentId)
  return row ? alarmPresetResidentRow(row) : null
}

function alarmPresetsSummary(profiles) {
  return {
    residents: profiles.length,
    autopilot: profiles.filter((profile) => profile.profile.autopilot).length,
    action_needed: profiles.filter((profile) => profile.recommendation.changed).length,
    custom: profiles.filter((profile) => profile.profile.mode === 'custom').length,
    templated: profiles.filter((profile) => profile.profile.template_id !== 'balanced').length,
  }
}

/* Los ajustes manuales solo existen para transiciones disponibles con el apoyo
 * declarado; una regla bloqueada no admite override. */
function normalizeAlarmOverrides(payload, mobilityAid) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload))
    return { error: 'overrides debe ser un objeto', fields: { overrides: 'invalid' } }
  const value = {}
  for (const [transitionId, rule] of Object.entries(payload)) {
    const transition = ALARM_TRANSITIONS.find((item) => item.id === transitionId)
    if (!transition || transition.locked || !transitionAvailable(transitionId, mobilityAid))
      return { error: `La transicion ${transitionId} no admite ajustes`, fields: { [transitionId]: 'invalid' } }
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule))
      return { error: `El ajuste de ${transitionId} debe ser un objeto`, fields: { [transitionId]: 'invalid' } }
    const entry = {}
    for (const shift of ALARM_SHIFTS) {
      if (!hasField(rule, shift)) continue
      if (!ALARM_ACTIONS.includes(rule[shift]))
        return { error: `El ajuste de ${transitionId} no es valido`, fields: { [transitionId]: 'invalid' } }
      entry[shift] = rule[shift]
    }
    for (const param of transition.params) {
      if (!hasField(rule, param.key)) continue
      if (param.type === 'enum') {
        if (!param.options.some((option) => option.value === rule[param.key]))
          return { error: `El valor de ${param.key} no es valido`, fields: { [transitionId]: 'invalid' } }
        entry[param.key] = rule[param.key]
        continue
      }
      /* Conjunto de condiciones: se guarda en el orden que declara el catalogo,
       * no en el que llego, para que el diff no reporte un cambio inexistente
       * por haber marcado las mismas dos casillas al reves. */
      if (param.type === 'multi') {
        const options = param.options.map((option) => option.value)
        const chosen = rule[param.key]
        if (!Array.isArray(chosen) || !chosen.length || chosen.some((value) => !options.includes(value)))
          return { error: `El valor de ${param.key} no es valido`, fields: { [transitionId]: 'invalid' } }
        entry[param.key] = options.filter((option) => chosen.includes(option))
        continue
      }
      const amount = Number(rule[param.key])
      if (!Number.isFinite(amount) || amount < param.min || amount > param.max)
        return { error: `El valor de ${param.key} esta fuera de rango`, fields: { [transitionId]: 'invalid' } }
      entry[param.key] = amount
    }
    for (const key of Object.keys(rule)) {
      if (!ALARM_SHIFTS.includes(key) && !transition.params.some((param) => param.key === key))
        return { error: `${key} no es un ajuste de ${transitionId}`, fields: { [transitionId]: 'invalid' } }
    }
    if (Object.keys(entry).length) value[transitionId] = entry
  }
  return { value }
}

function reportPeriod(url) {
  const to = url.searchParams.get('to') || timestamp()
  const from =
    url.searchParams.get('from') ||
    new Date(
      Date.now() -
        getParameter('analytics.default_window_hours', PARAMETERS.analytics.defaultWindowHours) * 60 * 60 * 1000,
    ).toISOString()
  const fromDate = new Date(from)
  const toDate = new Date(to)
  if (Number.isNaN(fromDate.valueOf()) || Number.isNaN(toDate.valueOf()) || fromDate > toDate) return null
  return { from: fromDate.toISOString(), to: toDate.toISOString(), wingId: url.searchParams.get('wing_id') || null }
}

function eventTime(payload) {
  if (payload.occurred_at) return payload.occurred_at
  if (payload.updated_ms && Number.isFinite(Number(payload.updated_ms)))
    return new Date(Number(payload.updated_ms)).toISOString()
  return timestamp()
}

/* Con el hub adelante, `socket.remoteAddress` es siempre el hub y el rate limit
 * del login pasaria de ser por cliente a ser por residencia: cinco intentos
 * fallidos de una tablet dejarian sin login a todo el turno.
 *
 * `X-Forwarded-For` solo se cree si quien conecta es loopback, que es donde
 * corre el hub. Desde la red, el header es del cliente y no vale nada. */
const TRUSTED_PROXY_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

function clientAddress(req) {
  const socketAddress = req.socket.remoteAddress || 'unknown'
  if (!TRUSTED_PROXY_ADDRESSES.has(socketAddress)) return socketAddress
  const forwarded = req.headers['x-forwarded-for']
  if (!forwarded) return socketAddress
  const client = String(forwarded).split(',')[0].trim()
  return client || socketAddress
}

function loginRateLimit(ip) {
  const now = Date.now()
  const current = loginAttempts.get(ip)
  if (!current || now - current.startedAt >= LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { startedAt: now, count: 0 })
    return false
  }
  return current.count >= LOGIN_MAX_ATTEMPTS
}

function ingestEvent(payload) {
  const required = requireFields(payload, ['monitor_key', 'kind'])
  if (required)
    return { error: { status: 422, code: 'VALIDATION_ERROR', message: 'Faltan campos obligatorios', fields: required } }
  const bed = db.prepare('SELECT id FROM beds WHERE monitor_key = ? AND active = 1').get(payload.monitor_key)
  if (!bed)
    return { error: { status: 404, code: 'MONITOR_NOT_LINKED', message: 'El monitor no esta vinculado a una cama' } }
  const assignment = db
    .prepare('SELECT resident_id FROM resident_bed_assignments WHERE bed_id = ? AND ends_at IS NULL')
    .get(bed.id)
  const projection = projectSensorState(payload)
  const occurredAt = eventTime(payload)
  if (!validDate(occurredAt))
    return { error: { status: 422, code: 'INVALID_DATE', message: 'occurred_at no es una fecha valida' } }
  const receivedAt = timestamp()
  const sourceEventId = payload.event_id || payload.id || null
  const eventId = newId('event')
  const result = db.transaction(() => {
    if (sourceEventId && db.prepare('SELECT id FROM sensor_events WHERE source_event_id = ?').get(sourceEventId)) {
      return { duplicate: true }
    }
    db.prepare(
      `INSERT INTO sensor_events
      (id, source_event_id, bed_id, resident_id, monitor_key, kind, room_state, substate, state, alert_level, occurred_at, received_at, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      eventId,
      sourceEventId,
      bed.id,
      assignment?.resident_id || null,
      payload.monitor_key,
      payload.kind,
      payload.room_state || null,
      payload.substate || null,
      projection.state,
      projection.alertLevel,
      occurredAt,
      receivedAt,
      JSON.stringify(payload),
    )
    let stateChanged = false
    if (payload.kind !== 'heartbeat') {
      const stateResult = db
        .prepare(
          `INSERT INTO current_bed_states
         (bed_id, resident_id, room_state, state, substate, sleeping, alert_level, updated_at, state_since, source, source_event_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(bed_id) DO UPDATE SET
           resident_id = excluded.resident_id,
           room_state = excluded.room_state,
           state = excluded.state,
           substate = excluded.substate,
           sleeping = excluded.sleeping,
           alert_level = excluded.alert_level,
           updated_at = excluded.updated_at,
           state_since = CASE
             WHEN current_bed_states.state IS NOT excluded.state THEN excluded.updated_at
             ELSE COALESCE(current_bed_states.state_since, excluded.updated_at)
           END,
           source = excluded.source,
           source_event_id = excluded.source_event_id
         WHERE excluded.updated_at >= current_bed_states.updated_at`,
        )
        .run(
          bed.id,
          assignment?.resident_id || null,
          projection.roomState,
          projection.state,
          payload.substate || null,
          projection.sleeping ? 1 : 0,
          projection.alertLevel,
          occurredAt,
          occurredAt,
          'sensor',
          eventId,
        )
      stateChanged = stateResult.changes > 0
    }
    const insertAlert = (kind, level, title, detail) =>
      db
        .prepare(
          `INSERT INTO alerts
        (id, resident_id, bed_id, sensor_event_id, kind, level, status, title, detail, occurred_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
        )
        .run(
          newId('alert'),
          assignment?.resident_id || null,
          bed.id,
          eventId,
          kind,
          level,
          title,
          detail,
          occurredAt,
          receivedAt,
          receivedAt,
        )

    /* La configuracion del residente decide que se avisa. Una cama sin residente
     * asignado no tiene configuracion posible: ahi sigue valiendo la politica
     * fija, que es lo unico que se puede afirmar sobre esa habitacion. */
    if (payload.kind !== 'heartbeat' && assignment?.resident_id) {
      const current = db
        .prepare('SELECT state, room_state, state_since FROM current_bed_states WHERE bed_id = ?')
        .get(bed.id)
      for (const decision of alarmDecisions({
        bedId: bed.id,
        residentId: assignment.resident_id,
        state: current?.state || projection.state,
        roomState: current?.room_state || projection.roomState,
        stateSince: current?.state_since || occurredAt,
        occurredAt,
        timezone: facilityTimezoneForBed(bed.id),
      })) {
        insertAlert(decision.ruleId, decision.level, decision.title, decision.detail)
      }
    } else if (stateChanged && ['medium', 'high'].includes(projection.alertLevel)) {
      const copy = alertDescription(payload, projection.alertLevel)
      insertAlert(payload.kind, projection.alertLevel, copy.title, copy.detail)
    }
    return {
      duplicate: false,
      eventId,
      bedId: bed.id,
      residentId: assignment?.resident_id || null,
      state: projection.state,
      alertLevel: projection.alertLevel,
      occurredAt,
    }
  })()
  return { result }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204)
  const url = new URL(req.url, `http://${req.headers.host || HOST}`)

  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { ok: true, service: 'virtual-rounds-api', database: 'sqlite' })
  }
  if (req.method === 'POST' && url.pathname === `${API_PREFIX}/auth/login`) {
    try {
      const ip = clientAddress(req)
      if (loginRateLimit(ip)) return error(res, 429, 'RATE_LIMITED', 'Demasiados intentos de inicio de sesion')
      const payload = await body(req)
      if (!payload.username || !payload.password)
        return error(res, 422, 'VALIDATION_ERROR', 'Usuario y clave son obligatorios')
      const session = login(String(payload.username), String(payload.password))
      if (session) {
        loginAttempts.delete(ip)
        return json(res, 200, session)
      }
      const attempts = loginAttempts.get(ip) || { startedAt: Date.now(), count: 0 }
      attempts.count += 1
      loginAttempts.set(ip, attempts)
      return error(res, 401, 'INVALID_CREDENTIALS', 'Usuario o clave invalidos')
    } catch {
      return error(res, 400, 'INVALID_JSON', 'El body debe ser JSON valido')
    }
  }
  if (req.method === 'POST' && url.pathname === '/internal/v1/clinical/incidents') {
    if (req.headers['x-clinical-secret'] !== CLINICAL_INGEST_SECRET)
      return error(res, 401, 'UNAUTHENTICATED', 'Se requiere secreto de ingesta clinica')
    try {
      const result = ingestIncident(await body(req))
      if (result.error)
        return error(res, result.error.status, result.error.code, result.error.message, result.error.fields)
      if (result.duplicate) return json(res, 200, { incident: result.incident, duplicate: true })
      return json(res, 201, { incident: result.incident })
    } catch (cause) {
      if (cause.message === 'invalid json') return error(res, 400, 'INVALID_JSON', 'El body debe ser JSON valido')
      if (cause.message === 'payload too large')
        return error(res, 413, 'PAYLOAD_TOO_LARGE', 'El payload excede el limite')
      if (cause.code === 'SQLITE_CONSTRAINT_UNIQUE') return error(res, 409, 'CONFLICT', 'El registro clinico ya existe')
      console.error(cause)
      return error(res, 500, 'INTERNAL_ERROR', 'No se pudo ingerir el incidente')
    }
  }
  if (req.method === 'POST' && url.pathname === '/internal/v1/clinical/sleep-summaries') {
    if (req.headers['x-clinical-secret'] !== CLINICAL_INGEST_SECRET)
      return error(res, 401, 'UNAUTHENTICATED', 'Se requiere secreto de ingesta clinica')
    try {
      const result = ingestSleepSummary(await body(req))
      if (result.error)
        return error(res, result.error.status, result.error.code, result.error.message, result.error.fields)
      if (result.duplicate) return json(res, 200, { summary: result.summary, duplicate: true })
      return json(res, 201, { summary: result.summary })
    } catch (cause) {
      if (cause.message === 'invalid json') return error(res, 400, 'INVALID_JSON', 'El body debe ser JSON valido')
      if (cause.message === 'payload too large')
        return error(res, 413, 'PAYLOAD_TOO_LARGE', 'El payload excede el limite')
      if (cause.code === 'SQLITE_CONSTRAINT_UNIQUE') return error(res, 409, 'CONFLICT', 'El resumen de sueño ya existe')
      console.error(cause)
      return error(res, 500, 'INTERNAL_ERROR', 'No se pudo ingerir el resumen de sueño')
    }
  }
  if (req.method === 'POST' && url.pathname === '/internal/v1/clinical/mobility-summaries') {
    if (req.headers['x-clinical-secret'] !== CLINICAL_INGEST_SECRET)
      return error(res, 401, 'UNAUTHENTICATED', 'Se requiere secreto de ingesta clinica')
    try {
      const result = ingestMobilitySummary(await body(req))
      if (result.error)
        return error(res, result.error.status, result.error.code, result.error.message, result.error.fields)
      if (result.duplicate) return json(res, 200, { summary: result.summary, duplicate: true })
      return json(res, 201, { summary: result.summary })
    } catch (cause) {
      if (cause.message === 'invalid json') return error(res, 400, 'INVALID_JSON', 'El body debe ser JSON valido')
      if (cause.message === 'payload too large')
        return error(res, 413, 'PAYLOAD_TOO_LARGE', 'El payload excede el limite')
      if (cause.code === 'SQLITE_CONSTRAINT_UNIQUE')
        return error(res, 409, 'CONFLICT', 'El resumen de movilidad ya existe')
      console.error(cause)
      return error(res, 500, 'INTERNAL_ERROR', 'No se pudo ingerir el resumen de movilidad')
    }
  }
  if (req.method === 'POST' && url.pathname === '/internal/v1/clinical/bathroom-summaries') {
    if (req.headers['x-clinical-secret'] !== CLINICAL_INGEST_SECRET)
      return error(res, 401, 'UNAUTHENTICATED', 'Se requiere secreto de ingesta clinica')
    try {
      const result = ingestBathroomSummary(await body(req))
      if (result.error)
        return error(res, result.error.status, result.error.code, result.error.message, result.error.fields)
      if (result.duplicate) return json(res, 200, { summary: result.summary, duplicate: true })
      return json(res, 201, { summary: result.summary })
    } catch (cause) {
      return error(res, 400, 'INVALID_BODY', cause.message)
    }
  }

  if (req.method === 'POST' && url.pathname === '/internal/v1/events') {
    if (req.headers['x-bridge-secret'] !== BRIDGE_SHARED_SECRET)
      return error(res, 401, 'UNAUTHENTICATED', 'Se requiere secreto del bridge')
    try {
      const result = ingestEvent(await body(req))
      if (result.error)
        return error(res, result.error.status, result.error.code, result.error.message, result.error.fields)
      return json(res, result.result.duplicate ? 200 : 201, result.result)
    } catch (cause) {
      console.error(cause)
      return error(res, 500, 'INTERNAL_ERROR', 'No se pudo ingerir el evento')
    }
  }
  if (!url.pathname.startsWith(API_PREFIX)) return error(res, 404, 'NOT_FOUND', 'Ruta no encontrada')
  const user = authenticate(req)
  if (!user) return error(res, 401, 'UNAUTHENTICATED', 'Se requiere iniciar sesion')
  if (req.method === 'GET' && url.pathname === `${API_PREFIX}/auth/me`) return json(res, 200, { user })
  if (req.method === 'POST' && url.pathname === `${API_PREFIX}/auth/logout`) {
    logout(req)
    return json(res, 204)
  }

  const parts = url.pathname.slice(API_PREFIX.length).split('/').filter(Boolean)
  try {
    if (parts[0] === 'rounds' && parts[1] === 'current' && req.method === 'GET') {
      if (!can(user, 'rounds.read')) return error(res, 403, 'FORBIDDEN', 'No tenes permiso para ver Rondas')
      const wingId = url.searchParams.get('wing_id')
      if (!wingId) return error(res, 422, 'VALIDATION_ERROR', 'wing_id es obligatorio')
      return json(res, 200, { round: activeRound(wingId) })
    }
    if (parts[0] === 'rounds' && parts.length === 1 && req.method === 'GET') {
      if (!can(user, 'rounds.read')) return error(res, 403, 'FORBIDDEN', 'No tenes permiso para ver Rondas')
      const wingId = url.searchParams.get('wing_id')
      const limit = Math.min(Number(url.searchParams.get('limit')) || 20, 100)
      return json(res, 200, { rounds: listRounds(wingId, limit) })
    }
    if (parts[0] === 'rounds' && parts.length === 1 && req.method === 'POST') {
      if (!can(user, 'rounds.manage')) return error(res, 403, 'FORBIDDEN', 'No tenes permiso para iniciar Rondas')
      const payload = await body(req)
      const fields = requireFields(payload, ['wing_id'])
      if (fields) return error(res, 422, 'VALIDATION_ERROR', 'Faltan campos obligatorios', fields)
      const result = createRound(payload.wing_id, user.id)
      if (result.error) return error(res, result.error.status, result.error.code, result.error.message)
      return json(res, 201, { round: result })
    }
    if (parts[0] === 'rounds' && parts.length === 2 && req.method === 'PATCH') {
      if (!can(user, 'rounds.manage')) return error(res, 403, 'FORBIDDEN', 'No tenes permiso para finalizar Rondas')
      const payload = await body(req)
      if (payload.status !== 'completed')
        return error(res, 422, 'VALIDATION_ERROR', 'Solo se puede finalizar una ronda')
      const result = completeRound(parts[1], user.id)
      if (result.error)
        return error(res, result.error.status, result.error.code, result.error.message, result.error.fields)
      return json(res, 200, result)
    }
    if (parts[0] === 'round-tasks' && parts.length === 2 && req.method === 'PATCH') {
      if (!can(user, 'rounds.manage')) return error(res, 403, 'FORBIDDEN', 'No tenes permiso para actualizar Rondas')
      const payload = await body(req)
      if (!['pending', 'completed'].includes(payload.status))
        return error(res, 422, 'VALIDATION_ERROR', 'status debe ser pending o completed')
      const result = updateRoundTask(parts[1], { status: payload.status, note: payload.note }, user.id)
      if (result.error) return error(res, result.error.status, result.error.code, result.error.message)
      return json(res, 200, result)
    }
    if (parts[0] === 'alarm-presets') {
      const writes = req.method === 'PATCH' || req.method === 'POST'
      if (!can(user, writes ? 'config.alarms.manage' : 'config.alarms.read'))
        return error(res, 403, 'FORBIDDEN', 'No tenes permiso para configurar alarmas')

      if (req.method === 'GET' && parts.length === 2 && parts[1] === 'catalog') {
        return json(res, 200, alarmCatalog())
      }
      if (req.method === 'GET' && parts.length === 1) {
        const profiles = alarmPresetResidents(url.searchParams.get('q') || '').map((resident) =>
          alarmProfileView(resident),
        )
        return json(res, 200, { profiles, summary: alarmPresetsSummary(profiles) })
      }
      if (req.method === 'GET' && parts.length === 2) {
        const resident = alarmPresetResident(parts[1])
        if (!resident) return error(res, 404, 'NOT_FOUND', 'Residente no encontrado')
        return json(res, 200, { profile: alarmProfileView(resident) })
      }
      if (req.method === 'PATCH' && parts.length === 2) {
        const resident = alarmPresetResident(parts[1])
        if (!resident) return error(res, 404, 'NOT_FOUND', 'Residente no encontrado')
        const payload = await body(req)
        const current = alarmProfileView(resident)
        const next = {
          risk_level: current.profile.risk_level,
          mobility_aid: current.profile.mobility_aid,
          autopilot: current.profile.autopilot,
          mode: current.profile.mode,
          template_id: current.profile.template_id,
          overrides: current.profile.overrides,
        }
        if (hasField(payload, 'risk_level')) {
          if (!RISK_LEVELS.includes(payload.risk_level))
            return error(res, 422, 'VALIDATION_ERROR', 'risk_level no es un nivel valido', { risk_level: 'invalid' })
          next.risk_level = payload.risk_level
        }
        if (hasField(payload, 'mobility_aid')) {
          if (!MOBILITY_AIDS.includes(payload.mobility_aid))
            return error(res, 422, 'VALIDATION_ERROR', 'mobility_aid no es un apoyo valido', {
              mobility_aid: 'invalid',
            })
          next.mobility_aid = payload.mobility_aid
        }
        if (hasField(payload, 'autopilot')) {
          if (typeof payload.autopilot !== 'boolean')
            return error(res, 422, 'VALIDATION_ERROR', 'autopilot debe ser booleano', { autopilot: 'invalid' })
          next.autopilot = payload.autopilot
        }
        if (hasField(payload, 'mode')) {
          if (!PRESET_MODES.includes(payload.mode))
            return error(res, 422, 'VALIDATION_ERROR', 'mode no es valido', { mode: 'invalid' })
          next.mode = payload.mode
        }
        if (hasField(payload, 'template_id')) {
          if (!templateById(payload.template_id))
            return error(res, 422, 'VALIDATION_ERROR', 'template_id no es una plantilla conocida', {
              template_id: 'invalid',
            })
          next.template_id = payload.template_id
        }
        if (hasField(payload, 'overrides')) {
          const overrides = normalizeAlarmOverrides(payload.overrides, next.mobility_aid)
          if (overrides.error) return error(res, 422, 'VALIDATION_ERROR', overrides.error, overrides.fields)
          next.overrides = overrides.value
        }
        upsertProfile(resident.id, next, user.id)
        clearAlarmRulesCache(resident.id)
        /* La auditoria guarda el antes y el despues: un registro que solo dice
         * como quedo no permite reconstruir quien subio o bajo la vigilancia. */
        audit(user.id, 'alarm-preset.updated', 'resident', resident.id, {
          from: {
            risk_level: current.profile.risk_level,
            mobility_aid: current.profile.mobility_aid,
            autopilot: current.profile.autopilot,
            mode: current.profile.mode,
            template_id: current.profile.template_id,
          },
          to: {
            risk_level: next.risk_level,
            mobility_aid: next.mobility_aid,
            autopilot: next.autopilot,
            mode: next.mode,
            template_id: next.template_id,
          },
        })
        return json(res, 200, { profile: alarmProfileView(resident) })
      }
      if (req.method === 'POST' && parts.length === 2 && parts[1] === 'apply-recommendations') {
        const payload = await body(req)
        const ids = Array.isArray(payload.resident_ids)
          ? payload.resident_ids.filter((id) => typeof id === 'string')
          : null
        const applied = []
        for (const resident of alarmPresetResidents('')) {
          if (ids && !ids.includes(resident.id)) continue
          const view = alarmProfileView(resident)
          if (!view.recommendation.changed) continue
          upsertProfile(resident.id, { ...view.profile, risk_level: view.recommendation.level }, user.id)
          clearAlarmRulesCache(resident.id)
          audit(user.id, 'alarm-preset.recommendation-applied', 'resident', resident.id, {
            from: view.profile.risk_level,
            to: view.recommendation.level,
          })
          applied.push(resident.id)
        }
        const profiles = alarmPresetResidents('').map((resident) => alarmProfileView(resident))
        return json(res, 200, { applied, profiles, summary: alarmPresetsSummary(profiles) })
      }
      if (req.method === 'POST' && parts.length === 2 && parts[1] === 'autopilot') {
        const payload = await body(req)
        if (typeof payload.enabled !== 'boolean')
          return error(res, 422, 'VALIDATION_ERROR', 'enabled debe ser booleano', { enabled: 'invalid' })
        const changed = []
        for (const resident of alarmPresetResidents('')) {
          const view = alarmProfileView(resident)
          if (view.profile.autopilot === payload.enabled) continue
          upsertProfile(resident.id, { ...view.profile, autopilot: payload.enabled }, user.id)
          clearAlarmRulesCache(resident.id)
          changed.push(resident.id)
        }
        audit(user.id, 'alarm-preset.autopilot-bulk', 'facility', 'alarm-presets', {
          enabled: payload.enabled,
          residents: changed.length,
        })
        const profiles = alarmPresetResidents('').map((resident) => alarmProfileView(resident))
        return json(res, 200, { changed, profiles, summary: alarmPresetsSummary(profiles) })
      }
      if (req.method === 'POST' && parts.length === 3 && parts[2] === 'apply-recommendation') {
        const resident = alarmPresetResident(parts[1])
        if (!resident) return error(res, 404, 'NOT_FOUND', 'Residente no encontrado')
        const view = alarmProfileView(resident)
        upsertProfile(resident.id, { ...view.profile, risk_level: view.recommendation.level }, user.id)
        clearAlarmRulesCache(resident.id)
        audit(user.id, 'alarm-preset.recommendation-applied', 'resident', resident.id, {
          from: view.profile.risk_level,
          to: view.recommendation.level,
        })
        return json(res, 200, { profile: alarmProfileView(resident) })
      }
    }
    if (req.method === 'GET' && parts[0] === 'reports' && parts[1] === 'summary') {
      if (!can(user, 'analytics.read')) return error(res, 403, 'FORBIDDEN', 'No tenes permiso para ver Reportes')
      const period = reportPeriod(url)
      if (!period) return error(res, 422, 'VALIDATION_ERROR', 'El periodo de fechas no es valido')
      if (period.wingId && !db.prepare('SELECT id FROM wings WHERE id = ? AND active = 1').get(period.wingId))
        return error(res, 404, 'NOT_FOUND', 'Ala no encontrada')
      return json(res, 200, reportSummary(period))
    }
    if (req.method === 'GET' && parts[0] === 'audit-log') {
      if (!can(user, 'audit.read')) return error(res, 403, 'FORBIDDEN', 'No tenes permiso para ver la auditoria')
      const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500)
      const entityType = url.searchParams.get('entity_type')
      const entityId = url.searchParams.get('entity_id')
      const rows = db
        .prepare(
          `
        SELECT a.id, a.actor_id, u.display_name AS actor_name, a.action,
          a.entity_type, a.entity_id, a.metadata_json, a.created_at
        FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
        WHERE (? IS NULL OR a.entity_type = ?) AND (? IS NULL OR a.entity_id = ?)
        ORDER BY a.created_at DESC, a.rowid DESC LIMIT ?
      `,
        )
        .all(entityType, entityType, entityId, entityId, limit)
      return json(res, 200, { audit: rows.map((row) => ({ ...row, metadata: JSON.parse(row.metadata_json) })) })
    }
    if (req.method === 'GET' && parts[0] === 'users' && parts.length === 1) {
      if (!can(user, 'master.structure.read'))
        return error(res, 403, 'FORBIDDEN', 'No tenes permiso para ver la estructura')
      const includeInactive = url.searchParams.get('include_inactive') === '1'
      const rows = includeInactive
        ? db
            .prepare(
              'SELECT id, username, display_name, role, job_title, active FROM users ORDER BY display_name, username',
            )
            .all()
        : db
            .prepare(
              'SELECT id, username, display_name, role, job_title, active FROM users WHERE active = 1 ORDER BY display_name, username',
            )
            .all()
      return json(res, 200, { users: rows.map(adminUserRow) })
    }

    if (req.method === 'POST' && parts[0] === 'users' && parts.length === 1) {
      if (!can(user, 'master.structure.write'))
        return error(res, 403, 'FORBIDDEN', 'No tenes permiso para configurar la residencia')
      const payload = await body(req)
      const fields = requireFields(payload, ['username', 'display_name', 'role', 'password'])
      if (fields) return error(res, 422, 'VALIDATION_ERROR', 'Faltan campos obligatorios', fields)
      if (!ADMIN_ROLES.has(payload.role))
        return error(res, 422, 'VALIDATION_ERROR', 'role debe ser supervisor o staff', { role: 'invalid' })
      if (typeof payload.password !== 'string' || payload.password.length < 6)
        return error(res, 422, 'VALIDATION_ERROR', 'password debe tener al menos 6 caracteres', {
          password: 'invalid',
        })
      const username = payload.username.trim().toLowerCase()
      if (db.prepare('SELECT id FROM users WHERE username = ?').get(username))
        return error(res, 409, 'CONFLICT', 'El usuario ya existe')
      /* El puesto es opcional y libre: describe a la persona en el hogar, no lo
       * que puede tocar. Eso lo decide `role`. */
      if (hasField(payload, 'job_title') && payload.job_title !== null && typeof payload.job_title !== 'string')
        return error(res, 422, 'VALIDATION_ERROR', 'job_title debe ser texto o null', { job_title: 'invalid' })
      const record = {
        id: newId('user'),
        username,
        display_name: payload.display_name.trim().slice(0, 120),
        role: payload.role,
        job_title: typeof payload.job_title === 'string' ? payload.job_title.trim().slice(0, 80) || null : null,
        active: 1,
      }
      db.prepare(
        'INSERT INTO users (id, username, display_name, role, job_title, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(
        record.id,
        record.username,
        record.display_name,
        record.role,
        record.job_title,
        hashPassword(payload.password),
        timestamp(),
      )
      audit(user.id, 'user.created', 'user', record.id, { username: record.username, role: record.role })
      return json(res, 201, { user: adminUserRow(record) })
    }

    if (req.method === 'PATCH' && parts[0] === 'users' && parts.length === 2) {
      if (!can(user, 'master.structure.write'))
        return error(res, 403, 'FORBIDDEN', 'No tenes permiso para configurar la residencia')
      const target = db
        .prepare('SELECT id, username, display_name, role, job_title, active FROM users WHERE id = ?')
        .get(parts[1])
      if (!target) return error(res, 404, 'NOT_FOUND', 'Usuario no encontrado')
      const payload = await body(req)
      const updates = []
      const values = []
      if (hasField(payload, 'display_name')) {
        if (typeof payload.display_name !== 'string' || !payload.display_name.trim())
          return error(res, 422, 'VALIDATION_ERROR', 'display_name debe ser un texto no vacio', {
            display_name: 'invalid',
          })
        updates.push('display_name = ?')
        values.push(payload.display_name.trim().slice(0, 120))
      }
      if (hasField(payload, 'role')) {
        if (!ADMIN_ROLES.has(payload.role))
          return error(res, 422, 'VALIDATION_ERROR', 'role debe ser supervisor o staff', { role: 'invalid' })
        updates.push('role = ?')
        values.push(payload.role)
      }
      if (hasField(payload, 'job_title')) {
        if (payload.job_title !== null && typeof payload.job_title !== 'string')
          return error(res, 422, 'VALIDATION_ERROR', 'job_title debe ser texto o null', { job_title: 'invalid' })
        updates.push('job_title = ?')
        values.push(typeof payload.job_title === 'string' ? payload.job_title.trim().slice(0, 80) || null : null)
      }
      if (hasField(payload, 'active')) {
        updates.push('active = ?')
        values.push(payload.active ? 1 : 0)
      }
      if (hasField(payload, 'password')) {
        if (typeof payload.password !== 'string' || payload.password.length < 6)
          return error(res, 422, 'VALIDATION_ERROR', 'password debe tener al menos 6 caracteres', {
            password: 'invalid',
          })
        updates.push('password_hash = ?')
        values.push(hashPassword(payload.password))
      }
      if (!updates.length) return error(res, 422, 'VALIDATION_ERROR', 'No hay campos para actualizar')
      values.push(target.id)
      db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values)
      audit(user.id, 'user.updated', 'user', target.id, {
        fields: updates.map((field) => field.split(' ')[0]).filter((field) => field !== 'password_hash'),
      })
      const updated = db
        .prepare('SELECT id, username, display_name, role, job_title, active FROM users WHERE id = ?')
        .get(target.id)
      return json(res, 200, { user: adminUserRow(updated) })
    }

    /* Estructura: residencias, alas, habitaciones, camas, grilla de turnos,
     * planograma, cobertura y grupos de staff. El dominio vive en
     * api/domains/structure.js; aca solo quedan los permisos y el contrato
     * HTTP. */
    if (req.method === 'GET' && parts[0] === 'facilities' && parts[2] === 'shifts' && parts.length === 3) {
      if (!can(user, 'master.structure.read'))
        return error(res, 403, 'FORBIDDEN', 'No tenes permiso para ver la estructura')
      const result = facilityShiftsView(parts[1])
      if (result.error)
        return error(res, result.error.status, result.error.code, result.error.message, result.error.fields)
      return json(res, 200, result)
    }
    if (req.method === 'PUT' && parts[0] === 'facilities' && parts[2] === 'shifts' && parts.length === 3) {
      if (!can(user, 'master.structure.write'))
        return error(res, 403, 'FORBIDDEN', 'No tenes permiso para configurar la residencia')
      const result = updateFacilityShifts(parts[1], await body(req), user.id)
      if (result.error)
        return error(res, result.error.status, result.error.code, result.error.message, result.error.fields)
      return json(res, 200, result)
    }
    if (req.method === 'GET' && parts[0] === 'facilities') {
      if (!can(user, 'master.structure.read'))
        return error(res, 403, 'FORBIDDEN', 'No tenes permiso para ver la estructura')
      if (parts.length === 1) return json(res, 200, { facilities: listFacilities() })
      const result = facilityDetail(parts[1])
      if (result.error)
        return error(res, result.error.status, result.error.code, result.error.message, result.error.fields)
      return json(res, 200, result)
    }
    if (req.method === 'PATCH' && parts[0] === 'facilities' && parts.length === 2) {
      if (!can(user, 'master.structure.write'))
        return error(res, 403, 'FORBIDDEN', 'No tenes permiso para configurar la residencia')
      const result = updateFacility(parts[1], await body(req), user.id)
      if (result.error)
        return error(res, result.error.status, result.error.code, result.error.message, result.error.fields)
      return json(res, 200, result)
    }
    if (req.method === 'POST' && parts[0] === 'facilities' && parts.length === 1) {
      if (!can(user, 'master.structure.write'))
        return error(res, 403, 'FORBIDDEN', 'No tenes permiso para configurar la residencia')
      const result = createFacility(await body(req))
      if (result.error)
        return error(res, result.error.status, result.error.code, result.error.message, result.error.fields)
      return json(res, 201, result)
    }
    if (req.method === 'GET' && parts[0] === 'wings' && parts.length === 1) {
      if (!can(user, 'master.structure.read'))
        return error(res, 403, 'FORBIDDEN', 'No tenes permiso para ver la estructura')
      return json(res, 200, { wings: wingsOverview() })
    }
    if (req.method === 'PATCH' && parts[0] === 'wings' && parts.length === 2) {
      if (!can(user, 'master.structure.write'))
        return error(res, 403, 'FORBIDDEN', 'No tenes permiso para configurar la residencia')
      const result = updateWing(parts[1], await body(req), user.id)
      if (result.error)
        return error(res, result.error.status, result.error.code, result.error.message, result.error.fields)
      return json(res, 200, result)
    }
    if (req.method === 'GET' && parts[0] === 'wings' && parts[2] === 'board') {
      if (!can(user, 'monitoring.board.read'))
        return error(res, 403, 'FORBIDDEN', 'No tenes permiso para ver Habitaciones')
      const result = board(parts[1])
      return result ? json(res, 200, result) : error(res, 404, 'NOT_FOUND', 'Ala no encontrada')
    }
    if (req.method === 'GET' && parts[0] === 'companion' && parts[1] === 'rooms' && parts.length === 2) {
      if (!can(user, 'monitoring.board.read'))
        return error(res, 403, 'FORBIDDEN', 'No tenes permiso para ver Habitaciones')
      return json(res, 200, { source: 'planogram', rooms: companionRooms() })
    }
    if (req.method === 'GET' && parts[0] === 'wings' && parts.length === 3 && parts[2] === 'rooms') {
      if (!can(user, 'master.structure.read'))
        return error(res, 403, 'FORBIDDEN', 'No tenes permiso para ver la estructura')
      const result = wingRooms(parts[1])
      if (result.error)
        return error(res, result.error.status, result.error.code, result.error.message, result.error.fields)
      return json(res, 200, result)
    }
    if (req.method === 'GET' && parts[0] === 'rooms' && parts.length === 3 && parts[2] === 'beds') {
      if (!can(user, 'master.structure.read'))
        return error(res, 403, 'FORBIDDEN', 'No tenes permiso para ver la estructura')
      const result = roomBeds(parts[1])
      if (result.error)
        return error(res, result.error.status, result.error.code, result.error.message, result.error.fields)
      return json(res, 200, result)
    }
    if (req.method === 'GET' && parts[0] === 'rooms' && parts.length === 3 && parts[2] === 'privacy-regions') {
      if (!can(user, 'master.structure.read'))
        return error(res, 403, 'FORBIDDEN', 'No tenes permiso para ver la estructura')
      const result = roomPrivacyRegions(parts[1])
      if (result.error)
        return error(res, result.error.status, result.error.code, result.error.message, result.error.fields)
      return json(res, 200, result)
    }
    if (req.method === 'PUT' && parts[0] === 'rooms' && parts.length === 3 && parts[2] === 'privacy-regions') {
      if (!can(user, 'master.structure.write'))
        return error(res, 403, 'FORBIDDEN', 'No tenes permiso para configurar la residencia')
      const result = saveRoomPrivacyRegions(parts[1], await body(req), user.id)
      if (result.error)
        return error(res, result.error.status, result.error.code, result.error.message, result.error.fields)
      return json(res, 200, result)
    }
    if (req.method === 'GET' && parts[0] === 'beds' && parts.length === 1) {
      if (!can(user, 'master.structure.read'))
        return error(res, 403, 'FORBIDDEN', 'No tenes permiso para ver la residencia')
      return json(res, 200, { beds: listBeds() })
    }
    if (req.method === 'PATCH' && parts[0] === 'beds' && parts.length === 2) {
      if (!can(user, 'master.structure.write'))
        return error(res, 403, 'FORBIDDEN', 'No tenes permiso para configurar la residencia')
      const result = updateBed(parts[1], await body(req), user.id)
      if (result.error)
        return error(res, result.error.status, result.error.code, result.error.message, result.error.fields)
      return json(res, 200, result)
    }
    if (req.method === 'POST' && parts[0] === 'facilities' && parts[2] === 'wings') {
      if (!can(user, 'master.structure.write'))
        return error(res, 403, 'FORBIDDEN', 'No tenes permiso para configurar la residencia')
      const result = createWing(parts[1], await body(req))
      if (result.error)
        return error(res, result.error.status, result.error.code, result.error.message, result.error.fields)
      return json(res, 201, result)
    }
    if (req.method === 'POST' && parts[0] === 'wings' && parts[2] === 'rooms') {
      if (!can(user, 'master.structure.write'))
        return error(res, 403, 'FORBIDDEN', 'No tenes permiso para configurar la residencia')
      const result = createRoom(parts[1], await body(req), user.id)
      if (result.error)
        return error(res, result.error.status, result.error.code, result.error.message, result.error.fields)
      return json(res, 201, result)
    }
    if (req.method === 'PATCH' && parts[0] === 'rooms' && parts.length === 2) {
      if (!can(user, 'master.structure.write'))
        return error(res, 403, 'FORBIDDEN', 'No tenes permiso para configurar la residencia')
      const result = updateRoom(parts[1], await body(req), user.id)
      if (result.error)
        return error(res, result.error.status, result.error.code, result.error.message, result.error.fields)
      return json(res, 200, result)
    }
    if (req.method === 'GET' && parts[0] === 'wings' && parts[2] === 'planogram' && parts.length === 3) {
      if (!can(user, 'master.structure.read'))
        return error(res, 403, 'FORBIDDEN', 'No tenes permiso para ver la estructura')
      const result = planogram(parts[1])
      if (result.error)
        return error(res, result.error.status, result.error.code, result.error.message, result.error.fields)
      return json(res, 200, result)
    }
    if (req.method === 'PUT' && parts[0] === 'wings' && parts[2] === 'planogram' && parts.length === 3) {
      if (!can(user, 'master.structure.write'))
        return error(res, 403, 'FORBIDDEN', 'No tenes permiso para configurar la residencia')
      const result = savePlanogram(parts[1], await body(req), user.id)
      if (result.error)
        return error(res, result.error.status, result.error.code, result.error.message, result.error.fields)
      return json(res, 200, result)
    }
    if (req.method === 'GET' && parts[0] === 'wings' && parts[2] === 'coverage' && parts.length === 3) {
      if (!can(user, 'master.structure.read'))
        return error(res, 403, 'FORBIDDEN', 'No tenes permiso para ver la estructura')
      const result = coverage(parts[1], url.searchParams.get('at') || new Date())
      if (result.error)
        return error(res, result.error.status, result.error.code, result.error.message, result.error.fields)
      return json(res, 200, result)
    }
    if (req.method === 'PUT' && parts[0] === 'wings' && parts[2] === 'coverage' && parts.length === 3) {
      if (!can(user, 'master.structure.write'))
        return error(res, 403, 'FORBIDDEN', 'No tenes permiso para configurar la residencia')
      const result = updateCoverage(parts[1], await body(req), user.id)
      if (result.error)
        return error(res, result.error.status, result.error.code, result.error.message, result.error.fields)
      return json(res, 200, result)
    }
    if (req.method === 'GET' && parts[0] === 'staff-groups' && parts.length === 1) {
      if (!can(user, 'master.structure.read'))
        return error(res, 403, 'FORBIDDEN', 'No tenes permiso para ver la estructura')
      return json(res, 200, listStaffGroups(url.searchParams.get('facility_id')))
    }
    if (req.method === 'GET' && parts[0] === 'staff-groups' && parts.length === 2) {
      if (!can(user, 'master.structure.read'))
        return error(res, 403, 'FORBIDDEN', 'No tenes permiso para ver la estructura')
      const result = staffGroupView(parts[1])
      if (result.error)
        return error(res, result.error.status, result.error.code, result.error.message, result.error.fields)
      return json(res, 200, result)
    }
    if (req.method === 'POST' && parts[0] === 'staff-groups' && parts.length === 1) {
      if (!can(user, 'master.structure.write'))
        return error(res, 403, 'FORBIDDEN', 'No tenes permiso para configurar la residencia')
      const result = createStaffGroup(await body(req), user.id)
      if (result.error)
        return error(res, result.error.status, result.error.code, result.error.message, result.error.fields)
      return json(res, 201, result)
    }
    if (req.method === 'PATCH' && parts[0] === 'staff-groups' && parts.length === 2) {
      if (!can(user, 'master.structure.write'))
        return error(res, 403, 'FORBIDDEN', 'No tenes permiso para configurar la residencia')
      const result = updateStaffGroup(parts[1], await body(req), user.id)
      if (result.error)
        return error(res, result.error.status, result.error.code, result.error.message, result.error.fields)
      return json(res, 200, result)
    }
    if (req.method === 'PUT' && parts[0] === 'staff-groups' && parts[2] === 'members' && parts.length === 3) {
      if (!can(user, 'master.structure.write'))
        return error(res, 403, 'FORBIDDEN', 'No tenes permiso para configurar la residencia')
      const result = saveStaffGroupMembers(parts[1], await body(req), user.id)
      if (result.error)
        return error(res, result.error.status, result.error.code, result.error.message, result.error.fields)
      return json(res, 200, result)
    }
    if (req.method === 'POST' && parts[0] === 'rooms' && parts[2] === 'beds') {
      if (!can(user, 'master.structure.write'))
        return error(res, 403, 'FORBIDDEN', 'No tenes permiso para configurar la residencia')
      const result = createBed(parts[1], await body(req))
      if (result.error)
        return error(res, result.error.status, result.error.code, result.error.message, result.error.fields)
      return json(res, 201, result)
    }

    if (req.method === 'GET' && parts[0] === 'alerts') {
      if (!can(user, 'alerts.read')) return error(res, 403, 'FORBIDDEN', 'No tenes permiso para ver Alertas')
      const status = url.searchParams.get('status') || 'open'
      const residentId = url.searchParams.get('resident_id')
      const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500)
      const statusFilter = status === 'all' ? '%' : status
      const alerts = db
        .prepare(
          `
         SELECT a.id, a.resident_id, a.bed_id, a.sensor_event_id, a.kind, a.level,
           a.status, a.title, a.detail, a.occurred_at, a.acknowledged_at,
           a.acknowledged_by, a.attended_at, a.attended_by, a.resolved_at, a.resolved_by, a.created_at, a.updated_at,
           res.full_name, rm.id AS room_id, rm.number AS room_number, rm.stream_key, w.id AS wing_id,
           b.label AS bed_label, attendee.display_name AS attended_by_name
         FROM alerts a
         LEFT JOIN residents res ON res.id = a.resident_id
         JOIN beds b ON b.id = a.bed_id
         JOIN rooms rm ON rm.id = b.room_id
         JOIN wings w ON w.id = rm.wing_id
         LEFT JOIN users attendee ON attendee.id = a.attended_by
         WHERE a.status LIKE ? AND (? IS NULL OR a.resident_id = ?)
         ORDER BY a.occurred_at DESC LIMIT ?
       `,
        )
        .all(statusFilter, residentId, residentId, limit)
      return json(res, 200, { alerts })
    }
    if (req.method === 'POST' && parts[0] === 'alerts' && parts.length === 1) {
      if (!can(user, 'alerts.manage')) return error(res, 403, 'FORBIDDEN', 'No tenes permiso para crear Alertas')
      const payload = await body(req)
      const fields = requireFields(payload, ['bed_id'])
      if (fields) return error(res, 422, 'VALIDATION_ERROR', 'Faltan campos obligatorios', fields)
      const bed = db
        .prepare(
          `
        SELECT b.id, a.resident_id
        FROM beds b
        LEFT JOIN resident_bed_assignments a ON a.bed_id = b.id AND a.ends_at IS NULL
        WHERE b.id = ? AND b.active = 1
      `,
        )
        .get(payload.bed_id)
      if (!bed) return error(res, 404, 'NOT_FOUND', 'Cama no encontrada')
      const occurredAt = timestamp()
      const alertId = newId('alert')
      db.prepare(
        `INSERT INTO alerts
        (id, resident_id, bed_id, sensor_event_id, kind, level, status, title, detail, occurred_at, created_at, updated_at)
        VALUES (?, ?, ?, NULL, 'manual', ?, 'open', ?, ?, ?, ?, ?)`,
      ).run(
        alertId,
        bed.resident_id || null,
        bed.id,
        ['medium', 'high'].includes(payload.level) ? payload.level : 'high',
        typeof payload.title === 'string' && payload.title.trim()
          ? payload.title.trim().slice(0, 120)
          : 'Alerta manual',
        typeof payload.detail === 'string' ? payload.detail.trim().slice(0, 500) || null : null,
        occurredAt,
        occurredAt,
        occurredAt,
      )
      audit(user.id, 'alert.created', 'alert', alertId, { kind: 'manual', bed_id: bed.id })
      return json(res, 201, {
        alert: db
          .prepare(
            'SELECT id, resident_id, bed_id, kind, level, status, title, detail, occurred_at, created_at, updated_at FROM alerts WHERE id = ?',
          )
          .get(alertId),
      })
    }
    if (req.method === 'POST' && parts[0] === 'alerts' && parts[2] === 'view' && parts.length === 3) {
      if (!can(user, 'monitoring.live.read'))
        audit(user.id, 'alert.image_revealed.denied', 'alert', parts[1], {
          context: 'alert',
          authorized: false,
          reason: 'missing_capability',
        })
      if (!can(user, 'monitoring.live.read'))
        return error(res, 403, 'FORBIDDEN', 'No tenes permiso para ver la imagen en vivo')
      const alert = db.prepare('SELECT id, bed_id, status FROM alerts WHERE id = ?').get(parts[1])
      if (!alert) return error(res, 404, 'NOT_FOUND', 'Alerta no encontrada')
      const payload = await body(req)
      const durationMs = Number(payload.duration_ms)
      audit(user.id, 'alert.image_revealed', 'alert', alert.id, {
        bed_id: alert.bed_id,
        status: alert.status,
        duration_ms: Number.isFinite(durationMs) ? Math.min(Math.max(Math.round(durationMs), 1000), 30_000) : 15_000,
      })
      return json(res, 204)
    }
    if (req.method === 'POST' && parts[0] === 'rooms' && parts[2] === 'peek' && parts.length === 3) {
      const room = db
        .prepare(
          `SELECT r.id, r.number, b.id AS bed_id
           FROM rooms r LEFT JOIN beds b ON b.room_id = r.id
           WHERE r.id = ? LIMIT 1`,
        )
        .get(parts[1])
      if (!can(user, 'monitoring.live.read')) {
        audit(user.id, 'companion.peek.denied', 'room', parts[1], {
          context: 'peek',
          authorized: false,
          reason: 'missing_capability',
        })
        return error(res, 403, 'FORBIDDEN', 'No tenes permiso para mirar la imagen en vivo')
      }
      if (!room) return error(res, 404, 'NOT_FOUND', 'Habitacion no encontrada')
      const payload = await body(req)
      const context = ['peek', 'manual_live'].includes(payload.context) ? payload.context : 'peek'
      const requested = Number(payload.duration_ms)
      const durationMs = Number.isFinite(requested) ? Math.min(Math.max(Math.round(requested), 1000), 30_000) : 20_000
      audit(user.id, `companion.${context}.started`, 'room', room.id, {
        bed_id: room.bed_id,
        room_number: room.number,
        context,
        authorized: true,
        started_at: timestamp(),
        duration_ms: durationMs,
      })
      return json(res, 200, {
        peek: { room_id: room.id, bed_id: room.bed_id, duration_ms: durationMs, authorized: true },
      })
    }
    if (req.method === 'PATCH' && parts[0] === 'alerts' && parts.length === 2) {
      if (!can(user, 'alerts.manage')) return error(res, 403, 'FORBIDDEN', 'No tenes permiso para actualizar Alertas')
      const payload = await body(req)
      if (!['open', 'acknowledged', 'attending', 'resolved'].includes(payload.status))
        return error(res, 422, 'VALIDATION_ERROR', 'status debe ser open, acknowledged, attending o resolved')
      const alert = db
        .prepare(
          'SELECT id, status, acknowledged_at, acknowledged_by, attended_at, attended_by FROM alerts WHERE id = ?',
        )
        .get(parts[1])
      if (!alert) return error(res, 404, 'NOT_FOUND', 'Alerta no encontrada')
      const updatedAt = timestamp()
      const acknowledgedAt = ['acknowledged', 'attending'].includes(payload.status)
        ? alert.acknowledged_at || updatedAt
        : alert.acknowledged_at
      const acknowledgedBy = ['acknowledged', 'attending'].includes(payload.status)
        ? alert.acknowledged_by || user.id
        : alert.acknowledged_by
      const attendedAt = payload.status === 'attending' ? alert.attended_at || updatedAt : alert.attended_at
      const attendedBy = payload.status === 'attending' ? alert.attended_by || user.id : alert.attended_by
      const resolvedAt = payload.status === 'resolved' ? updatedAt : null
      db.prepare(
        `UPDATE alerts SET status = ?, acknowledged_at = ?, acknowledged_by = ?,
        attended_at = ?, attended_by = ?, resolved_at = ?, resolved_by = ?, updated_at = ? WHERE id = ?`,
      ).run(
        payload.status,
        acknowledgedAt,
        acknowledgedBy,
        attendedAt,
        attendedBy,
        resolvedAt,
        payload.status === 'resolved' ? user.id : null,
        updatedAt,
        alert.id,
      )
      audit(user.id, `alert.${payload.status}`, 'alert', alert.id)
      return json(res, 200, {
        alert: db
          .prepare(
            `
        SELECT id, resident_id, bed_id, sensor_event_id, kind, level, status, title, detail,
          occurred_at, acknowledged_at, acknowledged_by, attended_at, attended_by, resolved_at, resolved_by, created_at, updated_at
        FROM alerts WHERE id = ?
      `,
          )
          .get(alert.id),
      })
    }

    if (req.method === 'GET' && parts[0] === 'residents') {
      if (parts.length === 1 && !can(user, 'residents.list.read'))
        return error(res, 403, 'FORBIDDEN', 'No tenes permiso para ver Residentes')
      if (parts.length > 1 && !can(user, 'residents.snapshot.read'))
        return error(res, 403, 'FORBIDDEN', 'No tenes permiso para ver el residente')
      if (parts.length === 1) {
        const query = url.searchParams.get('q') || ''
        return json(res, 200, { residents: listResidents(query) })
      }
      const resident = db
        .prepare(
          "SELECT id, external_id, full_name, birth_date, admission_date, status FROM residents WHERE id = ? AND status = 'active'",
        )
        .get(parts[1])
      if (!resident) return error(res, 404, 'NOT_FOUND', 'Residente no encontrado')
      if (['current-state', 'events'].includes(parts[2]) && !can(user, 'residents.live.read'))
        return error(res, 403, 'FORBIDDEN', 'No tenes permiso para ver monitoreo en vivo')
      if (parts[2] === 'incidents') {
        if (!can(user, 'incidents.read')) return error(res, 403, 'FORBIDDEN', 'No tenes permiso para ver incidentes')
        const result = residentIncidents(resident.id, {
          status: url.searchParams.get('status') || 'all',
          from: url.searchParams.get('from'),
          to: url.searchParams.get('to'),
          limit: url.searchParams.get('limit'),
        })
        if (result.error)
          return error(res, result.error.status, result.error.code, result.error.message, result.error.fields)
        return json(res, 200, { incidents: result.incidents })
      }
      if (parts[2] === 'sleep') {
        if (!can(user, 'sleep.read')) return error(res, 403, 'FORBIDDEN', 'No tenes permiso para ver sueño')
        const result = residentSleep(resident.id, {
          from: url.searchParams.get('from'),
          to: url.searchParams.get('to'),
        })
        if (result.error)
          return error(res, result.error.status, result.error.code, result.error.message, result.error.fields)
        return json(res, 200, result)
      }
      if (parts[2] === 'mobility') {
        if (!can(user, 'mobility.read')) return error(res, 403, 'FORBIDDEN', 'No tenes permiso para ver movilidad')
        const result = residentMobility(resident.id, {
          from: url.searchParams.get('from'),
          to: url.searchParams.get('to'),
        })
        if (result.error)
          return error(res, result.error.status, result.error.code, result.error.message, result.error.fields)
        return json(res, 200, result)
      }
      if (parts[2] === 'bathroom') {
        if (!can(user, 'bathroom.read')) return error(res, 403, 'FORBIDDEN', 'No tenes permiso para ver uso del bano')
        const result = residentBathroom(resident.id, {
          from: url.searchParams.get('from'),
          to: url.searchParams.get('to'),
        })
        if (result.error)
          return error(res, result.error.status, result.error.code, result.error.message, result.error.fields)
        return json(res, 200, result)
      }
      if (parts[2] === 'care') {
        if (!can(user, 'care.read'))
          return error(res, 403, 'FORBIDDEN', 'No tenes permiso para ver actividad de cuidado')
        return json(res, 200, residentCare(resident.id, { days: url.searchParams.get('days') }))
      }
      if (parts[2] === 'assignments') {
        const result = residentAssignments(resident.id)
        if (result.error)
          return error(res, result.error.status, result.error.code, result.error.message, result.error.fields)
        return json(res, 200, result)
      }
      if (parts[2] === 'current-state') {
        const current = db
          .prepare(
            `
          SELECT cs.bed_id, cs.room_state, cs.state, cs.substate, cs.sleeping, cs.alert_level, cs.updated_at, cs.source,
            b.label AS bed_label, rm.number AS room_number, w.id AS wing_id, w.name AS wing_name
          FROM current_bed_states cs
          JOIN beds b ON b.id = cs.bed_id
          JOIN rooms rm ON rm.id = b.room_id
          JOIN wings w ON w.id = rm.wing_id
          JOIN resident_bed_assignments a ON a.bed_id = cs.bed_id AND a.resident_id = ? AND a.ends_at IS NULL
        `,
          )
          .get(resident.id)
        return json(res, 200, { resident, current_state: currentStateView(current) })
      }
      if (parts[2] === 'timeline') {
        const hours = Number(url.searchParams.get('hours') || 48)
        if (!Number.isInteger(hours) || hours < 1 || hours > 720)
          return error(res, 422, 'VALIDATION_ERROR', 'hours debe ser un entero entre 1 y 720', { hours: 'invalid' })
        const to = timestamp()
        const from = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()
        return json(res, 200, {
          period: { from, to, hours },
          timeline: residentTimeline(resident.id, from, to, user.capabilities),
        })
      }
      if (parts[2] === 'events') {
        const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 1000)
        const from = url.searchParams.get('from')
        const to = url.searchParams.get('to')
        if ((from && !validDate(from)) || (to && !validDate(to)))
          return error(res, 422, 'INVALID_DATE', 'from y to deben ser fechas validas')
        if (from && to && new Date(from) > new Date(to))
          return error(res, 422, 'INVALID_DATE', 'from no puede ser posterior a to')
        const events = residentEvents(parts[1], { from, to, limit })
        return json(res, 200, { events })
      }
      if (parts[2] === 'notes') {
        if (!can(user, 'residents.notes.read'))
          return error(res, 403, 'FORBIDDEN', 'No tenes permiso para ver notas clinicas')
        const result = residentNotes(resident.id, url.searchParams.get('limit'))
        if (result.error)
          return error(res, result.error.status, result.error.code, result.error.message, result.error.fields)
        return json(res, 200, result)
      }
      return json(res, 200, resident)
    }
    /* Reconstruccion de un incidente: la secuencia de estados que lo rodea y
     * las dos medidas que salen de ella. Es lo que hace revisable un evento —
     * sin la secuencia, un incidente es una fila que afirma que algo paso.
     *
     * Va en su propio endpoint y no dentro del listado: solo se pide cuando
     * alguien abre la revision, y son ~7 eventos por incidente. */
    if (req.method === 'GET' && parts[0] === 'incidents' && parts.length === 3 && parts[2] === 'sequence') {
      if (!can(user, 'incidents.read')) return error(res, 403, 'FORBIDDEN', 'No tenes permiso para ver incidentes')
      const result = incidentSequence(parts[1], {
        before: url.searchParams.get('before'),
        after: url.searchParams.get('after'),
      })
      if (result.error)
        return error(res, result.error.status, result.error.code, result.error.message, result.error.fields)
      return json(res, 200, result)
    }
    if (req.method === 'PATCH' && parts[0] === 'incidents' && parts.length === 2) {
      if (!can(user, 'incidents.manage'))
        return error(res, 403, 'FORBIDDEN', 'No tenes permiso para revisar incidentes')
      const payload = await body(req)
      if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        return error(res, 422, 'VALIDATION_ERROR', 'El body debe ser un objeto JSON')
      const result = reviewIncident(parts[1], payload, user.id)
      if (result.error)
        return error(res, result.error.status, result.error.code, result.error.message, result.error.fields)
      return json(res, 200, { incident: result.incident })
    }
    if (req.method === 'PATCH' && parts[0] === 'residents' && parts.length === 2) {
      if (!can(user, 'residents.write'))
        return error(res, 403, 'FORBIDDEN', 'No tenes permiso para gestionar Residentes')
      const payload = await body(req)
      if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        return error(res, 422, 'VALIDATION_ERROR', 'El body debe ser un objeto JSON')
      const result = updateResident(parts[1], payload, user.id)
      if (result.error)
        return error(res, result.error.status, result.error.code, result.error.message, result.error.fields)
      return json(res, 200, result)
    }
    if (req.method === 'POST' && parts[0] === 'residents' && parts[2] === 'discharge' && parts.length === 3) {
      if (!can(user, 'residents.write'))
        return error(res, 403, 'FORBIDDEN', 'No tenes permiso para gestionar Residentes')
      const result = dischargeResident(parts[1], await body(req), user.id)
      if (result.error)
        return error(res, result.error.status, result.error.code, result.error.message, result.error.fields)
      return json(res, 200, result)
    }
    if (req.method === 'POST' && parts[0] === 'residents' && parts[2] === 'notes') {
      if (!can(user, 'residents.notes.write'))
        return error(res, 403, 'FORBIDDEN', 'No tenes permiso para registrar notas')
      const payload = await body(req)
      if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        return error(res, 422, 'VALIDATION_ERROR', 'El body debe ser un objeto JSON')
      const result = createCareNote(parts[1], payload, user.id)
      if (result.error)
        return error(res, result.error.status, result.error.code, result.error.message, result.error.fields)
      return json(res, 201, result)
    }
    if (req.method === 'POST' && parts[0] === 'residents' && parts.length === 1) {
      if (!can(user, 'residents.write'))
        return error(res, 403, 'FORBIDDEN', 'No tenes permiso para gestionar Residentes')
      const payload = await body(req)
      if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        return error(res, 422, 'VALIDATION_ERROR', 'El body debe ser un objeto JSON')
      const result = createResident(payload, user.id)
      if (result.error)
        return error(res, result.error.status, result.error.code, result.error.message, result.error.fields)
      return json(res, 201, result)
    }
    if (req.method === 'POST' && parts[0] === 'residents' && parts[2] === 'assignments') {
      if (!can(user, 'residents.write'))
        return error(res, 403, 'FORBIDDEN', 'No tenes permiso para gestionar asignaciones')
      const payload = await body(req)
      if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        return error(res, 422, 'VALIDATION_ERROR', 'El body debe ser un objeto JSON')
      const result = assignBed(parts[1], payload, user.id)
      if (result.error)
        return error(res, result.error.status, result.error.code, result.error.message, result.error.fields)
      return json(res, 201, result)
    }

    /* Liberar una cama sin dar de alta al residente. Hasta ahora la unica forma
     * de vaciarla era el egreso, que es otra cosa: una cama queda libre cuando
     * alguien se muda de habitacion o mientras se decide donde ubicarlo, y el
     * residente sigue en la casa. */
    if (req.method === 'DELETE' && parts[0] === 'beds' && parts[2] === 'assignment' && parts.length === 3) {
      if (!can(user, 'residents.write'))
        return error(res, 403, 'FORBIDDEN', 'No tenes permiso para gestionar asignaciones')
      const result = releaseBed(parts[1], user.id)
      if (result.error)
        return error(res, result.error.status, result.error.code, result.error.message, result.error.fields)
      return json(res, 200, result)
    }
  } catch (cause) {
    if (cause.message === 'invalid json') return error(res, 400, 'INVALID_JSON', 'El body debe ser JSON valido')
    if (cause.message === 'payload too large')
      return error(res, 413, 'PAYLOAD_TOO_LARGE', 'El payload excede el limite')
    if (cause.code === 'SQLITE_CONSTRAINT_UNIQUE') return error(res, 409, 'CONFLICT', 'El recurso ya existe')
    console.error(cause)
    return error(res, 500, 'INTERNAL_ERROR', 'Error interno')
  }
  return error(res, 404, 'NOT_FOUND', 'Ruta no encontrada')
})

/* Las permanencias vencen por el paso del tiempo, no por un evento nuevo: sin
 * este barrido, una alarma de "cuarenta minutos fuera de la cama" dependeria de
 * que el monitor repita el estado. */
const SWEEP_SECONDS = Number(process.env.ALARM_SWEEP_SECONDS || 60)

export function runDwellSweep(now = new Date()) {
  const receivedAt = timestamp()
  let created = 0
  for (const entry of sweepDecisions(now)) {
    for (const decision of entry.decisions) {
      db.prepare(
        `INSERT INTO alerts
        (id, resident_id, bed_id, sensor_event_id, kind, level, status, title, detail, occurred_at, created_at, updated_at)
        VALUES (?, ?, ?, NULL, ?, ?, 'open', ?, ?, ?, ?, ?)`,
      ).run(
        newId('alert'),
        entry.residentId,
        entry.bedId,
        decision.ruleId,
        decision.level,
        decision.title,
        decision.detail,
        now.toISOString(),
        receivedAt,
        receivedAt,
      )
      created += 1
    }
  }
  return created
}

if (SWEEP_SECONDS > 0) {
  const sweep = setInterval(() => {
    try {
      runDwellSweep()
    } catch (cause) {
      console.error('[virtual-rounds-api] barrido de permanencias fallido', cause)
    }
  }, SWEEP_SECONDS * 1000)
  sweep.unref()
}

server.listen(PORT, HOST, () => {
  console.log(`[virtual-rounds-api] escuchando http://${HOST}:${PORT}`)
  console.log(`  GET http://${HOST}:${PORT}/health`)
})

const shutdown = () => {
  server.close(() => {
    closeDb()
    process.exit(0)
  })
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

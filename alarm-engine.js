/* Motor de alarmas: traduce un cambio de estado observado en la habitacion a la
 * alerta que el equipo recibe, aplicando la configuracion del residente.
 *
 * Hasta acá la configuracion se guardaba, se auditaba y se explicaba, pero la
 * ingesta decidia con una politica fija. Este modulo cierra ese hueco para las
 * reglas que el vocabulario actual del monitor permite resolver:
 *
 *   bed_exit, bed_edge, sitting_in_bed, bed_entry — transiciones observadas
 *   out_of_bed_dwell, in_bed_dwell, room_absence_dwell — permanencias
 *
 * Las otras reglas del catalogo necesitan eventos que el detector todavia no
 * emite (bano, area comun, exterior, piso, silla, apoyo, sueno fuera de la
 * cama). Mientras no lleguen, se configuran pero no disparan: `ENGINE_RULES` es
 * la lista de lo que hoy es operativo, y `pendingRules()` la de lo que espera al
 * detector.
 *
 * El sueno queda entero del lado pendiente aunque el monitor ya emita
 * `sleeping`: el flag se persiste como estado actual, pero no hay marca de
 * cuando empezo el episodio, y una permanencia sin su propio `since` no se puede
 * vencer. Es una adicion de esquema, no una regla que se pueda improvisar. */

import { db } from './db.js'
import {
  ACTION_LEVEL,
  ALARM_TRANSITIONS,
  SENSITIVITY_CALIBRATION,
  SHIFT_HOURS,
  predictRiskLevel,
  profileFromRow,
  readProfileRow,
  residentSignals,
  resolveRules,
  transitionById,
} from './alarm-presets.js'

export const ENGINE_RULES = [
  'bed_exit',
  'bed_edge',
  'sitting_in_bed',
  'bed_entry',
  'out_of_bed_dwell',
  'in_bed_dwell',
  'room_absence_dwell',
]

export function pendingRules() {
  return ALARM_TRANSITIONS.filter((transition) => !ENGINE_RULES.includes(transition.id)).map(
    (transition) => transition.id,
  )
}

const IN_BED = new Set(['laying_in_bed', 'sitting_in_bed', 'sitting_on_bed_edge'])
const OUT_OF_BED = new Set(['standing', 'unoccupied'])

export function waitSecondsFor(transition, rule) {
  const timer = transition.params.find((param) => param.type === 'number')
  const minutes = timer ? Number(rule.params[timer.key] ?? 0) : 0
  const sensitivity = String(rule.params.sensitivity ?? 'standard')
  if (!Number.isFinite(minutes) || minutes <= 0) return SENSITIVITY_CALIBRATION.floor_seconds[sensitivity] ?? 20
  return Math.round(minutes * 60 * (SENSITIVITY_CALIBRATION.factor[sensitivity] ?? 1))
}

/* El turno se resuelve en la hora local de la residencia, no en la del server:
 * una alarma nocturna configurada en Buenos Aires no puede depender de UTC. */
export function shiftFor(date, timezone = 'UTC') {
  let hour
  try {
    hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hour12: false }).format(date))
  } catch {
    hour = date.getUTCHours()
  }
  if (!Number.isFinite(hour)) hour = date.getUTCHours()
  return hour >= SHIFT_HOURS.day_start && hour < SHIFT_HOURS.night_start ? 'day' : 'night'
}

export function transitionBetween(previous, next) {
  if (!previous || !next || previous === next) return null
  if (IN_BED.has(previous) && OUT_OF_BED.has(next)) return 'bed_exit'
  if ((previous === 'laying_in_bed' || previous === 'sitting_in_bed') && next === 'sitting_on_bed_edge')
    return 'bed_edge'
  if (previous === 'laying_in_bed' && next === 'sitting_in_bed') return 'sitting_in_bed'
  /* Acostarse cierra el episodio: se reconoce desde cualquier estado anterior
   * conocido, venga de estar de pie, fuera de la habitacion o sentado al borde. */
  if (next === 'laying_in_bed' && previous !== 'unknown') return 'bed_entry'
  return null
}

/* Las reglas efectivas cambian una vez por dia (autopilot) o cuando alguien
 * guarda: recalcularlas en cada evento del sensor seria gasto puro. */
const RULES_TTL_MS = 60_000
const rulesCache = new Map()

export function clearAlarmRulesCache(residentId) {
  if (residentId) rulesCache.delete(residentId)
  else rulesCache.clear()
}

function parseTraits(value) {
  try {
    const parsed = JSON.parse(value || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function effectiveRulesFor(residentId, now = new Date()) {
  const cached = rulesCache.get(residentId)
  if (cached && cached.expires > now.valueOf()) return cached.rules

  const resident = db.prepare('SELECT id, traits_json FROM residents WHERE id = ?').get(residentId)
  if (!resident) return null
  const bedTraits = db
    .prepare(
      `SELECT b.traits_json FROM beds b
       JOIN resident_bed_assignments a ON a.bed_id = b.id AND a.ends_at IS NULL
       WHERE a.resident_id = ?`,
    )
    .get(residentId)
  const traits = [...new Set([...parseTraits(resident.traits_json), ...parseTraits(bedTraits?.traits_json)])]

  const profile = profileFromRow(readProfileRow(residentId), traits)
  const level = profile.autopilot
    ? predictRiskLevel(residentSignals(residentId, now), traits).level
    : profile.risk_level
  const rules = resolveRules({
    level,
    mobilityAid: profile.mobility_aid,
    mode: profile.mode,
    templateId: profile.template_id,
    overrides: profile.overrides,
  })
  rulesCache.set(residentId, { rules, expires: now.valueOf() + RULES_TTL_MS })
  return rules
}

function previousDistinctState(bedId, state, stateSince) {
  const row = db
    .prepare(
      `SELECT state FROM sensor_events
       WHERE bed_id = ? AND occurred_at <= ? AND state IS NOT ? AND state IS NOT NULL
       ORDER BY occurred_at DESC, rowid DESC LIMIT 1`,
    )
    .get(bedId, stateSince, state)
  return row?.state || null
}

/* Un episodio avisa una sola vez por regla: mientras el residente siga fuera de
 * la cama no se repite la alarma cada vez que llega un evento. */
function alreadyAlerted(bedId, ruleId, stateSince) {
  return Boolean(
    db
      .prepare('SELECT 1 FROM alerts WHERE bed_id = ? AND kind = ? AND occurred_at >= ?')
      .get(bedId, ruleId, stateSince),
  )
}

/* La zona horaria de la residencia se resuelve una vez por cama: la estructura
 * casi no cambia y el turno se decide en hora local, no en la del server. */
const bedTimezones = new Map()
export function facilityTimezoneForBed(bedId) {
  if (bedTimezones.has(bedId)) return bedTimezones.get(bedId)
  const row = db
    .prepare(
      `SELECT f.timezone FROM beds b
       JOIN rooms rm ON rm.id = b.room_id
       JOIN wings w ON w.id = rm.wing_id
       JOIN facilities f ON f.id = w.facility_id
       WHERE b.id = ?`,
    )
    .get(bedId)
  const timezone = row?.timezone || 'UTC'
  bedTimezones.set(bedId, timezone)
  return timezone
}

function candidateRules(state, roomState) {
  const rules = []
  if (!IN_BED.has(state) && state !== 'unknown') rules.push('out_of_bed_dwell')
  if (IN_BED.has(state)) rules.push('in_bed_dwell')
  if (state === 'unoccupied' || roomState === 'empty') rules.push('room_absence_dwell')
  return rules
}

/* Decide que alertas corresponden a este evento. No escribe nada: devuelve la
 * lista para que la ingesta la persista dentro de su propia transaccion. */
export function alarmDecisions({
  bedId,
  residentId,
  state,
  roomState,
  stateSince,
  occurredAt,
  timezone,
  dwellOnly = false,
}) {
  if (!residentId || !state) return []
  const rules = effectiveRulesFor(residentId, new Date(occurredAt))
  if (!rules) return []

  const shift = shiftFor(new Date(occurredAt), timezone)
  const since = stateSince || occurredAt
  const elapsedSeconds = Math.max(0, (new Date(occurredAt).valueOf() - new Date(since).valueOf()) / 1000)
  const decisions = []

  const consider = (ruleId, detailPrefix) => {
    const rule = rules[ruleId]
    const transition = transitionById(ruleId)
    if (!rule || !transition) return
    const action = rule[shift]
    if (action === 'off') return
    const wait = waitSecondsFor(transition, rule)
    if (elapsedSeconds < wait) return
    if (alreadyAlerted(bedId, ruleId, since)) return
    decisions.push({
      ruleId,
      action,
      level: ACTION_LEVEL[action] || 'medium',
      title: transition.label,
      detail: `${detailPrefix} · turno ${shift === 'day' ? 'dia' : 'noche'}`,
    })
  }

  if (!dwellOnly) {
    const transitionId = transitionBetween(previousDistinctState(bedId, state, since), state)
    if (transitionId && ENGINE_RULES.includes(transitionId)) consider(transitionId, 'Transicion observada')
  }

  for (const ruleId of candidateRules(state, roomState)) {
    if (!ENGINE_RULES.includes(ruleId)) continue
    consider(ruleId, `Sostenido ${Math.round(elapsedSeconds / 60)} min`)
  }

  return decisions
}

/* Barrido de permanencias.
 *
 * Las reglas de permanencia se cumplen por el paso del tiempo, no por un evento:
 * un residente que lleva cuarenta minutos fuera de la cama no genera ningun
 * evento nuevo mientras siga ahi. Si solo se evaluara al recibir eventos, la
 * alarma dependeria de que el detector repita el estado.
 *
 * Este barrido reevalua los episodios abiertos y no necesita nada del detector:
 * lee el estado actual que ya esta persistido. */
export function sweepDecisions(now = new Date()) {
  const rows = db
    .prepare(
      `SELECT bed_id, resident_id, state, room_state, state_since
       FROM current_bed_states
       WHERE resident_id IS NOT NULL AND state_since IS NOT NULL`,
    )
    .all()

  const pending = []
  for (const row of rows) {
    const decisions = alarmDecisions({
      bedId: row.bed_id,
      residentId: row.resident_id,
      state: row.state,
      roomState: row.room_state,
      stateSince: row.state_since,
      occurredAt: now.toISOString(),
      timezone: facilityTimezoneForBed(row.bed_id),
      /* El barrido solo cierra permanencias vencidas: una transicion se
       * reconoce cuando ocurre, no una hora despues. */
      dwellOnly: true,
    })
    if (decisions.length) pending.push({ bedId: row.bed_id, residentId: row.resident_id, decisions })
  }
  return pending
}

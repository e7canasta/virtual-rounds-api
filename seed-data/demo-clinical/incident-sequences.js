import { atDay } from './wellbeing.js'

/* Secuencia de estados alrededor de cada incidente.
 *
 * Un incidente sin su secuencia es una fila en una tabla: dice que paso algo,
 * no que paso. La revision de una caida es exactamente esa secuencia — borde
 * de cama, de pie, en el piso, staff entra — y de ella salen las dos medidas
 * que importan: cuanto tardo la respuesta y cuanto estuvo en el piso.
 *
 * Los offsets son minutos relativos al `occurred_at` del incidente: negativos
 * antes, positivos despues.
 */

/* Como se ve cada tipo de incidente en la secuencia de estados. */
const SEQUENCES = {
  fall: [
    { at: -9, roomState: 'resident_in_bed', substate: 'settled', state: 'laying_in_bed', level: 'low' },
    { at: -3, roomState: 'resident_in_bed', substate: 'head_off_bed', state: 'sitting_on_bed_edge', level: 'high' },
    { at: -1, roomState: 'occupied', substate: null, state: 'standing', level: 'medium' },
    { at: 0, roomState: 'on_floor', substate: 'laying', state: 'laying_on_floor', level: 'high' },
    { at: 3, roomState: 'on_floor', substate: 'sitting', state: 'sitting_on_floor', level: 'high' },
    /* `assisted` marca la llegada del staff: cierra el tiempo en el piso. */
    { at: 6, roomState: 'assisted', substate: null, state: 'standing', level: 'low' },
    { at: 14, roomState: 'resident_in_bed', substate: 'settled', state: 'laying_in_bed', level: 'low' },
  ],
  bed_exit: [
    { at: -6, roomState: 'resident_in_bed', substate: 'settled', state: 'laying_in_bed', level: 'low' },
    { at: -2, roomState: 'resident_in_bed', substate: 'limb_near_edge', state: 'sitting_in_bed', level: 'medium' },
    { at: 0, roomState: 'resident_in_bed', substate: 'head_off_bed', state: 'sitting_on_bed_edge', level: 'high' },
    { at: 2, roomState: 'occupied', substate: null, state: 'standing', level: 'medium' },
    { at: 4, roomState: 'assisted', substate: null, state: 'standing', level: 'low' },
    { at: 11, roomState: 'resident_in_bed', substate: 'settled', state: 'laying_in_bed', level: 'low' },
  ],
  wandering: [
    { at: -8, roomState: 'resident_in_bed', substate: 'settled', state: 'laying_in_bed', level: 'low' },
    { at: -4, roomState: 'occupied', substate: null, state: 'standing', level: 'medium' },
    { at: 0, roomState: 'empty', substate: null, state: 'unoccupied', level: 'high' },
    { at: 9, roomState: 'assisted', substate: null, state: 'standing', level: 'low' },
    { at: 16, roomState: 'resident_in_bed', substate: 'settled', state: 'laying_in_bed', level: 'low' },
  ],
}

/* Los incidentes de la seed ocurren `atDay(now, 2, 3, 20)`; ver incidents.js. */
const INCIDENT_DAYS_AGO = 2
const INCIDENT_HOUR = 3
const INCIDENT_MINUTE = 20

export function generateIncidentSequences(profile, now) {
  const kind = profile.incident?.kind
  const steps = SEQUENCES[kind]
  if (!steps) return []
  const base = new Date(atDay(now, INCIDENT_DAYS_AGO, INCIDENT_HOUR, INCIDENT_MINUTE)).valueOf()
  return steps.map((step, index) => {
    const occurredAt = new Date(base + step.at * 60000).toISOString()
    return {
      id: `event-demo-seq-${profile.bedId}-${index}`,
      source_event_id: `demo-seq-${profile.bedId}-${index}`,
      bed_id: profile.bedId,
      resident_id: profile.residentId,
      kind: 'state_change',
      room_state: step.roomState,
      substate: step.substate,
      state: step.state,
      alert_level: step.level,
      occurred_at: occurredAt,
    }
  })
}

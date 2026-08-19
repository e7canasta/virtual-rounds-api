/* Estados actuales de la seed demo.
 *
 * La frescura NO se persiste: la API la deriva de la edad de `updated_at`
 * (monitoring.live_after_seconds / stale_after_seconds). Por eso la semilla
 * fija la antiguedad de cada cama en segundos y deja que el servidor decida
 * la etiqueta. Asi la matriz live/stale/offline/not_observed queda cubierta
 * con datos reales, sin campos falsos.
 *
 * Nota operativa: las camas sembradas como `live` envejecen a `stale` a los
 * 30 s reales. Para una demo sostenida, `pnpm dev:monitor` mantiene viva la
 * 118; el resto queda fijo donde la semilla lo dejo.
 */

/* Cada entrada es un punto de la matriz que el panel tiene que saber pintar. */
export const DEMO_CURRENT_STATES = [
  {
    bedId: '118-0',
    residentId: 'resident-demo-118-0',
    agoSeconds: 0,
    roomState: 'resident_in_bed',
    state: 'laying_in_bed',
    substate: 'settled',
    sleeping: true,
    alertLevel: 'low',
    /* Historial corto para que el resumen pueda medir cuanto lleva asi. */
    history: [
      { agoMinutes: 214, state: 'standing', roomState: 'assisted', substate: 'transfer', alertLevel: 'low' },
      { agoMinutes: 212, state: 'laying_in_bed', roomState: 'resident_in_bed', substate: 'settled', alertLevel: 'low' },
    ],
  },
  {
    bedId: '201-0',
    residentId: 'resident-demo-201-0',
    agoSeconds: 5,
    roomState: 'resident_in_bed',
    state: 'sitting_on_bed_edge',
    substate: 'limb_near_edge',
    sleeping: false,
    alertLevel: 'high',
    history: [
      { agoMinutes: 41, state: 'laying_in_bed', roomState: 'resident_in_bed', substate: 'settled', alertLevel: 'low' },
      {
        agoMinutes: 6,
        state: 'sitting_in_bed',
        roomState: 'resident_in_bed',
        substate: 'awake',
        alertLevel: 'medium',
      },
    ],
  },
  {
    bedId: '201-1',
    residentId: 'resident-demo-201-1',
    agoSeconds: 75,
    roomState: 'assisted',
    state: 'standing',
    substate: 'transfer',
    sleeping: false,
    alertLevel: 'medium',
    history: [
      { agoMinutes: 95, state: 'laying_in_bed', roomState: 'resident_in_bed', substate: 'settled', alertLevel: 'low' },
    ],
  },
  {
    bedId: '202-0',
    residentId: 'resident-demo-202-0',
    agoSeconds: 10,
    roomState: 'room_empty',
    state: 'unoccupied',
    substate: null,
    sleeping: false,
    alertLevel: 'low',
    history: [
      { agoMinutes: 130, state: 'laying_in_bed', roomState: 'resident_in_bed', substate: 'settled', alertLevel: 'low' },
    ],
  },
  {
    bedId: '202-1',
    residentId: 'resident-demo-202-1',
    agoSeconds: 25 * 60,
    roomState: 'resident_in_bed',
    state: 'laying_in_bed',
    substate: 'settled',
    sleeping: true,
    alertLevel: 'low',
    history: [],
  },
  {
    bedId: '301-0',
    residentId: 'resident-demo-301-0',
    agoSeconds: 3 * 3600,
    roomState: 'assisted',
    state: 'out_of_view',
    substate: null,
    sleeping: false,
    alertLevel: 'medium',
    history: [
      { agoMinutes: 260, state: 'standing', roomState: 'assisted', substate: 'transfer', alertLevel: 'medium' },
    ],
  },
  /* 301-1 se deja deliberadamente sin fila: es el caso `not_observed`, el
   * unico que no se puede fabricar escribiendo un estado. */
]

export function generateCurrentStates(now = new Date()) {
  const states = []
  const events = []
  for (const entry of DEMO_CURRENT_STATES) {
    const updatedAt = new Date(now.valueOf() - entry.agoSeconds * 1000).toISOString()
    const eventId = `event-demo-state-${entry.bedId}`
    states.push({
      bed_id: entry.bedId,
      resident_id: entry.residentId,
      room_state: entry.roomState,
      state: entry.state,
      substate: entry.substate,
      sleeping: entry.sleeping ? 1 : 0,
      alert_level: entry.alertLevel,
      updated_at: updatedAt,
      source_event_id: eventId,
    })
    /* El estado actual siempre tiene su evento: el timeline y el estado
     * persistido cuentan la misma historia. */
    events.push({
      id: eventId,
      source_event_id: `demo-state-${entry.bedId}`,
      bed_id: entry.bedId,
      resident_id: entry.residentId,
      kind: 'state_change',
      room_state: entry.roomState,
      substate: entry.substate,
      state: entry.state,
      alert_level: entry.alertLevel,
      occurred_at: updatedAt,
    })
    for (const [index, step] of (entry.history || []).entries()) {
      events.push({
        id: `event-demo-hist-${entry.bedId}-${index}`,
        source_event_id: `demo-hist-${entry.bedId}-${index}`,
        bed_id: entry.bedId,
        resident_id: entry.residentId,
        kind: 'state_change',
        room_state: step.roomState,
        substate: step.substate,
        state: step.state,
        alert_level: step.alertLevel,
        occurred_at: new Date(now.valueOf() - step.agoMinutes * 60 * 1000).toISOString(),
      })
    }
  }
  return { states, events }
}

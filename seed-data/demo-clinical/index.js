import { DEMO_CLINICAL_PROFILES } from './profiles.js'
import { generateWellbeing } from './wellbeing.js'
import { generateCareNotes } from './care.js'
import { generateIncident } from './incidents.js'
import { generateAlerts } from './alerts.js'
import { generateIncidentSequences } from './incident-sequences.js'
import { DEMO_CURRENT_STATES, generateCurrentStates } from './states.js'

export function demoClinicalData(now = new Date()) {
  const data = {
    sleep: [],
    mobility: [],
    bathroom: [],
    notes: [],
    incidents: [],
    alerts: [],
    states: [],
    stateEvents: [],
  }
  for (const profile of DEMO_CLINICAL_PROFILES) {
    const wellbeing = generateWellbeing(profile, now)
    data.sleep.push(...wellbeing.sleep)
    data.mobility.push(...wellbeing.mobility)
    data.bathroom.push(...wellbeing.bathroom)
    const alerts = generateAlerts(profile, now)
    data.alerts.push(...alerts)
    data.notes.push(...generateCareNotes(profile, now, alerts))
    const incident = generateIncident(profile, now)
    if (incident) {
      data.incidents.push(incident)
      /* La secuencia de estados que rodea al incidente: sin ella no hay
       * revision posible, solo una fila en una tabla. */
      data.stateEvents.push(...generateIncidentSequences(profile, now))
    }
  }
  const current = generateCurrentStates(now)
  data.states = current.states
  data.stateEvents.push(...current.events)
  return data
}

export { DEMO_CLINICAL_PROFILES, DEMO_CURRENT_STATES }

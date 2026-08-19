import { PARAMETERS, getParameter } from './parameters.js'

export function projectSensorState(payload) {
  const roomState = payload.room_state
  const substate = payload.substate
  const sleeping = payload.sleeping === true && roomState === 'resident_in_bed'
  let state = payload.state || 'unknown'
  let alertLevel = payload.alert_level || 'low'

  if (roomState === 'empty') state = 'unoccupied'
  else if (roomState === 'unknown') state = 'unknown'
  else if (roomState === 'on_floor') {
    /* El catalogo de alarmas ya define `on_floor` como "acostado, sentado o
     * de rodillas" en el piso. Sin proyectarlo como estado, el motor puede
     * alarmar pero la ficha no puede reconstruir que paso: no hay secuencia
     * que revisar ni tiempo en el piso que medir. */
    state = substate === 'sitting' ? 'sitting_on_floor' : substate === 'kneeling' ? 'kneeling' : 'laying_on_floor'
    alertLevel = 'high'
  } else if (roomState === 'occupied') {
    state = 'standing'
    alertLevel = 'medium'
  } else if (roomState === 'assisted') {
    state = 'standing'
  } else if (roomState === 'resident_in_bed') {
    state =
      substate === 'head_off_bed' || substate === 'limb_out_of_bed'
        ? 'sitting_on_bed_edge'
        : substate === 'limb_near_edge'
          ? 'sitting_in_bed'
          : 'laying_in_bed'
    if (substate === 'head_off_bed') alertLevel = 'high'
    else if (substate === 'limb_out_of_bed' || substate === 'limb_near_edge') alertLevel = 'medium'
  }

  return { state, alertLevel, roomState, sleeping }
}

export function monitoringFreshness(updatedAt, now = new Date()) {
  if (!updatedAt) return 'not_observed'
  const ageSeconds = Math.max(0, (now.valueOf() - new Date(updatedAt).valueOf()) / 1000)
  if (!Number.isFinite(ageSeconds)) return 'not_observed'
  if (ageSeconds <= getParameter('monitoring.live_after_seconds', PARAMETERS.monitoring.liveAfterSeconds)) return 'live'
  if (ageSeconds <= getParameter('monitoring.stale_after_seconds', PARAMETERS.monitoring.staleAfterSeconds))
    return 'stale'
  return 'offline'
}

export function monitoringLabel(state, substate) {
  const labels = {
    laying_in_bed: 'Acostado en cama',
    sitting_in_bed: 'Sentado en cama',
    sitting_on_bed_edge: 'Al borde de la cama',
    standing: 'De pie',
    laying_on_floor: 'Acostado en el piso',
    sitting_on_floor: 'Sentado en el piso',
    kneeling: 'De rodillas',
    unoccupied: 'Cama desocupada',
    unknown: 'Sin observacion',
  }
  if (substate === 'head_off_bed') return 'Cabeza fuera de la cama'
  if (substate === 'limb_out_of_bed') return 'Extremidad fuera de la cama'
  return labels[state] || 'Estado no disponible'
}

export function alertDescription(payload, level) {
  if (level === 'high')
    return { title: 'Riesgo de salida de cama', detail: payload.substate || 'Estado de alta prioridad' }
  if (payload.room_state === 'occupied')
    return { title: 'Residente fuera de cama', detail: payload.substate || 'Movimiento detectado' }
  return { title: 'Estado que requiere atencion', detail: payload.substate || payload.kind }
}

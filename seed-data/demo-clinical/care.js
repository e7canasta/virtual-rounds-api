import { atDay } from './wellbeing.js'

/* Actividad de cuidado de una semana.
 *
 * El panel de Cuidado agrega por tipo, por hora y por dia, asi que la seed
 * necesita densidad real: unas pocas notas sueltas no permiten ver una brecha
 * de atencion ni una distribucion horaria. Cada rutina declara su horario y
 * su duracion tipica; las notas del perfil se mantienen como el registro
 * narrativo de esa semana.
 */

/* Rutinas diarias por tipo, con la hora en que suelen ocurrir y cuanto duran.
 * Las tardes quedan deliberadamente flojas: es la brecha que el mockup de UX
 * usa como hallazgo. */
const DAILY_ROUTINE = [
  { kind: 'hygiene', hour: 7, minutes: 22 },
  { kind: 'meal', hour: 9, minutes: 25 },
  { kind: 'medication', hour: 11, minutes: 8 },
  { kind: 'meal', hour: 13, minutes: 28 },
  { kind: 'observation', hour: 19, minutes: 10 },
  { kind: 'meal', hour: 20, minutes: 24 },
  { kind: 'medication', hour: 22, minutes: 7 },
]

export function generateCareNotes(profile, now, alerts = []) {
  const events = []
  const routine = profile.care?.routine ?? DAILY_ROUTINE
  const extra = profile.care?.extra ?? []

  /* Atencion que responde a una alerta: se registra pocos minutos despues, y
   * por eso el endpoint la deriva como reactiva. El par alerta → registro es
   * el mismo hecho contado en dos vistas. */
  for (const [index, alert] of alerts.entries()) {
    const respondedAt = alert.attended_at ?? alert.occurred_at
    events.push({
      id: `care-demo-${profile.bedId}-alert-${index}`,
      resident_id: profile.residentId,
      author_id: 'user-staff',
      kind: 'assistance',
      body: 'Atencion tras aviso del sistema.',
      duration_minutes: 9,
      created_at: respondedAt,
      updated_at: respondedAt,
    })
  }

  /* Dos semanas: la vista compara la ventana reciente contra la anterior, y
   * con solo 7 dias el delta nunca tendria contra que medirse. */
  for (let dayAgo = 13; dayAgo >= 0; dayAgo -= 1) {
    /* La semana previa tiene algo menos de atencion, para que el delta se vea
     * y no quede clavado en cero. */
    const weekFactor = dayAgo >= 7 ? 0.88 : 1
    for (const [index, step] of routine.entries()) {
      /* Un minuto de dispersion por dia evita que todos los residentes
       * compartan exactamente el mismo horario. */
      const drift = ((dayAgo * 7 + index * 3) % 11) - 5
      const createdAt = atDay(now, dayAgo, step.hour, Math.max(0, 15 + drift))
      events.push({
        id: `care-demo-${profile.bedId}-${dayAgo}-${index}`,
        resident_id: profile.residentId,
        author_id: 'user-staff',
        kind: step.kind,
        body: CARE_BODIES[step.kind] ?? 'Registro de cuidado.',
        duration_minutes: Math.max(1, Math.round((step.minutes + (((dayAgo + index) % 5) - 2)) * weekFactor)),
        created_at: createdAt,
        updated_at: createdAt,
      })
    }
    /* Rutinas propias del perfil (transferencias, acompanamiento al bano). */
    for (const [index, step] of extra.entries()) {
      const createdAt = atDay(now, dayAgo, step.hour, 30)
      events.push({
        id: `care-demo-${profile.bedId}-${dayAgo}-x${index}`,
        resident_id: profile.residentId,
        author_id: 'user-staff',
        kind: step.kind,
        body: CARE_BODIES[step.kind] ?? 'Registro de cuidado.',
        duration_minutes: Math.max(1, Math.round(step.minutes * weekFactor)),
        created_at: createdAt,
        updated_at: createdAt,
      })
    }
  }

  /* Las notas narrativas del perfil siguen existiendo: son el registro
   * clinico que la pestana de Cuidado no muestra pero el equipo si lee. */
  for (const [index, [kind, body]] of (profile.notes ?? []).entries()) {
    const createdAt = atDay(now, index + 1, 8 + index * 4, 15)
    events.push({
      id: `note-demo-${profile.bedId}-${index + 1}`,
      resident_id: profile.residentId,
      author_id: 'user-staff',
      kind,
      body,
      duration_minutes: null,
      created_at: createdAt,
      updated_at: createdAt,
    })
  }

  return events
}

const CARE_BODIES = {
  hygiene: 'Higiene matinal completada.',
  meal: 'Asistencia durante la comida.',
  medication: 'Administracion de medicacion segun indicacion.',
  observation: 'Control de ronda sin novedades.',
  transfer: 'Transferencia asistida.',
  bathroom: 'Acompanamiento al bano.',
  assistance: 'Asistencia general registrada.',
}

import { atDay } from './wellbeing.js'

/* Alertas de la semana.
 *
 * Sin historial de alertas, todo el cuidado registrado se lee como proactivo:
 * la pestana de Cuidado deriva "reactivo" de si hubo una alerta del residente
 * en la ventana previa. La seed necesita el contrapunto para que esa lectura
 * se pueda ver — y para que el par alerta → atencion sea coherente entre
 * ambas vistas.
 */

const ALERT_TITLES = {
  bed_exit: { title: 'Riesgo de salida de cama', detail: 'Movimiento cerca del borde de la cama' },
  wandering: { title: 'Deambulacion detectada', detail: 'Salida del area asignada' },
  transfer: { title: 'Transferencia sin asistencia', detail: 'Movimiento de cama a silla' },
}

/* Cuantas alertas por dia y a que hora, segun el perfil operativo. Los
 * residentes con fall_risk o wandering generan mas, que es justamente lo que
 * el perfil describe. */
export function generateAlerts(profile, now) {
  const plan = profile.alerts
  if (!plan) return []
  const alerts = []
  for (let dayAgo = 6; dayAgo >= 0; dayAgo -= 1) {
    for (const [index, step] of plan.entries()) {
      /* No todos los dias disparan: si no, la alerta deja de ser un evento. */
      if ((dayAgo + index) % step.everyDays !== 0) continue
      const occurredAt = atDay(now, dayAgo, step.hour, 5)
      const copy = ALERT_TITLES[step.kind] ?? ALERT_TITLES.bed_exit
      alerts.push({
        id: `alert-demo-${profile.bedId}-${dayAgo}-${index}`,
        resident_id: profile.residentId,
        bed_id: profile.bedId,
        kind: step.kind,
        level: step.level,
        status: 'closed',
        title: copy.title,
        detail: copy.detail,
        occurred_at: occurredAt,
        /* La atencion queda registrada: es el mismo evento que en Cuidado
         * aparece como respuesta reactiva. */
        attended_at: new Date(new Date(occurredAt).valueOf() + step.responseMinutes * 60000).toISOString(),
        attended_by: 'user-staff',
      })
    }
  }
  return alerts
}

function isoDay(now, daysAgo) {
  const date = new Date(now.valueOf() - daysAgo * 86400000)
  return date.toISOString().slice(0, 10)
}

function atDay(now, daysAgo, hour, minute = 0) {
  const date = new Date(now.valueOf() - daysAgo * 86400000)
  date.setHours(hour, minute, 0, 0)
  return date.toISOString()
}

function variation(index, amount) {
  return ((index * 17) % (amount * 2 + 1)) - amount
}

/* Desvio del ultimo dia.
 *
 * Sin esto la serie es un serrucho regular y todos los residentes leen
 * "Habitual": el Resumen nunca muestra un desvio y la banda de Insights no
 * tiene nada que titular. `deviation` mueve solo el ultimo dia respecto de la
 * linea base del propio residente, que es exactamente lo que el panel compara.
 */
function deviate(value, factor) {
  if (!factor) return value
  return Math.max(0, Math.round(value * (1 + factor)))
}

export function generateWellbeing(profile, now) {
  const sleep = []
  const mobility = []
  const bathroom = []
  const deviation = profile.deviation || {}
  for (let index = 0; index < 14; index += 1) {
    const observedOn = isoDay(now, 13 - index)
    /* Solo el dia mas reciente se desvia: los 13 anteriores son la base. */
    const last = index === 13
    const sleepFactor = last ? deviation.sleep : 0
    const outBedFactor = last ? deviation.outBed : 0
    const bathroomFactor = last ? deviation.bathroom : 0
    sleep.push({
      id: `sleep-demo-${profile.bedId}-${observedOn}`,
      source_record_id: `sleep-demo-${profile.bedId}-${observedOn}`,
      resident_id: profile.residentId,
      observed_on: observedOn,
      sleep_started_at: atDay(now, 14 - index, 22, 15 + (index % 3) * 5),
      sleep_ended_at: atDay(now, 13 - index, 6, 30 + (index % 2) * 15),
      calm_minutes: deviate(Math.max(0, profile.sleep.calm + variation(index, 18)), sleepFactor),
      restless_minutes: Math.max(0, profile.sleep.restless + variation(index, 8)),
      awake_minutes: Math.max(0, profile.sleep.awake + variation(index, 6)),
      out_of_bed_minutes: Math.max(0, profile.sleep.outOfBed + variation(index, 25)),
      bed_exit_count: Math.max(0, profile.sleep.exits + (index % 5 === 0 ? 1 : 0)),
      /* Los despertares son episodios, no minutos: puede haber mas que salidas
       * (despertarse y no salir de la cama) pero nunca menos por noche. */
      wake_count: Math.max(
        0,
        profile.sleep.exits + (index % 5 === 0 ? 1 : 0),
        profile.sleep.wakes + variation(index, 2),
      ),
    })
    /* Invariante de ingesta: el dia observado no puede superar 1440 minutos.
     * La variacion de cada eje empujaba la suma por encima en los perfiles de
     * mucha actividad; el excedente se recorta de la menor de las dos
     * componentes moviles, no del tiempo en cama. */
    const inBed = Math.max(0, profile.mobility.inBed + variation(index, 30))
    const rawOutBed = Math.max(0, profile.mobility.outBed + variation(index, 30))
    const outBed = Math.min(rawOutBed, Math.max(0, 1440 - inBed))
    const outSight = Math.min(
      Math.max(0, profile.mobility.outSight + variation(index, 20)),
      Math.max(0, 1440 - inBed - outBed),
    )
    mobility.push({
      id: `mobility-demo-${profile.bedId}-${observedOn}`,
      source_record_id: `mobility-demo-${profile.bedId}-${observedOn}`,
      resident_id: profile.residentId,
      observed_on: observedOn,
      in_bed_minutes: inBed,
      out_of_bed_minutes: deviate(outBed, outBedFactor),
      out_of_sight_minutes: outSight,
      walking_minutes: profile.mobility.speed === null ? 0 : Math.max(0, 80 + variation(index, 12)),
      walking_distance_meters:
        profile.mobility.speed === null ? null : Math.max(0, profile.mobility.speed * 300 + variation(index, 25)),
      walking_speed_mps:
        profile.mobility.speed === null ? null : Math.max(0.1, profile.mobility.speed + variation(index, 5) / 100),
      transfer_count: Math.max(0, profile.mobility.transfers + (index % 4 === 0 ? 1 : 0)),
    })
    /* Uso del bano. Las nocturnas y las asistidas son subconjuntos del total,
     * igual que valida la API: la seed no puede producir un resumen que la
     * ingesta rechazaria. */
    const visits = Math.max(1, deviate(profile.bathroom.visits + variation(index, 2), bathroomFactor))
    const nightVisits = Math.min(visits, Math.max(0, profile.bathroom.night + (index % 3 === 0 ? 1 : 0)))
    const assisted = Math.min(visits, Math.max(0, profile.bathroom.assisted + (index % 4 === 0 ? 1 : 0)))
    const totalMinutes = Math.max(visits, visits * profile.bathroom.minutesPerVisit)
    bathroom.push({
      id: `bathroom-demo-${profile.bedId}-${observedOn}`,
      source_record_id: `bathroom-demo-${profile.bedId}-${observedOn}`,
      resident_id: profile.residentId,
      observed_on: observedOn,
      visit_count: visits,
      night_visit_count: nightVisits,
      assisted_count: assisted,
      total_minutes: totalMinutes,
      longest_visit_minutes: Math.min(totalMinutes, profile.bathroom.minutesPerVisit + 6 + variation(index, 3)),
    })
  }
  return { sleep, mobility, bathroom }
}

export { atDay }

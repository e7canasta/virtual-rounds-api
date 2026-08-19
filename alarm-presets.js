/* Dominio de presets de alarma. Es la fuente de verdad de las transiciones
 * observables, de la calibracion por nivel de riesgo, de las plantillas de
 * perfil y de la prediccion diaria (autopilot). El panel no duplica la matriz:
 * la pide por `catalog` y resuelve la vista previa con la misma tabla que
 * aplica el servidor.
 *
 * Una regla efectiva se arma en capas: preset del nivel -> plantilla de perfil
 * -> ajustes manuales del residente. Cada capa se puede explicar en la UI. */

import { db } from './db.js'

export const RISK_LEVELS = ['low', 'medium', 'high']
export const MOBILITY_AIDS = ['none', 'walker', 'wheelchair']
export const ALARM_ACTIONS = ['off', 'notify', 'alarm']
export const ALARM_SHIFTS = ['day', 'night']
export const PRESET_MODES = ['preset', 'custom']
export const SENSITIVITIES = ['low', 'standard', 'high']

/* Corte operativo del turno, en hora local de la residencia. Lo publica el
 * catalogo para que el motor y la pantalla no puedan discrepar. */
export const SHIFT_HOURS = { day_start: 7, night_start: 19 }

/* Traduccion de la sensibilidad a cuanto se sostiene el estado antes de avisar.
 * Es calibracion de politica, no mecanismo: el motor solo la aplica. Con
 * confirmacion en cero igual hay un piso, porque sin el cualquier parpadeo del
 * detector se convierte en una alarma. */
export const SENSITIVITY_CALIBRATION = {
  factor: { low: 1.5, standard: 1, high: 0.5 },
  floor_seconds: { low: 60, standard: 20, high: 0 },
}

/* Que nivel de alerta produce cada accion. Tambien politica: quien recibe un
 * "notify" no ve lo mismo que quien recibe un "alarm". */
export const ACTION_LEVEL = { notify: 'medium', alarm: 'high' }

const PICTOGRAM_BASE = '/assets/pictogramas'
/* Los accesorios tienen su propia familia de dibujo: el objeto solo, con la
 * marca de advertencia. No es la figura del residente, porque la regla no habla
 * de el sino de lo que quedo mal en la habitacion. */
const AID_BASE = '/assets/aid'

export const ALARM_GROUPS = [
  {
    id: 'fall_prevention',
    label: 'Prevención de caídas',
    detail: 'Transiciones, posturas y exposición que anteceden a una caída.',
  },
  {
    id: 'location',
    label: 'Ubicación y permanencia',
    detail: 'Dónde quedó el residente y cuánto tiempo lleva ahí.',
  },
  {
    id: 'sleep',
    label: 'Sueño y descanso',
    detail: 'Cuándo se duerme, en qué postura y cuánto dura el episodio.',
  },
  /* Las tres primeras miran al residente. Esta mira la habitacion: el apoyo que
   * dejaron lejos, la baranda que nadie subio. Se evalua con el residente en la
   * cama, que es cuando el entorno tiene que estar listo: no hace falta decirlo
   * en cada regla. */
  {
    id: 'environment',
    label: 'Entorno y accesorios',
    detail: 'Lo que tiene que estar en su lugar mientras el residente está en la cama.',
  },
]

/* Cada regla declara sus parametros ajustables. El temporizador cambia de
 * sentido segun la regla: en una transicion es cuanto espera el sistema antes
 * de avisar; en una permanencia es cuanto tiempo tolera la situacion. */
const timerParam = (kind, max, step = 1) => ({
  key: kind === 'dwell' ? 'dwell_minutes' : 'delay_minutes',
  kind,
  type: 'number',
  label: kind === 'dwell' ? 'Avisar si supera' : 'Confirmar durante',
  detail:
    kind === 'dwell'
      ? 'Tiempo tolerado antes de avisar.'
      : 'Tiempo de confirmación antes de avisar. Cero avisa apenas se detecta.',
  unit: 'min',
  min: 0,
  max,
  step,
})

/* Un accesorio no se configura con un valor sino con una lista de condiciones.
 * La regla avisa si falla alguna de las que estan marcadas, y por eso son una
 * sola baldosa: el objeto es uno, lo que se le vigila puede ser mas de una cosa.
 * Las condiciones no se solapan a proposito —"al alcance" solo se evalua si el
 * accesorio esta— para que el aviso pueda decir cual de las dos fallo. */
const watchParam = (options) => ({
  key: 'watch',
  kind: 'watch',
  type: 'multi',
  label: 'Qué vigilar',
  detail: 'Avisa si falla alguna de las condiciones marcadas.',
  options,
})

const AID_WATCH = [
  { value: 'present', label: 'Que esté en la habitación', detail: 'Avisa si no está a la vista.' },
  {
    value: 'reach',
    label: 'Que esté al alcance',
    detail: 'Avisa si está en la habitación pero lejos de la cama.',
  },
]

const SENSITIVITY_PARAM = {
  key: 'sensitivity',
  kind: 'sensitivity',
  type: 'enum',
  label: 'Sensibilidad',
  detail: 'Cuánta evidencia pide el sistema antes de disparar la regla.',
  options: [
    { value: 'low', label: 'Baja', detail: 'Espera más evidencia. Avisa menos veces y más tarde.' },
    { value: 'standard', label: 'Estándar', detail: 'Equilibrio calibrado para el nivel.' },
    { value: 'high', label: 'Alta', detail: 'Avisa antes. Más avisos, incluye situaciones dudosas.' },
  ],
}

/* `short_label` es el texto de la baldosa: la grilla necesita que todas las
 * etiquetas ocupen lo mismo. `label` sigue siendo la frase completa que se lee
 * en el detalle, en la lista de cambios y en el lector de pantalla.
 *
 * `art` describe la familia visual del pictograma: `framed` trae su propio
 * marco, `line` es trazo sobre fondo de la baldosa y `scene` es una escena 3D
 * sobre fondo claro.
 *
 * Convencion de nombres (la grilla se lee sola, sin leyenda):
 *   evento      -> verbo:      "Sale de la cama", "Se sienta", "Duerme acostado"
 *   permanencia -> "Tiempo...": "Tiempo fuera de cama", "Tiempo sentado"
 * Un evento usa `confirm` (cuanto espera el sistema antes de darlo por cierto) y
 * una permanencia usa `dwell` (cuanto tolera la situacion). Que las dos cosas se
 * llamaran igual era la confusion de fondo: "Sale del cuarto" y "Fuera del
 * cuarto" son la misma frase para quien configura. */
export const ALARM_TRANSITIONS = [
  {
    id: 'fall',
    group: 'fall_prevention',
    label: 'Caída detectada',
    short_label: 'Caída',
    detail: 'Siempre activa. Ningún preset ni ajuste puede desactivarla.',
    pictogram: `${PICTOGRAM_BASE}/new_features_fall.webp`,
    art: 'framed',
    locked: true,
    requires_aid: null,
    params: [timerParam('confirm', 2), SENSITIVITY_PARAM],
  },
  {
    id: 'on_floor',
    group: 'fall_prevention',
    label: 'Residente en el piso',
    short_label: 'En el piso',
    detail: 'Detecta que quedó en el piso: acostado, sentado o de rodillas.',
    pictogram: `${PICTOGRAM_BASE}/laying_on_floor.webp`,
    art: 'figure',
    locked: false,
    requires_aid: null,
    params: [timerParam('confirm', 5), SENSITIVITY_PARAM],
  },
  {
    id: 'bed_exit',
    group: 'fall_prevention',
    label: 'Se levanta de la cama',
    short_label: 'Sale de la cama',
    detail: 'La transición con más caídas asociadas en la observación.',
    pictogram: `${PICTOGRAM_BASE}/getting_up_from_bed_large.webp`,
    art: 'framed',
    locked: false,
    requires_aid: null,
    params: [timerParam('confirm', 10), SENSITIVITY_PARAM],
  },
  {
    id: 'out_of_bed_dwell',
    group: 'fall_prevention',
    label: 'Mucho tiempo fuera de la cama',
    short_label: 'Tiempo fuera de cama',
    detail: 'Cuánto lleva levantado. De noche, es la exposición que sigue a la salida.',
    /* La cama vacia con la silla al lado: el dibujo dice "no esta en la cama".
     * Antes esta regla usaba `laying_in_bed`, alguien acostado *en* la cama. */
    pictogram: `${PICTOGRAM_BASE}/out_of_view.webp`,
    art: 'figure',
    locked: false,
    requires_aid: null,
    params: [timerParam('dwell', 120, 5), SENSITIVITY_PARAM],
  },
  {
    id: 'bed_edge',
    group: 'fall_prevention',
    label: 'Se sienta al borde de la cama',
    short_label: 'Borde de la cama',
    detail: 'Da margen para asistir antes de que intente salir.',
    pictogram: `${PICTOGRAM_BASE}/sitting_on_bed_edge.webp`,
    art: 'figure',
    locked: false,
    requires_aid: null,
    params: [timerParam('confirm', 10), SENSITIVITY_PARAM],
  },
  {
    id: 'sitting_in_bed',
    group: 'fall_prevention',
    label: 'Se incorpora en la cama',
    short_label: 'Se incorpora',
    detail: 'El aviso más temprano de la secuencia: todavía está dentro de la cama.',
    pictogram: `${PICTOGRAM_BASE}/sitting_in_bed.webp`,
    art: 'figure',
    locked: false,
    requires_aid: null,
    params: [timerParam('confirm', 15), SENSITIVITY_PARAM],
  },
  {
    id: 'chair_exit',
    group: 'fall_prevention',
    label: 'Se levanta de la silla',
    short_label: 'Sale de la silla',
    detail: 'Alerta cuando se incorpora, sobre todo después de estar en reposo.',
    pictogram: `${PICTOGRAM_BASE}/getting_up_from_chair_large.webp`,
    art: 'framed',
    locked: false,
    requires_aid: null,
    params: [timerParam('confirm', 10), SENSITIVITY_PARAM],
  },
  {
    id: 'wheelchair_exit',
    group: 'fall_prevention',
    label: 'Se levanta de la silla de ruedas',
    short_label: 'Silla de ruedas',
    detail: 'Las transferencias cama-silla concentran el mayor riesgo observado.',
    pictogram: `${PICTOGRAM_BASE}/getting_up_from_wheelchair_large.webp`,
    art: 'figure',
    locked: false,
    requires_aid: ['wheelchair'],
    params: [timerParam('confirm', 10), SENSITIVITY_PARAM],
  },
  {
    id: 'standing_unassisted',
    group: 'fall_prevention',
    label: 'De pie sin asistencia',
    short_label: 'De pie solo',
    detail: 'Se mantiene de pie en la habitación sin personal presente.',
    pictogram: `${PICTOGRAM_BASE}/standing.webp`,
    art: 'figure',
    locked: false,
    requires_aid: null,
    params: [timerParam('confirm', 15), SENSITIVITY_PARAM],
  },
  {
    id: 'walking_without_aid',
    group: 'fall_prevention',
    label: 'Camina sin su apoyo',
    short_label: 'Sin su apoyo',
    detail: 'Detecta marcha sin el andador o la silla que el residente necesita.',
    pictogram: `${PICTOGRAM_BASE}/walking_without_aid_large.webp`,
    art: 'framed',
    locked: false,
    requires_aid: ['walker', 'wheelchair'],
    params: [timerParam('confirm', 10), SENSITIVITY_PARAM],
  },
  /* Ubicacion y permanencia. Cada lugar tiene dos hechos distintos: llegar
   * (evento) y seguir ahi (permanencia). Sentarse o acostarse no son caidas
   * —quien ya se sento no esta en la secuencia que antecede a una— pero si son
   * ubicaciones, y su duracion es lo que agrava el riesgo. */
  {
    id: 'bed_entry',
    group: 'location',
    label: 'Se acuesta en la cama',
    short_label: 'Se acuesta',
    detail: 'Confirma que volvió a la cama: cierra el episodio que abrió la salida.',
    pictogram: `${PICTOGRAM_BASE}/laying_in_bed.webp`,
    art: 'figure',
    locked: false,
    requires_aid: null,
    params: [timerParam('confirm', 10), SENSITIVITY_PARAM],
  },
  {
    id: 'in_bed_dwell',
    group: 'location',
    label: 'Mucho tiempo en la cama',
    short_label: 'Tiempo en la cama',
    detail: 'Permanencia en la cama durante el turno. Útil de día, para vigilar el encamamiento.',
    pictogram: `${PICTOGRAM_BASE}/laying_in_bed.webp`,
    art: 'figure',
    locked: false,
    requires_aid: null,
    params: [timerParam('dwell', 480, 15), SENSITIVITY_PARAM],
  },
  {
    id: 'chair_sit',
    group: 'location',
    label: 'Se sienta en la silla',
    short_label: 'Se sienta',
    detail: 'Confirma que quedó sentado: es el final de una transferencia, no una caída.',
    pictogram: `${PICTOGRAM_BASE}/sitting_in_chair.webp`,
    art: 'figure',
    locked: false,
    requires_aid: null,
    params: [timerParam('confirm', 10), SENSITIVITY_PARAM],
  },
  {
    id: 'wheelchair_sit',
    group: 'location',
    label: 'Se sienta en la silla de ruedas',
    short_label: 'En silla de ruedas',
    detail: 'Cierra la transferencia hacia la silla de ruedas.',
    pictogram: `${PICTOGRAM_BASE}/sitting_in_wheelchair.webp`,
    art: 'figure',
    locked: false,
    requires_aid: ['wheelchair'],
    params: [timerParam('confirm', 10), SENSITIVITY_PARAM],
  },
  {
    id: 'sitting_dwell',
    group: 'location',
    label: 'Mucho tiempo sentado',
    short_label: 'Tiempo sentado',
    detail: 'Sentado en silla o en silla de ruedas sin cambio de postura.',
    pictogram: `${PICTOGRAM_BASE}/sitting_in_chair.webp`,
    art: 'figure',
    locked: false,
    requires_aid: null,
    params: [timerParam('dwell', 240, 15), SENSITIVITY_PARAM],
  },
  {
    id: 'bathroom_visit',
    group: 'location',
    label: 'Entra al baño',
    short_label: 'Entra al baño',
    detail: 'Avisa el ingreso al baño, donde el sistema deja de observar la postura.',
    pictogram: `${PICTOGRAM_BASE}/out_of_view_bathroom.webp`,
    art: 'scene',
    locked: false,
    requires_aid: null,
    params: [timerParam('confirm', 10), SENSITIVITY_PARAM],
  },
  {
    id: 'bathroom_dwell',
    group: 'location',
    label: 'Mucho tiempo en el baño',
    short_label: 'Tiempo en el baño',
    detail: 'Avisa cuando la permanencia en el baño supera el tiempo configurado.',
    pictogram: `${PICTOGRAM_BASE}/out_of_view_bathroom.webp`,
    art: 'scene',
    locked: false,
    requires_aid: null,
    params: [timerParam('dwell', 60, 5), SENSITIVITY_PARAM],
  },
  {
    id: 'room_exit',
    group: 'location',
    label: 'Sale de la habitación',
    short_label: 'Sale del cuarto',
    detail: 'Salida hacia pasillo o área común.',
    pictogram: `${PICTOGRAM_BASE}/out_of_view_commonarea.webp`,
    art: 'scene',
    locked: false,
    requires_aid: null,
    params: [timerParam('confirm', 10), SENSITIVITY_PARAM],
  },
  {
    id: 'room_absence_dwell',
    group: 'location',
    label: 'Mucho tiempo fuera de la habitación',
    short_label: 'Tiempo sin volver',
    detail: 'Ausencia prolongada sin volver a la habitación.',
    pictogram: `${PICTOGRAM_BASE}/out_of_view_commonarea.webp`,
    art: 'scene',
    locked: false,
    requires_aid: null,
    params: [timerParam('dwell', 180, 5), SENSITIVITY_PARAM],
  },
  {
    id: 'outdoor_exit',
    group: 'location',
    label: 'Sale al exterior',
    short_label: 'Sale al exterior',
    detail: 'Salida al jardín o al exterior del edificio.',
    pictogram: `${PICTOGRAM_BASE}/out_of_view_garden.webp`,
    art: 'scene',
    locked: false,
    requires_aid: null,
    params: [timerParam('confirm', 5), SENSITIVITY_PARAM],
  },
  {
    id: 'outdoor_dwell',
    group: 'location',
    label: 'Mucho tiempo en el exterior',
    short_label: 'Tiempo afuera',
    detail: 'Permanencia prolongada fuera del edificio.',
    pictogram: `${PICTOGRAM_BASE}/out_of_view_garden.webp`,
    art: 'scene',
    locked: false,
    requires_aid: null,
    params: [timerParam('dwell', 180, 5), SENSITIVITY_PARAM],
  },

  /* Entorno y accesorios. Una baldosa por objeto, no por falla: el andador es
   * uno solo y quien configura piensa en el andador, no en dos reglas. Que se
   * le vigila —que este, que este al alcance— vive en el ajuste, que es donde
   * hay lugar para explicarlo.
   *
   * El posesivo distingue lo que es del residente (su andador, su silla de
   * ruedas: apoyos declarados en el perfil) de lo que hay en la habitacion (la
   * baranda, la silla). Es la misma marca que usa "Camina sin su apoyo". */
  {
    id: 'bed_rail',
    group: 'environment',
    label: 'Baranda de la cama',
    short_label: 'La baranda',
    detail: 'Con el residente en la cama, la baranda tiene que estar levantada y con su protector.',
    pictogram: `${AID_BASE}/bed_warn.webp`,
    art: 'figure',
    locked: false,
    requires_aid: null,
    params: [
      watchParam([
        { value: 'up', label: 'Que esté levantada', detail: 'Avisa si quedó abajo con el residente en la cama.' },
        { value: 'pad', label: 'Que tenga su protector', detail: 'Avisa si está levantada pero sin el acolchado.' },
      ]),
      timerParam('confirm', 15),
      SENSITIVITY_PARAM,
    ],
  },
  {
    id: 'wheelchair_aid',
    group: 'environment',
    label: 'Silla de ruedas del residente',
    short_label: 'Su silla de ruedas',
    detail: 'El apoyo declarado tiene que estar en la habitación y al alcance de la cama.',
    pictogram: `${AID_BASE}/wheelchair_warn.webp`,
    art: 'figure',
    locked: false,
    requires_aid: ['wheelchair'],
    params: [watchParam(AID_WATCH), timerParam('confirm', 30), SENSITIVITY_PARAM],
  },
  {
    id: 'chair_aid',
    group: 'environment',
    label: 'Silla de la habitación',
    short_label: 'La silla',
    detail: 'El punto de apoyo para sentarse fuera de la cama.',
    pictogram: `${AID_BASE}/chair_warn.webp`,
    art: 'figure',
    locked: false,
    requires_aid: null,
    params: [watchParam(AID_WATCH), timerParam('confirm', 30), SENSITIVITY_PARAM],
  },
  {
    id: 'walker_aid',
    group: 'environment',
    label: 'Andador del residente',
    short_label: 'Su andador',
    detail: 'El apoyo declarado tiene que estar en la habitación y al alcance de la cama.',
    pictogram: `${AID_BASE}/walker_warn.webp`,
    art: 'figure',
    locked: false,
    requires_aid: ['walker'],
    params: [watchParam(AID_WATCH), timerParam('confirm', 30), SENSITIVITY_PARAM],
  },

  /* Sueno y descanso. Es la tercera dimension observable —el monitor ya emite
   * `sleeping`— y hasta ahora solo existia del lado de la lectura (resumen de
   * sueno, bienestar). Aca se vuelve configurable: cuando se duerme, en que
   * postura y cuanto dura. Dormirse sentado o en la silla no es lo mismo que
   * dormirse acostado: el cuerpo se desliza y la respuesta del equipo cambia. */
  {
    id: 'sleep_in_bed',
    group: 'sleep',
    label: 'Se duerme en la cama',
    short_label: 'Duerme acostado',
    detail: 'Se durmió acostado en la cama, la postura de descanso esperada.',
    pictogram: `${PICTOGRAM_BASE}/laying_in_bed_sleeping.webp`,
    art: 'figure',
    locked: false,
    requires_aid: null,
    params: [timerParam('confirm', 15), SENSITIVITY_PARAM],
  },
  {
    id: 'sleep_sitting_in_bed',
    group: 'sleep',
    label: 'Se duerme incorporado en la cama',
    short_label: 'Duerme incorporado',
    detail: 'Se durmió sentado en la cama: el cuerpo se desliza y puede terminar en el borde.',
    pictogram: `${PICTOGRAM_BASE}/sitting_in_bed_sleeping.webp`,
    art: 'figure',
    locked: false,
    requires_aid: null,
    params: [timerParam('confirm', 15), SENSITIVITY_PARAM],
  },
  {
    id: 'sleep_in_chair',
    group: 'sleep',
    label: 'Se duerme en la silla',
    short_label: 'Duerme en la silla',
    detail: 'Se durmió fuera de la cama, sentado. Sin apoyo lateral el deslizamiento es más probable.',
    pictogram: `${PICTOGRAM_BASE}/sitting_in_chair_sleeping.webp`,
    art: 'figure',
    locked: false,
    requires_aid: null,
    params: [timerParam('confirm', 15), SENSITIVITY_PARAM],
  },
  {
    id: 'sleep_dwell',
    group: 'sleep',
    label: 'Mucho tiempo dormido',
    short_label: 'Tiempo dormido',
    detail: 'Duración del episodio de sueño. De día avisa la somnolencia que se sale de la rutina.',
    pictogram: `${PICTOGRAM_BASE}/laying_in_bed_sleeping.webp`,
    art: 'figure',
    locked: false,
    requires_aid: null,
    params: [timerParam('dwell', 480, 15), SENSITIVITY_PARAM],
  },
]

const TRANSITIONS_BY_ID = new Map(ALARM_TRANSITIONS.map((transition) => [transition.id, transition]))

/* Calibracion por nivel. `t` es el temporizador de la regla (confirmacion o
 * permanencia, segun corresponda) y `s` la sensibilidad. */
const CALIBRATION = {
  fall: {
    low: ['alarm', 'alarm', 0, 'standard'],
    medium: ['alarm', 'alarm', 0, 'standard'],
    high: ['alarm', 'alarm', 0, 'high'],
  },
  on_floor: {
    low: ['alarm', 'alarm', 1, 'standard'],
    medium: ['alarm', 'alarm', 1, 'standard'],
    high: ['alarm', 'alarm', 0, 'high'],
  },
  bed_exit: {
    low: ['off', 'notify', 2, 'low'],
    medium: ['notify', 'alarm', 1, 'standard'],
    high: ['alarm', 'alarm', 0, 'high'],
  },
  bed_edge: {
    low: ['off', 'off', 3, 'low'],
    medium: ['off', 'notify', 2, 'standard'],
    high: ['notify', 'alarm', 1, 'high'],
  },
  sitting_in_bed: {
    low: ['off', 'off', 10, 'low'],
    medium: ['off', 'off', 5, 'standard'],
    high: ['off', 'notify', 3, 'standard'],
  },
  chair_exit: {
    low: ['off', 'off', 2, 'low'],
    medium: ['notify', 'notify', 1, 'standard'],
    high: ['alarm', 'alarm', 0, 'high'],
  },
  wheelchair_exit: {
    low: ['notify', 'notify', 1, 'standard'],
    medium: ['alarm', 'alarm', 0, 'standard'],
    high: ['alarm', 'alarm', 0, 'high'],
  },
  standing_unassisted: {
    low: ['off', 'off', 10, 'low'],
    medium: ['off', 'notify', 5, 'standard'],
    high: ['notify', 'alarm', 3, 'standard'],
  },
  walking_without_aid: {
    low: ['notify', 'alarm', 1, 'standard'],
    medium: ['alarm', 'alarm', 0, 'standard'],
    high: ['alarm', 'alarm', 0, 'high'],
  },
  bathroom_visit: {
    low: ['off', 'off', 0, 'low'],
    medium: ['off', 'notify', 0, 'standard'],
    high: ['notify', 'notify', 0, 'standard'],
  },
  bathroom_dwell: {
    low: ['off', 'notify', 25, 'low'],
    medium: ['notify', 'notify', 20, 'standard'],
    high: ['alarm', 'alarm', 15, 'high'],
  },
  /* Volver a la cama o quedar sentado son buenas noticias: no alarman en ningun
   * nivel. En nivel alto notifican porque cierran el episodio que abrio la
   * salida —el equipo necesita saber que la situacion se resolvio sola. */
  bed_entry: {
    low: ['off', 'off', 2, 'low'],
    medium: ['off', 'off', 1, 'standard'],
    high: ['notify', 'notify', 1, 'standard'],
  },
  /* La permanencia en la cama se vigila de dia (encamamiento), nunca de noche:
   * dormir ocho horas seguidas es el resultado buscado, no un aviso. */
  in_bed_dwell: {
    low: ['off', 'off', 360, 'low'],
    medium: ['off', 'off', 300, 'standard'],
    high: ['notify', 'off', 240, 'standard'],
  },
  out_of_bed_dwell: {
    low: ['off', 'notify', 60, 'low'],
    medium: ['off', 'notify', 45, 'standard'],
    high: ['notify', 'alarm', 30, 'high'],
  },
  chair_sit: {
    low: ['off', 'off', 2, 'low'],
    medium: ['off', 'off', 1, 'standard'],
    high: ['notify', 'off', 1, 'standard'],
  },
  wheelchair_sit: {
    low: ['off', 'off', 1, 'low'],
    medium: ['off', 'off', 1, 'standard'],
    high: ['notify', 'notify', 1, 'standard'],
  },
  /* Dos horas sentado sin cambio de postura es el umbral clasico de cuidado de
   * la piel: por eso el nivel alto tolera 120 minutos y no mas. */
  sitting_dwell: {
    low: ['off', 'off', 180, 'low'],
    medium: ['notify', 'off', 150, 'standard'],
    high: ['notify', 'notify', 120, 'standard'],
  },
  room_exit: {
    low: ['off', 'off', 0, 'low'],
    medium: ['off', 'notify', 0, 'standard'],
    high: ['notify', 'alarm', 0, 'high'],
  },
  room_absence_dwell: {
    low: ['off', 'notify', 90, 'low'],
    medium: ['off', 'notify', 60, 'standard'],
    high: ['notify', 'alarm', 30, 'high'],
  },
  outdoor_exit: {
    low: ['off', 'notify', 0, 'standard'],
    medium: ['notify', 'alarm', 0, 'standard'],
    high: ['alarm', 'alarm', 0, 'high'],
  },
  outdoor_dwell: {
    low: ['off', 'notify', 90, 'low'],
    medium: ['notify', 'alarm', 60, 'standard'],
    high: ['alarm', 'alarm', 30, 'high'],
  },
  /* Dormirse en la cama de noche es lo esperado y no avisa. De dia, en nivel
   * alto, notifica: la somnolencia diurna es un cambio que la direccion medica
   * quiere ver. */
  sleep_in_bed: {
    low: ['off', 'off', 5, 'low'],
    medium: ['off', 'off', 5, 'standard'],
    high: ['notify', 'off', 5, 'standard'],
  },
  sleep_sitting_in_bed: {
    low: ['off', 'off', 5, 'low'],
    medium: ['off', 'notify', 5, 'standard'],
    high: ['notify', 'notify', 3, 'high'],
  },
  sleep_in_chair: {
    low: ['off', 'notify', 5, 'low'],
    medium: ['notify', 'notify', 5, 'standard'],
    high: ['notify', 'alarm', 3, 'high'],
  },
  sleep_dwell: {
    low: ['off', 'off', 180, 'low'],
    medium: ['off', 'off', 150, 'standard'],
    high: ['notify', 'off', 120, 'standard'],
  },
  /* Entorno. La baranda es la unica que alarma sola: es la barrera fisica entre
   * el residente dormido y el piso. El resto notifica, porque el arreglo es ir a
   * la habitacion y acomodar algo, no correr.
   *
   * El quinto valor es que se vigila del accesorio. En nivel bajo alcanza con
   * que este al alcance —si esta al alcance, esta—; el nivel medio suma que
   * alguien no se lo haya llevado. El protector de la baranda entra solo en
   * nivel alto: es la unica condicion del grupo que no evita una caida sino un
   * golpe.
   *
   * "Al alcance" hereda la calibracion de la vieja regla `aid_out_of_reach` del
   * grupo de caidas, que esta reemplaza por accesorio. */
  bed_rail: {
    low: ['off', 'off', 10, 'low', ['up']],
    medium: ['off', 'notify', 5, 'standard', ['up']],
    high: ['notify', 'alarm', 3, 'high', ['up', 'pad']],
  },
  wheelchair_aid: {
    low: ['off', 'notify', 10, 'low', ['reach']],
    medium: ['notify', 'alarm', 5, 'standard', ['present', 'reach']],
    high: ['alarm', 'alarm', 2, 'high', ['present', 'reach']],
  },
  chair_aid: {
    low: ['off', 'off', 15, 'low', ['reach']],
    medium: ['off', 'notify', 10, 'standard', ['reach']],
    high: ['notify', 'notify', 10, 'standard', ['present', 'reach']],
  },
  walker_aid: {
    low: ['off', 'notify', 10, 'low', ['reach']],
    medium: ['notify', 'alarm', 5, 'standard', ['present', 'reach']],
    high: ['alarm', 'alarm', 2, 'high', ['present', 'reach']],
  },
}

function timerKey(transition) {
  const param = transition.params.find((item) => item.kind === 'dwell' || item.kind === 'confirm')
  return param ? param.key : null
}

function watchParamOf(transition) {
  return transition.params.find((param) => param.type === 'multi') || null
}

function buildPresetMatrix() {
  const matrix = {}
  for (const level of RISK_LEVELS) {
    matrix[level] = {}
    for (const transition of ALARM_TRANSITIONS) {
      const entry = CALIBRATION[transition.id]?.[level]
      if (!entry) continue
      const [day, night, timer, sensitivity, watch] = entry
      const params = { [timerKey(transition)]: timer, sensitivity }
      /* Una regla con condiciones vigila todas las que declara si el nivel no
       * dice otra cosa: el default nunca puede ser "no vigila nada". */
      const watchDefinition = watchParamOf(transition)
      if (watchDefinition) params.watch = watch || watchDefinition.options.map((option) => option.value)
      matrix[level][transition.id] = { day, night, params }
    }
  }
  return matrix
}

export const PRESET_MATRIX = buildPresetMatrix()

/* Plantillas de perfil: ajustes sobre el preset del nivel para situaciones
 * operativas concretas. No reemplazan el nivel de riesgo, lo especializan. */
export const ALARM_TEMPLATES = [
  {
    id: 'balanced',
    label: 'Equilibrada',
    detail: 'Solo el preset del nivel, sin ajustes de perfil.',
    recommended_for: [],
    rules: {},
  },
  {
    id: 'night_wandering',
    label: 'Deambulación nocturna',
    detail: 'Refuerza salidas de habitación y exterior durante la noche.',
    recommended_for: ['wandering'],
    rules: {
      room_exit: { night: 'alarm', day: 'notify' },
      room_absence_dwell: { night: 'alarm', params: { dwell_minutes: 20 } },
      outdoor_exit: { day: 'alarm', night: 'alarm' },
      bed_exit: { night: 'alarm' },
      out_of_bed_dwell: { night: 'alarm', params: { dwell_minutes: 20 } },
      /* Quien deambula de noche termina dormido donde lo agarro el cansancio:
       * en la silla, sin apoyo lateral. */
      sleep_in_chair: { night: 'alarm' },
    },
  },
  {
    id: 'wheelchair_transfers',
    label: 'Transferencias en silla',
    detail: 'Prioriza el momento de la transferencia y el apoyo al alcance.',
    recommended_for: ['wheelchair'],
    rules: {
      wheelchair_exit: { day: 'alarm', night: 'alarm', params: { delay_minutes: 0, sensitivity: 'high' } },
      /* La transferencia se cierra cuando quedo sentado: sin ese aviso el
       * equipo se entera de que empezo, no de que termino bien. */
      wheelchair_sit: { day: 'notify', night: 'notify' },
      wheelchair_aid: { day: 'alarm', night: 'alarm', params: { delay_minutes: 2 } },
      walking_without_aid: { day: 'alarm', night: 'alarm' },
    },
  },
  {
    id: 'bathroom_assist',
    label: 'Asistencia en el baño',
    detail: 'Acompaña el circuito del baño con tiempos más cortos.',
    recommended_for: [],
    rules: {
      bathroom_visit: { day: 'notify', night: 'notify' },
      bathroom_dwell: { day: 'alarm', night: 'alarm', params: { dwell_minutes: 10 } },
    },
  },
  {
    id: 'post_fall',
    label: 'Post caída',
    detail: 'Vigilancia reforzada de transiciones después de un evento.',
    recommended_for: ['fall_risk'],
    rules: {
      bed_edge: { day: 'notify', night: 'alarm', params: { delay_minutes: 0 } },
      sitting_in_bed: { day: 'notify', night: 'notify', params: { delay_minutes: 1 } },
      standing_unassisted: { day: 'notify', night: 'alarm', params: { delay_minutes: 1 } },
      chair_exit: { day: 'alarm', night: 'alarm' },
      on_floor: { params: { sensitivity: 'high' } },
    },
  },
]

const TEMPLATES_BY_ID = new Map(ALARM_TEMPLATES.map((template) => [template.id, template]))

const FACTOR_ART = '/assets/risk-factors'

/* Los factores con pictograma propio lo declaran aca: el panel no arma rutas de
 * assets por su cuenta. Los que no tienen imagen caen en un glifo del UI kit.
 * Andador y silla de ruedas son factores distintos porque son hechos distintos:
 * comparten peso pero no significado operativo. */
export const RISK_FACTORS = {
  fall_history: { id: 'fall_history', label: 'Caídas registradas', icon: `${FACTOR_ART}/fall.png` },
  bed_exits: { id: 'bed_exits', label: 'Salidas de cama nocturnas', icon: `${FACTOR_ART}/bed.png` },
  wakeups: { id: 'wakeups', label: 'Despertares nocturnos', icon: `${FACTOR_ART}/wakeup.png` },
  bathroom: { id: 'bathroom', label: 'Baños frecuentes', icon: `${FACTOR_ART}/bathroom.png` },
  night_activity: { id: 'night_activity', label: 'Actividad nocturna', icon: null },
  gait: { id: 'gait', label: 'Marcha lenta', icon: null },
  transfers: { id: 'transfers', label: 'Transferencias frecuentes', icon: null },
  walker: { id: 'walker', label: 'Usa andador', icon: `${FACTOR_ART}/walker.png` },
  wheelchair: { id: 'wheelchair', label: 'Usa silla de ruedas', icon: `${FACTOR_ART}/wheelchair.png` },
  wandering: { id: 'wandering', label: 'Deambulación', icon: `${FACTOR_ART}/deambulacion.png` },
}

const SIGNAL_WINDOW_DAYS = 14
const INCIDENT_WINDOW_DAYS = 90

export function alarmCatalog() {
  return {
    levels: RISK_LEVELS,
    mobility_aids: MOBILITY_AIDS,
    actions: ALARM_ACTIONS,
    shifts: ALARM_SHIFTS,
    shift_hours: SHIFT_HOURS,
    modes: PRESET_MODES,
    sensitivities: SENSITIVITIES,
    groups: ALARM_GROUPS,
    transitions: ALARM_TRANSITIONS,
    presets: PRESET_MATRIX,
    templates: ALARM_TEMPLATES,
    risk_factors: Object.values(RISK_FACTORS),
  }
}

export function transitionAvailable(transitionId, mobilityAid) {
  const transition = TRANSITIONS_BY_ID.get(transitionId)
  if (!transition) return false
  if (!transition.requires_aid) return true
  return transition.requires_aid.includes(mobilityAid)
}

export function transitionById(transitionId) {
  return TRANSITIONS_BY_ID.get(transitionId) || null
}

export function templateById(templateId) {
  return TEMPLATES_BY_ID.get(templateId) || null
}

function paramValue(transition, key, value) {
  const definition = transition.params.find((param) => param.key === key)
  if (!definition) return null
  if (definition.type === 'enum') return definition.options.some((option) => option.value === value) ? value : null
  /* Un conjunto vacio no es una configuracion valida: seria una regla encendida
   * que no puede disparar nunca. Para dejar de vigilar el accesorio esta la
   * accion "sin aviso", que ademas queda en el registro de cambios. */
  if (definition.type === 'multi') {
    if (!Array.isArray(value) || !value.length) return null
    const clean = definition.options.map((option) => option.value).filter((option) => value.includes(option))
    return clean.length === new Set(value).size && clean.length ? clean : null
  }
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount < definition.min || amount > definition.max) return null
  return amount
}

/* Reglas efectivas de un residente: preset del nivel, luego la plantilla de
 * perfil y por ultimo los ajustes manuales. Cada regla informa de que capa
 * viene para que la UI no tenga que adivinarlo. */
export function resolveRules({ level, mobilityAid, mode = 'preset', templateId = null, overrides = {} }) {
  const preset = PRESET_MATRIX[level] || PRESET_MATRIX.medium
  const template = templateId ? TEMPLATES_BY_ID.get(templateId) : null
  const rules = {}

  for (const transition of ALARM_TRANSITIONS) {
    if (!transitionAvailable(transition.id, mobilityAid)) continue
    const base = preset[transition.id] || { day: 'off', night: 'off', params: {} }
    const fromTemplate = template?.rules?.[transition.id] || {}
    const fromOverride = mode === 'custom' ? overrides[transition.id] || {} : {}

    const resolved = { day: base.day, night: base.night }
    const params = { ...(base.params || {}) }
    let source = 'preset'

    for (const shift of ALARM_SHIFTS) {
      if (!transition.locked && ALARM_ACTIONS.includes(fromTemplate[shift])) {
        resolved[shift] = fromTemplate[shift]
        source = 'template'
      }
    }
    for (const [key, value] of Object.entries(fromTemplate.params || {})) {
      const clean = paramValue(transition, key, value)
      if (clean !== null) {
        params[key] = clean
        source = 'template'
      }
    }
    for (const shift of ALARM_SHIFTS) {
      if (!transition.locked && ALARM_ACTIONS.includes(fromOverride[shift])) {
        resolved[shift] = fromOverride[shift]
        source = 'custom'
      }
    }
    for (const [key, value] of Object.entries(fromOverride)) {
      if (ALARM_SHIFTS.includes(key)) continue
      const clean = paramValue(transition, key, value)
      if (clean !== null) {
        params[key] = clean
        source = 'custom'
      }
    }

    rules[transition.id] = {
      day: resolved.day,
      night: resolved.night,
      group: transition.group,
      locked: transition.locked,
      source,
      customized: source === 'custom',
      params,
    }
  }
  return rules
}

function parseJson(value, fallback) {
  if (!value) return fallback
  try {
    const parsed = JSON.parse(value)
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

export function defaultMobilityAid(traits = []) {
  if (traits.includes('wheelchair')) return 'wheelchair'
  if (traits.includes('walker')) return 'walker'
  return 'none'
}

export function defaultRiskLevel(traits = []) {
  if (traits.includes('fall_risk') || traits.includes('wandering')) return 'medium'
  return 'low'
}

/* La plantilla sugerida sale del perfil operativo declarado, no del historial
 * clinico: es una recomendacion de configuracion, no un diagnostico. */
export function suggestedTemplate(traits = []) {
  const match = ALARM_TEMPLATES.find(
    (template) => template.recommended_for.length && template.recommended_for.some((trait) => traits.includes(trait)),
  )
  return match ? match.id : 'balanced'
}

/* `null` no es cero: una noche sin velocidad de marcha observada queda fuera
 * del promedio en vez de entrar como 0 y castigar el perfil. */
function numeric(value) {
  if (value === null || value === undefined || value === '') return NaN
  return Number(value)
}

function averageOf(values) {
  const usable = values.filter((value) => Number.isFinite(value))
  if (!usable.length) return null
  return usable.reduce((total, value) => total + value, 0) / usable.length
}

/* Senales observadas por residente en la ventana de analisis. Solo se usa lo
 * que la base ya tiene: si un dominio no fue observado, no cuenta como cero. */
export function residentSignals(residentId, now = new Date()) {
  const since = new Date(now.valueOf() - SIGNAL_WINDOW_DAYS * 86400000).toISOString().slice(0, 10)
  const incidentSince = new Date(now.valueOf() - INCIDENT_WINDOW_DAYS * 86400000).toISOString()

  const sleep = db
    .prepare(
      `SELECT bed_exit_count, wake_count, awake_minutes, restless_minutes, out_of_bed_minutes
       FROM sleep_summaries WHERE resident_id = ? AND observed_on >= ?`,
    )
    .all(residentId, since)

  const mobility = db
    .prepare(
      `SELECT walking_speed_mps, transfer_count, out_of_bed_minutes
       FROM mobility_summaries WHERE resident_id = ? AND observed_on >= ?`,
    )
    .all(residentId, since)

  const incidents = db
    .prepare(
      `SELECT kind, severity, status FROM incidents
       WHERE resident_id = ? AND (occurred_at IS NULL OR occurred_at >= ?)`,
    )
    .all(residentId, incidentSince)

  const bathroom = db
    .prepare(
      `SELECT visit_count FROM bathroom_summaries
       WHERE resident_id = ? AND observed_on >= ?`,
    )
    .all(residentId, since)

  return {
    nights_observed: sleep.length,
    days_observed: mobility.length,
    bathroom_days_observed: bathroom.length,
    bed_exits_per_night: averageOf(sleep.map((night) => numeric(night.bed_exit_count))),
    wakes_per_night: averageOf(sleep.map((night) => numeric(night.wake_count))),
    bathroom_visits_per_day: averageOf(bathroom.map((day) => numeric(day.visit_count))),
    awake_minutes_per_night: averageOf(
      sleep.map((night) => numeric(night.awake_minutes || 0) + numeric(night.restless_minutes || 0)),
    ),
    walking_speed_mps: averageOf(mobility.map((day) => numeric(day.walking_speed_mps))),
    transfers_per_day: averageOf(mobility.map((day) => numeric(day.transfer_count))),
    falls: incidents.filter((incident) => incident.kind === 'fall').length,
    severe_falls: incidents.filter((incident) => incident.kind === 'fall' && incident.severity === 'high').length,
    transfer_incidents: incidents.filter((incident) => incident.kind === 'transfer_incident').length,
  }
}

/* Prediccion diaria de nivel. Es una suma explicita de senales observadas: no
 * infiere un diagnostico ni cierra un caso, solo propone un nivel de alarma. */
export function predictRiskLevel(signals, traits = []) {
  const factors = []
  let score = 0
  let evaluated = 0

  /* Un mismo factor puede llegar por dos vias (un incidente y el perfil
   * declarado). Se acumula en una sola entrada para no repetir el chip. */
  const add = (factorId, points, detail) => {
    score += points
    const existing = factors.find((factor) => factor.id === factorId)
    if (existing) {
      existing.weight += points
      existing.detail = `${existing.detail} · ${detail}`
      return
    }
    factors.push({ ...RISK_FACTORS[factorId], detail, weight: points })
  }

  const aid = defaultMobilityAid(traits)

  if (signals.falls || signals.transfer_incidents) {
    evaluated += 1
    const events = signals.falls + signals.transfer_incidents
    add(
      'fall_history',
      (signals.falls ? 2 : 1) + (signals.severe_falls ? 1 : 0),
      `${events} evento${events === 1 ? '' : 's'} en ${INCIDENT_WINDOW_DAYS} días`,
    )
  }
  if (Number.isFinite(signals.bed_exits_per_night)) {
    evaluated += 1
    if (signals.bed_exits_per_night >= 3) add('bed_exits', 2, `${signals.bed_exits_per_night.toFixed(1)} por noche`)
    else if (signals.bed_exits_per_night >= 1.5)
      add('bed_exits', 1, `${signals.bed_exits_per_night.toFixed(1)} por noche`)
  }
  /* Los despertares son episodios, no salidas: el que se despierta no siempre
   * se levanta, pero el que se levanta siempre se desperto. Por eso comparten
   * origen pero suman por separado. */
  if (Number.isFinite(signals.wakes_per_night)) {
    evaluated += 1
    if (signals.wakes_per_night >= 6) add('wakeups', 2, `${signals.wakes_per_night.toFixed(1)} por noche`)
    else if (signals.wakes_per_night >= 4)
      add('wakeups', 1, `${signals.wakes_per_night.toFixed(1)} por noche`)
  }
  if (Number.isFinite(signals.awake_minutes_per_night)) {
    evaluated += 1
    if (signals.awake_minutes_per_night >= 120)
      add('night_activity', 1, `${Math.round(signals.awake_minutes_per_night)} min despierto por noche`)
  }
  if (Number.isFinite(signals.bathroom_visits_per_day)) {
    evaluated += 1
    if (signals.bathroom_visits_per_day >= 10)
      add('bathroom', 2, `${signals.bathroom_visits_per_day.toFixed(1)} visitas por día`)
    else if (signals.bathroom_visits_per_day >= 7)
      add('bathroom', 1, `${signals.bathroom_visits_per_day.toFixed(1)} visitas por día`)
  }
  /* La marcha solo pondera cuando el residente camina: en silla de ruedas la
   * ausencia de velocidad es el patron esperado, no un deterioro. */
  if (aid !== 'wheelchair' && Number.isFinite(signals.walking_speed_mps)) {
    evaluated += 1
    if (signals.walking_speed_mps < 0.5) add('gait', 2, `${signals.walking_speed_mps.toFixed(2)} m/s`)
    else if (signals.walking_speed_mps < 0.8) add('gait', 1, `${signals.walking_speed_mps.toFixed(2)} m/s`)
  }
  if (Number.isFinite(signals.transfers_per_day)) {
    evaluated += 1
    if (signals.transfers_per_day >= 8) add('transfers', 1, `${signals.transfers_per_day.toFixed(1)} por día`)
  }
  if (traits.includes('fall_risk')) {
    evaluated += 1
    add('fall_history', 1, 'Perfil con riesgo de caída declarado')
  }
  if (traits.includes('wandering')) {
    evaluated += 1
    add('wandering', 2, 'Deambulación registrada en el perfil')
  }
  if (aid !== 'none') {
    evaluated += 1
    add(aid, 1, aid === 'walker' ? 'Declarado en el perfil del residente' : 'Declarada en el perfil del residente')
  }

  const level = score >= 6 ? 'high' : score >= 3 ? 'medium' : 'low'
  return { level, score, factors, signals_evaluated: evaluated }
}

/* El actor se resuelve a nombre como en el resto de la API (rondas, notas,
 * incidentes): una configuracion clinica tiene que poder decir quien la firmo. */
export function readProfileRow(residentId) {
  return (
    db
      .prepare(
        `SELECT p.*, u.display_name AS updated_by_name
         FROM resident_alarm_profiles p
         LEFT JOIN users u ON u.id = p.updated_by
         WHERE p.resident_id = ?`,
      )
      .get(residentId) || null
  )
}

export function profileFromRow(row, traits = []) {
  if (!row) {
    return {
      risk_level: defaultRiskLevel(traits),
      mobility_aid: defaultMobilityAid(traits),
      autopilot: false,
      mode: 'preset',
      template_id: 'balanced',
      overrides: {},
      updated_at: null,
      updated_by: null,
      updated_by_name: null,
      source: 'default',
    }
  }
  return {
    risk_level: RISK_LEVELS.includes(row.risk_level) ? row.risk_level : defaultRiskLevel(traits),
    mobility_aid: MOBILITY_AIDS.includes(row.mobility_aid) ? row.mobility_aid : defaultMobilityAid(traits),
    autopilot: Boolean(row.autopilot),
    mode: PRESET_MODES.includes(row.mode) ? row.mode : 'preset',
    template_id: TEMPLATES_BY_ID.has(row.template_id) ? row.template_id : 'balanced',
    overrides: parseJson(row.overrides_json, {}),
    updated_at: row.updated_at,
    updated_by: row.updated_by,
    updated_by_name: row.updated_by_name ?? null,
    source: 'stored',
  }
}

/* Vista completa por residente: perfil guardado (o el derivado del perfil
 * operativo), reglas efectivas y la recomendacion del dia. */
export function alarmProfileView(resident, now = new Date()) {
  const traits = Array.isArray(resident.traits) ? resident.traits : parseJson(resident.traits_json, [])
  const profile = profileFromRow(readProfileRow(resident.id), traits)
  const prediction = predictRiskLevel(residentSignals(resident.id, now), traits)
  const appliedLevel = profile.autopilot ? prediction.level : profile.risk_level

  return {
    resident: {
      id: resident.id,
      full_name: resident.full_name,
      external_id: resident.external_id ?? null,
      room_number: resident.room_number ?? null,
      /* La ingesta busca la cama por `monitor_key`: sin monitor, esta
       * configuracion no puede producir un solo aviso. El panel tiene que
       * poder decirlo en vez de mostrar un perfil que nunca va a sonar. */
      monitor_key: resident.monitor_key ?? null,
      bed_label: resident.bed_label ?? null,
      wing_id: resident.wing_id ?? null,
      wing_name: resident.wing_name ?? null,
      traits,
    },
    profile,
    effective: {
      level: appliedLevel,
      mobility_aid: profile.mobility_aid,
      mode: profile.mode,
      template_id: profile.template_id,
      rules: resolveRules({
        level: appliedLevel,
        mobilityAid: profile.mobility_aid,
        mode: profile.mode,
        templateId: profile.template_id,
        overrides: profile.overrides,
      }),
    },
    recommendation: {
      level: prediction.level,
      changed: !profile.autopilot && prediction.level !== profile.risk_level,
      factors: prediction.factors,
      score: prediction.score,
      signals_evaluated: prediction.signals_evaluated,
      suggested_template: suggestedTemplate(traits),
      computed_at: now.toISOString(),
    },
  }
}

export function upsertProfile(residentId, values, actorId, now = new Date()) {
  const timestamp = now.toISOString()
  db.prepare(
    `INSERT INTO resident_alarm_profiles
       (resident_id, risk_level, mobility_aid, autopilot, mode, template_id, overrides_json, updated_at, updated_by)
     VALUES (@resident_id, @risk_level, @mobility_aid, @autopilot, @mode, @template_id, @overrides_json, @updated_at, @updated_by)
     ON CONFLICT(resident_id) DO UPDATE SET
       risk_level = @risk_level,
       mobility_aid = @mobility_aid,
       autopilot = @autopilot,
       mode = @mode,
       template_id = @template_id,
       overrides_json = @overrides_json,
       updated_at = @updated_at,
       updated_by = @updated_by`,
  ).run({
    resident_id: residentId,
    risk_level: values.risk_level,
    mobility_aid: values.mobility_aid,
    autopilot: values.autopilot ? 1 : 0,
    mode: values.mode,
    template_id: values.template_id || 'balanced',
    overrides_json: JSON.stringify(values.overrides || {}),
    updated_at: timestamp,
    updated_by: actorId || null,
  })
}

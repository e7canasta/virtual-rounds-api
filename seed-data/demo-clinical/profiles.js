export const DEMO_CLINICAL_PROFILES = [
  {
    residentId: 'resident-demo-118-0',
    bedId: '118-0',
    /* Mala noche puntual: el Resumen tiene que titularla como desvio, no
     * promediarla contra la semana. */
    deviation: { sleep: -0.32 },
    care: {
      extra: [
        { kind: 'bathroom', hour: 3, minutes: 12 },
        { kind: 'transfer', hour: 16, minutes: 14 },
      ],
    },
    alerts: [{ kind: 'bed_exit', level: 'medium', hour: 3, everyDays: 2, responseMinutes: 4 }],
    bathroom: { visits: 6, night: 2, assisted: 3, minutesPerVisit: 7 },
    sleep: { calm: 330, restless: 70, awake: 45, outOfBed: 90, exits: 3, wakes: 5 },
    mobility: { inBed: 900, outBed: 360, outSight: 180, speed: 0.55, transfers: 4 },
    notes: [
      ['bathroom', 'Requirio acompanamiento al bano durante la ronda nocturna.'],
      ['transfer', 'Transferencia cama-silla con andador y supervision.'],
      ['observation', 'Se mantiene despierto y orientado durante la ronda.'],
    ],
    incident: {
      kind: 'bed_exit',
      severity: 'medium',
      status: 'under_review',
      location: 'room',
      activity: 'bed_exit',
      injury: 'none',
      narrative: 'Se incorporo al borde de la cama y requirio asistencia antes de ponerse de pie.',
      intervention: 'Reforzar llamada antes de levantarse.',
    },
  },
  {
    residentId: 'resident-demo-201-0',
    bedId: '201-0',
    care: {
      extra: [
        { kind: 'transfer', hour: 8, minutes: 18 },
        { kind: 'transfer', hour: 15, minutes: 18 },
        { kind: 'bathroom', hour: 21, minutes: 15 },
      ],
    },
    alerts: [{ kind: 'transfer', level: 'high', hour: 15, everyDays: 3, responseMinutes: 6 }],
    bathroom: { visits: 5, night: 1, assisted: 5, minutesPerVisit: 12 },
    sleep: { calm: 390, restless: 50, awake: 30, outOfBed: 300, exits: 2, wakes: 5 },
    mobility: { inBed: 1000, outBed: 280, outSight: 160, speed: null, transfers: 8 },
    notes: [
      ['bathroom', 'Transferencia asistida al bano; silla de ruedas colocada junto a la cama.'],
      ['hygiene', 'Higiene de la manana completada con asistencia.'],
      ['observation', 'Requiere dos personas para transferencias prolongadas.'],
    ],
    incident: {
      kind: 'fall',
      severity: 'medium',
      status: 'under_review',
      location: 'room',
      activity: 'transfer',
      injury: 'none',
      narrative:
        'Perdio estabilidad durante una transferencia desde la cama; el equipo interrumpio el movimiento y la asistio.',
      intervention: 'Revisar frenos, posicion de la silla y tecnica de transferencia.',
      /* El equipo no pudo determinar si llego a ser una caida. */
      verdict: 'uncertain',
    },
  },
  {
    residentId: 'resident-demo-201-1',
    bedId: '201-1',
    /* Bastantes menos visitas al bano que su habitual: el desvio que el
     * mockup de UX usa como titular del Insight. */
    deviation: { bathroom: -0.45 },
    bathroom: { visits: 8, night: 2, assisted: 1, minutesPerVisit: 6 },
    sleep: { calm: 420, restless: 30, awake: 20, outOfBed: 500, exits: 3, wakes: 5 },
    mobility: { inBed: 760, outBed: 520, outSight: 160, speed: 0.7, transfers: 3 },
    notes: [
      ['bathroom', 'Acceso al bano con andador, sin asistencia fisica.'],
      ['observation', 'Marcha estable durante la ronda de la tarde.'],
      ['care', 'Se recuerda solicitar ayuda antes de levantarse por antecedente de caida.'],
    ],
    incident: {
      kind: 'fall',
      severity: 'high',
      status: 'closed',
      location: 'bathroom',
      activity: 'transfer',
      injury: 'minor',
      narrative: 'Perdio estabilidad durante el giro hacia el bano; recupero el equilibrio con asistencia.',
      intervention: 'Revisar tecnica de transferencia y despejar recorrido.',
      /* Caida confirmada por el equipo: el detector acerto. */
      verdict: 'fall',
    },
  },
  {
    residentId: 'resident-demo-202-0',
    bedId: '202-0',
    /* Dia mucho mas activo de lo habitual: el desvio hacia arriba tambien
     * tiene que ser legible, no solo el que preocupa. */
    deviation: { outBed: 0.42 },
    bathroom: { visits: 5, night: 0, assisted: 0, minutesPerVisit: 5 },
    sleep: { calm: 450, restless: 20, awake: 15, outOfBed: 420, exits: 1, wakes: 2 },
    mobility: { inBed: 820, outBed: 430, outSight: 190, speed: 0.8, transfers: 2 },
    notes: [
      ['bathroom', 'Uso independiente del bano registrado durante la ronda.'],
      ['observation', 'Patron de sueno estable; sin eventos de salida de cama.'],
      ['care', 'Sin intervencion adicional requerida.'],
    ],
    incident: {
      kind: 'fall',
      severity: 'low',
      status: 'closed',
      location: 'room',
      activity: 'transfer',
      injury: 'none',
      narrative: 'El sensor marco una caida; el equipo verifico que se habia agachado a recoger un objeto.',
      intervention: 'Sin intervencion: se corrigio la clasificacion.',
      /* Falso positivo puro: nunca fue una caida. Es el caso que mide al
       * detector, y el que no puede seguir contando como incidente. */
      verdict: 'not_a_fall',
    },
  },
  {
    residentId: 'resident-demo-202-1',
    bedId: '202-1',
    care: {
      extra: [
        { kind: 'transfer', hour: 10, minutes: 20 },
        { kind: 'bathroom', hour: 17, minutes: 16 },
      ],
    },
    alerts: [{ kind: 'transfer', level: 'medium', hour: 10, everyDays: 4, responseMinutes: 5 }],
    bathroom: { visits: 4, night: 1, assisted: 4, minutesPerVisit: 14 },
    sleep: { calm: 400, restless: 40, awake: 30, outOfBed: 240, exits: 2, wakes: 5 },
    mobility: { inBed: 1060, outBed: 220, outSight: 120, speed: null, transfers: 7 },
    notes: [
      ['bathroom', 'Traslado asistido a silla de ruedas para uso del bano.'],
      ['transfer', 'Se verifica freno de silla antes de la transferencia.'],
      ['hygiene', 'Higiene y cambio de ropa completados con asistencia.'],
    ],
    incident: {
      kind: 'fall',
      severity: 'low',
      status: 'closed',
      location: 'bathroom',
      activity: 'transfer',
      injury: 'none',
      narrative: 'Deslizo el pie durante el giro hacia el bano, sin impacto ni lesion.',
      intervention: 'Reforzar calzado, frenos y asistencia durante el giro.',
      /* Falso positivo: se apoyo en el piso de forma controlada. No debe
       * romper la racha sin caidas ni contar en los indicadores. */
      verdict: 'safe_to_ground',
    },
  },
  {
    residentId: 'resident-demo-301-0',
    bedId: '301-0',
    /* Menos movimiento que su habitual: el otro sentido del desvio. */
    deviation: { outBed: -0.35 },
    care: {
      extra: [
        { kind: 'observation', hour: 2, minutes: 9 },
        { kind: 'observation', hour: 5, minutes: 9 },
      ],
    },
    alerts: [
      { kind: 'wandering', level: 'high', hour: 2, everyDays: 2, responseMinutes: 7 },
      { kind: 'bed_exit', level: 'medium', hour: 23, everyDays: 3, responseMinutes: 5 },
    ],
    bathroom: { visits: 9, night: 4, assisted: 2, minutesPerVisit: 8 },
    sleep: { calm: 300, restless: 100, awake: 75, outOfBed: 600, exits: 5, wakes: 7 },
    mobility: { inBed: 700, outBed: 620, outSight: 220, speed: 0.45, transfers: 5 },
    notes: [
      ['bathroom', 'Se encontro fuera de ruta al dirigirse al bano; acompanamiento hasta la habitacion.'],
      ['observation', 'Presenta salidas de cama frecuentes y deambulacion sin aviso.'],
      ['care', 'Se mantiene baranda configurada y monitoreo reforzado durante la noche.'],
    ],
    incident: {
      kind: 'wandering',
      severity: 'medium',
      status: 'open',
      location: 'hallway',
      activity: 'wandering',
      injury: 'none',
      narrative: 'Se detecto deambulando fuera del area asignada durante la madrugada.',
      intervention: 'Acompanamiento de regreso y verificacion de entorno.',
    },
  },
]

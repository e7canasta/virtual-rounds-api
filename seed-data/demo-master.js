/* Modelo demo: residente → cama → habitación; la habitación tiene un stream
 * de video (go2rtc). El monitor_key vive en la cama (eventos del detector).
 * Habitación compartida = un stream, varias camas/monitores. */
export const DEMO_MASTER_DATA = {
  facility: {
    id: 'facility-demo',
    name: 'Manantial',
    timezone: 'America/Argentina/Buenos_Aires',
  },
  wings: [
    { id: 'north-1f', name: 'Ala Norte', floor: '1', sort_order: 1 },
    { id: 'north-2f', name: 'Ala Norte', floor: '2', sort_order: 2 },
    { id: 'south-1f', name: 'Ala Sur', floor: '1', sort_order: 3 },
  ],
  rooms: [
    {
      id: '118',
      wing_id: 'north-1f',
      number: '118',
      type: 'single',
      stream_key: 'home2',
      privacy_regions: [{ id: 'privacy-118-person', x: 0.32, y: 0.18, w: 0.28, h: 0.62 }],
      beds: [
        {
          id: '118-0',
          label: 'Cama 1',
          monitor_key: 'mana-camera-118',
          resident: {
            id: 'resident-demo-118-0',
            external_id: 'demo-118-0',
            full_name: 'Jose Martinez',
            birth_date: '1942-03-18',
            admission_date: '2024-06-01',
            traits: ['bed_guard', 'fall_risk', 'walker'],
          },
        },
      ],
    },
    {
      id: '201',
      wing_id: 'north-2f',
      number: '201',
      type: 'double',
      stream_key: 'room-201',
      privacy_regions: [
        { id: 'privacy-201-person-a', x: 0.18, y: 0.2, w: 0.22, h: 0.58 },
        { id: 'privacy-201-person-b', x: 0.62, y: 0.2, w: 0.22, h: 0.58 },
      ],
      beds: [
        {
          id: '201-0',
          label: 'Cama 1',
          monitor_key: 'mana-camera-201-0',
          resident: {
            id: 'resident-demo-201-0',
            external_id: 'demo-201-0',
            full_name: 'Alicia Molina',
            birth_date: '1938-11-02',
            admission_date: '2023-09-14',
            traits: ['wheelchair', 'night_monitoring'],
          },
        },
        {
          id: '201-1',
          label: 'Cama 2',
          monitor_key: 'mana-camera-201-1',
          resident: {
            id: 'resident-demo-201-1',
            external_id: 'demo-201-1',
            full_name: 'Tomas Reyes',
            birth_date: '1940-05-21',
            admission_date: '2022-02-10',
            traits: ['walker', 'fall_risk'],
          },
        },
      ],
    },
    {
      id: '202',
      wing_id: 'north-2f',
      number: '202',
      type: 'double',
      stream_key: 'room-202',
      privacy_regions: [{ id: 'privacy-202-person', x: 0.38, y: 0.2, w: 0.24, h: 0.58 }],
      beds: [
        {
          id: '202-0',
          label: 'Cama 1',
          monitor_key: 'mana-camera-202-0',
          resident: {
            id: 'resident-demo-202-0',
            external_id: 'demo-202-0',
            full_name: 'Pablo Diaz',
            birth_date: '1939-07-09',
            admission_date: '2024-01-12',
            traits: ['night_monitoring'],
          },
        },
        {
          id: '202-1',
          label: 'Cama 2',
          monitor_key: 'mana-camera-202-1',
          resident: {
            id: 'resident-demo-202-1',
            external_id: 'demo-202-1',
            full_name: 'Nina Ortiz',
            birth_date: '1945-10-30',
            admission_date: '2025-03-04',
            traits: ['wheelchair'],
          },
        },
      ],
    },
    {
      id: '301',
      wing_id: 'south-1f',
      number: '301',
      type: 'single',
      stream_key: 'room-301',
      privacy_regions: [{ id: 'privacy-301-person', x: 0.34, y: 0.18, w: 0.28, h: 0.62 }],
      beds: [
        {
          id: '301-0',
          label: 'Cama 1',
          monitor_key: 'mana-camera-301',
          resident: {
            id: 'resident-demo-301-0',
            external_id: 'demo-301-0',
            full_name: 'Walter Cole',
            birth_date: '1937-01-28',
            admission_date: '2021-11-20',
            traits: ['wandering', 'fall_risk', 'bed_guard'],
          },
        },
      ],
    },
  ],
  users: [
    {
      id: 'user-gaston',
      username: 'gaston',
      display_name: 'Gaston',
      role: 'supervisor',
      /* Puesto y acceso son ejes distintos: el demo muestra los dos para que la
       * distincion se vea sin tener que dar de alta a nadie. */
      job_title: 'Director médico',
      passwordEnv: 'DEMO_GASTON_PASSWORD',
      fallbackPassword: 'gaston-demo',
    },
    {
      id: 'user-staff',
      username: 'staff',
      display_name: 'Staff',
      role: 'staff',
      job_title: 'Persona de cuidado',
      passwordEnv: 'DEMO_STAFF_PASSWORD',
      fallbackPassword: 'staff-demo',
    },
  ],
  planogram: [
    { id: 'placement-118', wing_id: 'north-1f', room_id: '118', x: 0.2, y: 0.4, sort_order: 1 },
    { id: 'placement-201', wing_id: 'north-2f', room_id: '201', x: 0.25, y: 0.35, sort_order: 1 },
    { id: 'placement-202', wing_id: 'north-2f', room_id: '202', x: 0.55, y: 0.35, sort_order: 2 },
    { id: 'placement-301', wing_id: 'south-1f', room_id: '301', x: 0.4, y: 0.5, sort_order: 1 },
  ],
  staff_groups: [
    {
      id: 'sg-norte',
      facility_id: 'facility-demo',
      name: 'Turno Norte',
      member_user_ids: ['user-gaston', 'user-staff'],
    },
    {
      id: 'sg-sur',
      facility_id: 'facility-demo',
      name: 'Turno Sur',
      member_user_ids: ['user-staff'],
    },
  ],
  coverages: [
    { id: 'coverage-north-1f-day', wing_id: 'north-1f', staff_group_id: 'sg-norte', shift: 'day' },
    { id: 'coverage-north-1f-night', wing_id: 'north-1f', staff_group_id: 'sg-norte', shift: 'night' },
    { id: 'coverage-north-2f-day', wing_id: 'north-2f', staff_group_id: 'sg-norte', shift: 'day' },
    { id: 'coverage-north-2f-night', wing_id: 'north-2f', staff_group_id: 'sg-norte', shift: 'night' },
    { id: 'coverage-south-1f-day', wing_id: 'south-1f', staff_group_id: 'sg-sur', shift: 'day' },
    { id: 'coverage-south-1f-night', wing_id: 'south-1f', staff_group_id: 'sg-sur', shift: 'night' },
  ],
}

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { SYSTEM_PARAMETERS } from './seed-data/system.js'
import { DEMO_MASTER_DATA } from './seed-data/demo-master.js'
import { demoSensorEvents } from './seed-data/demo-transactions.js'
import { demoClinicalData } from './seed-data/demo-clinical/index.js'

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
const databasePath = process.env.SQLITE_PATH || path.join(moduleDirectory, 'data/virtual-rounds.sqlite')
fs.mkdirSync(path.dirname(databasePath), { recursive: true })

export const db = new Database(databasePath)
db.pragma('foreign_keys = ON')
db.pragma('journal_mode = WAL')
db.pragma('busy_timeout = 5000')
db.pragma('synchronous = NORMAL')

/*
 * Estos pragmas permiten preparar la convivencia con el hub. No resuelven la
 * promocion de una transaccion diferida a escritura: las escrituras Rust
 * deberan usar BEGIN IMMEDIATE cuando ctx-identidad empiece en S1.1.
 */

db.exec(`
  CREATE TABLE IF NOT EXISTS facilities (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS system_parameters (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS wings (
    id TEXT PRIMARY KEY,
    facility_id TEXT NOT NULL REFERENCES facilities(id),
    name TEXT NOT NULL,
    floor TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    wing_id TEXT NOT NULL REFERENCES wings(id),
    number TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'single',
    stream_key TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    UNIQUE(wing_id, number)
  );
  CREATE TABLE IF NOT EXISTS room_privacy_regions (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    x REAL NOT NULL,
    y REAL NOT NULL,
    w REAL NOT NULL,
    h REAL NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS beds (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    label TEXT NOT NULL,
    monitor_key TEXT,
    traits_json TEXT NOT NULL DEFAULT '[]',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS residents (
    id TEXT PRIMARY KEY,
    external_id TEXT UNIQUE,
    full_name TEXT NOT NULL,
    birth_date TEXT,
    admission_date TEXT,
    traits_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS resident_bed_assignments (
    id TEXT PRIMARY KEY,
    resident_id TEXT NOT NULL REFERENCES residents(id),
    bed_id TEXT NOT NULL REFERENCES beds(id),
    starts_at TEXT NOT NULL,
    ends_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sensor_events (
    id TEXT PRIMARY KEY,
    source_event_id TEXT UNIQUE,
    bed_id TEXT NOT NULL REFERENCES beds(id),
    resident_id TEXT REFERENCES residents(id),
    monitor_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    room_state TEXT,
    substate TEXT,
    state TEXT,
    alert_level TEXT,
    occurred_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS current_bed_states (
    bed_id TEXT PRIMARY KEY REFERENCES beds(id),
    resident_id TEXT REFERENCES residents(id),
    room_state TEXT,
    state TEXT NOT NULL,
    substate TEXT,
    sleeping INTEGER NOT NULL DEFAULT 0,
    alert_level TEXT NOT NULL DEFAULT 'low',
    updated_at TEXT NOT NULL,
    source TEXT NOT NULL,
    source_event_id TEXT REFERENCES sensor_events(id)
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rounds (
    id TEXT PRIMARY KEY,
    wing_id TEXT NOT NULL REFERENCES wings(id),
    status TEXT NOT NULL DEFAULT 'in_progress',
    scheduled_for TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    started_by TEXT NOT NULL REFERENCES users(id),
    completed_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS round_tasks (
    id TEXT PRIMARY KEY,
    round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
    resident_id TEXT NOT NULL REFERENCES residents(id),
    bed_id TEXT NOT NULL REFERENCES beds(id),
    status TEXT NOT NULL DEFAULT 'pending',
    note TEXT,
    completed_at TEXT,
    completed_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS care_notes (
    id TEXT PRIMARY KEY,
    resident_id TEXT NOT NULL REFERENCES residents(id),
    author_id TEXT NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL DEFAULT 'general',
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY,
    resident_id TEXT REFERENCES residents(id),
    bed_id TEXT NOT NULL REFERENCES beds(id),
    sensor_event_id TEXT REFERENCES sensor_events(id),
    kind TEXT NOT NULL,
    level TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    title TEXT NOT NULL,
    detail TEXT,
    occurred_at TEXT NOT NULL,
    acknowledged_at TEXT,
    acknowledged_by TEXT REFERENCES users(id),
    attended_at TEXT,
    attended_by TEXT REFERENCES users(id),
    resolved_at TEXT,
    resolved_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS incidents (
    id TEXT PRIMARY KEY,
    source_record_id TEXT NOT NULL UNIQUE,
    resident_id TEXT NOT NULL REFERENCES residents(id),
    bed_id TEXT REFERENCES beds(id),
    source_alert_id TEXT REFERENCES alerts(id),
    kind TEXT NOT NULL,
    severity TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    occurred_at TEXT NOT NULL,
    location TEXT,
    activity TEXT,
    injury_status TEXT NOT NULL DEFAULT 'unknown',
    self_recovery INTEGER,
    response_seconds INTEGER,
    narrative TEXT,
    interventions_json TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL,
    model_version TEXT,
    confidence REAL,
    provenance_json TEXT NOT NULL DEFAULT '{}',
    review_note TEXT,
    reviewed_by TEXT REFERENCES users(id),
    reviewed_at TEXT,
    resolved_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sleep_summaries (
    id TEXT PRIMARY KEY,
    source_record_id TEXT NOT NULL UNIQUE,
    resident_id TEXT NOT NULL REFERENCES residents(id),
    observed_on TEXT NOT NULL,
    sleep_started_at TEXT,
    sleep_ended_at TEXT,
    calm_minutes INTEGER NOT NULL DEFAULT 0,
    restless_minutes INTEGER NOT NULL DEFAULT 0,
    awake_minutes INTEGER NOT NULL DEFAULT 0,
    out_of_bed_minutes INTEGER NOT NULL DEFAULT 0,
    bed_exit_count INTEGER NOT NULL DEFAULT 0,
    wake_count INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL,
    model_version TEXT NOT NULL,
    confidence REAL,
    provenance_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(resident_id, observed_on, source, model_version)
  );
  CREATE TABLE IF NOT EXISTS mobility_summaries (
    id TEXT PRIMARY KEY,
    source_record_id TEXT NOT NULL UNIQUE,
    resident_id TEXT NOT NULL REFERENCES residents(id),
    observed_on TEXT NOT NULL,
    in_bed_minutes INTEGER NOT NULL DEFAULT 0,
    out_of_bed_minutes INTEGER NOT NULL DEFAULT 0,
    out_of_sight_minutes INTEGER NOT NULL DEFAULT 0,
    walking_minutes INTEGER NOT NULL DEFAULT 0,
    walking_distance_meters REAL,
    walking_speed_mps REAL,
    transfer_count INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL,
    model_version TEXT NOT NULL,
    confidence REAL,
    provenance_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(resident_id, observed_on, source, model_version)
  );
  CREATE TABLE IF NOT EXISTS bathroom_summaries (
    id TEXT PRIMARY KEY,
    source_record_id TEXT NOT NULL UNIQUE,
    resident_id TEXT NOT NULL REFERENCES residents(id),
    observed_on TEXT NOT NULL,
    visit_count INTEGER NOT NULL DEFAULT 0,
    night_visit_count INTEGER NOT NULL DEFAULT 0,
    assisted_count INTEGER NOT NULL DEFAULT 0,
    total_minutes INTEGER NOT NULL DEFAULT 0,
    longest_visit_minutes INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL,
    model_version TEXT NOT NULL,
    confidence REAL,
    provenance_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(resident_id, observed_on, source, model_version)
  );
  CREATE TABLE IF NOT EXISTS resident_alarm_profiles (
    resident_id TEXT PRIMARY KEY REFERENCES residents(id),
    risk_level TEXT NOT NULL DEFAULT 'low',
    mobility_aid TEXT NOT NULL DEFAULT 'none',
    autopilot INTEGER NOT NULL DEFAULT 0,
    mode TEXT NOT NULL DEFAULT 'preset',
    template_id TEXT NOT NULL DEFAULT 'balanced',
    overrides_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL,
    updated_by TEXT REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    actor_id TEXT REFERENCES users(id),
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  /* Unidad funcional = wing. Planograma y cobertura de staff anclan ahi. */
  CREATE TABLE IF NOT EXISTS planogram_placements (
    id TEXT PRIMARY KEY,
    wing_id TEXT NOT NULL REFERENCES wings(id),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    x REAL NOT NULL DEFAULT 0,
    y REAL NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    UNIQUE(room_id)
  );
  CREATE TABLE IF NOT EXISTS staff_groups (
    id TEXT PRIMARY KEY,
    facility_id TEXT NOT NULL REFERENCES facilities(id),
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS staff_group_members (
    id TEXT PRIMARY KEY,
    staff_group_id TEXT NOT NULL REFERENCES staff_groups(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    UNIQUE(staff_group_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS unit_shift_coverages (
    id TEXT PRIMARY KEY,
    wing_id TEXT NOT NULL REFERENCES wings(id),
    staff_group_id TEXT NOT NULL REFERENCES staff_groups(id),
    shift TEXT NOT NULL CHECK (shift IN ('day', 'night')),
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  /* Grilla de turnos de staff de la residencia.
   *
   * Es un eje distinto del de alarmas. Los presets de alarma hablan de
   * momentos del dia -- el residente duerme de noche, se levanta a la
   * madrugada, el riesgo de caida cambia con la luz -- y eso es fisiologia.
   * Esta tabla habla de trabajo: quien cubre el Ala Norte de 14 a 22. Que
   * compartieran el mismo corte era un accidente, no un diseño, y obligaba a
   * una casa con tres turnos a elegir entre romper sus alarmas o mentir sobre
   * su planilla.
   *
   * Cada turno declara donde empieza; termina donde empieza el siguiente, y el
   * ultimo cruza la medianoche hasta el primero. */
  CREATE TABLE IF NOT EXISTS facility_shifts (
    id TEXT PRIMARY KEY,
    facility_id TEXT NOT NULL REFERENCES facilities(id),
    key TEXT NOT NULL,
    label TEXT NOT NULL,
    start_hour INTEGER NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    UNIQUE(facility_id, key)
  );
  CREATE INDEX IF NOT EXISTS idx_facility_shifts ON facility_shifts(facility_id, start_hour);
  CREATE INDEX IF NOT EXISTS idx_wings_facility ON wings(facility_id);
  CREATE INDEX IF NOT EXISTS idx_rooms_wing ON rooms(wing_id);
  CREATE INDEX IF NOT EXISTS idx_beds_room ON beds(room_id);
  CREATE INDEX IF NOT EXISTS idx_assignments_active ON resident_bed_assignments(bed_id, ends_at);
  CREATE INDEX IF NOT EXISTS idx_sensor_events_bed_time ON sensor_events(bed_id, occurred_at);
  CREATE INDEX IF NOT EXISTS idx_sensor_events_resident_time ON sensor_events(resident_id, occurred_at);
  CREATE INDEX IF NOT EXISTS idx_rounds_wing_status ON rounds(wing_id, status, started_at);
  CREATE INDEX IF NOT EXISTS idx_round_tasks_round ON round_tasks(round_id, status);
  CREATE INDEX IF NOT EXISTS idx_care_notes_resident_time ON care_notes(resident_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_alerts_status_time ON alerts(status, occurred_at);
  CREATE INDEX IF NOT EXISTS idx_alerts_resident_time ON alerts(resident_id, occurred_at);
  CREATE INDEX IF NOT EXISTS idx_incidents_resident_time ON incidents(resident_id, occurred_at);
  CREATE INDEX IF NOT EXISTS idx_incidents_status_time ON incidents(status, occurred_at);
  CREATE INDEX IF NOT EXISTS idx_sleep_summaries_resident_date ON sleep_summaries(resident_id, observed_on);
  CREATE INDEX IF NOT EXISTS idx_mobility_summaries_resident_date ON mobility_summaries(resident_id, observed_on);
  CREATE INDEX IF NOT EXISTS idx_audit_log_entity_time ON audit_log(entity_type, entity_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_log_actor_time ON audit_log(actor_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_planogram_wing ON planogram_placements(wing_id, sort_order);
  CREATE INDEX IF NOT EXISTS idx_staff_groups_facility ON staff_groups(facility_id);
  CREATE INDEX IF NOT EXISTS idx_staff_group_members_group ON staff_group_members(staff_group_id);
  CREATE INDEX IF NOT EXISTS idx_unit_shift_coverages_wing ON unit_shift_coverages(wing_id, shift);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_unit_shift_coverages_active
    ON unit_shift_coverages(wing_id, shift) WHERE active = 1;
`)

// Keep existing local databases compatible with the room stream association.
if (
  !db
    .prepare('PRAGMA table_info(rooms)')
    .all()
    .some((column) => column.name === 'stream_key')
) {
  db.exec('ALTER TABLE rooms ADD COLUMN stream_key TEXT')
}

/* La cobertura nacio con `CHECK (shift IN ('day', 'night'))`, que es el corte de
 * alarmas metido en una tabla de planilla laboral. Se reconstruye sin el CHECK
 * para que la residencia pueda declarar su propia grilla (mañana/tarde/noche, o
 * la que use). Las filas existentes conservan su valor: la grilla por defecto
 * que se siembra abajo usa exactamente las claves `day` y `night`, asi que
 * nada cambia de significado. */
const coverageTable = db
  .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'unit_shift_coverages'")
  .get()
if (coverageTable?.sql?.includes('CHECK')) {
  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN;
    CREATE TABLE unit_shift_coverages_new (
      id TEXT PRIMARY KEY,
      wing_id TEXT NOT NULL REFERENCES wings(id),
      staff_group_id TEXT NOT NULL REFERENCES staff_groups(id),
      shift TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    INSERT INTO unit_shift_coverages_new (id, wing_id, staff_group_id, shift, active, created_at)
      SELECT id, wing_id, staff_group_id, shift, active, created_at FROM unit_shift_coverages;
    DROP TABLE unit_shift_coverages;
    ALTER TABLE unit_shift_coverages_new RENAME TO unit_shift_coverages;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `)
}

/* Puesto asistencial, separado del acceso.
 *
 * `role` responde "que puede ver y tocar" y tiene dos valores. El puesto
 * responde "que es esta persona en el hogar" -- director medico, enfermera,
 * persona de cuidado -- y no gobierna permisos: dos personas con el mismo
 * acceso pueden tener puestos distintos, y el parte de turno necesita
 * distinguirlas. Es texto libre a proposito: cada casa nombra sus puestos, y
 * un enum obligaria a desplegar cada vez que aparece uno nuevo. */
if (
  !db
    .prepare('PRAGMA table_info(users)')
    .all()
    .some((column) => column.name === 'job_title')
) {
  db.exec('ALTER TABLE users ADD COLUMN job_title TEXT')
}
/* Veredicto de deteccion: que dice el equipo que realmente paso.
 *
 * Es un eje distinto de `status`. `status` responde "¿el equipo ya actuo?"
 * (abierta / en revision / cerrada); el veredicto responde "¿el detector
 * acerto?". Un incidente puede estar cerrado y ser un falso positivo, y las
 * dos lecturas importan: una es clinica, la otra mide al sistema.
 *
 * NULL significa pendiente de revision, no "sin veredicto valido".
 */
for (const column of [
  ['detection_verdict', 'TEXT'],
  ['verdict_by', 'TEXT'],
  ['verdict_at', 'TEXT'],
]) {
  if (
    !db
      .prepare('PRAGMA table_info(incidents)')
      .all()
      .some((existing) => existing.name === column[0])
  ) {
    db.exec(`ALTER TABLE incidents ADD COLUMN ${column[0]} ${column[1]}`)
  }
}

/* Duracion del cuidado registrado. Es nullable a proposito: una nota vieja no
 * la tiene, y el panel distingue "sin duracion registrada" de "cero minutos". */
if (
  !db
    .prepare('PRAGMA table_info(care_notes)')
    .all()
    .some((column) => column.name === 'duration_minutes')
) {
  db.exec('ALTER TABLE care_notes ADD COLUMN duration_minutes INTEGER')
}
/* Despertares por noche. Nullable a proposito: una noche vieja no los tiene, y
 * el promedio no puede leer ausencia como cero despertares. */
if (
  !db
    .prepare('PRAGMA table_info(sleep_summaries)')
    .all()
    .some((column) => column.name === 'wake_count')
) {
  db.exec('ALTER TABLE sleep_summaries ADD COLUMN wake_count INTEGER')
}
if (
  !db
    .prepare('PRAGMA table_info(alerts)')
    .all()
    .some((column) => column.name === 'attended_at')
) {
  db.exec('ALTER TABLE alerts ADD COLUMN attended_at TEXT')
}
if (
  !db
    .prepare('PRAGMA table_info(alerts)')
    .all()
    .some((column) => column.name === 'attended_by')
) {
  db.exec('ALTER TABLE alerts ADD COLUMN attended_by TEXT REFERENCES users(id)')
}
if (
  !db
    .prepare('PRAGMA table_info(current_bed_states)')
    .all()
    .some((column) => column.name === 'room_state')
) {
  db.exec('ALTER TABLE current_bed_states ADD COLUMN room_state TEXT')
}
if (
  !db
    .prepare('PRAGMA table_info(beds)')
    .all()
    .some((column) => column.name === 'traits_json')
) {
  db.exec("ALTER TABLE beds ADD COLUMN traits_json TEXT NOT NULL DEFAULT '[]'")
}
// `state_since` marca el inicio del episodio actual: el motor de alarmas lo usa
// para confirmar una transicion y para no repetir un aviso de permanencia.
if (
  !db
    .prepare('PRAGMA table_info(current_bed_states)')
    .all()
    .some((column) => column.name === 'state_since')
) {
  db.exec('ALTER TABLE current_bed_states ADD COLUMN state_since TEXT')
}
// La plantilla de perfil se agrego despues del primer corte de presets.
if (
  !db
    .prepare('PRAGMA table_info(resident_alarm_profiles)')
    .all()
    .some((column) => column.name === 'template_id')
) {
  db.exec("ALTER TABLE resident_alarm_profiles ADD COLUMN template_id TEXT NOT NULL DEFAULT 'balanced'")
}
if (
  !db
    .prepare('PRAGMA table_info(residents)')
    .all()
    .some((column) => column.name === 'traits_json')
) {
  db.exec("ALTER TABLE residents ADD COLUMN traits_json TEXT NOT NULL DEFAULT '[]'")
}
if (
  !db
    .prepare('PRAGMA table_info(current_bed_states)')
    .all()
    .some((column) => column.name === 'sleeping')
) {
  db.exec('ALTER TABLE current_bed_states ADD COLUMN sleeping INTEGER NOT NULL DEFAULT 0')
}
db.exec(`
  UPDATE current_bed_states
  SET room_state = (
    SELECT room_state
    FROM sensor_events
    WHERE sensor_events.id = current_bed_states.source_event_id
  )
  WHERE room_state IS NULL AND source_event_id IS NOT NULL
`)

const now = () => new Date().toISOString()

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const derived = crypto.scryptSync(password, salt, 64).toString('hex')
  return `scrypt$${salt}$${derived}`
}

export function seedSystem() {
  const timestamp = now()
  const insert = db.prepare(`
    INSERT INTO system_parameters (key, value_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO NOTHING
  `)
  const seed = db.transaction(() => {
    SYSTEM_PARAMETERS.forEach(([key, value]) => insert.run(key, JSON.stringify(value), timestamp))
  })
  seed()
}

/* Identidad minima para empezar de cero: sin residencia, sin camas, sin
 * resumenes. Solo el usuario supervisor y el de staff para poder operar la
 * API. La estructura y la clinica llegan despues por escenas
 * (project/producto/SCENES.md). */
export function seedIdentity() {
  const timestamp = now()
  const insertUser = db.prepare(`
    INSERT INTO users (id, username, display_name, role, job_title, password_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      username = excluded.username, display_name = excluded.display_name,
      role = excluded.role, job_title = excluded.job_title
  `)
  db.transaction(() => {
    for (const user of DEMO_MASTER_DATA.users || []) {
      const password = process.env[user.passwordEnv] || user.fallbackPassword
      if (!password) throw new Error(`El usuario master ${user.username} requiere passwordEnv o fallbackPassword`)
      insertUser.run(
        user.id,
        user.username,
        user.display_name,
        user.role,
        user.job_title || null,
        hashPassword(password),
        timestamp,
      )
    }
  })()
}

export function seedMaster(data = DEMO_MASTER_DATA) {
  const timestamp = now()
  const insertFacility = db.prepare(`
    INSERT INTO facilities (id, name, timezone, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, timezone = excluded.timezone
  `)
  const insertWing = db.prepare(`
    INSERT INTO wings (id, facility_id, name, floor, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET facility_id = excluded.facility_id, name = excluded.name, floor = excluded.floor, sort_order = excluded.sort_order
  `)
  const insertRoom = db.prepare(`
    INSERT INTO rooms (id, wing_id, number, type, stream_key, created_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET wing_id = excluded.wing_id, number = excluded.number, type = excluded.type, stream_key = excluded.stream_key
  `)
  const insertBed = db.prepare(`
    INSERT INTO beds (id, room_id, label, monitor_key, traits_json, created_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET room_id = excluded.room_id, label = excluded.label,
      monitor_key = excluded.monitor_key, traits_json = excluded.traits_json
  `)
  const insertResident = db.prepare(`
    INSERT INTO residents (id, external_id, full_name, birth_date, admission_date, traits_json, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
    ON CONFLICT(id) DO UPDATE SET external_id = excluded.external_id, full_name = excluded.full_name,
      birth_date = excluded.birth_date, admission_date = excluded.admission_date,
      traits_json = excluded.traits_json, status = 'active'
  `)
  const insertAssignment = db.prepare(`
    INSERT INTO resident_bed_assignments (id, resident_id, bed_id, starts_at, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `)
  const insertUser = db.prepare(`
    INSERT INTO users (id, username, display_name, role, job_title, password_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      username = excluded.username, display_name = excluded.display_name,
      role = excluded.role, job_title = excluded.job_title
  `)
  const insertPlacement = db.prepare(`
    INSERT INTO planogram_placements (id, wing_id, room_id, x, y, sort_order, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(room_id) DO UPDATE SET
      wing_id = excluded.wing_id, x = excluded.x, y = excluded.y, sort_order = excluded.sort_order, active = 1
  `)
  const insertPrivacyRegion = db.prepare(`
    INSERT INTO room_privacy_regions (id, room_id, x, y, w, h, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET room_id = excluded.room_id, x = excluded.x,
      y = excluded.y, w = excluded.w, h = excluded.h, active = 1
  `)
  const insertStaffGroup = db.prepare(`
    INSERT INTO staff_groups (id, facility_id, name, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET facility_id = excluded.facility_id, name = excluded.name, active = 1
  `)
  const insertStaffMember = db.prepare(`
    INSERT INTO staff_group_members (id, staff_group_id, user_id, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(staff_group_id, user_id) DO NOTHING
  `)
  const insertCoverage = db.prepare(`
    INSERT INTO unit_shift_coverages (id, wing_id, staff_group_id, shift, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      wing_id = excluded.wing_id, staff_group_id = excluded.staff_group_id, shift = excluded.shift, active = 1
  `)

  db.transaction(() => {
    insertFacility.run(data.facility.id, data.facility.name, data.facility.timezone, timestamp)
    data.wings.forEach((wing) =>
      insertWing.run(wing.id, data.facility.id, wing.name, wing.floor, wing.sort_order, timestamp),
    )
    data.rooms.forEach((room) => {
      insertRoom.run(room.id, room.wing_id, room.number, room.type, room.stream_key || null, timestamp)
      room.beds.forEach((bed) => {
        insertBed.run(
          bed.id,
          room.id,
          bed.label,
          bed.monitor_key || null,
          JSON.stringify(Array.isArray(bed.traits) ? bed.traits : []),
          timestamp,
        )
        if (bed.resident) {
          const resident = bed.resident
          insertResident.run(
            resident.id,
            resident.external_id,
            resident.full_name,
            resident.birth_date || null,
            resident.admission_date || null,
            JSON.stringify(Array.isArray(resident.traits) ? resident.traits : []),
            timestamp,
          )
          const assignmentId = `assignment-${resident.id}-${bed.id}`
          if (
            !db
              .prepare(
                'SELECT 1 FROM resident_bed_assignments WHERE resident_id = ? AND bed_id = ? AND ends_at IS NULL',
              )
              .get(resident.id, bed.id)
          ) {
            insertAssignment.run(assignmentId, resident.id, bed.id, timestamp, timestamp)
          }
        }
      })
    })
    ;(data.users || []).forEach((user) => {
      const password = process.env[user.passwordEnv] || user.fallbackPassword
      if (!password) throw new Error(`El usuario master ${user.username} requiere passwordEnv o fallbackPassword`)
      insertUser.run(
        user.id,
        user.username,
        user.display_name,
        user.role,
        user.job_title || null,
        hashPassword(password),
        timestamp,
      )
    })
    ;(data.planogram || []).forEach((placement) => {
      insertPlacement.run(
        placement.id || `placement-${placement.room_id}`,
        placement.wing_id,
        placement.room_id,
        Number(placement.x) || 0,
        Number(placement.y) || 0,
        Number(placement.sort_order) || 0,
        timestamp,
      )
    })
    ;(data.privacy_regions || []).forEach((region) => {
      insertPrivacyRegion.run(
        region.id || `privacy-${region.room_id}`,
        region.room_id,
        Number(region.x),
        Number(region.y),
        Number(region.w),
        Number(region.h),
        timestamp,
      )
    })
    data.rooms.forEach((room) => {
      ;(room.privacy_regions || []).forEach((region) => {
        insertPrivacyRegion.run(
          region.id || `privacy-${room.id}`,
          room.id,
          Number(region.x),
          Number(region.y),
          Number(region.w),
          Number(region.h),
          timestamp,
        )
      })
    })
    ;(data.staff_groups || []).forEach((group) => {
      insertStaffGroup.run(group.id, group.facility_id || data.facility.id, group.name, timestamp)
      ;(group.member_user_ids || []).forEach((userId) => {
        insertStaffMember.run(`sgm-${group.id}-${userId}`, group.id, userId, timestamp)
      })
    })
    ;(data.coverages || []).forEach((coverage) => {
      insertCoverage.run(
        coverage.id || `coverage-${coverage.wing_id}-${coverage.shift}`,
        coverage.wing_id,
        coverage.staff_group_id,
        coverage.shift,
        timestamp,
      )
    })
  })()
}

export function seedDemoTransactions(nowValue = new Date()) {
  const receivedAt = now()
  const events = demoSensorEvents(nowValue)
  const roundStartedAt = new Date(nowValue.valueOf() - 120 * 60 * 1000).toISOString()
  const roundCompletedAt = new Date(nowValue.valueOf() - 90 * 60 * 1000).toISOString()
  const insertEvent = db.prepare(`
    INSERT INTO sensor_events
      (id, source_event_id, bed_id, resident_id, monitor_key, kind, room_state, substate, state, alert_level, occurred_at, received_at, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `)
  const insertState = db.prepare(`
    INSERT INTO current_bed_states
      (bed_id, resident_id, room_state, state, substate, sleeping, alert_level, updated_at, source, source_event_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'seed-demo', ?)
    ON CONFLICT(bed_id) DO UPDATE SET resident_id = excluded.resident_id, state = excluded.state,
      room_state = excluded.room_state, substate = excluded.substate, alert_level = excluded.alert_level,
      sleeping = excluded.sleeping,
      updated_at = excluded.updated_at,
      source = excluded.source, source_event_id = excluded.source_event_id
    WHERE excluded.updated_at >= current_bed_states.updated_at
  `)
  const insertRound = db.prepare(`
    INSERT INTO rounds (id, wing_id, status, started_at, completed_at, started_by, completed_by, created_at, updated_at)
    VALUES ('round-demo-1', 'north-1f', 'completed', ?, ?, 'user-staff', 'user-staff', ?, ?)
    ON CONFLICT(id) DO NOTHING
  `)
  const insertTask = db.prepare(`
    INSERT INTO round_tasks (id, round_id, resident_id, bed_id, status, note, completed_at, completed_by, created_at, updated_at)
    VALUES ('round-task-demo-1', 'round-demo-1', 'resident-demo-118-0', '118-0', 'completed', 'Control de ejemplo', ?, 'user-staff', ?, ?)
    ON CONFLICT(id) DO NOTHING
  `)
  const insertAlert = db.prepare(`
    INSERT INTO alerts (id, resident_id, bed_id, sensor_event_id, kind, level, status, title, detail, occurred_at, created_at, updated_at)
    VALUES ('alert-demo-118-edge', 'resident-demo-118-0', '118-0', 'event-demo-118-edge', 'state_change', 'medium', 'open', 'Movimiento detectado', 'Extremidad cerca del borde', ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `)
  const insertNote = db.prepare(`
    INSERT INTO care_notes (id, resident_id, author_id, kind, body, created_at, updated_at)
    VALUES ('note-demo-118', 'resident-demo-118-0', 'user-staff', 'general', 'Observacion de ejemplo del dataset demo', ?, ?)
    ON CONFLICT(id) DO NOTHING
  `)
  db.transaction(() => {
    events.forEach((event) => {
      insertEvent.run(
        event.id,
        event.source_event_id,
        event.bed_id,
        event.resident_id,
        event.monitor_key,
        event.kind,
        event.room_state,
        event.substate,
        event.state,
        event.alert_level,
        event.occurred_at,
        receivedAt,
        JSON.stringify(event),
      )
      insertState.run(
        event.bed_id,
        event.resident_id,
        event.room_state,
        event.state,
        event.substate,
        event.sleeping ? 1 : 0,
        event.alert_level,
        event.occurred_at,
        event.id,
      )
    })
    insertRound.run(roundStartedAt, roundCompletedAt, roundStartedAt, roundCompletedAt)
    insertTask.run(roundCompletedAt, roundStartedAt, roundCompletedAt)
    insertAlert.run(events[1].occurred_at, receivedAt, receivedAt)
    insertNote.run(roundCompletedAt, roundCompletedAt)
  })()
}

export function seedDemoClinicalData(nowValue = new Date()) {
  const clinical = demoClinicalData(nowValue)
  const insertSleep = db.prepare(`
    INSERT INTO sleep_summaries
      (id, source_record_id, resident_id, observed_on, sleep_started_at, sleep_ended_at,
       calm_minutes, restless_minutes, awake_minutes, out_of_bed_minutes, bed_exit_count, wake_count,
       source, model_version, confidence, created_at, updated_at)
    VALUES (@id, @source_record_id, @resident_id, @observed_on, @sleep_started_at, @sleep_ended_at,
       @calm_minutes, @restless_minutes, @awake_minutes, @out_of_bed_minutes, @bed_exit_count, @wake_count,
       'seed-demo', 'seed-v1', 1, @observed_at, @observed_at)
    ON CONFLICT(source_record_id) DO UPDATE SET
      calm_minutes = excluded.calm_minutes, restless_minutes = excluded.restless_minutes,
      awake_minutes = excluded.awake_minutes, out_of_bed_minutes = excluded.out_of_bed_minutes,
      bed_exit_count = excluded.bed_exit_count, wake_count = excluded.wake_count, updated_at = excluded.updated_at
  `)
  const insertMobility = db.prepare(`
    INSERT INTO mobility_summaries
      (id, source_record_id, resident_id, observed_on, in_bed_minutes, out_of_bed_minutes,
       out_of_sight_minutes, walking_minutes, walking_distance_meters, walking_speed_mps,
       transfer_count, source, model_version, confidence, created_at, updated_at)
    VALUES (@id, @source_record_id, @resident_id, @observed_on, @in_bed_minutes, @out_of_bed_minutes,
       @out_of_sight_minutes, @walking_minutes, @walking_distance_meters, @walking_speed_mps,
       @transfer_count, 'seed-demo', 'seed-v1', 1, @observed_at, @observed_at)
    ON CONFLICT(source_record_id) DO UPDATE SET
      in_bed_minutes = excluded.in_bed_minutes, out_of_bed_minutes = excluded.out_of_bed_minutes,
      out_of_sight_minutes = excluded.out_of_sight_minutes, walking_minutes = excluded.walking_minutes,
      walking_distance_meters = excluded.walking_distance_meters, walking_speed_mps = excluded.walking_speed_mps,
      transfer_count = excluded.transfer_count, updated_at = excluded.updated_at
  `)
  const insertBathroom = db.prepare(`
    INSERT INTO bathroom_summaries
      (id, source_record_id, resident_id, observed_on, visit_count, night_visit_count,
       assisted_count, total_minutes, longest_visit_minutes,
       source, model_version, confidence, created_at, updated_at)
    VALUES (@id, @source_record_id, @resident_id, @observed_on, @visit_count, @night_visit_count,
       @assisted_count, @total_minutes, @longest_visit_minutes,
       'seed-demo', 'seed-v1', 1, @observed_at, @observed_at)
    ON CONFLICT(source_record_id) DO UPDATE SET
      visit_count = excluded.visit_count, night_visit_count = excluded.night_visit_count,
      assisted_count = excluded.assisted_count, total_minutes = excluded.total_minutes,
      longest_visit_minutes = excluded.longest_visit_minutes, updated_at = excluded.updated_at
  `)
  const insertNote = db.prepare(`
    INSERT INTO care_notes (id, resident_id, author_id, kind, body, duration_minutes, created_at, updated_at)
    VALUES (@id, @resident_id, @author_id, @kind, @body, @duration_minutes, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, body = excluded.body,
      duration_minutes = excluded.duration_minutes, updated_at = excluded.updated_at
  `)
  const insertIncident = db.prepare(`
    INSERT INTO incidents
      (id, source_record_id, resident_id, bed_id, kind, severity, status, occurred_at, location,
       activity, injury_status, self_recovery, response_seconds, narrative, interventions_json,
       source, model_version, confidence, detection_verdict, verdict_by, verdict_at, created_at, updated_at)
    VALUES (@id, @source_record_id, @resident_id, @bed_id, @kind, @severity, @status, @occurred_at, @location,
       @activity, @injury_status, @self_recovery, @response_seconds, @narrative, @interventions_json,
       @source, @model_version, @confidence, @detection_verdict, @verdict_by, @verdict_at, @created_at, @updated_at)
    ON CONFLICT(source_record_id) DO UPDATE SET
      status = excluded.status, narrative = excluded.narrative,
      interventions_json = excluded.interventions_json,
      detection_verdict = excluded.detection_verdict, verdict_by = excluded.verdict_by,
      verdict_at = excluded.verdict_at, updated_at = excluded.updated_at
  `)

  /* Estados actuales de la matriz demo. La frescura la deriva la API de la
   * edad de updated_at, asi que aca solo se persiste el instante. */
  const insertClinicalEvent = db.prepare(`
    INSERT INTO sensor_events
      (id, source_event_id, bed_id, resident_id, monitor_key, kind, room_state, substate, state, alert_level, occurred_at, received_at, payload_json)
    VALUES (@id, @source_event_id, @bed_id, @resident_id, @monitor_key, @kind, @room_state, @substate, @state, @alert_level, @occurred_at, @received_at, '{}')
    ON CONFLICT(id) DO UPDATE SET
      room_state = excluded.room_state, substate = excluded.substate, state = excluded.state,
      alert_level = excluded.alert_level, occurred_at = excluded.occurred_at, received_at = excluded.received_at
  `)
  const insertClinicalState = db.prepare(`
    INSERT INTO current_bed_states
      (bed_id, resident_id, room_state, state, substate, sleeping, alert_level, updated_at, source, source_event_id)
    VALUES (@bed_id, @resident_id, @room_state, @state, @substate, @sleeping, @alert_level, @updated_at, 'seed-demo', @source_event_id)
    ON CONFLICT(bed_id) DO UPDATE SET
      resident_id = excluded.resident_id, room_state = excluded.room_state, state = excluded.state,
      substate = excluded.substate, sleeping = excluded.sleeping, alert_level = excluded.alert_level,
      updated_at = excluded.updated_at, source = excluded.source, source_event_id = excluded.source_event_id
  `)

  const insertClinicalAlert = db.prepare(`
    INSERT INTO alerts
      (id, resident_id, bed_id, sensor_event_id, kind, level, status, title, detail,
       occurred_at, attended_at, attended_by, created_at, updated_at)
    VALUES (@id, @resident_id, @bed_id, NULL, @kind, @level, @status, @title, @detail,
       @occurred_at, @attended_at, @attended_by, @occurred_at, @occurred_at)
    ON CONFLICT(id) DO UPDATE SET
      level = excluded.level, status = excluded.status, occurred_at = excluded.occurred_at,
      attended_at = excluded.attended_at, attended_by = excluded.attended_by,
      updated_at = excluded.updated_at
  `)

  db.transaction(() => {
    clinical.alerts.forEach((alert) => insertClinicalAlert.run(alert))
    clinical.sleep.forEach((summary) => insertSleep.run({ ...summary, observed_at: nowValue.toISOString() }))
    clinical.mobility.forEach((summary) => insertMobility.run({ ...summary, observed_at: nowValue.toISOString() }))
    clinical.bathroom.forEach((summary) => insertBathroom.run({ ...summary, observed_at: nowValue.toISOString() }))
    clinical.notes.forEach((note) => insertNote.run(note))
    clinical.incidents.forEach((incident) =>
      insertIncident.run({ ...incident, interventions_json: JSON.stringify(incident.interventions) }),
    )
    /* El monitor real solo existe en las camas equipadas; el resto usa una
     * clave de origen propia de la seed para no inventar hardware. */
    const monitorKeyFor = db.prepare('SELECT monitor_key FROM beds WHERE id = ?')
    clinical.stateEvents.forEach((event) =>
      insertClinicalEvent.run({
        ...event,
        substate: event.substate ?? null,
        received_at: event.occurred_at,
        monitor_key: monitorKeyFor.get(event.bed_id)?.monitor_key || `seed-demo-${event.bed_id}`,
      }),
    )
    clinical.states.forEach((state) => insertClinicalState.run(state))
  })()
}

export function closeDb() {
  db.close()
}

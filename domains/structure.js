/* Dominio de estructura: residencias, alas, habitaciones, camas, grilla de
 * turnos, planograma, cobertura de staff y grupos de staff.
 *
 * Reglas que viven aca:
 * - dos turnos no pueden compartir clave ni arrancar a la misma hora;
 * - quitar un turno deja sin cobertura a las alas que cubria (se avisa, no se
 *   borra en silencio);
 * - un monitor y un stream se vinculan a una sola cama/habitacion activa;
 * - una residencia sin grilla declarada trabaja con la grilla por defecto;
 * - la cobertura se resuelve con la grilla de staff de la residencia, no con
 *   el corte de alarmas.
 *
 * Los permisos (auth y `can`) son de la plataforma y se resuelven en el
 * transporte: este modulo no sabe quien pidio. */

import { audit, newId, timestamp } from '../platform.js'
import { db } from '../db.js'

function hasField(payload, field) {
  return Object.prototype.hasOwnProperty.call(payload, field)
}

function requireFields(payload, fields) {
  const missing = Object.fromEntries(
    fields
      .filter((field) => typeof payload[field] !== 'string' || !payload[field].trim())
      .map((field) => [field, 'required']),
  )
  return Object.keys(missing).length ? missing : null
}

function activeFacility(facilityId) {
  return db.prepare('SELECT id, name, timezone FROM facilities WHERE id = ? AND active = 1').get(facilityId)
}

function activeWing(wingId) {
  return db.prepare('SELECT id FROM wings WHERE id = ? AND active = 1').get(wingId)
}

function activeRoom(roomId) {
  return db.prepare('SELECT id FROM rooms WHERE id = ? AND active = 1').get(roomId)
}

function activeBed(bedId) {
  return db.prepare('SELECT id FROM beds WHERE id = ? AND active = 1').get(bedId)
}

export function staffGroupDetail(groupId) {
  const group = db
    .prepare('SELECT id, facility_id, name, active FROM staff_groups WHERE id = ? AND active = 1')
    .get(groupId)
  if (!group) return null
  const members = db
    .prepare(
      `
      SELECT u.id, u.username, u.display_name, u.role
      FROM staff_group_members m
      JOIN users u ON u.id = m.user_id AND u.active = 1
      WHERE m.staff_group_id = ?
      ORDER BY u.display_name, u.id
    `,
    )
    .all(groupId)
  return { ...group, members }
}

export function wingPlanogram(wingId) {
  return db
    .prepare(
      `
      SELECT p.id, p.wing_id, p.room_id, p.x, p.y, p.sort_order,
             r.number AS room_number, r.type AS room_type, r.stream_key
      FROM planogram_placements p
      JOIN rooms r ON r.id = p.room_id AND r.active = 1
      WHERE p.wing_id = ? AND p.active = 1
      ORDER BY p.sort_order, r.number, r.id
    `,
    )
    .all(wingId)
}

export function companionRooms() {
  const placements = db
    .prepare(
      `
      SELECT p.room_id, p.wing_id, p.x, p.y, p.sort_order,
             r.number AS room_number, r.type AS room_type, r.stream_key,
             w.name AS wing_name, w.floor AS wing_floor
      FROM planogram_placements p
      JOIN rooms r ON r.id = p.room_id AND r.active = 1
      JOIN wings w ON w.id = p.wing_id AND w.active = 1
      WHERE p.active = 1
      ORDER BY w.sort_order, p.sort_order, r.number, r.id
    `,
    )
    .all()
  const coverageByWing = new Map()
  const privacyRegionsByRoom = new Map()
  for (const region of db
    .prepare('SELECT room_id, x, y, w, h FROM room_privacy_regions WHERE active = 1 ORDER BY room_id, id')
    .all()) {
    const regions = privacyRegionsByRoom.get(region.room_id) || []
    regions.push({ x: region.x, y: region.y, w: region.w, h: region.h })
    privacyRegionsByRoom.set(region.room_id, regions)
  }
  return placements.map((placement) => {
    if (!coverageByWing.has(placement.wing_id)) coverageByWing.set(placement.wing_id, wingCoverage(placement.wing_id))
    return {
      ...placement,
      coverage: coverageByWing.get(placement.wing_id) || null,
      privacy_regions: privacyRegionsByRoom.get(placement.room_id) || [],
    }
  })
}

/* Grilla por defecto: dos turnos que coinciden con las claves que ya existian
 * en `unit_shift_coverages`, para que sembrarla no cambie el significado de
 * ninguna fila guardada. */
const DEFAULT_SHIFT_GRID = [
  { key: 'day', label: 'Día', start_hour: 7 },
  { key: 'night', label: 'Noche', start_hour: 19 },
]

export function facilityShifts(facilityId) {
  const rows = db
    .prepare(
      'SELECT id, facility_id, key, label, start_hour, sort_order FROM facility_shifts WHERE facility_id = ? AND active = 1 ORDER BY start_hour, sort_order',
    )
    .all(facilityId)
  if (rows.length) return rows

  /* Una residencia sin grilla declarada trabaja con la de por defecto. Se
   * siembra al leerla para que la primera edicion parta de algo concreto en vez
   * de una tabla vacia. */
  const now = timestamp()
  const insert = db.prepare(
    'INSERT INTO facility_shifts (id, facility_id, key, label, start_hour, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(facility_id, key) DO NOTHING',
  )
  DEFAULT_SHIFT_GRID.forEach((shift, index) => {
    insert.run(newId('shift'), facilityId, shift.key, shift.label, shift.start_hour, index + 1, now)
  })
  return db
    .prepare(
      'SELECT id, facility_id, key, label, start_hour, sort_order FROM facility_shifts WHERE facility_id = ? AND active = 1 ORDER BY start_hour, sort_order',
    )
    .all(facilityId)
}

/* Que turno de staff corre a una hora dada. Cada turno empieza donde dice y
 * termina donde empieza el siguiente; el ultimo cruza la medianoche, asi que
 * una hora anterior al primer arranque cae en el. */
function shiftAtHour(shifts, hour) {
  if (!shifts.length) return null
  let current = shifts[shifts.length - 1]
  for (const shift of shifts) {
    if (hour >= shift.start_hour) current = shift
  }
  return current
}

function localHourIn(timezone, date) {
  try {
    return Number(
      new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' }).format(date),
    )
  } catch {
    return date.getUTCHours()
  }
}

export function wingCoverage(wingId, at = new Date()) {
  const wing = db
    .prepare(
      `
      SELECT w.id, w.name, w.floor, w.facility_id, f.timezone
      FROM wings w
      JOIN facilities f ON f.id = w.facility_id
      WHERE w.id = ? AND w.active = 1
    `,
    )
    .get(wingId)
  if (!wing) return null
  const when = at instanceof Date ? at : new Date(at)
  const moment = Number.isNaN(when.valueOf()) ? new Date() : when
  /* La cobertura se resuelve con la grilla de staff de la residencia, no con el
   * corte de alarmas: las alarmas hablan de momentos del dia y esto habla de
   * quien trabaja. Que compartieran el corte impedia tener tres turnos sin
   * tocar la configuracion clinica de cada residente. */
  const shifts = facilityShifts(wing.facility_id)
  const resolved = shiftAtHour(shifts, localHourIn(wing.timezone || 'UTC', moment))
  const shift = resolved?.key ?? 'day'
  const coverage = db
    .prepare(
      `
      SELECT id, wing_id, staff_group_id, shift
      FROM unit_shift_coverages
      WHERE wing_id = ? AND shift = ? AND active = 1
    `,
    )
    .get(wingId, shift)
  return {
    wing: { id: wing.id, name: wing.name, floor: wing.floor, facility_id: wing.facility_id },
    at: (Number.isNaN(when.valueOf()) ? new Date() : when).toISOString(),
    shift,
    staff_group: coverage ? staffGroupDetail(coverage.staff_group_id) : null,
  }
}

export function listWings(facilityId) {
  return db
    .prepare(
      `
    SELECT id, facility_id, name, floor, sort_order
    FROM wings WHERE facility_id = ? AND active = 1 ORDER BY sort_order, id
  `,
    )
    .all(facilityId)
}

export function listFacilities() {
  return db.prepare('SELECT id, name, timezone FROM facilities WHERE active = 1 ORDER BY name').all()
}

export function facilityDetail(facilityId) {
  const facility = activeFacility(facilityId)
  if (!facility) return { error: { status: 404, code: 'NOT_FOUND', message: 'Residencia no encontrada' } }
  return { ...facility, wings: listWings(facility.id) }
}

export function createFacility(payload) {
  const fields = requireFields(payload, ['name'])
  if (fields) return { error: { status: 422, code: 'VALIDATION_ERROR', message: 'Faltan campos obligatorios', fields } }
  const record = { id: newId('facility'), name: payload.name.trim(), timezone: payload.timezone || 'UTC' }
  db.prepare('INSERT INTO facilities (id, name, timezone, created_at) VALUES (?, ?, ?, ?)').run(
    record.id,
    record.name,
    record.timezone,
    timestamp(),
  )
  return record
}

export function updateFacility(facilityId, payload, userId) {
  const facility = activeFacility(facilityId)
  if (!facility) return { error: { status: 404, code: 'NOT_FOUND', message: 'Residencia no encontrada' } }
  const updates = []
  const values = []
  if (hasField(payload, 'name')) {
    if (typeof payload.name !== 'string' || !payload.name.trim())
      return {
        error: {
          status: 422,
          code: 'VALIDATION_ERROR',
          message: 'name debe ser un texto no vacio',
          fields: { name: 'invalid' },
        },
      }
    updates.push('name = ?')
    values.push(payload.name.trim().slice(0, 120))
  }
  if (hasField(payload, 'timezone')) {
    if (typeof payload.timezone !== 'string' || !payload.timezone.trim())
      return {
        error: {
          status: 422,
          code: 'VALIDATION_ERROR',
          message: 'timezone debe ser un texto no vacio',
          fields: { timezone: 'invalid' },
        },
      }
    updates.push('timezone = ?')
    values.push(payload.timezone.trim().slice(0, 80))
  }
  if (!updates.length)
    return { error: { status: 422, code: 'VALIDATION_ERROR', message: 'No hay campos para actualizar' } }
  values.push(facility.id)
  db.prepare(`UPDATE facilities SET ${updates.join(', ')} WHERE id = ?`).run(...values)
  audit(userId, 'facility.updated', 'facility', facility.id, {
    fields: updates.map((field) => field.split(' ')[0]),
  })
  return {
    facility: db.prepare('SELECT id, name, timezone FROM facilities WHERE id = ?').get(facility.id),
  }
}

export function facilityShiftsView(facilityId) {
  const facility = activeFacility(facilityId)
  if (!facility) return { error: { status: 404, code: 'NOT_FOUND', message: 'Residencia no encontrada' } }
  return { facility_id: facility.id, shifts: facilityShifts(facility.id) }
}

export function updateFacilityShifts(facilityId, payload, userId) {
  const facility = activeFacility(facilityId)
  if (!facility) return { error: { status: 404, code: 'NOT_FOUND', message: 'Residencia no encontrada' } }
  if (!Array.isArray(payload.shifts) || payload.shifts.length < 1)
    return {
      error: {
        status: 422,
        code: 'VALIDATION_ERROR',
        message: 'shifts debe ser un arreglo con al menos un turno',
        fields: { shifts: 'invalid' },
      },
    }
  const seen = new Set()
  const hours = new Set()
  for (const shift of payload.shifts) {
    if (!shift || typeof shift.key !== 'string' || !/^[a-z0-9_-]+$/.test(shift.key))
      return {
        error: {
          status: 422,
          code: 'VALIDATION_ERROR',
          message: 'Cada turno necesita una clave simple',
          fields: { key: 'invalid' },
        },
      }
    if (seen.has(shift.key))
      return {
        error: {
          status: 409,
          code: 'CONFLICT',
          message: 'Hay dos turnos con la misma clave',
          fields: { key: shift.key },
        },
      }
    seen.add(shift.key)
    if (typeof shift.label !== 'string' || !shift.label.trim())
      return {
        error: {
          status: 422,
          code: 'VALIDATION_ERROR',
          message: 'Cada turno necesita un nombre',
          fields: { label: 'invalid' },
        },
      }
    const hour = Number(shift.start_hour)
    if (!Number.isInteger(hour) || hour < 0 || hour > 23)
      return {
        error: {
          status: 422,
          code: 'VALIDATION_ERROR',
          message: 'start_hour debe ser una hora entre 0 y 23',
          fields: { start_hour: 'invalid' },
        },
      }
    /* Dos turnos que arrancan a la misma hora dejan un tramo del dia sin
     * dueño definido: se rechaza antes de guardar. */
    if (hours.has(hour))
      return {
        error: {
          status: 409,
          code: 'CONFLICT',
          message: 'Hay dos turnos que empiezan a la misma hora',
          fields: { start_hour: hour },
        },
      }
    hours.add(hour)
  }
  /* Un turno que se saca deja sin cobertura a las alas que cubria: se avisa
   * en vez de borrarla en silencio. */
  const removed = facilityShifts(facilityId)
    .map((shift) => shift.key)
    .filter((key) => !seen.has(key))
  const orphaned = removed.length
    ? db
        .prepare(
          `SELECT COUNT(*) AS total FROM unit_shift_coverages c
           JOIN wings w ON w.id = c.wing_id
           WHERE w.facility_id = ? AND c.active = 1 AND c.shift IN (${removed.map(() => '?').join(',')})`,
        )
        .get(facilityId, ...removed).total
    : 0
  const now = timestamp()
  db.transaction(() => {
    db.prepare('UPDATE facility_shifts SET active = 0 WHERE facility_id = ?').run(facilityId)
    const upsert = db.prepare(`
      INSERT INTO facility_shifts (id, facility_id, key, label, start_hour, sort_order, active, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(facility_id, key) DO UPDATE SET
        label = excluded.label, start_hour = excluded.start_hour,
        sort_order = excluded.sort_order, active = 1
    `)
    payload.shifts.forEach((shift, index) => {
      upsert.run(
        newId('shift'),
        facilityId,
        shift.key,
        shift.label.trim().slice(0, 40),
        Number(shift.start_hour),
        index + 1,
        now,
      )
    })
    if (removed.length) {
      db.prepare(
        `UPDATE unit_shift_coverages SET active = 0
         WHERE active = 1 AND shift IN (${removed.map(() => '?').join(',')})
         AND wing_id IN (SELECT id FROM wings WHERE facility_id = ?)`,
      ).run(...removed, facilityId)
    }
  })()
  audit(userId, 'facility.shifts.updated', 'facility', facilityId, {
    shifts: payload.shifts.length,
    removed,
    coverages_cleared: orphaned,
  })
  return {
    facility_id: facilityId,
    shifts: facilityShifts(facilityId),
    coverages_cleared: orphaned,
  }
}

export function wingsOverview() {
  return db
    .prepare(
      `
    SELECT w.id, w.facility_id, w.name, w.floor, w.sort_order, COUNT(b.id) AS bed_count
    FROM wings w
    LEFT JOIN rooms r ON r.wing_id = w.id AND r.active = 1
    LEFT JOIN beds b ON b.room_id = r.id AND b.active = 1
    WHERE w.active = 1
    GROUP BY w.id
    ORDER BY w.sort_order, w.id
  `,
    )
    .all()
}

export function updateWing(wingId, payload, userId) {
  const wing = activeWing(wingId)
  if (!wing) return { error: { status: 404, code: 'NOT_FOUND', message: 'Ala no encontrada' } }
  const updates = []
  const values = []
  if (hasField(payload, 'name')) {
    if (typeof payload.name !== 'string' || !payload.name.trim())
      return {
        error: {
          status: 422,
          code: 'VALIDATION_ERROR',
          message: 'name debe ser un texto no vacio',
          fields: { name: 'invalid' },
        },
      }
    updates.push('name = ?')
    values.push(payload.name.trim().slice(0, 120))
  }
  if (hasField(payload, 'floor')) {
    if (typeof payload.floor !== 'string' || !payload.floor.trim())
      return {
        error: {
          status: 422,
          code: 'VALIDATION_ERROR',
          message: 'floor debe ser un texto no vacio',
          fields: { floor: 'invalid' },
        },
      }
    updates.push('floor = ?')
    values.push(payload.floor.trim().slice(0, 40))
  }
  if (hasField(payload, 'sort_order')) {
    if (!Number.isInteger(Number(payload.sort_order)) || Number(payload.sort_order) < 0)
      return {
        error: {
          status: 422,
          code: 'VALIDATION_ERROR',
          message: 'sort_order debe ser un entero positivo',
          fields: { sort_order: 'invalid' },
        },
      }
    updates.push('sort_order = ?')
    values.push(Number(payload.sort_order))
  }
  if (!updates.length)
    return { error: { status: 422, code: 'VALIDATION_ERROR', message: 'No hay campos para actualizar' } }
  values.push(wing.id)
  db.prepare(`UPDATE wings SET ${updates.join(', ')} WHERE id = ?`).run(...values)
  audit(userId, 'wing.updated', 'wing', wing.id, {
    fields: updates.map((field) => field.split(' ')[0]),
  })
  return {
    wing: db.prepare('SELECT id, facility_id, name, floor, sort_order FROM wings WHERE id = ?').get(wing.id),
  }
}

export function createWing(facilityId, payload) {
  const fields = requireFields(payload, ['name', 'floor'])
  if (fields) return { error: { status: 422, code: 'VALIDATION_ERROR', message: 'Faltan campos obligatorios', fields } }
  const facility = activeFacility(facilityId)
  if (!facility) return { error: { status: 404, code: 'NOT_FOUND', message: 'Residencia no encontrada' } }
  const record = {
    id: newId('wing'),
    facility_id: facilityId,
    name: payload.name.trim(),
    floor: payload.floor.trim(),
    sort_order: Number(payload.sort_order || 0),
  }
  db.prepare('INSERT INTO wings (id, facility_id, name, floor, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    record.id,
    record.facility_id,
    record.name,
    record.floor,
    record.sort_order,
    timestamp(),
  )
  return record
}

export function wingRooms(wingId) {
  const wing = activeWing(wingId)
  if (!wing) return { error: { status: 404, code: 'NOT_FOUND', message: 'Ala no encontrada' } }
  return {
    rooms: db
      .prepare(
        `
      SELECT id, wing_id, number, type, stream_key
      FROM rooms WHERE wing_id = ? AND active = 1 ORDER BY number, id
    `,
      )
      .all(wingId),
  }
}

export function createRoom(wingId, payload, userId) {
  const fields = requireFields(payload, ['number'])
  if (fields) return { error: { status: 422, code: 'VALIDATION_ERROR', message: 'Faltan campos obligatorios', fields } }
  const wing = activeWing(wingId)
  if (!wing) return { error: { status: 404, code: 'NOT_FOUND', message: 'Ala no encontrada' } }
  let streamKey = null
  if (hasField(payload, 'stream_key')) {
    if (payload.stream_key !== null && (typeof payload.stream_key !== 'string' || !payload.stream_key.trim()))
      return {
        error: {
          status: 422,
          code: 'VALIDATION_ERROR',
          message: 'stream_key debe ser texto o null',
          fields: { stream_key: 'invalid' },
        },
      }
    streamKey = typeof payload.stream_key === 'string' ? payload.stream_key.trim() : null
    if (streamKey && db.prepare('SELECT id FROM rooms WHERE stream_key = ? AND active = 1').get(streamKey))
      return { error: { status: 409, code: 'CONFLICT', message: 'El stream ya esta vinculado a otra habitacion' } }
  }
  const record = {
    id: newId('room'),
    wing_id: wingId,
    number: payload.number.trim(),
    type: payload.type || 'single',
    stream_key: streamKey,
  }
  db.prepare('INSERT INTO rooms (id, wing_id, number, type, stream_key, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    record.id,
    record.wing_id,
    record.number,
    record.type,
    record.stream_key,
    timestamp(),
  )
  audit(userId, 'room.created', 'room', record.id, {
    number: record.number,
    stream_key: record.stream_key,
  })
  return record
}

export function updateRoom(roomId, payload, userId) {
  const room = activeRoom(roomId)
  if (!room) return { error: { status: 404, code: 'NOT_FOUND', message: 'Habitacion no encontrada' } }
  const updates = []
  const values = []
  if (hasField(payload, 'number')) {
    if (typeof payload.number !== 'string' || !payload.number.trim())
      return {
        error: {
          status: 422,
          code: 'VALIDATION_ERROR',
          message: 'number debe ser un texto no vacio',
          fields: { number: 'invalid' },
        },
      }
    updates.push('number = ?')
    values.push(payload.number.trim().slice(0, 40))
  }
  if (hasField(payload, 'type')) {
    if (typeof payload.type !== 'string' || !payload.type.trim())
      return {
        error: {
          status: 422,
          code: 'VALIDATION_ERROR',
          message: 'type debe ser un texto no vacio',
          fields: { type: 'invalid' },
        },
      }
    updates.push('type = ?')
    values.push(payload.type.trim().slice(0, 40))
  }
  if (hasField(payload, 'stream_key')) {
    if (payload.stream_key !== null && (typeof payload.stream_key !== 'string' || !payload.stream_key.trim()))
      return {
        error: {
          status: 422,
          code: 'VALIDATION_ERROR',
          message: 'stream_key debe ser texto o null',
          fields: { stream_key: 'invalid' },
        },
      }
    const streamKey = typeof payload.stream_key === 'string' ? payload.stream_key.trim() : null
    if (
      streamKey &&
      db.prepare('SELECT id FROM rooms WHERE stream_key = ? AND id != ? AND active = 1').get(streamKey, room.id)
    )
      return { error: { status: 409, code: 'CONFLICT', message: 'El stream ya esta vinculado a otra habitacion' } }
    updates.push('stream_key = ?')
    values.push(streamKey)
  }
  if (!updates.length)
    return { error: { status: 422, code: 'VALIDATION_ERROR', message: 'No hay campos para actualizar' } }
  values.push(room.id)
  db.prepare(`UPDATE rooms SET ${updates.join(', ')} WHERE id = ?`).run(...values)
  audit(userId, 'room.updated', 'room', room.id, {
    fields: updates.map((field) => field.split(' ')[0]),
  })
  return {
    room: db.prepare('SELECT id, wing_id, number, type, stream_key FROM rooms WHERE id = ?').get(room.id),
  }
}

export function roomBeds(roomId) {
  const room = activeRoom(roomId)
  if (!room) return { error: { status: 404, code: 'NOT_FOUND', message: 'Habitacion no encontrada' } }
  return {
    beds: db
      .prepare(
        `
      SELECT b.id, b.room_id, b.label, b.monitor_key,
        a.resident_id, r.full_name AS resident_name
      FROM beds b
      LEFT JOIN resident_bed_assignments a ON a.bed_id = b.id AND a.ends_at IS NULL
      LEFT JOIN residents r ON r.id = a.resident_id AND r.status = 'active'
      WHERE b.room_id = ? AND b.active = 1 ORDER BY b.id
    `,
      )
      .all(roomId)
      .map((bed) => ({
        id: bed.id,
        room_id: bed.room_id,
        label: bed.label,
        monitor_key: bed.monitor_key,
        /* Quién la ocupa viaja con la cama para que la estructura no tenga que
         * pedir el padrón de residentes para saber si está libre. Una cama
         * ocupada sin monitor es una falla silenciosa; una cama libre sin
         * monitor es apenas algo por cargar, y la diferencia se lee acá. */
        resident_id: bed.resident_id ?? null,
        resident_name: bed.resident_name ?? null,
      })),
  }
}

export function createBed(roomId, payload) {
  const fields = requireFields(payload, ['label'])
  if (fields) return { error: { status: 422, code: 'VALIDATION_ERROR', message: 'Faltan campos obligatorios', fields } }
  const room = activeRoom(roomId)
  if (!room) return { error: { status: 404, code: 'NOT_FOUND', message: 'Habitacion no encontrada' } }
  const record = {
    id: newId('bed'),
    room_id: roomId,
    label: payload.label.trim(),
    monitor_key: payload.monitor_key || null,
  }
  db.prepare('INSERT INTO beds (id, room_id, label, monitor_key, created_at) VALUES (?, ?, ?, ?, ?)').run(
    record.id,
    record.room_id,
    record.label,
    record.monitor_key,
    timestamp(),
  )
  return record
}

/* Todas las camas de la residencia con su ubicacion y quien las ocupa.
 *
 * Existe porque hay una pregunta que no se puede contestar habitacion por
 * habitacion: "donde puedo ubicar a esta persona". Recorrer alas, pedir las
 * habitaciones de cada una y las camas de cada habitacion es una cascada de
 * decenas de requests para una lista que la base resuelve en una consulta.
 *
 * Devuelve tambien las ocupadas: mudar a alguien es elegir una cama que hoy
 * tiene duenio, y esconderla obligaria a liberar primero y elegir despues. */
export function listBeds() {
  return db
    .prepare(
      `
    SELECT b.id, b.room_id, b.label, b.monitor_key,
      rm.number AS room_number, rm.type AS room_type, rm.stream_key,
      w.id AS wing_id, w.name AS wing_name, w.floor AS wing_floor,
      a.resident_id, r.full_name AS resident_name
    FROM beds b
    JOIN rooms rm ON rm.id = b.room_id AND rm.active = 1
    JOIN wings w ON w.id = rm.wing_id AND w.active = 1
    LEFT JOIN resident_bed_assignments a ON a.bed_id = b.id AND a.ends_at IS NULL
    LEFT JOIN residents r ON r.id = a.resident_id AND r.status = 'active'
    WHERE b.active = 1
    ORDER BY w.sort_order, w.name, rm.number, b.label
  `,
    )
    .all()
    .map((bed) => ({
      id: bed.id,
      room_id: bed.room_id,
      label: bed.label,
      monitor_key: bed.monitor_key,
      room_number: bed.room_number,
      room_type: bed.room_type,
      /* El stream es de la habitacion y el monitor es de la cama: el alta
       * necesita los dos para decir si esa cama ve y avisa. */
      stream_key: bed.stream_key,
      wing_id: bed.wing_id,
      wing_name: bed.wing_name,
      wing_floor: bed.wing_floor,
      resident_id: bed.resident_id ?? null,
      resident_name: bed.resident_name ?? null,
    }))
}

export function updateBed(bedId, payload, userId) {
  const bed = activeBed(bedId)
  if (!bed) return { error: { status: 404, code: 'NOT_FOUND', message: 'Cama no encontrada' } }
  const updates = []
  const values = []
  if (hasField(payload, 'label')) {
    if (typeof payload.label !== 'string' || !payload.label.trim())
      return {
        error: {
          status: 422,
          code: 'VALIDATION_ERROR',
          message: 'label debe ser un texto no vacio',
          fields: { label: 'invalid' },
        },
      }
    updates.push('label = ?')
    values.push(payload.label.trim().slice(0, 80))
  }
  if (hasField(payload, 'monitor_key')) {
    if (payload.monitor_key !== null && (typeof payload.monitor_key !== 'string' || !payload.monitor_key.trim()))
      return {
        error: {
          status: 422,
          code: 'VALIDATION_ERROR',
          message: 'monitor_key debe ser texto o null',
          fields: { monitor_key: 'invalid' },
        },
      }
    const monitorKey = typeof payload.monitor_key === 'string' ? payload.monitor_key.trim() : null
    if (
      monitorKey &&
      db.prepare('SELECT id FROM beds WHERE monitor_key = ? AND id != ? AND active = 1').get(monitorKey, bed.id)
    )
      return { error: { status: 409, code: 'CONFLICT', message: 'El monitor ya esta vinculado a otra cama' } }
    updates.push('monitor_key = ?')
    values.push(monitorKey)
  }
  if (!updates.length)
    return { error: { status: 422, code: 'VALIDATION_ERROR', message: 'No hay campos para actualizar' } }
  values.push(bed.id)
  db.prepare(`UPDATE beds SET ${updates.join(', ')} WHERE id = ?`).run(...values)
  audit(userId, 'bed.updated', 'bed', bed.id, {
    fields: updates.map((field) => field.split(' ')[0]),
  })
  return {
    bed: db.prepare('SELECT id, room_id, label, monitor_key FROM beds WHERE id = ?').get(bed.id),
  }
}

export function planogram(wingId) {
  const wing = activeWing(wingId)
  if (!wing) return { error: { status: 404, code: 'NOT_FOUND', message: 'Unidad no encontrada' } }
  return { wing_id: wing.id, placements: wingPlanogram(wing.id) }
}

export function savePlanogram(wingId, payload, userId) {
  const wing = activeWing(wingId)
  if (!wing) return { error: { status: 404, code: 'NOT_FOUND', message: 'Unidad no encontrada' } }
  if (!Array.isArray(payload.placements))
    return {
      error: {
        status: 422,
        code: 'VALIDATION_ERROR',
        message: 'placements debe ser un arreglo',
        fields: { placements: 'invalid' },
      },
    }
  const seenRooms = new Set()
  for (const item of payload.placements) {
    if (!item || typeof item.room_id !== 'string' || !item.room_id.trim())
      return {
        error: {
          status: 422,
          code: 'VALIDATION_ERROR',
          message: 'Cada placement requiere room_id',
          fields: { room_id: 'invalid' },
        },
      }
    const roomId = item.room_id.trim()
    if (seenRooms.has(roomId))
      return {
        error: {
          status: 409,
          code: 'CONFLICT',
          message: 'Habitacion duplicada en el planograma',
          fields: { room_id: roomId },
        },
      }
    seenRooms.add(roomId)
    const room = db.prepare('SELECT id, wing_id FROM rooms WHERE id = ? AND active = 1').get(roomId)
    if (!room)
      return {
        error: { status: 404, code: 'NOT_FOUND', message: 'Habitacion no encontrada', fields: { room_id: roomId } },
      }
    if (room.wing_id !== wingId)
      return {
        error: {
          status: 422,
          code: 'VALIDATION_ERROR',
          message: 'La habitacion no pertenece a esta unidad',
          fields: { room_id: roomId },
        },
      }
    if (![item.x, item.y].every((value) => value === undefined || Number.isFinite(Number(value))))
      return {
        error: {
          status: 422,
          code: 'VALIDATION_ERROR',
          message: 'x e y deben ser numericos',
          fields: { room_id: roomId },
        },
      }
  }
  const nowTs = timestamp()
  db.transaction(() => {
    db.prepare('UPDATE planogram_placements SET active = 0 WHERE wing_id = ?').run(wingId)
    const upsert = db.prepare(`
      INSERT INTO planogram_placements (id, wing_id, room_id, x, y, sort_order, active, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(room_id) DO UPDATE SET
        wing_id = excluded.wing_id, x = excluded.x, y = excluded.y,
        sort_order = excluded.sort_order, active = 1
    `)
    payload.placements.forEach((item, index) => {
      upsert.run(
        newId('placement'),
        wingId,
        item.room_id.trim(),
        Number(item.x) || 0,
        Number(item.y) || 0,
        Number.isInteger(Number(item.sort_order)) ? Number(item.sort_order) : index + 1,
        nowTs,
      )
    })
  })()
  audit(userId, 'planogram.updated', 'wing', wingId, { count: payload.placements.length })
  return { wing_id: wingId, placements: wingPlanogram(wingId) }
}

export function coverage(wingId, at) {
  const result = wingCoverage(wingId, at)
  if (!result) return { error: { status: 404, code: 'NOT_FOUND', message: 'Unidad no encontrada' } }
  return result
}

export function updateCoverage(wingId, payload, userId) {
  const wing = activeWing(wingId)
  if (!wing) return { error: { status: 404, code: 'NOT_FOUND', message: 'Unidad no encontrada' } }
  /* El turno valido es el que la residencia declaro en su grilla, no un enum
   * fijo: una casa con mañana/tarde/noche tiene que poder asignarlos. */
  const coverageGrid = facilityShifts(db.prepare('SELECT facility_id FROM wings WHERE id = ?').get(wingId).facility_id)
  if (!coverageGrid.some((item) => item.key === payload.shift))
    return {
      error: {
        status: 422,
        code: 'VALIDATION_ERROR',
        message: `shift debe ser uno de los turnos de la residencia: ${coverageGrid.map((item) => item.key).join(', ')}`,
        fields: { shift: 'invalid' },
      },
    }
  if (payload.staff_group_id !== null && (typeof payload.staff_group_id !== 'string' || !payload.staff_group_id.trim()))
    return {
      error: {
        status: 422,
        code: 'VALIDATION_ERROR',
        message: 'staff_group_id debe ser texto o null',
        fields: { staff_group_id: 'invalid' },
      },
    }
  const shift = payload.shift
  if (payload.staff_group_id === null) {
    db.prepare('UPDATE unit_shift_coverages SET active = 0 WHERE wing_id = ? AND shift = ?').run(wingId, shift)
    audit(userId, 'coverage.cleared', 'wing', wingId, { shift })
    return wingCoverage(wingId)
  }
  const groupId = payload.staff_group_id.trim()
  if (!db.prepare('SELECT id FROM staff_groups WHERE id = ? AND active = 1').get(groupId))
    return { error: { status: 404, code: 'NOT_FOUND', message: 'Grupo de staff no encontrado' } }
  const existing = db
    .prepare('SELECT id FROM unit_shift_coverages WHERE wing_id = ? AND shift = ? AND active = 1')
    .get(wingId, shift)
  if (existing) {
    db.prepare('UPDATE unit_shift_coverages SET staff_group_id = ? WHERE id = ?').run(groupId, existing.id)
  } else {
    db.prepare(
      'INSERT INTO unit_shift_coverages (id, wing_id, staff_group_id, shift, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(newId('coverage'), wingId, groupId, shift, timestamp())
  }
  audit(userId, 'coverage.updated', 'wing', wingId, { shift, staff_group_id: groupId })
  return wingCoverage(wingId)
}
export function listStaffGroups(facilityId) {
  const filter = facilityId || null
  const rows = db
    .prepare(
      `
      SELECT g.id, g.facility_id, g.name, g.active, COUNT(m.user_id) AS member_count
      FROM staff_groups g
      LEFT JOIN staff_group_members m ON m.staff_group_id = g.id
      WHERE g.active = 1 AND (? IS NULL OR g.facility_id = ?)
      GROUP BY g.id
      ORDER BY g.name, g.id
    `,
    )
    .all(filter, filter)
  return { staff_groups: rows.map((group) => staffGroupDetail(group.id)) }
}

export function staffGroupView(groupId) {
  const detail = staffGroupDetail(groupId)
  if (!detail) return { error: { status: 404, code: 'NOT_FOUND', message: 'Grupo de staff no encontrado' } }
  return { staff_group: detail }
}

export function createStaffGroup(payload, userId) {
  const fields = requireFields(payload, ['facility_id', 'name'])
  if (fields) return { error: { status: 422, code: 'VALIDATION_ERROR', message: 'Faltan campos obligatorios', fields } }
  if (!activeFacility(payload.facility_id.trim()))
    return { error: { status: 404, code: 'NOT_FOUND', message: 'Residencia no encontrada' } }
  const record = {
    id: newId('sg'),
    facility_id: payload.facility_id.trim(),
    name: payload.name.trim().slice(0, 120),
  }
  db.prepare('INSERT INTO staff_groups (id, facility_id, name, created_at) VALUES (?, ?, ?, ?)').run(
    record.id,
    record.facility_id,
    record.name,
    timestamp(),
  )
  audit(userId, 'staff_group.created', 'staff_group', record.id, { name: record.name })
  return { staff_group: staffGroupDetail(record.id) }
}

export function updateStaffGroup(groupId, payload, userId) {
  const group = db.prepare('SELECT id FROM staff_groups WHERE id = ?').get(groupId)
  if (!group) return { error: { status: 404, code: 'NOT_FOUND', message: 'Grupo de staff no encontrado' } }
  const updates = []
  const values = []
  if (hasField(payload, 'name')) {
    if (typeof payload.name !== 'string' || !payload.name.trim())
      return {
        error: {
          status: 422,
          code: 'VALIDATION_ERROR',
          message: 'name debe ser un texto no vacio',
          fields: { name: 'invalid' },
        },
      }
    updates.push('name = ?')
    values.push(payload.name.trim().slice(0, 120))
  }
  if (hasField(payload, 'active')) {
    updates.push('active = ?')
    values.push(payload.active ? 1 : 0)
  }
  if (!updates.length)
    return { error: { status: 422, code: 'VALIDATION_ERROR', message: 'No hay campos para actualizar' } }
  values.push(group.id)
  db.prepare(`UPDATE staff_groups SET ${updates.join(', ')} WHERE id = ?`).run(...values)
  audit(userId, 'staff_group.updated', 'staff_group', group.id, {
    fields: updates.map((field) => field.split(' ')[0]),
  })
  const detail = staffGroupDetail(group.id)
  return {
    staff_group:
      detail || db.prepare('SELECT id, facility_id, name, active FROM staff_groups WHERE id = ?').get(group.id),
  }
}

export function saveStaffGroupMembers(groupId, payload, userId) {
  const group = db.prepare('SELECT id FROM staff_groups WHERE id = ? AND active = 1').get(groupId)
  if (!group) return { error: { status: 404, code: 'NOT_FOUND', message: 'Grupo de staff no encontrado' } }
  if (!Array.isArray(payload.user_ids))
    return {
      error: {
        status: 422,
        code: 'VALIDATION_ERROR',
        message: 'user_ids debe ser un arreglo',
        fields: { user_ids: 'invalid' },
      },
    }
  const userIds = [
    ...new Set(payload.user_ids.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim())),
  ]
  for (const userId of userIds) {
    if (!db.prepare('SELECT id FROM users WHERE id = ? AND active = 1').get(userId))
      return {
        error: { status: 404, code: 'NOT_FOUND', message: 'Usuario no encontrado', fields: { user_id: userId } },
      }
  }
  const nowTs = timestamp()
  db.transaction(() => {
    db.prepare('DELETE FROM staff_group_members WHERE staff_group_id = ?').run(groupId)
    const insert = db.prepare(
      'INSERT INTO staff_group_members (id, staff_group_id, user_id, created_at) VALUES (?, ?, ?, ?)',
    )
    userIds.forEach((userId) => insert.run(newId('sgm'), groupId, userId, nowTs))
  })()
  audit(userId, 'staff_group.members_updated', 'staff_group', groupId, { count: userIds.length })
  return { staff_group: staffGroupDetail(groupId) }
}

export function roomPrivacyRegions(roomId) {
  const room = activeRoom(roomId)
  if (!room) return { error: { status: 404, code: 'NOT_FOUND', message: 'Habitacion no encontrada' } }
  return {
    room_id: room.id,
    regions: db
      .prepare('SELECT x, y, w, h FROM room_privacy_regions WHERE room_id = ? AND active = 1 ORDER BY id')
      .all(room.id),
  }
}

export function saveRoomPrivacyRegions(roomId, payload, userId) {
  const room = activeRoom(roomId)
  if (!room) return { error: { status: 404, code: 'NOT_FOUND', message: 'Habitacion no encontrada' } }
  if (!Array.isArray(payload.regions) || payload.regions.length > 8)
    return {
      error: { status: 422, code: 'VALIDATION_ERROR', message: 'regions debe ser una lista de hasta 8 regiones' },
    }
  const regions = payload.regions.map((region) => ({
    x: Number(region.x),
    y: Number(region.y),
    w: Number(region.w),
    h: Number(region.h),
  }))
  if (
    regions.some(
      (region) =>
        ![region.x, region.y, region.w, region.h].every(Number.isFinite) ||
        region.x < 0 ||
        region.y < 0 ||
        region.w <= 0 ||
        region.h <= 0 ||
        region.x + region.w > 1 ||
        region.y + region.h > 1,
    )
  )
    return {
      error: { status: 422, code: 'VALIDATION_ERROR', message: 'Cada region debe estar normalizada dentro de 0..1' },
    }
  db.transaction(() => {
    db.prepare('DELETE FROM room_privacy_regions WHERE room_id = ?').run(room.id)
    const insert = db.prepare(
      'INSERT INTO room_privacy_regions (id, room_id, x, y, w, h, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    regions.forEach((region, index) =>
      insert.run(`privacy-${room.id}-${index + 1}`, room.id, region.x, region.y, region.w, region.h, timestamp()),
    )
  })()
  audit(userId, 'room.privacy_regions.updated', 'room', room.id, { count: regions.length })
  return { room_id: room.id, regions }
}

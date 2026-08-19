import crypto from 'node:crypto'
import Database from 'better-sqlite3'
import { db } from './db.js'

const SESSION_TTL_MS = 8 * 60 * 60 * 1000

const roleFeatures = {
  supervisor: ['nursing', 'residents', 'alerts', 'reports', 'configuration'],
  staff: ['nursing'],
}

const roleCapabilities = {
  supervisor: [
    'master.structure.read',
    'master.structure.write',
    'monitoring.board.read',
    'monitoring.live.read',
    'residents.list.read',
    'residents.snapshot.read',
    'residents.live.read',
    'residents.write',
    'residents.notes.read',
    'residents.notes.write',
    'sleep.read',
    'mobility.read',
    'bathroom.read',
    'care.read',
    'incidents.read',
    'incidents.manage',
    'rounds.read',
    'rounds.manage',
    'alerts.read',
    'alerts.manage',
    'analytics.read',
    'audit.read',
    'config.alarms.read',
    'config.alarms.manage',
  ],
  staff: [
    'master.structure.read',
    'monitoring.board.read',
    'monitoring.live.read',
    'residents.snapshot.read',
    'residents.live.read',
    'sleep.read',
    'mobility.read',
    'bathroom.read',
    'care.read',
    'rounds.read',
    'rounds.manage',
    'alerts.read',
    'alerts.manage',
  ],
}

const DEFAULT_ACTIVE_CAPABILITIES = [
  'master.structure.read',
  'master.structure.write',
  'monitoring.board.read',
  'monitoring.live.read',
  'residents.list.read',
  'residents.snapshot.read',
  'residents.live.read',
  'residents.write',
  'sleep.read',
  'mobility.read',
  'bathroom.read',
  'care.read',
  'incidents.read',
  'incidents.manage',
  'rounds.read',
  'rounds.manage',
  'alerts.read',
  'alerts.manage',
  'config.alarms.read',
  'config.alarms.manage',
  // Sin estas dos, Reportes y el registro de cambios responden 403 aunque el rol
  // las tenga concedidas: quedaban fuera del rollout por defecto.
  'analytics.read',
  'audit.read',
]

let hubIdentityDb
let hubIdentityDbWarningShown = false

function activeCapabilities() {
  const raw = process.env.API_ENABLED_CAPABILITIES
  if (!raw) return new Set(DEFAULT_ACTIVE_CAPABILITIES)
  return new Set(
    raw
      .split(',')
      .map((capability) => capability.trim())
      .filter(Boolean),
  )
}

function publicUser(user) {
  const features = roleFeatures[user.role] || []
  const active = activeCapabilities()
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    role: user.role,
    features,
    permissions: features,
    capabilities: (roleCapabilities[user.role] || []).filter((capability) => active.has(capability)),
  }
}

export function verifyPassword(password, stored) {
  const [, salt, expectedHex] = stored.split('$')
  if (!salt || !expectedHex) return false
  const actual = crypto.scryptSync(password, salt, 64)
  const expected = Buffer.from(expectedHex, 'hex')
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}

export function authenticate(req) {
  const header = req.headers.authorization || ''
  if (!header.startsWith('Bearer ')) return null
  const tokenHash = crypto.createHash('sha256').update(header.slice(7)).digest('hex')
  const user = db
    .prepare(
      `
    SELECT u.id, u.username, u.display_name, u.role
    FROM auth_sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1
  `,
    )
    .get(tokenHash, new Date().toISOString())
  if (user) return publicUser(user)

  /* Durante la migracion, identidad Rust crea la sesion en su propia SQLite
   * y las rutas que siguen en Node reciben el mismo bearer. La lectura
   * compartida es deliberadamente solo lectura: Node no es dueño de identidad
   * y Rust sigue siendo quien revoca la sesion. */
  const hubUser = authenticateFromHub(header.slice(7), new Date().toISOString())
  return hubUser ? publicUser(hubUser) : null
}

function authenticateFromHub(token, now) {
  const shared = hubIdentityDatabase()
  if (!shared) return null
  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest()
    return shared
      .prepare(
        `
        SELECT u.id, u.username, u.display_name, u.role
        FROM auth_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ? AND u.retired_at IS NULL
      `,
      )
      .get(tokenHash, now)
  } catch (cause) {
    if (!hubIdentityDbWarningShown) {
      hubIdentityDbWarningShown = true
      console.warn(`[virtual-rounds-api] no se pudo leer la identidad Rust: ${cause.message}`)
    }
    return null
  }
}

function hubIdentityDatabase() {
  const databasePath = process.env.MANA_HUB_DATABASE_URL
  if (!databasePath || databasePath === process.env.SQLITE_PATH) return null
  if (hubIdentityDb) return hubIdentityDb
  try {
    hubIdentityDb = new Database(databasePath, { readonly: true, fileMustExist: true })
    return hubIdentityDb
  } catch (cause) {
    if (!hubIdentityDbWarningShown) {
      hubIdentityDbWarningShown = true
      console.warn(`[virtual-rounds-api] no se pudo abrir la identidad Rust: ${cause.message}`)
    }
    return null
  }
}

export function login(username, password) {
  const user = db
    .prepare('SELECT id, username, display_name, role, password_hash FROM users WHERE username = ? AND active = 1')
    .get(username.trim().toLowerCase())
  if (!user || !verifyPassword(password, user.password_hash)) return null
  const token = crypto.randomBytes(32).toString('base64url')
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString()
  db.prepare('INSERT INTO auth_sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(
    tokenHash,
    user.id,
    expiresAt,
    new Date().toISOString(),
  )
  return { token, expires_at: expiresAt, user: publicUser(user) }
}

export function logout(req) {
  const header = req.headers.authorization || ''
  if (header.startsWith('Bearer ')) {
    const tokenHash = crypto.createHash('sha256').update(header.slice(7)).digest('hex')
    db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash)
  }
}

export function can(user, permission) {
  return user?.capabilities?.includes(permission)
}

/* Capacidades de plataforma: identidad, tiempo y auditoria. Son del
 * proceso, no de ningun dominio: cualquier modulo que las necesite las
 * importa desde aca. */

import crypto from 'node:crypto'
import Database from 'better-sqlite3'
import { db } from './db.js'

export const newId = (prefix) => `${prefix}-${crypto.randomUUID()}`
export const timestamp = () => new Date().toISOString()

let hubAuditDb
let hubAuditInsert
let hubAuditWarningShown = false

export const audit = (actorId, action, entityType, entityId, metadata = {}) => {
  const id = newId('audit')
  const metadataJson = JSON.stringify(metadata)
  const createdAt = timestamp()
  db.prepare(
    `INSERT INTO audit_log (id, actor_id, action, entity_type, entity_id, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, actorId || null, action, entityType, entityId, metadataJson, createdAt)
  mirrorAuditToHub({ id, actorId, action, entityType, entityId, metadataJson, createdAt })
}

/* Mientras queden mutaciones Node, el fallback conserva su bitacora local pero
 * replica la misma evidencia en el SoR Rust. Si el hub no esta activo o se
 * hace rollback al puerto Node, la API directa sigue funcionando con su DB. */
function mirrorAuditToHub({ id, actorId, action, entityType, entityId, metadataJson, createdAt }) {
  const databaseUrl = process.env.MANA_HUB_DATABASE_URL
  if (!databaseUrl || databaseUrl === ':memory:') return
  try {
    if (!hubAuditDb) {
      hubAuditDb = new Database(databaseUrl)
      hubAuditDb.pragma('busy_timeout = 5000')
      hubAuditDb.pragma('journal_mode = WAL')
    }
    const table = hubAuditDb
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'")
      .get()
    if (!table) return
    hubAuditInsert ||= hubAuditDb.prepare(
      `INSERT INTO audit_log (id, actor_id, action, entity_type, entity_id, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    hubAuditInsert.run(id, actorId || null, action, entityType, entityId, metadataJson, createdAt)
  } catch (error) {
    if (!hubAuditWarningShown) {
      hubAuditWarningShown = true
      console.warn(`[api] no se pudo replicar auditoria al hub: ${error.message}`)
    }
  }
}

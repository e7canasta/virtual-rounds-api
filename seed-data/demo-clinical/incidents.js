import { atDay } from './wellbeing.js'

export function generateIncident(profile, now) {
  if (!profile.incident) return null
  const incident = profile.incident
  const occurredAt = atDay(now, 2, 3, 20)
  return {
    id: `incident-demo-${profile.bedId}`,
    source_record_id: `incident-demo-${profile.bedId}`,
    resident_id: profile.residentId,
    bed_id: profile.bedId,
    kind: incident.kind,
    severity: incident.severity,
    status: incident.status,
    occurred_at: occurredAt,
    location: incident.location,
    activity: incident.activity,
    injury_status: incident.injury,
    self_recovery: incident.injury === 'none' ? 0 : 1,
    response_seconds: incident.severity === 'high' ? 42 : 28,
    narrative: incident.narrative,
    interventions: [incident.intervention],
    source: 'seed-demo',
    model_version: 'seed-v1',
    confidence: 1,
    /* Veredicto de deteccion. `undefined` deja el incidente pendiente de
     * revision, que es el estado con el que llega del detector. */
    detection_verdict: incident.verdict ?? null,
    verdict_by: incident.verdict ? 'user-gaston' : null,
    verdict_at: incident.verdict ? occurredAt : null,
    created_at: occurredAt,
    updated_at: occurredAt,
  }
}

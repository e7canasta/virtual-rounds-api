export function demoSensorEvents(now = new Date()) {
  const at = (minutesAgo) => new Date(now.valueOf() - minutesAgo * 60 * 1000).toISOString()
  return [
    {
      id: 'event-demo-118-settled',
      source_event_id: 'demo-118-settled',
      bed_id: '118-0',
      resident_id: 'resident-demo-118-0',
      monitor_key: 'mana-camera-118',
      kind: 'state_change',
      room_state: 'resident_in_bed',
      substate: 'settled',
      state: 'laying_in_bed',
      sleeping: true,
      alert_level: 'low',
      occurred_at: at(45),
    },
    {
      id: 'event-demo-118-edge',
      source_event_id: 'demo-118-edge',
      bed_id: '118-0',
      resident_id: 'resident-demo-118-0',
      monitor_key: 'mana-camera-118',
      kind: 'state_change',
      room_state: 'resident_in_bed',
      substate: 'limb_near_edge',
      state: 'sitting_in_bed',
      sleeping: false,
      alert_level: 'low',
      occurred_at: at(12),
    },
  ]
}

import { describe, expect, it } from 'vitest';
import { X_RECONNECT_EVENTS, offersXReconnect } from './notification-reconnect';

describe('offersXReconnect', () => {
  it('shows the connect box on an open x_revoked and an open x_forbidden notice', () => {
    expect(offersXReconnect({ event: 'x_revoked', state: 'active' })).toBe(true);
    expect(offersXReconnect({ event: 'x_forbidden', state: 'active' })).toBe(true);
    expect(X_RECONNECT_EVENTS).toEqual(['x_revoked', 'x_forbidden']);
  });

  it('offers nothing once the notice is resolved', () => {
    expect(offersXReconnect({ event: 'x_revoked', state: 'resolved' })).toBe(false);
    expect(offersXReconnect({ event: 'x_forbidden', state: 'resolved' })).toBe(false);
  });

  it('offers nothing on the other events, open or not', () => {
    for (const event of ['review_waiting', 'review_expiring', 'fuel_low', 'gas_out', 'agent_asleep', 'agent_stopped', 'key_rotation', 'model_changed', 'model_unavailable']) {
      expect(offersXReconnect({ event, state: 'active' })).toBe(false);
      expect(offersXReconnect({ event, state: 'resolved' })).toBe(false);
    }
  });
});

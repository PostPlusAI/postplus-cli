export type SubscriptionStatusState = 'invalid' | 'missing' | 'none' | 'string';

export type SubscriptionStatusPresentation = {
  label: string;
  state: SubscriptionStatusState;
  value?: string | null;
};

export function readSubscriptionStatusField(
  payload: Record<string, unknown>,
  fieldName = 'subscriptionStatus',
): SubscriptionStatusPresentation {
  if (!Object.prototype.hasOwnProperty.call(payload, fieldName)) {
    return {
      label: 'unknown',
      state: 'missing',
    };
  }

  const value = payload[fieldName];

  if (value === null) {
    return {
      label: 'none',
      state: 'none',
      value: null,
    };
  }

  if (typeof value === 'string') {
    return {
      label: value,
      state: 'string',
      value,
    };
  }

  return {
    label: 'invalid',
    state: 'invalid',
  };
}

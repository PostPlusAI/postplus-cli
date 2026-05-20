export type AccountBindingDisplayInput = {
  accountId: string | null;
  accountName: string | null;
  accountSlug?: string | null;
  accountType: 'personal' | 'team' | null;
};

export function formatAccountBindingLines(
  input: AccountBindingDisplayInput,
): string[] {
  if (input.accountType === 'team') {
    return [
      `Workspace: ${formatAccountBindingName(input)}`,
      ...(input.accountSlug ? [`Workspace slug: ${input.accountSlug}`] : []),
      `Account ID: ${input.accountId ?? 'not bound'}`,
    ];
  }

  return [
    `Account: ${input.accountName ?? 'not bound'}`,
    `Account ID: ${input.accountId ?? 'not bound'}`,
  ];
}

export function formatAccountBindingName(input: AccountBindingDisplayInput) {
  if (!input.accountName) {
    return input.accountId ? `Account ${input.accountId}` : 'not bound';
  }

  return input.accountType === 'team'
    ? `${input.accountName} (team)`
    : input.accountName;
}

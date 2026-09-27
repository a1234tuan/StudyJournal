type NavigationCheck = () => Promise<void> | undefined;

const checks = new Set<NavigationCheck>();

export const registerReviewNavigationCheck = (check: NavigationCheck) => {
  checks.add(check);
  return () => { checks.delete(check); };
};

export const pendingReviewNavigation = (): Promise<void> | undefined => {
  const pending = Array.from(checks, (check) => check()).filter((value): value is Promise<void> => Boolean(value));
  return pending.length ? Promise.all(pending).then(() => undefined) : undefined;
};

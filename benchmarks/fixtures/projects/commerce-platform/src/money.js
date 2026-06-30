export function percentageOfCents(cents, percent) {
  return Math.round((cents * percent) / 100);
}

export function formatCents(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

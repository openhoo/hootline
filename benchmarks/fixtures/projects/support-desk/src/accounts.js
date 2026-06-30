export const CUSTOMER_PLANS = Object.freeze({
  free: Object.freeze({ id: "free", responseHours: 48, prioritySupport: false }),
  startup: Object.freeze({ id: "startup", responseHours: 24, prioritySupport: false }),
  enterprise: Object.freeze({ id: "enterprise", responseHours: 4, prioritySupport: true }),
});

export function lookupCustomerPlan(customerPlanId) {
  const normalizedId = String(customerPlanId ?? "free").trim().toLowerCase();
  return CUSTOMER_PLANS[normalizedId] ?? CUSTOMER_PLANS.free;
}

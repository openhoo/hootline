import type { CustomerPlan } from "@support-desk/contracts";

export const CUSTOMER_PLANS: Record<string, CustomerPlan> = Object.freeze({
  free: Object.freeze({ id: "free", label: "Free", prioritySupport: false, responseHours: 48 }),
  growth: Object.freeze({ id: "growth", label: "Growth", prioritySupport: false, responseHours: 24 }),
  enterprise: Object.freeze({ id: "enterprise", label: "Enterprise", prioritySupport: true, responseHours: 4 }),
});

export function lookupCustomerPlan(planId: string | undefined): CustomerPlan {
  const normalizedId = String(planId ?? "free").trim().toLowerCase();
  return CUSTOMER_PLANS[normalizedId] ?? CUSTOMER_PLANS.free;
}

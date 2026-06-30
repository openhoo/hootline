export const MACROS = Object.freeze({
  requestDiagnostics: Object.freeze({
    status: "waiting_on_customer",
    tags: Object.freeze(["diagnostics-requested"]),
  }),
  closeDuplicate: Object.freeze({
    status: "resolved",
    tags: Object.freeze(["duplicate"]),
  }),
});

export function applyMacro(ticket, macroId) {
  const macro = MACROS[macroId];
  if (macro === undefined) return ticket;
  return {
    ...ticket,
    status: macro.status,
    tags: [...new Set([...ticket.tags, ...macro.tags])],
  };
}

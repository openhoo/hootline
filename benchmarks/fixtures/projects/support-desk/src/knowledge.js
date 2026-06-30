const ARTICLES = Object.freeze({
  billing: Object.freeze({ id: "kb-billing-001", title: "Update billing details" }),
  bug: Object.freeze({ id: "kb-bug-001", title: "Collect browser diagnostics" }),
  login: Object.freeze({ id: "kb-login-001", title: "Reset your password" }),
});

export function suggestKnowledgeArticle(ticket) {
  for (const tag of ticket.tags) {
    if (ARTICLES[tag] !== undefined) return ARTICLES[tag];
  }
  if (ticket.subject.toLowerCase().includes("login")) return ARTICLES.login;
  return null;
}

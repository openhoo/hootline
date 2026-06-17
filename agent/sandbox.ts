import { defineSandbox, defaultBackend } from "eve/sandbox";

export default defineSandbox({
  backend: defaultBackend({
    vercel: { networkPolicy: "deny-all" },
    docker: { networkPolicy: "deny-all" },
    microsandbox: { networkPolicy: "deny-all" },
  }),
});

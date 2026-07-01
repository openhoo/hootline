import { app } from "./app";

const port = Number(process.env.PORT ?? 4200);

app.listen(port, () => {
  console.log(`Support API listening on http://127.0.0.1:${port}`);
});

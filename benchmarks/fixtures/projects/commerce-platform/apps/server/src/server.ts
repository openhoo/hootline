import { app } from "./app";

const port = Number(process.env.PORT ?? 4100);

app.listen(port, () => {
  console.log(`Commerce API listening on http://127.0.0.1:${port}`);
});

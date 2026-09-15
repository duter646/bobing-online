import { createApplication } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
const app = createApplication(process.env.BOBING_DB_PATH ? { dbPath: process.env.BOBING_DB_PATH } : {});
const actualPort = await app.listen(port);
console.log(`Bo Bing server listening on http://127.0.0.1:${actualPort}`);

const shutdown = async () => { await app.close(); process.exit(0); };
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

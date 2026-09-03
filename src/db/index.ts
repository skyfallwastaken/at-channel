import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { env } from "../env";

export const db = drizzle({
  connection: {
    url: env.TURSO_CONNECTION_URL,
    authToken: env.TURSO_AUTH_TOKEN,
  },
});

await migrate(db, { migrationsFolder: "./migrations" });

export {
  adminsTable,
  pingsTable,
  pingPermsTable,
  userTokensTable,
} from "./schema";

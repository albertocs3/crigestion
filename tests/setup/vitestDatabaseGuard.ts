import { verifyVitestDatabaseEnvironment } from "@/tests/helpers/vitestDatabaseEnvironment";

export default async function setup(): Promise<void> {
  const identity = await verifyVitestDatabaseEnvironment();
  console.info(
    `Vitest database verified: ${identity.databaseName} (${identity.databaseUser}, ${identity.applicationName})`
  );
}

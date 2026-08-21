import { afterEach, beforeEach } from "vitest";

import { resetVitestCrossTestDependencies } from "@/tests/helpers/vitestDatabaseEnvironment";

beforeEach(async () => {
  await resetVitestCrossTestDependencies();
}, 30_000);

afterEach(async () => {
  await resetVitestCrossTestDependencies();
}, 30_000);

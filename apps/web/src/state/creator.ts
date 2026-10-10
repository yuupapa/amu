import { createCreatorEnvironmentAtoms } from "@t3tools/client-runtime/state/creator";

import { connectionAtomRuntime } from "../connection/runtime";

export const creatorEnvironment = createCreatorEnvironmentAtoms(connectionAtomRuntime);

import {
  collectEnvironmentSnapshot,
  EnvironmentSnapshot
} from "../environmentSnapshot.js";

export type EnvironmentSnapshotSurface =
  | {
      status: "available";
      snapshot: EnvironmentSnapshot;
    }
  | {
      status: "unavailable";
      error: string;
    };

export async function collectNonBlockingEnvironmentSnapshot(
  collector: () => Promise<EnvironmentSnapshot> = collectEnvironmentSnapshot
): Promise<EnvironmentSnapshotSurface> {
  try {
    return {
      status: "available",
      snapshot: await collector()
    };
  } catch (error) {
    return {
      status: "unavailable",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

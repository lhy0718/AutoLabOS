/**
 * The validation root is durable operator state, not a test scratch directory.
 * run-tests.mjs owns and removes its isolated .tmp/run-* directory.
 */
export function shouldPreserveValidationRootEntry(_entry: string): boolean {
  return true;
}

export function setup(): void {}

export function teardown(): void {}

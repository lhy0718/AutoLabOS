const POSIX_PRIVATE_ROOTS = [
  ["home"],
  ["Users"],
  ["mnt"],
  ["tmp"],
  ["var", "folders"]
].map((segments) => `/${segments.join("/")}/`);

const WINDOWS_USER_ROOT = `[A-Za-z]:\\\\${["Users"].join("")}\\\\`;

export const PRIVATE_MACHINE_PATH_PATTERN_SOURCE =
  `(?:${[...POSIX_PRIVATE_ROOTS, WINDOWS_USER_ROOT].join("|")})`;

export function createPrivateMachinePathPattern(flags = "u"): RegExp {
  return new RegExp(PRIVATE_MACHINE_PATH_PATTERN_SOURCE, flags);
}

export function createPrivateMachinePathValuePattern(flags = "gu"): RegExp {
  return new RegExp(
    `${PRIVATE_MACHINE_PATH_PATTERN_SOURCE}[^\\s\"'<>\\]}),;]*`,
    flags
  );
}

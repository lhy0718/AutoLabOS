const PRIVATE_PATH_PATTERN = new RegExp(
  `(?:^|[\\s\"'=:])(?:${[
    String.fromCharCode(47, 104, 111, 109, 101, 47),
    String.fromCharCode(47, 85, 115, 101, 114, 115, 47),
    String.fromCharCode(47, 109, 110, 116, 47),
    String.fromCharCode(47, 116, 109, 112, 47),
    "[A-Za-z]:\\\\"
  ].join("|")})`,
  "u"
);

const SENSITIVE_TEXT_PATTERN =
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|private[_-]?key|credential|secret)\s*[=:]/iu;

export function containsNonPortableResearchText(text: string): boolean {
  return PRIVATE_PATH_PATTERN.test(text) || SENSITIVE_TEXT_PATTERN.test(text);
}

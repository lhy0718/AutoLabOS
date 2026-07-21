import { createPrivateMachinePathPattern } from "./privateMachinePath.js";

const PRIVATE_PATH_PATTERN = createPrivateMachinePathPattern();

const SENSITIVE_TEXT_PATTERN =
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|private[_-]?key|credential|secret)\s*[=:]/iu;

export function containsNonPortableResearchText(text: string): boolean {
  return PRIVATE_PATH_PATTERN.test(text) || SENSITIVE_TEXT_PATTERN.test(text);
}

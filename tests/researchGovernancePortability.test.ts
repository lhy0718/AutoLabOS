import { describe, expect, it } from "vitest";
import path from "node:path";

import {
  assertPromotionArtifactPrivacySafe,
  projectPromotionReviewerArtifact
} from "../src/core/benchmark/promotionArtifactPrivacy.js";
import { containsNonPortableResearchText } from "../src/core/researchGovernancePortability.js";

describe("research governance portability", () => {
  const posixPath = (root: string, ...segments: string[]) =>
    path.posix.join(path.posix.sep, root, ...segments);

  it.each([
    `](${posixPath("home", "example", "workspace", "result.json")})`,
    `\\url{${posixPath("Users", "example", "workspace", "result.json")}}`,
    `](${posixPath("mnt", "data", "workspace", "result.json")})`,
    `\\url{${posixPath("tmp", "workspace", "result.json")}}`,
    `](${posixPath("private", "var", "folders", "ab", "session", "result.json")})`,
    ["C:", "Users", "example", "workspace", "result.json"].join("\\")
  ])("detects private machine paths in punctuation and document markup: %s", (text) => {
    expect(containsNonPortableResearchText(text)).toBe(true);
    expect(() => assertPromotionArtifactPrivacySafe("artifact.md", Buffer.from(text))).toThrow(
      "private machine path"
    );
  });

  it("redacts markup-contained private paths without consuming surrounding punctuation", () => {
    const projected = projectPromotionReviewerArtifact(
      "artifact.json",
      Buffer.from(JSON.stringify({
        markdown: `](${posixPath("home", "example", "result.json")})`,
        tex: `\\url{${posixPath("var", "folders", "ab", "result.json")}}`
      })),
      { redactCredentialLikeValues: true }
    );
    const parsed = JSON.parse(Buffer.from(projected.bytes).toString("utf8")) as {
      markdown: string;
      tex: string;
    };

    expect(projected.privacy_redaction_count).toBe(2);
    expect(parsed.markdown).toBe("](<private-path>)");
    expect(parsed.tex).toBe("\\url{<private-path>}");
  });
});

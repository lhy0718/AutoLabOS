import { describe, expect, it } from "vitest";

import {
  detectAclTemplatePackage,
  inspectAclTemplateSurface
} from "../src/core/latex/aclTemplate.js";

describe("ACL template detection", () => {
  it.each([
    {
      label: "the current lowercase package",
      packageLine: "\\usepackage[review]{acl}",
      generation: "current",
      bibliographyStyleOwner: "package"
    },
    {
      label: "a year-specific package",
      packageLine: "\\usepackage[review]{ACL2023}",
      generation: "year_specific",
      bibliographyStyleOwner: "document"
    }
  ] as const)("recognizes $label", ({ packageLine, generation, bibliographyStyleOwner }) => {
    const detected = detectAclTemplatePackage(packageLine);

    expect(detected).toMatchObject({
      packageCommand: packageLine,
      generation,
      bibliographyStyleOwner
    });
  });

  it("recognizes ACL inside a comma-separated package list", () => {
    expect(detectAclTemplatePackage("\\usepackage[review]{xcolor, acl, booktabs}"))
      .toMatchObject({ generation: "current", packageName: "acl", bibliographyStyleOwner: "package" });
  });

  it("allows acl.sty to own the bibliography style while year-specific templates require acl_natbib", () => {
    const current = inspectAclTemplateSurface("\\usepackage[review]{acl}");
    const yearSpecificMissing = inspectAclTemplateSurface("\\usepackage[review]{ACL2023}");
    const yearSpecificCompatible = inspectAclTemplateSurface(
      "\\usepackage[review]{ACL2023}\n\\bibliographystyle{acl_natbib}"
    );

    expect(current.hasBibliographyStyleMismatch).toBe(false);
    expect(yearSpecificMissing.hasBibliographyStyleMismatch).toBe(true);
    expect(yearSpecificCompatible.hasBibliographyStyleMismatch).toBe(false);
  });

  it.each([
    "\\usepackage[review]{acl}\n\\keywords{evaluation, reproducibility}",
    "\\usepackage[review]{ACL2023}\n\\noindent\\textbf{Keywords:} evaluation, reproducibility"
  ])("rejects keywords on every supported ACL template surface", (source) => {
    expect(inspectAclTemplateSurface(source).hasExcludedKeywords).toBe(true);
  });

  it("ignores package, bibliography, and keyword commands inside TeX comments", () => {
    const source = [
      "% \\usepackage[review]{ACL2023}",
      "\\usepackage[review]{acl}",
      "% \\bibliographystyle{plain}",
      "\\bibliographystyle{acl_natbib}",
      "% \\keywords{evaluation, reproducibility}",
      "Escaped percent remains text: \\%."
    ].join("\n");

    expect(detectAclTemplatePackage(source)).toMatchObject({
      packageName: "acl",
      generation: "current"
    });
    expect(inspectAclTemplateSurface(source)).toMatchObject({
      explicitBibliographyStyle: "acl_natbib",
      hasBibliographyStyleMismatch: false,
      hasExcludedKeywords: false
    });
  });
});

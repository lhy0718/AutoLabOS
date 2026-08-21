import { describe, expect, it } from "vitest";

import {
  detectAclTemplatePackage,
  inspectAclTemplateSurface
} from "../src/core/latex/aclTemplate.js";

describe("ACL template detection", () => {
  it("recognizes the official lowercase package", () => {
    const packageLine = "\\usepackage[review]{acl}";
    const detected = detectAclTemplatePackage(packageLine);

    expect(detected).toMatchObject({
      packageCommand: packageLine,
      packageName: "acl"
    });
  });

  it("does not treat unrelated packages as ACL templates", () => {
    expect(detectAclTemplatePackage("\\usepackage[review]{conference_style}"))
      .toBeNull();
  });

  it("recognizes ACL inside a comma-separated package list", () => {
    expect(detectAclTemplatePackage("\\usepackage[review]{xcolor, acl, booktabs}"))
      .toMatchObject({ packageName: "acl" });
  });

  it("allows acl.sty to own the bibliography style", () => {
    expect(inspectAclTemplateSurface("\\usepackage[review]{acl}").hasBibliographyStyleMismatch)
      .toBe(false);
    expect(inspectAclTemplateSurface(
      "\\usepackage[review]{acl}\n\\bibliographystyle{plain}"
    ).hasBibliographyStyleMismatch).toBe(true);
  });

  it("rejects keywords on the supported ACL template surface", () => {
    const source = "\\usepackage[review]{acl}\n\\keywords{evaluation, reproducibility}";
    expect(inspectAclTemplateSurface(source).hasExcludedKeywords).toBe(true);
  });

  it("ignores package, bibliography, and keyword commands inside TeX comments", () => {
    const source = [
      "% \\usepackage[review]{conference_style}",
      "\\usepackage[review]{acl}",
      "% \\bibliographystyle{plain}",
      "\\bibliographystyle{acl_natbib}",
      "% \\keywords{evaluation, reproducibility}",
      "Escaped percent remains text: \\%."
    ].join("\n");

    expect(detectAclTemplatePackage(source)).toMatchObject({
      packageName: "acl"
    });
    expect(inspectAclTemplateSurface(source)).toMatchObject({
      explicitBibliographyStyle: "acl_natbib",
      hasBibliographyStyleMismatch: true,
      hasExcludedKeywords: false
    });
  });
});

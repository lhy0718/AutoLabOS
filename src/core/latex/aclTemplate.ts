export const ACL_BIBLIOGRAPHY_STYLE = "acl_natbib";

export type AclTemplatePackage = {
  packageName: string;
  packageCommand: string;
};

export type AclTemplateSurface = {
  template: AclTemplatePackage | null;
  explicitBibliographyStyle: string | null;
  hasBibliographyStyleMismatch: boolean;
  hasExcludedKeywords: boolean;
};

const USE_PACKAGE_PATTERN = /^[ \t]*(\\usepackage\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\})/gmu;
const BIBLIOGRAPHY_STYLE_PATTERN = /\\bibliographystyle\s*\{([^}]+)\}/u;
const KEYWORDS_FIELD_PATTERN = /\\textbf\s*\{\s*Keywords\s*:\s*\}|\\keywords\s*\{/iu;

export function detectAclTemplatePackage(source: string): AclTemplatePackage | null {
  for (const match of stripLatexComments(source).matchAll(USE_PACKAGE_PATTERN)) {
    const packageCommand = match[1].trim();
    const packageNames = match[2].split(",").map((packageName) => packageName.trim());

    for (const packageName of packageNames) {
      if (packageName === "acl") {
        return {
          packageName,
          packageCommand
        };
      }
    }
  }

  return null;
}

export function extractLatexBibliographyStyle(source: string): string | null {
  return stripLatexComments(source).match(BIBLIOGRAPHY_STYLE_PATTERN)?.[1]?.trim() ?? null;
}

export function hasLatexKeywordsField(source: string): boolean {
  return KEYWORDS_FIELD_PATTERN.test(stripLatexComments(source));
}

export function inspectAclTemplateSurface(source: string): AclTemplateSurface {
  const template = detectAclTemplatePackage(source);
  const explicitBibliographyStyle = extractLatexBibliographyStyle(source);

  return {
    template,
    explicitBibliographyStyle,
    hasBibliographyStyleMismatch: template !== null && explicitBibliographyStyle !== null,
    hasExcludedKeywords: template !== null && hasLatexKeywordsField(source)
  };
}

function stripLatexComments(source: string): string {
  return source.split(/\r?\n/gu).map((line) => {
    for (let index = 0; index < line.length; index += 1) {
      if (line[index] !== "%") continue;
      let precedingBackslashes = 0;
      for (let cursor = index - 1; cursor >= 0 && line[cursor] === "\\"; cursor -= 1) {
        precedingBackslashes += 1;
      }
      if (precedingBackslashes % 2 === 0) return line.slice(0, index);
    }
    return line;
  }).join("\n");
}

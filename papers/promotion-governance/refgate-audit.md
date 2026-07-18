# Refgate Audit

## Summary

- Entries: 10
- Blocking issues: 14
- Warnings: 10

## Blocking Issues

- `CLAIM_NOT_CHECKED` `schmidgall-etal-2025-agent`: Claim claim-0001 is marked needs_review.
- `CLAIM_NOT_CHECKED` `starace2025paperbench`: Claim claim-0002 is marked needs_review.
- `CLAIM_NOT_CHECKED` `jiang-etal-2026-badscientist`: Claim claim-0003 is marked needs_review.
- `CLAIM_NOT_CHECKED` `dycke-gurevych-2026-automatic`: Claim claim-0004 is marked needs_review.
- `CLAIM_NOT_CHECKED` `schmidgall-etal-2025-agent`: Claim claim-0005 is marked needs_review.
- `CLAIM_NOT_CHECKED` `starace2025paperbench`: Claim claim-0006 is marked needs_review.
- `CLAIM_NOT_CHECKED` `jiang-etal-2026-badscientist`: Claim claim-0007 is marked needs_review.
- `CLAIM_NOT_CHECKED` `dycke-gurevych-2026-automatic`: Claim claim-0008 is marked needs_review.
- `CLAIM_NOT_CHECKED` `javaji-etal-2025-ai`: Claim claim-0009 is marked needs_review.
- `CLAIM_NOT_CHECKED` `riehl2026ara`: Claim claim-0010 is marked needs_review.
- `CLAIM_NOT_CHECKED` `hu2025reprobench`: Claim claim-0011 is marked needs_review.
- `CLAIM_NOT_CHECKED` `petel2026madscps`: Claim claim-0012 is marked claim_unchecked.
- `CLAIM_NOT_CHECKED` `ma2026reflection`: Claim claim-0013 is marked needs_review.
- `CLAIM_NOT_CHECKED` `nishi2026claimgarden`: Claim claim-0014 is marked claim_unchecked.

## Warnings

- `ARXIV_FALLBACK` `starace2025paperbench`: Entry uses arXiv fallback rather than final publication BibTeX.
- `DOI_MISSING` `starace2025paperbench`: Lockfile record has no DOI.
- `ARXIV_FALLBACK` `riehl2026ara`: Entry uses arXiv fallback rather than final publication BibTeX.
- `DOI_MISSING` `riehl2026ara`: Lockfile record has no DOI.
- `ARXIV_FALLBACK` `hu2025reprobench`: Entry uses arXiv fallback rather than final publication BibTeX.
- `DOI_MISSING` `hu2025reprobench`: Lockfile record has no DOI.
- `DOI_MISSING` `petel2026madscps`: Lockfile record has no DOI.
- `ARXIV_FALLBACK` `ma2026reflection`: Entry uses arXiv fallback rather than final publication BibTeX.
- `DOI_MISSING` `ma2026reflection`: Lockfile record has no DOI.
- `DOI_MISSING` `nishi2026claimgarden`: Lockfile record has no DOI.

## Verified Official BibTeX

- `dycke-gurevych-2026-automatic` — acl: https://aclanthology.org/2026.tacl-1.22.bib
- `javaji-etal-2025-ai` — acl: https://aclanthology.org/2025.ijcnlp-long.127.bib
- `jiang-etal-2026-badscientist` — acl: https://aclanthology.org/2026.acl-long.1134.bib
- `schmidgall-etal-2025-agent` — acl: https://aclanthology.org/2025.findings-emnlp.320.bib

## Manual Fallbacks

- `nishi2026claimgarden` — Official arXiv records have no BibTeX export; OpenReview entries are normalized from the official record pages.
- `petel2026madscps` — Official arXiv records have no BibTeX export; OpenReview entries are normalized from the official record pages.

## arXiv Fallbacks

- `hu2025reprobench` — 2507.18901 (2026-07-16)
- `ma2026reflection` — 2606.31478 (2026-07-16)
- `riehl2026ara` — 2605.02651 (2026-07-16)
- `starace2025paperbench` — 2504.01848 (2026-07-16)

## Claim-to-Source Status

- `CLAIM_NOT_CHECKED` `schmidgall-etal-2025-agent`: Claim claim-0001 is marked needs_review.
- `CLAIM_NOT_CHECKED` `starace2025paperbench`: Claim claim-0002 is marked needs_review.
- `CLAIM_NOT_CHECKED` `jiang-etal-2026-badscientist`: Claim claim-0003 is marked needs_review.
- `CLAIM_NOT_CHECKED` `dycke-gurevych-2026-automatic`: Claim claim-0004 is marked needs_review.
- `CLAIM_NOT_CHECKED` `schmidgall-etal-2025-agent`: Claim claim-0005 is marked needs_review.
- `CLAIM_NOT_CHECKED` `starace2025paperbench`: Claim claim-0006 is marked needs_review.
- `CLAIM_NOT_CHECKED` `jiang-etal-2026-badscientist`: Claim claim-0007 is marked needs_review.
- `CLAIM_NOT_CHECKED` `dycke-gurevych-2026-automatic`: Claim claim-0008 is marked needs_review.
- `CLAIM_NOT_CHECKED` `javaji-etal-2025-ai`: Claim claim-0009 is marked needs_review.
- `CLAIM_NOT_CHECKED` `riehl2026ara`: Claim claim-0010 is marked needs_review.
- `CLAIM_NOT_CHECKED` `hu2025reprobench`: Claim claim-0011 is marked needs_review.
- `CLAIM_NOT_CHECKED` `petel2026madscps`: Claim claim-0012 is marked claim_unchecked.
- `CLAIM_NOT_CHECKED` `ma2026reflection`: Claim claim-0013 is marked needs_review.
- `CLAIM_NOT_CHECKED` `nishi2026claimgarden`: Claim claim-0014 is marked claim_unchecked.

## Submission Checklist

- [ ] Blocking issue count is zero.
- [ ] Every citation key has a lockfile entry.
- [ ] Official BibTeX export entries use `official_export`.
- [ ] Manual fallback entries include fallback reason and field checks.
- [ ] arXiv fallback entries include version and accessed date.
- [ ] Important claims have source locations and evidence spans.

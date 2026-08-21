# Public Source Release

AutoLabOS separates a public source snapshot from the history of a public Git
remote. A clean current tree does not remove private paths or experiment-specific
material that may remain in older commits.

## History-Free Snapshot

Create a snapshot only from a clean, reviewed commit:

```bash
npm run public:snapshot -- --out-dir <new-directory-outside-checkout>
```

The command runs the public-code sanitization test first, then:

- resolves the requested revision to an immutable commit;
- refuses a dirty working tree or an existing output directory;
- requires the output directory to be outside the checkout;
- exports tracked files with `git archive`, without `.git` or commit history;
- rejects personal home paths, credential-like material, and unsafe symlinks;
- writes `public-source-snapshot.json` with the source revision, per-file hashes,
  a deterministic tree hash, and the portability result.

Use `--ref <git-ref>` only when the named revision has already passed the same
review and validation gates. The manifest records both the requested ref and the
resolved commit.

## Git Remote History

The snapshot does not sanitize an existing Git remote. If a public remote already
contains unsuitable historical commits, replacing that history is a separate,
owner-approved migration. Coordinate branch protection, forks, open pull
requests, tags, releases, and collaborator clones before changing the remote.
Until that migration is approved and verified, distribute the history-free
snapshot as the clean source artifact and describe the remote-history limitation
explicitly.

## Release Gate

Before distributing a snapshot, run the repository's required build, test,
harness, plugin release, and portability checks. CI also creates a fresh snapshot
after the full test suite so archive extraction and snapshot scanning cannot
silently regress.

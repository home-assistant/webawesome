---
description: Merge new upstream Web Awesome releases into next and report pain points
intent: Open one reviewable PR per upstream release that keeps HA customizations and builds
on:
  schedule: weekly
  workflow_dispatch:
    inputs:
      tag:
        description: Upstream tag to merge (e.g. v3.15.0). Skips the 3-day age check.
        required: false
  skip-if-match: "is:pr is:open label:upstream-sync"
permissions:
  contents: read
  pull-requests: read
  copilot-requests: write
checkout:
  fetch-depth: 0
network:
  allowed:
    - defaults
    - github
    - node
    - playwright
timeout-minutes: 60
runtimes:
  node:
    version: "24"
concurrency:
  job-discriminator: ${{ github.run_id }}

jobs:
  check_upstream:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    outputs:
      current: ${{ steps.pick.outputs.current }}
      target: ${{ steps.pick.outputs.target }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - name: Pick upstream release
        id: pick
        env:
          GH_TOKEN: ${{ github.token }}
          INPUT_TAG: ${{ inputs.tag }}
        run: |
          current="v$(jq -r .version packages/webawesome/package.json | sed 's/-ha\..*//')"
          if [ -n "$INPUT_TAG" ]; then
            target="$INPUT_TAG"
          else
            # Releases must be at least 3 days old, matching HA frontend's minimumReleaseAge
            target=$(gh api repos/shoelace-style/webawesome/releases --paginate --jq '
              .[] | select(.draft | not) | select(.prerelease | not)
                  | select((.published_at | fromdateiso8601) <= (now - 259200)) | .tag_name' \
              | sort -V | tail -1)
          fi
          newest=$(printf '%s\n' "$current" "$target" | sort -V | tail -1)
          if [ -z "$target" ] || [ "$newest" = "$current" ]; then
            target=""
          fi
          echo "current=$current" >> "$GITHUB_OUTPUT"
          echo "target=$target" >> "$GITHUB_OUTPUT"
          echo "Current: $current, target: ${target:-none}" >> "$GITHUB_STEP_SUMMARY"
  upgrade_gh_aw:
    runs-on: ubuntu-latest
    # Don't hold up the upstream sync if the upgrade fails
    continue-on-error: true
    permissions:
      contents: read
    steps:
      - uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0
        id: app-token
        with:
          client-id: ${{ vars.UPSTREAM_SYNC_APP_ID }}
          private-key: ${{ secrets.UPSTREAM_SYNC_APP_PRIVATE_KEY }}
          permission-contents: write
          permission-pull-requests: write
          permission-workflows: write
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: next
          persist-credentials: false
      - name: Upgrade gh-aw and open a pull request
        env:
          GH_TOKEN: ${{ steps.app-token.outputs.token }}
        run: |
          gh extension install github/gh-aw
          gh aw upgrade
          # upgrade also adds Copilot agent, skill and setup files we don't use
          git clean -fd -- .github/agents .github/skills .github/workflows/copilot-setup-steps.yml
          if [ -z "$(git status --porcelain)" ]; then
            echo "gh-aw is up to date" >> "$GITHUB_STEP_SUMMARY"
            exit 0
          fi
          version=$(gh aw version | awk '{print $NF}')
          branch=gh-aw-upgrade
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git switch -C "$branch"
          git add .github
          git commit -m "Upgrade gh-aw to $version"
          git push --force "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" "$branch"
          if [ -z "$(gh pr list --head "$branch" --state open --json number --jq '.[].number')" ]; then
            gh pr create --base next --head "$branch" --draft \
              --title "Upgrade gh-aw to $version" \
              --body "Runs \`gh aw upgrade\` to refresh the action pins and recompile the agentic workflows." \
              --reviewer home-assistant/ohf-frontend
          fi
  agent:
    needs: [check_upstream]
    if: needs.check_upstream.outputs.target != ''

steps:
  - name: Gather upstream and HA changes
    env:
      CURRENT: ${{ needs.check_upstream.outputs.current }}
      TARGET: ${{ needs.check_upstream.outputs.target }}
    run: |
      git remote add upstream https://github.com/shoelace-style/webawesome.git
      # Fetch into refs/tags/upstream/* because upstream tags clash with ours
      git fetch --no-tags upstream \
        "+refs/tags/$CURRENT:refs/tags/upstream/$CURRENT" \
        "+refs/tags/$TARGET:refs/tags/upstream/$TARGET"
      d=/tmp/gh-aw/upstream-sync
      mkdir -p "$d"
      base="refs/tags/upstream/$CURRENT"
      head="refs/tags/upstream/$TARGET"
      git diff --name-only "$base" HEAD -- packages/webawesome/src > "$d/ha-files.txt"
      git diff "$base" HEAD -- packages/webawesome/src > "$d/ha.diff"
      git diff --name-only "$base" "$head" > "$d/upstream-files.txt"
      comm -12 <(sort "$d/ha-files.txt") <(sort "$d/upstream-files.txt") > "$d/overlap.txt"
      git log --oneline "$base..$head" -- packages/webawesome/src > "$d/upstream-log.txt"

pre-agent-steps:
  - name: Start the upstream merge
    env:
      TARGET: ${{ needs.check_upstream.outputs.target }}
    run: |
      git config user.name "github-actions[bot]"
      git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
      git switch -c "upgrade-${TARGET#v}"
      git merge --no-ff --no-commit "refs/tags/upstream/$TARGET" || true
      git diff --name-only --diff-filter=U > /tmp/gh-aw/upstream-sync/conflicts.txt

safe-outputs:
  github-app:
    client-id: ${{ vars.UPSTREAM_SYNC_APP_ID }}
    private-key: ${{ secrets.UPSTREAM_SYNC_APP_PRIVATE_KEY }}
  create-pull-request:
    base-branch: next
    labels:
      - upstream-sync
    team-reviewers:
      - ohf-frontend
    draft: true
    preserve-branch-name: true
    allowed-branches:
      - upgrade-*
    allow-workflows: true
    signed-commits: false
    protected-files: allowed
    max-patch-files: 2000
    max-patch-size: 10240
  noop:
---

# Upstream Web Awesome sync

This repository is Home Assistant's fork of Web Awesome. Our `next` branch is based on upstream `${{ needs.check_upstream.outputs.current }}`. Merge upstream `${{ needs.check_upstream.outputs.target }}` into it, keep our customizations, and open a draft pull request that tells the frontend team where problems could show up when they test it.

## Context

The merge is already in progress on a branch named `upgrade-<version>`, where `<version>` is the target tag without the leading `v`. Upstream tags are available as `refs/tags/upstream/<tag>`.

Files in `/tmp/gh-aw/upstream-sync/`:

- `conflicts.txt`: files with merge conflicts.
- `overlap.txt`: source files that both we and upstream changed. Check these even when they merged cleanly.
- `ha.diff` and `ha-files.txt`: our customizations, as a diff from the upstream release we are currently based on.
- `upstream-files.txt` and `upstream-log.txt`: what upstream changed between the two releases.

## Task

1. Read the context files.
2. Resolve every conflict, and review every file in `overlap.txt`:
   - Keep our customizations from `ha.diff`.
   - Take upstream's changes wherever they don't conflict with ours.
   - If upstream now does what one of our customizations did, drop ours and note it in the pull request.
   - Look for duplicated output from clean merges, such as an attribute rendered twice.
3. Commit the merge with the message `Merge tag '<target tag>' into upgrade-<version>`.
4. Bump the version in a separate commit:
   - In `packages/webawesome`, run `npm pkg set version=<version>-ha.0`.
   - At the repository root, run `npm install --package-lock-only --ignore-scripts`.
   - Do not use `npm version`. Its `postversion` script rewrites the root `package.json` and `VERSIONS.txt`, which come from upstream.
5. At the root, run `npm ci`. Then in `packages/webawesome` run `npm run prettier` and `npm run build`.
6. In `packages/webawesome`, run `npx playwright install chromium`. Then for each component in `overlap.txt` that has a `<name>.test.ts` file, run `CSR_ONLY=true npm run test:component -- <name>`.
7. Fix failures caused by the merge and commit the fixes. Don't change unrelated code.
8. Call `create_pull_request` with branch `upgrade-<version>` and title `Upgrade WA to <version>`. Write the body with these sections, leaving out any that would be empty:
   - `## Upgrade to Web Awesome <version>`: one line saying which release was merged and from which version, and the new package version. Link the upstream release (`https://github.com/shoelace-style/webawesome/releases/tag/<target tag>`) and changelog (https://webawesome.com/docs/resources/changelog).
   - `### Conflict resolution`: one bullet per component, saying what we kept and what we took from upstream.
   - `### Dropped (now in upstream)`: customizations removed because upstream covers them.
   - `### Additional fixes`: anything you changed beyond resolving the merge.
   - `### Notes for the HA frontend`: changed defaults, deprecated parts or attributes, and behavior changes in components we customize or that Home Assistant is likely to use. These are the pain points to test.
   - `### Testing`: what ran and passed, and what didn't run.
9. If the build or tests still fail after a reasonable attempt, still open the pull request. List the failures at the top of the body under `### Needs attention`.
10. If the merge brings in no changes, call `noop` with a short reason instead of opening a pull request.

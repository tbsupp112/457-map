# Publishing, Rollback, and Backup Workflow

This project intentionally uses a user-controlled publishing process. Codex edits and tests the local working copy; the owner reviews and publishes changes through GitHub Desktop or, when necessary, GitHub's website. The work ChatGPT account does not receive GitHub credentials or connector access.

## Routine update

1. Codex changes and tests the local files, then lists every file that changed.
2. Review the changes in GitHub Desktop.
3. Create a short-lived branch named `update/YYYY-MM-DD-description`.
4. Commit the reviewed files to that branch and push it to GitHub.
5. Open a pull request into `main` and review the **Files changed** tab.
6. Merge the pull request. GitHub Pages publishes from `main`.
7. Confirm the change on both phone and desktop before marking it completed in `BACKLOG.md`.

In GitHub's file-delete view, seeing `This file was deleted` is only the proposed diff. Select **Commit changes** (or **Propose changes**), save it to the current update branch, and merge that branch's pull request before expecting the deletion to appear on `main`. Always check the branch selector when verifying whether a file still exists.

Do not upload directly to `main` for normal changes. Keep one logical change set per pull request so a problem can be reversed cleanly.

## Codex update handoff format

For each testable update, Codex should end its response with the same publishing package:

- A suggested `update/YYYY-MM-DD-description` branch name.
- A short description suitable for the commit or pull-request description.
- A bulleted list of every file to add or replace.
- A bulleted list of every file to remove, or an explicit `None`.

If a local change is not worth publishing for live testing, Codex should say so instead of presenting an upload package.

## Roll back a problem

If a newly merged change causes an error:

1. Open the merged pull request on GitHub.
2. Select **Revert** to create a pull request that undoes that change.
3. Review and merge the revert pull request.
4. Confirm that GitHub Pages has returned to the prior behavior.

Avoid deleting files manually or rewriting Git history during a rollback. If GitHub cannot create the revert automatically, stop and inspect the conflicting changes before proceeding.

## Stable milestone

Create a stable release only after a version has been confirmed on the published site.

1. In `457-map`, open **Releases** and draft a new release.
2. Create a tag named `stable-YYYY-MM-DD-vN`, targeting the confirmed commit on `main`.
3. Briefly describe what was confirmed and publish the release.
4. Download the release's source ZIP.

Small interim updates remain recoverable through pull requests and commits; they do not each need a release.

## Isolated backup repository

Keep `457-map-backup` private and do not grant Codex or another automation access to it.

After each stable milestone:

1. Download the source ZIP from the new stable release in `457-map`.
2. In `457-map-backup`, create a release tagged `backup-YYYY-MM-DD-vN`.
3. Attach the stable source ZIP and note the matching live release/tag.
4. Publish the backup release and keep a second copy of the ZIP outside the project folder.

This is intentionally manual. It keeps the restore copy independent from both the working folder and any automation attached to the live repository.

## Restore sources

Use them in this order:

1. Revert the most recent pull request when one known change caused the problem.
2. Use a stable tag/release in `457-map` when several changes need to be rolled back together.
3. Use the ZIP stored in `457-map-backup` if the live repository or its history is unavailable.

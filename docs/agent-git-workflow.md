# Agent Git Workflow

This document is mandatory for every future agent working on this project.

## Remote

Use GitHub as the project remote:

```bash
git remote add github https://github.com/319reinforce/proboost-creator-crm
```

If a remote already exists, verify that `github` points to the URL above:

```bash
git remote -v
```

Prefer the remote name `github` for all fetch, pull, and push operations in this repository.

## Branch Rule

Before changing code, always create a new working branch.

Do not make code changes directly on `main`, `master`, or another shared integration branch. Do not continue coding on a previous agent's work branch unless the user explicitly asks you to do so.

Recommended branch format:

```bash
git fetch github
git switch -c codex/<short-task-name> github/main
```

If the active base branch is not `main`, branch from the user-specified base instead:

```bash
git fetch github
git switch -c codex/<short-task-name> github/<base-branch>
```

## Before Editing

Every agent must run:

```bash
git status --short --branch
git remote -v
git branch --show-current
```

If there are uncommitted changes, treat them as user or previous-agent work. Do not overwrite or revert them without explicit user approval.

## Publishing Work

Push work branches to GitHub:

```bash
git push github <branch-name>:<branch-name>
```

Use force push only when the user explicitly authorizes it. Prefer:

```bash
git push --force-with-lease github <branch-name>:<branch-name>
```

Never use a bare `git push --force` unless the user has explicitly accepted that it may overwrite remote work.


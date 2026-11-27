/**
 * The `git` shim for code sessions (docs/design/code-sessions.md §3.3): a POSIX sh script installed
 * as `<cache>/bin/git`, first on the engine's PATH (`workspaceEnv`, code/sandbox.ts).
 *
 * It refuses the git operations the policy always denies (push, remote add/set-url, config keys
 * that run commands, filter-branch, gc --prune, reflog expire, refs/rye/*, clone, credentials, …)
 * with a clear message, and otherwise execs the real git, found by skipping its own directory on
 * PATH. It is there for the messages only, NOT as a security boundary: `/usr/bin/git` bypasses it,
 * a script can edit PATH, and the agent could overwrite it. The `PreToolUse` hook (`commandVerdict`,
 * code/policy.ts) catches absolute paths and obfuscations, and the OS sandbox makes the result
 * harmless anyway (no remote, no credentials, no network, writes confined to the workspace).
 *
 * Keep its rules a subset of the policy's denials (tests/code-sandbox.test.ts checks the two agree).
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Written with String.raw so backslashes reach sh unchanged; "@{" stands for sh's "${", which a
// template literal would otherwise interpolate.
export const GIT_SHIM_SCRIPT = String.raw`#!/bin/sh
# Rye code session: git shim (packages/agent-core/src/code/shim/git.ts).
#
# This refuses the git operations a code session never does, with a message saying why, and
# otherwise runs the real git. It is a clarity layer, NOT a security boundary: /usr/bin/git
# bypasses it. Rye's policy check and the OS sandbox are what enforce these rules.

rye_refuse() {
  printf 'rye: %s\n' "$1" >&2
  printf 'rye: (this is the code session'"'"'s git shim; Rye'"'"'s policy refuses the same command)\n' >&2
  exit 1
}

rye_lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

rye_dangerous_key() {
  case $(rye_lower "$1") in
    alias.*|credential.*|filter.*|include.*|includeif.*|url.*|protocol.*|pager.*|*.pager) return 0 ;;
    remote.*.url|remote.*.pushurl|remote.*.proxy|remote.*.receivepack|remote.*.uploadpack|remote.*.vcs) return 0 ;;
    core.hookspath|core.fsmonitor|core.sshcommand|core.gitproxy|core.askpass|core.editor|core.worktree) return 0 ;;
    diff.external|sequence.editor|uploadpack.packobjectshook) return 0 ;;
    diff.*.textconv|diff.*.command|merge.*.driver|gpg.program|gpg.*.program|difftool.*.cmd|mergetool.*.cmd) return 0 ;;
  esac
  return 1
}

NO_REMOTE="this workspace has no remote and no credentials; when the work is ready, Rye creates a branch in your repository (Create branch)"

# The real git: the first "git" on PATH that isn't this script.
rye_self=$0
rye_self_dir=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd -P)
rye_git=""
set -f
rye_ifs=$IFS
IFS=:
for rye_d in $PATH; do
  [ -n "$rye_d" ] || rye_d=.
  [ -x "$rye_d/git" ] && [ ! -d "$rye_d/git" ] || continue
  rye_real_dir=$(CDPATH= cd -- "$rye_d" 2>/dev/null && pwd -P) || continue
  [ "$rye_real_dir" = "$rye_self_dir" ] && continue
  [ "$rye_d/git" -ef "$rye_self" ] && continue
  rye_git="$rye_d/git"
  break
done
IFS=$rye_ifs
set +f
if [ -z "$rye_git" ]; then
  for rye_p in /usr/bin/git /usr/local/bin/git /opt/homebrew/bin/git; do
    if [ -x "$rye_p" ] && ! [ "$rye_p" -ef "$rye_self" ]; then rye_git=$rye_p; break; fi
  done
fi
if [ -z "$rye_git" ]; then
  printf 'rye: git was not found on PATH\n' >&2
  exit 127
fi

# Pass 1: the global options and the subcommand.
rye_sub=""
rye_subpos=0
rye_n=0
rye_expect=""
rye_aliases=""
for rye_a in "$@"; do
  rye_n=$((rye_n + 1))
  if [ -n "$rye_expect" ]; then
    if [ "$rye_expect" = c ]; then
      case $(rye_lower "$rye_a") in
        alias.*=*) rye_aliases="$rye_aliases
$(rye_lower "@{rye_a%%=*}" | sed 's/^alias\.//')=@{rye_a#*=}" ;;
      esac
    fi
    rye_expect=""
    continue
  fi
  case $rye_a in
    -c) rye_expect=c ;;
    -C|--git-dir|--work-tree|--namespace|--super-prefix|--config-env|--attr-source|--list-cmds) rye_expect=v ;;
    -*) ;;
    *) rye_sub=$(rye_lower "$rye_a"); rye_subpos=$rye_n; break ;;
  esac
done

# git -c alias.<sub>=<value> <sub>: judge what the alias names (a "!" alias runs a shell command;
# Rye's policy asked about it before it got here).
if [ -n "$rye_aliases" ] && [ -n "$rye_sub" ]; then
  IFS='
'
  for rye_line in $rye_aliases; do
    if [ "@{rye_line%%=*}" = "$rye_sub" ]; then
      rye_value=@{rye_line#*=}
      case $rye_value in
        '!'*) ;;
        *) rye_sub=$(rye_lower "$(printf '%s' "$rye_value" | awk '{print $1}')") ;;
      esac
    fi
  done
  IFS=$rye_ifs
fi

# Pass 2: what follows the subcommand.
rye_n=0
rye_first=""
rye_key=""
rye_npos=0
rye_prune=""
rye_rye_ref=""
rye_cfg_action=""
rye_cfg_scope=""
rye_skip=""
for rye_a in "$@"; do
  rye_n=$((rye_n + 1))
  [ "$rye_n" -le "$rye_subpos" ] && continue
  if [ -n "$rye_skip" ]; then rye_skip=""; continue; fi
  case $rye_a in
    --prune*) rye_prune=1 ;;
  esac
  case $rye_a in
    refs/rye|refs/rye/*|refs//rye*) rye_rye_ref=1 ;;
  esac
  if [ "$rye_sub" = config ]; then
    case $rye_a in
      --global|--system) rye_cfg_scope=$rye_a; continue ;;
      -e|--edit) rye_cfg_action=edit; continue ;;
      --get|--get-all|--get-regexp|--get-urlmatch|--get-color|--get-colorbool|--list|-l) rye_cfg_action=get; continue ;;
      --unset|--unset-all|--remove-section) rye_cfg_action=unset; continue ;;
      --add|--replace-all) rye_cfg_action=set; continue ;;
      --rename-section) rye_cfg_action=rename; continue ;;
      --file|-f|--type|--default|--comment|--value|--url|--blob) rye_skip=1; continue ;;
      -*) continue ;;
    esac
    rye_npos=$((rye_npos + 1))
    if [ "$rye_npos" -eq 1 ] && [ -z "$rye_cfg_action" ]; then
      case $rye_a in
        set) rye_cfg_action=set; rye_npos=0; continue ;;
        get|list) rye_cfg_action=get; rye_npos=0; continue ;;
        unset|remove-section) rye_cfg_action=unset; rye_npos=0; continue ;;
        edit) rye_cfg_action=edit; rye_npos=0; continue ;;
        rename-section) rye_cfg_action=rename; rye_npos=0; continue ;;
      esac
    fi
    if [ "$rye_npos" -eq 1 ]; then rye_key=$rye_a; fi
    if [ "$rye_cfg_action" = rename ] && [ "$rye_npos" -eq 2 ] && rye_dangerous_key "$rye_a.x"; then rye_key="$rye_a.x"; fi
    if [ -z "$rye_cfg_action" ] && [ "$rye_npos" -ge 2 ]; then rye_cfg_action=set; fi
    continue
  fi
  case $rye_a in
    -*) ;;
    *) [ -z "$rye_first" ] && rye_first=$rye_a ;;
  esac
done

case $rye_sub in
  push|send-pack|http-push)
    rye_refuse "git push is never allowed in a code session: $NO_REMOTE." ;;
  send-email|imap-send)
    rye_refuse "git $rye_sub sends patches out of the workspace." ;;
  filter-branch|filter-repo)
    rye_refuse "git $rye_sub rewrites every ref at once and isn't allowed in a code session; rewrite single commits with rebase instead." ;;
  clone)
    rye_refuse "git clone isn't allowed: a code session works only in the clone Rye made for it." ;;
  prune)
    rye_refuse "git prune deletes unreachable objects, which the session's snapshots may still need." ;;
  credential|credential-*)
    rye_refuse "git credential commands read or store your git credentials, which code sessions never use." ;;
  for-each-repo)
    rye_refuse "git for-each-repo runs git in other repositories." ;;
  remote)
    case $rye_first in
      add|set-url) rye_refuse "git remote $rye_first isn't allowed: a code session has no remote. When the work is ready, Rye creates a branch in your repository (Create branch)." ;;
    esac ;;
  gc)
    [ -n "$rye_prune" ] && rye_refuse "git gc --prune deletes unreachable objects, which the session's snapshots may still need; run git gc without --prune." ;;
  reflog)
    case $rye_first in
      expire|delete) rye_refuse "git reflog $rye_first deletes the history that makes rewritten work recoverable." ;;
    esac ;;
  update-ref)
    [ -n "$rye_rye_ref" ] && rye_refuse "refs/rye/* hold Rye's snapshots of this session; git update-ref may not touch them." ;;
  maintenance)
    case $rye_first in
      start|register|unregister|stop) rye_refuse "git maintenance $rye_first schedules background jobs and writes your global git config." ;;
    esac ;;
  svn)
    case $rye_first in
      dcommit|set-tree) rye_refuse "git svn $rye_first publishes commits; $NO_REMOTE." ;;
    esac ;;
  p4)
    [ "$rye_first" = submit ] && rye_refuse "git p4 submit publishes commits; $NO_REMOTE." ;;
  lfs)
    [ "$rye_first" = push ] && rye_refuse "git lfs push publishes objects; $NO_REMOTE." ;;
  cvsexportcommit)
    rye_refuse "git cvsexportcommit publishes commits; $NO_REMOTE." ;;
  config)
    case $rye_cfg_action in
      edit) rye_refuse "git config --edit can set any key, including ones that make git run commands; set keys one at a time instead." ;;
      set|rename)
        [ -n "$rye_cfg_scope" ] && rye_refuse "git config $rye_cfg_scope writes configuration outside the workspace."
        if [ -n "$rye_key" ] && rye_dangerous_key "$rye_key"; then
          rye_refuse "git config $rye_key can make git run commands or reach a remote, so a code session never sets it."
        fi ;;
    esac ;;
esac

exec "$rye_git" "$@"
`.replaceAll("@{", "${");

/**
 * Write the shim to `<binDir>/git` with mode 0755 (the workspace puts `binDir` first on PATH).
 * Returns the shim's path. Overwrites an existing file.
 */
export function installGitShim(binDir: string): string {
  mkdirSync(binDir, { recursive: true });
  const path = join(binDir, "git");
  writeFileSync(path, GIT_SHIM_SCRIPT, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

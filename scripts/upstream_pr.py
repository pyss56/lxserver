#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
upstream_pr.py —— 一键把 fork 的「通用功能改动」提交给上游 PR，自动排除 fork 私有代码。

用法（在本仓库根目录执行）：
    python scripts/upstream_pr.py --dry-run            # 只检查并打印计划，不改任何东西
    python scripts/upstream_pr.py                     # 重建干净分支 + 推送 + 复用/新建 PR
    python scripts/upstream_pr.py --title "..." --body-file body.md
    python scripts/upstream_pr.py --message "feat: ..."

设计要点：
  * 唯一需要维护的规则是 FORK_PRIVATE_PATTERNS；规则以「白名单」方式生效，
    未跟踪的诊断脚本、临时文件天然不会进入 commit（不使用 git add -A）。
  * 每次都从 upstream/dev 直接拉基底，落成单 commit，PR head 固定为
    pyss56:upstream-pr，永不拿 dev 当 head。
  * 已有指向该 head 的 open PR 时直接复用（GitHub 不允许改 PR 的 head），
    避免每次新建 PR 产生一堆废弃 PR。
  * 提交前强制校验：排除文件清单、版本号文件是否仅版本字段有差异、
    敏感凭据扫描、CI/私有关键字残留。
"""
import argparse
import fnmatch
import json
import os
import re
import subprocess
import sys
import urllib.request

sys.stdout.reconfigure(encoding="utf-8")

# ============================================================
# 唯一需要维护的规则：fork 私有文件（不提交给上游）
# 新增私有文件时，只需在这里加一条 glob
# ============================================================
FORK_PRIVATE_PATTERNS = [
    ".github/**",              # CI / GHCR 镜像构建 workflow（fork 私有）
    "package.json",            # fork 第 4 位版本号
    "public/js/config.js",     # fork 版本号 / buildHash
    "scripts/upstream_pr.py",  # 本脚本自身：fork 私有工具，不提交给上游
]

# 这些文件只允许「版本号 / buildHash 字段」与上游不同；
# 若其它内容也有差异，脚本会中止，避免静默丢弃合法改动（例如新增依赖）
VERSION_ONLY_FILES = ["package.json", "public/js/config.js"]

# 允许文件里若出现这些词，说明混入了私有 CI 配置
FORBIDDEN_KEYWORDS = [
    "GHCR_TOKEN", "ghcr.io", "DOCKER_PASSWORD", "DOCKER_USERNAME",
    "secrets.GITHUB_TOKEN", "build_and_push", "docker/login-action",
]

# 高敏感凭据（明文）
SENSITIVE_PATTERNS = [
    r"AKIA[0-9A-Z]{16}",
    r"-----BEGIN [A-Z ]+PRIVATE KEY-----",
    r"\bsk-[A-Za-z0-9]{20,}",
    r"\beyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]+\.",
    r"\bghp_[A-Za-z0-9]{30,}",
    r"\bgithub_pat_[A-Za-z0-9_]{30,}",
    r"\bxox[baprs]-[A-Za-z0-9-]+",
    r"Bearer\s+[A-Za-z0-9._-]{20,}",
]

REPO_LOCAL = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE_REF = "upstream/dev"          # 干净基底
SOURCE_REF = "dev"                 # 功能来源（fork 部署分支）
PR_BRANCH = "upstream-pr"          # 固定的 PR head 分支
FORK_OWNER = "pyss56"
UPSTREAM_REPO = "XCQ0607/lxserver"
PR_BASE = "dev"

DEFAULT_TITLE = "feat: 同步 fork 通用功能改动（自动排除 fork 私有代码）"
DEFAULT_MESSAGE = "feat: 同步 fork 通用功能改动至上游（自动排除 fork 私有代码）"


def git(*args, check=True):
    r = subprocess.run(["git", *args], cwd=REPO_LOCAL, capture_output=True,
                       text=True, encoding="utf-8", errors="replace")
    if check and r.returncode != 0:
        raise RuntimeError("git %s 失败: %s" % (" ".join(args), (r.stderr or r.stdout).strip()))
    return r.stdout.strip()


def get_token():
    cred = subprocess.run(["git", "credential", "fill"],
                          input="protocol=https\nhost=github.com\n\n",
                          capture_output=True, text=True).stdout
    for line in cred.splitlines():
        if line.startswith("password="):
            return line[len("password="):]
    raise RuntimeError("无法从 git credential 获取 token")


def api(token, method, url, data=None):
    body = json.dumps(data).encode("utf-8") if data is not None else None
    req = urllib.request.Request(url, data=body, headers={
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "upstream-pr-tool",
    }, method=method)
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode("utf-8"))


def is_private(path):
    return any(fnmatch.fnmatch(path, p) for p in FORK_PRIVATE_PATTERNS)


def normalize_version_fields(path, text):
    """把版本号 / buildHash 的值抹平，用于比较「除版本号外是否还有其它改动」"""
    if path == "package.json":
        text = re.sub(r'("version"\s*:\s*")[^"]*(")', r'\1<VER>\2', text)
    elif path == "public/js/config.js":
        text = re.sub(r"(version:\s*')[^']*(')", r"\1<VER>\2", text)
        text = re.sub(r"(buildHash:\s*')[^']*(')", r"\1<HASH>\2", text)
    return text


def build_body(allowed, excluded, sensitive_clean=True):
    lines = [
        "## 概述",
        "",
        "本 PR 基于 `XCQ0607/dev` 当前代码，提交一组面向上游的通用功能改进，为单一 commit，便于 review。",
        "",
        "> 本 PR 由脚本自动生成，已按规则排除 fork 私有代码；下列文件保持与上游完全一致、零改动：",
    ]
    lines += ["- `%s`" % p for p in FORK_PRIVATE_PATTERNS]
    lines += [
        "",
        "亦不含任何 CI / 镜像发布提交、版本号 bump 历史、临时诊断脚本。",
        "",
        "## 变更文件（%d 个）" % len(allowed),
        "",
    ]
    lines += ["- `%s`" % f for f in allowed]
    lines += [
        "",
        "## 验证",
        "",
        "- 相对 `upstream/dev` 仅上述 %d 个文件，无 `.github` 改动、无版本号文件改动；" % len(allowed),
        "- 与 `dev` 中对应文件内容逐字节一致；",
        "- 敏感凭据扫描：%s；" % ("0 匹配" if sensitive_clean else "见复核"),
        "- 已排除的 fork 私有文件：%s。" % ", ".join("`%s`" % f for f in excluded),
        "",
        "> 注：功能细节说明请在提交 PR 时通过 `--body-file` 补充。",
    ]
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description="一键提交上游 PR（自动排除 fork 私有代码）")
    ap.add_argument("--dry-run", action="store_true", help="只检查并打印计划，不改仓库/GitHub")
    ap.add_argument("--title", default=DEFAULT_TITLE)
    ap.add_argument("--message", default=DEFAULT_MESSAGE)
    ap.add_argument("--body-file", help="自定义 PR 正文（markdown 文件），不传则用自动模板")
    ap.add_argument("--update-body", action="store_true",
                    help="复用已有 PR 时强制覆盖其标题/正文（默认保留原正文，避免丢失手写说明）")
    ap.add_argument("--no-pr", action="store_true", help="只重建并推送分支，不操作 GitHub PR")
    args = ap.parse_args()

    # ---- 1. 计算文件集合（白名单） ----
    name_status = git("diff", "--name-status", BASE_REF, SOURCE_REF)
    changed = []
    for line in name_status.splitlines():
        parts = line.split("\t")
        if len(parts) >= 2:
            status = parts[0][0]
            if status in ("R", "C"):
                raise RuntimeError("检测到重命名/复制：%s\n  脚本不自动处理，请人工确认后手动提交。" % line)
            changed.append((status, parts[-1]))  # (A/M/D, path)

    allowed = [p for status, p in changed if not is_private(p)]
    excluded = [p for status, p in changed if is_private(p)]
    deleted = [p for status, p in changed if status == "D" and not is_private(p)]

    print("== 文件分类 ==")
    print("  dev 相对 %s 变更: %d 个" % (BASE_REF, len(changed)))
    print("  提交给上游: %d 个" % len(allowed))
    print("  排除（fork 私有）: %d 个 -> %s" % (len(excluded), ", ".join(excluded)))

    # ---- 2. 版本号文件：确认仅版本字段有差异 ----
    print("== 版本号文件校验 ==")
    for f in VERSION_ONLY_FILES:
        upstream_txt = git("show", "%s:%s" % (BASE_REF, f), check=False)
        dev_txt = git("show", "%s:%s" % (SOURCE_REF, f), check=False)
        if not upstream_txt or not dev_txt:
            print("  [跳过] %s 无法读取" % f)
            continue
        if normalize_version_fields(f, upstream_txt) != normalize_version_fields(f, dev_txt):
            raise RuntimeError(
                "%s 除版本号字段外还有其它差异，已中止！\n"
                "  请人工确认：要么把该改动加入白名单，要么把它从 dev 中移除。" % f)
        print("  [OK] %s 仅版本号字段不同（其余内容与上游一致）" % f)

    # ---- 3. 敏感信息 / 私有关键字扫描（针对将要提交的内容） ----
    print("== 内容扫描 ==")
    diff_text = git("diff", BASE_REF, SOURCE_REF, "--", *allowed) if allowed else ""
    hits = []
    for pat in SENSITIVE_PATTERNS:
        hits += ["凭据 %s" % pat for _ in re.finditer(pat, diff_text)]
    hits += ["私有关键字 %s" % kw for kw in FORBIDDEN_KEYWORDS if kw in diff_text]
    if hits:
        raise RuntimeError("提交内容中发现可疑内容，已中止：\n  " + "\n  ".join(hits[:20]))
    print("  [OK] 敏感凭据 0 匹配；私有 CI 关键字 0 匹配")

    body = (open(args.body_file, "r", encoding="utf-8").read()
            if args.body_file else build_body(allowed, excluded))

    if args.dry_run:
        print("\n[dry-run] 计划：")
        print("  - 从 %s 重建分支 %s（单 commit）" % (BASE_REF, PR_BRANCH))
        print("  - 写入 %d 个允许文件%s" % (len(allowed), "（其中删除 %d 个）" % len(deleted) if deleted else ""))
        print("  - force-with-lease 推送 origin/%s" % PR_BRANCH)
        if not args.no_pr:
            print("  - 复用 head=%s:%s 的 open PR，若无则新建" % (FORK_OWNER, PR_BRANCH))
        print("  - 未做任何改动（dry-run）")
        return

    # ---- 4. 检查工作区，避免切换分支时覆盖已跟踪的未提交改动 ----
    dirty = [l for l in git("status", "--porcelain").splitlines()
             if not l.startswith("??")]
    if dirty:
        raise RuntimeError("存在已跟踪文件的未提交改动，请先处理：\n  " + "\n  ".join(dirty[:10]))

    # ---- 5. 从上游基底重建干净分支 ----
    print("== 重建干净分支 ==")
    git("fetch", "upstream", "dev")
    git("fetch", "origin", "dev")
    git("fetch", "origin", PR_BRANCH, check=False)  # 首次运行时远端可能还没有该分支，容错
    git("checkout", "-B", PR_BRANCH, BASE_REF)
    for status, f in changed:
        if is_private(f):
            continue
        if status == "D":
            git("rm", "-f", "--", f, check=False)
        else:
            git("checkout", SOURCE_REF, "--", f)

    staged = git("diff", "--cached", "--name-only")
    staged_files = staged.splitlines() if staged else []
    unexpected = [f for f in staged_files if is_private(f) or f not in allowed]
    if unexpected:
        raise RuntimeError("暂存区出现非预期文件，已中止：%s" % unexpected)
    print("  [OK] 暂存 %d 个文件，全部在白名单内" % len(staged_files))

    git("commit", "-m", args.message)
    print("  [OK] 单 commit 已生成")

    # ---- 6. 推送 ----
    print("== 推送 ==")
    git("push", "--force-with-lease", "origin", PR_BRANCH)
    print("  [OK] origin/%s 已更新" % PR_BRANCH)

    if args.no_pr:
        print("\n完成（--no-pr，未操作 GitHub PR）")
        return

    # ---- 7. 复用或新建 PR ----
    print("== GitHub PR ==")
    token = get_token()
    root = "https://api.github.com/repos/%s" % UPSTREAM_REPO
    head_label = "%s:%s" % (FORK_OWNER, PR_BRANCH)
    existing = api(token, "GET", root + "/pulls?state=open&head=%s&base=%s&per_page=10"
                   % (head_label, PR_BASE))
    if existing:
        pr = existing[0]
        if args.update_body or args.body_file:
            pr = api(token, "PATCH", root + "/pulls/%d" % pr["number"],
                     {"title": args.title, "body": body})
            print("  [OK] 复用 PR #%d 并按要求更新标题/正文" % pr["number"])
        else:
            print("  [OK] 复用 PR #%d（保留原有标题/正文，仅更新 commit）" % pr["number"])
        print("       %s" % pr["html_url"])
    else:
        pr = api(token, "POST", root + "/pulls",
                 {"title": args.title, "head": head_label, "base": PR_BASE, "body": body})
        print("  [OK] 新建 PR #%d: %s" % (pr["number"], pr["html_url"]))
        # 关闭其它仍 open 的、由本 fork 发出的旧 PR 并留言
        others = api(token, "GET", root + "/pulls?state=open&per_page=50")
        for o in others:
            if o["number"] == pr["number"]:
                continue
            if not o["head"]["label"].startswith(FORK_OWNER + ":"):
                continue
            try:
                api(token, "POST", root + "/issues/%d/comments" % o["number"],
                    {"body": "已由 #%d 替代：本 PR 的 head 不是固定的干净分支 `%s`，"
                             "且可能包含 fork 私有的 CI / 版本号提交。" % (pr["number"], PR_BRANCH)})
                api(token, "PATCH", root + "/pulls/%d" % o["number"], {"state": "closed"})
                print("  [OK] 关闭旧 PR #%d" % o["number"])
            except Exception as e:
                print("  [warn] 关闭旧 PR #%d 失败: %s" % (o["number"], e))

    print("\n完成：%s" % pr["html_url"])


if __name__ == "__main__":
    original_branch = ""
    try:
        original_branch = git("branch", "--show-current")
        main()
    except Exception as e:
        print("ERROR: %s" % e, file=sys.stderr)
        sys.exit(1)
    finally:
        # 无论成功或中途失败，都切回进入脚本时所在的分支
        if original_branch:
            cur = git("branch", "--show-current", check=False)
            if cur and cur != original_branch:
                git("checkout", original_branch, check=False)
                print("\n[恢复] 已切回原分支 %s" % original_branch)

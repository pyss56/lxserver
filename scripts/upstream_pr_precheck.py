#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
upstream_pr_precheck.py —— 执行 scripts/upstream_pr.py 之前的本地 CodeRabbit 预检。

定位：把上游 PR 上的机器人评审「左移」到本机，减少推 PR 后被退回修改的轮次。
本脚本不推送、不建 PR、不改分支内容，只做校验与本地评审。

用法（在仓库根目录执行）：
    python scripts/upstream_pr_precheck.py --check-only     # 只做接线自检，不调用 CLI
    python scripts/upstream_pr_precheck.py                  # 完整预检
    python scripts/upstream_pr_precheck.py --gate critical  # 放宽阻断阈值
    python scripts/upstream_pr_precheck.py --agent          # NDJSON 结构化输出（供 AI 消费）
    python scripts/upstream_pr_precheck.py --cr-args "--fresh"

退出码：
    0  预检通过，可执行 python scripts/upstream_pr.py
    1  前置校验失败 / CLI 缺失 / 评审失败或未覆盖全部文件
    2  评审发现 --gate 阈值及以上级别的问题（阻断）
"""
import argparse
import importlib.util
import os
import shlex
import shutil
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")
sys.dont_write_bytecode = True  # 动态加载 upstream_pr.py 时不要在仓库里留下 __pycache__

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UPSTREAM_TOOL = os.path.join(REPO, "scripts", "upstream_pr.py")
BASE_REF = "upstream/dev"
SOURCE_REF = "dev"
PRECHECK_BASE = "precheck-base"
CODERABBIT_CONFIG = ".coderabbit.yaml"

# 本方案新增的 fork 私有文件，必须已登记进 upstream_pr.py 的 FORK_PRIVATE_PATTERNS
OWN_FILES = [CODERABBIT_CONFIG, "scripts/upstream_pr_precheck.py"]

INSTALL_HINT = """\
本机尚未检测到 CodeRabbit CLI（cr / coderabbit）。请先完成一次性准备：

  PowerShell:
      irm https://cli.coderabbit.ai/install.ps1 | iex
      # 重开 PowerShell 窗口后
      cr auth login          # 浏览器 OAuth，不要把 API key 写进命令行
      cr doctor

完成后重跑：python scripts/upstream_pr_precheck.py
"""


def step(title):
    print("\n== %s ==" % title)


def git(*args, check=True):
    r = subprocess.run(["git", *args], cwd=REPO, capture_output=True,
                       text=True, encoding="utf-8", errors="replace")
    if check and r.returncode != 0:
        raise RuntimeError("git %s 失败: %s" % (" ".join(args), (r.stderr or r.stdout).strip()))
    return r


def load_rules():
    """直接复用 upstream_pr.py 的规则常量，保证排除清单只有一个事实来源。"""
    spec = importlib.util.spec_from_file_location("upstream_pr_rules", UPSTREAM_TOOL)
    if spec is None or spec.loader is None:
        raise RuntimeError("无法加载 %s" % UPSTREAM_TOOL)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def preflight(rules):
    step("1/5 接线自检")
    if git("rev-parse", "--verify", BASE_REF, check=False).returncode != 0:
        raise RuntimeError("缺少 %s，请先执行：git fetch upstream dev" % BASE_REF)

    cur = git("branch", "--show-current").stdout.strip()
    if cur != SOURCE_REF:
        raise RuntimeError("预检需要在 %s 分支上运行（当前 %s）；CLI 的 --base 比较的是当前工作区。"
                           % (SOURCE_REF, cur or "<detached>"))
    print("  [OK] 当前分支 %s；基底 %s" % (cur, BASE_REF))

    missing = [f for f in OWN_FILES if not rules.is_private(f)]
    if missing:
        raise RuntimeError("以下 fork 私有文件未登记进 FORK_PRIVATE_PATTERNS，会被带进上游 PR：%s"
                           % ", ".join(missing))
    print("  [OK] 新增的 %d 个文件均已被 FORK_PRIVATE_PATTERNS 排除" % len(OWN_FILES))

    if not os.path.isfile(os.path.join(REPO, CODERABBIT_CONFIG)):
        raise RuntimeError("缺少 %s，CLI 评审范围无法与上游 PR 对齐" % CODERABBIT_CONFIG)
    print("  [OK] %s 存在" % CODERABBIT_CONFIG)

    dirty = [l for l in git("status", "--porcelain").stdout.splitlines()
             if l.strip() and not l.startswith("??")]
    if dirty:
        print("  [提示] 存在 %d 个已跟踪文件的未提交改动；CLI 会把它们一并评审，"
              "而下面的 dry-run 只比较两个 ref，不含这些改动。" % len(dirty))

    step("2/5 复用上游 PR 的提交前校验（dry-run）")
    r = subprocess.run([sys.executable, UPSTREAM_TOOL, "--dry-run"], cwd=REPO,
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    print(r.stdout.rstrip())
    if r.returncode != 0:
        raise RuntimeError("upstream_pr.py --dry-run 未通过：\n%s" % (r.stderr or r.stdout).strip())
    print("  [OK] 版本号文件 / 敏感凭据 / 私有 CI 关键字校验通过")

    step("3/5 评审范围对齐")
    name_status = git("diff", "--name-status", BASE_REF, SOURCE_REF).stdout.strip()
    changed = []
    for line in name_status.splitlines():
        parts = line.split("\t")
        if len(parts) >= 2:
            changed.append(parts[-1])
    allowed = [p for p in changed if not rules.is_private(p)]
    excluded = [p for p in changed if rules.is_private(p)]
    print("  变更 %d 个；将提交上游 %d 个；fork 私有排除 %d 个"
          % (len(changed), len(allowed), len(excluded)))
    print("  path_filters 已排除：%s" % ", ".join(sorted(set(excluded + OWN_FILES))))
    if not allowed:
        print("  [warn] 没有需要提交给上游的文件，CLI 评审可能为空")

    step("4/5 建立本地比较基准 %s" % PRECHECK_BASE)
    r = git("branch", "-f", PRECHECK_BASE, BASE_REF, check=False)
    if r.returncode != 0:
        raise RuntimeError("无法创建 %s：%s" % (PRECHECK_BASE, (r.stderr or r.stdout).strip()))
    base_sha = git("rev-parse", PRECHECK_BASE).stdout.strip()
    if base_sha != git("rev-parse", BASE_REF).stdout.strip():
        raise RuntimeError("基准分支未对齐 %s" % BASE_REF)
    print("  [OK] %s -> %s (%s)" % (PRECHECK_BASE, BASE_REF, base_sha[:12]))
    return allowed


def find_cli():
    for name in ("cr", "coderabbit"):
        if shutil.which(name):
            return name
    return None


def run_review(args, cli):
    step("5/5 本地 AI 评审（通常耗时 7-30 分钟）")
    cmd = [cli, "review", "--base", PRECHECK_BASE, "--deep", "--gate", args.gate]
    if args.agent:
        cmd.append("--agent")
    if args.cr_args:
        cmd.extend(shlex.split(args.cr_args))
    cmd += ["-c", CODERABBIT_CONFIG]
    print("  $ %s" % " ".join(cmd))
    print("  --- CodeRabbit CLI 输出开始 ---")
    started = time.time()
    code = subprocess.run(cmd, cwd=REPO).returncode
    elapsed = int(time.time() - started)
    print("  --- CodeRabbit CLI 输出结束 ---")
    print("  评审退出码 %d，耗时 %dm%02ds" % (code, elapsed // 60, elapsed % 60))
    return code


def main():
    ap = argparse.ArgumentParser(description="提交上游 PR 之前的本地 CodeRabbit 预检")
    ap.add_argument("--check-only", action="store_true",
                    help="只做前置校验与范围对齐，不调用 CLI（无需安装/登录）")
    ap.add_argument("--gate", default="major",
                    choices=["critical", "major", "minor", "trivial", "info"],
                    help="阻断阈值，默认 major")
    ap.add_argument("--agent", action="store_true", help="输出 NDJSON 结构化 findings")
    ap.add_argument("--cr-args", default="",
                    help="附加 CLI flag（只传 flag，不要传位置参数或另一个 -c）")
    args = ap.parse_args()

    try:
        rules = load_rules()
        allowed = preflight(rules)
    except Exception as e:
        print("\nERROR: %s" % e, file=sys.stderr)
        return 1

    if args.check_only:
        print("\n[check-only] 前置校验全部通过，未调用 CodeRabbit CLI。")
        print("  评审范围 %d 个文件；确认无误后可继续：python scripts/upstream_pr.py" % len(allowed))
        return 0

    cli = find_cli()
    if not cli:
        # 走 stdout：PowerShell 5.1 会把子进程的 stderr 当作 NativeCommandError 展示，
        # 且中文提示容易在重编码时乱码。
        print("\n" + INSTALL_HINT)
        return 1
    try:
        ver = subprocess.run([cli, "--version"], capture_output=True, text=True).stdout.strip()
    except OSError:
        ver = "unknown"
    print("\n  CLI: %s %s" % (cli, ver))

    try:
        code = run_review(args, cli)
    except KeyboardInterrupt:
        print("\n已中断。", file=sys.stderr)
        return 1

    print("\n== 预检汇总 ==")
    if code == 0:
        print("  结论：PASS（无 %s 及以上级别问题）" % args.gate)
        print("  下一步：python scripts/upstream_pr.py")
    elif code == 2:
        print("  结论：BLOCK（存在 %s 及以上级别问题），请先修改再重跑" % args.gate)
        print("  复看：cr review findings")
    else:
        print("  结论：ERROR（评审失败或未覆盖全部文件），退出码 %d" % code)
        print("  排查：cr doctor / cr auth status / cr usage")
    print("  注：CLI 评审与上游 PR 评审的策略、上下文不完全一致，本地 PASS 不等于上游零意见。")
    print("  注：本脚本不推送、不建 PR；push 仍由 scripts/upstream_pr.py 负责。")
    return code


if __name__ == "__main__":
    sys.exit(main())

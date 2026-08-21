#!/usr/bin/env python3
import os
import pty
import re
import select
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional

DOCTOR_CHECK_PATTERN = r"\[(OK|ATTN|WARN|FAIL)\]\s+[A-Za-z0-9-]+:"
DOCTOR_HARNESS_PATTERN = r"\[(OK|FAIL)\]\s+harness-validation:"
DOCTOR_PROVIDER_PATTERN = r"\[(OK|ATTN|WARN|FAIL)\]\s+codex-chat-provider-compatibility:"
DOCTOR_PROVIDER_OK_PATTERN = r"\[OK\]\s+codex-chat-provider-compatibility:"


def wait_for(fd: int, pattern: str, timeout: float, buffer_text: str) -> str:
    deadline = time.time() + timeout
    regex = re.compile(pattern, re.MULTILINE)
    joined = buffer_text
    if regex.search(joined):
        return joined
    while time.time() < deadline:
        ready, _, _ = select.select([fd], [], [], max(0.1, deadline - time.time()))
        if not ready:
            continue
        try:
            data = os.read(fd, 8192)
        except OSError:
            break
        if not data:
            break
        joined += data.decode("utf-8", errors="ignore")
        if regex.search(joined):
            return joined
    print(f"FAIL: pattern not found: {pattern}")
    if joined:
        print("---- recent buffer ----")
        print(joined[-6000:])
        print("-----------------------")
    raise SystemExit(1)



def doctor_command_contract_error(doctor_command: str, output: str) -> Optional[str]:
    if doctor_command == "/doctor --live-provider":
        if not re.search(DOCTOR_PROVIDER_OK_PATTERN, output, re.MULTILINE):
            return "live-provider doctor validation requires an OK compatibility row"
        return None
    if re.search(DOCTOR_PROVIDER_PATTERN, output, re.MULTILINE):
        return "default doctor validation must not include a compatibility row"
    return None


def run_doctor_pattern_selftest() -> int:
    current = "+ [OK] disk-free-space: Disk space looks healthy.\nx [FAIL] harness-validation: 1 issue(s), 1 run(s) checked\n"
    previous = "+ [OK] readiness: ok\n+ [OK] harness-validation: 0 issue(s), 0 run(s) checked\n"
    if not re.search(DOCTOR_CHECK_PATTERN, current):
        print("FAIL: doctor check pattern did not match current check-row output")
        return 1
    if not re.search(DOCTOR_HARNESS_PATTERN, current):
        print("FAIL: doctor harness pattern did not match current harness output")
        return 1
    if not re.search(DOCTOR_CHECK_PATTERN, previous):
        print("FAIL: doctor check pattern did not preserve older readiness output")
        return 1
    if not re.search(DOCTOR_HARNESS_PATTERN, previous):
        print("FAIL: doctor harness pattern did not preserve older harness output")
        return 1
    live_ok = "+ [OK] codex-chat-provider-compatibility: compatible\n" + current
    live_warn = "+ [WARN] codex-chat-provider-compatibility: timeout\n" + current
    if doctor_command_contract_error("/doctor --live-provider", live_ok) is not None:
        print("FAIL: live-provider doctor contract rejected an OK compatibility row")
        return 1
    if doctor_command_contract_error("/doctor --live-provider", current) is None:
        print("FAIL: live-provider doctor contract accepted a missing compatibility row")
        return 1
    if doctor_command_contract_error("/doctor --live-provider", live_warn) is None:
        print("FAIL: live-provider doctor contract accepted a warning compatibility row")
        return 1
    if doctor_command_contract_error("/doctor", live_ok) is None:
        print("FAIL: default doctor contract accepted an unexpected compatibility row")
        return 1
    if doctor_command_contract_error("/doctor", current) is not None:
        print("FAIL: default doctor contract rejected output without a compatibility row")
        return 1
    print("PASS: live-validation doctor output pattern self-test")
    return 0

def send_line(fd: int, text: str) -> None:
    os.write(fd, text.encode("utf-8") + b"\n")


def main() -> int:
    if os.environ.get("AUTOLABOS_VALIDATION_DOCTOR_PATTERN_SELFTEST", "") == "1":
        return run_doctor_pattern_selftest()
    doctor_command = os.environ.get("AUTOLABOS_VALIDATION_DOCTOR_COMMAND", "/doctor").strip()
    if doctor_command not in {"/doctor", "/doctor --live-provider"}:
        print("FAIL: AUTOLABOS_VALIDATION_DOCTOR_COMMAND must be /doctor or /doctor --live-provider")
        return 1
    repo_root = Path(__file__).resolve().parents[1]
    default_workspace = repo_root.parent / ".autolabos-validation" / "live-validation"
    workspace = Path(os.environ.get("AUTOLABOS_VALIDATION_WORKSPACE", str(default_workspace))).resolve()
    output_dir = Path(os.environ.get("AUTOLABOS_VALIDATION_PREFLIGHT_OUT", str(repo_root / "outputs" / "live-validation-preflight"))).resolve()
    dist_main = repo_root / "dist" / "cli" / "main.js"
    output_dir.mkdir(parents=True, exist_ok=True)

    if not workspace.exists():
        print(f"FAIL: workspace does not exist: {workspace}")
        return 1
    config_path = workspace / ".autolabos" / "config.yaml"
    if not config_path.is_file():
        print(f"FAIL: validation workspace is not prepared: missing {config_path}")
        print(
            "Run `npm run validation:preflight` with an explicit "
            "AUTOLABOS_VALIDATION_BRIEF_SOURCE before `npm run validation:doctor`."
        )
        return 1
    if not dist_main.exists():
        print(f"FAIL: expected built CLI at {dist_main}; run npm run build first")
        return 1

    env = os.environ.copy()
    env["COLUMNS"] = "220"
    env["LINES"] = "40"

    master_fd, slave_fd = pty.openpty()
    proc = subprocess.Popen(
        ["node", str(dist_main)],
        cwd=str(workspace),
        env=env,
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        preexec_fn=os.setsid,
        close_fds=True,
    )
    os.close(slave_fd)

    buffer_text = ""
    try:
        buffer_text = wait_for(
            master_fd,
            r"(Research Brief workflow is ready|Start with /new to create a Research Brief\.|Add steering, or wait for the next (?:run or )?approval\.|collect_papers pending)",
            40,
            buffer_text,
        )
        send_line(master_fd, doctor_command)
        buffer_text = wait_for(master_fd, DOCTOR_CHECK_PATTERN, 40, buffer_text)
        buffer_text = wait_for(master_fd, DOCTOR_HARNESS_PATTERN, 40, buffer_text)
        send_line(master_fd, "/quit")
        buffer_text = wait_for(master_fd, r"Bye", 10, buffer_text)
    finally:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except Exception:
            pass
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
        try:
            os.close(master_fd)
        except OSError:
            pass

    output_path = output_dir / "doctor-pty-output.txt"
    output_path.write_text(buffer_text, encoding="utf-8")
    command_contract_error = doctor_command_contract_error(doctor_command, buffer_text)
    if command_contract_error:
        print(f"FAIL: {command_contract_error}; see {output_path}")
        return 1
    if "[ATTN] readiness:" in buffer_text or "[FAIL] harness-validation:" in buffer_text:
        print(f"FAIL: requested doctor command completed with attention/fail status; see {output_path}")
        return 1
    print(f"PASS: requested doctor command completed through Python PTY fallback; output={output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

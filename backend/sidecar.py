"""PhoNote 的后端进程：把驱动平台的 pho_note 插件当成本地服务跑起来。

桌面端（Electron 主进程）在启动时用随机端口拉起这个进程，退出时杀掉它；
打出来的 exe 已经把 driver_platform 一起装进包里，所以最终用户不需要 Python。

三类参数：
  --port       监听端口（主进程挑一个空闲端口传进来）
  --data-dir   笔记库目录（默认 %APPDATA%\\PhoNote\\notes）
  --ai-*       模型配置，直接映射到平台的 DRIVER_NOTES_LLM* 开关

设计上只做「把已有插件装配起来」这件事：不复制任何业务逻辑，
笔记、批注、版本、同步都仍是插件里那一套（P0–P3 已验收）。
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path


def _default_data_dir() -> Path:
    base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
    return Path(base) / "PhoNote" / "notes"


def build_settings(args: argparse.Namespace):
    # 延迟 import：PyInstaller 在解析参数前就把这些打进了包，但这样写让 --help 更快
    from driver_platform.config import Settings

    return Settings(
        plugins=("pho_note",),
        notes_dir=str(Path(args.data_dir).expanduser()),
        notes_ui=True,
        notes_llm=args.ai_mode,
        notes_llm_base_url=args.ai_base_url,
        notes_llm_api_key=args.ai_api_key,
        notes_llm_model=args.ai_model,
        auth_mode="off",
        log_level="WARNING",
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="phonote-backend", description="PhoNote 本地后端")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--data-dir", default=str(_default_data_dir()))
    parser.add_argument("--ai-mode", default="off", choices=("off", "openai", "anthropic", "manual"))
    parser.add_argument("--ai-base-url", default="")
    parser.add_argument("--ai-api-key", default="")
    parser.add_argument("--ai-model", default="")
    args = parser.parse_args(argv)

    from driver_platform.main import create_app
    import uvicorn

    data_dir = Path(args.data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)

    application = create_app(build_settings(args))
    print(f"phonote-backend ready on 127.0.0.1:{args.port} (data: {data_dir})", flush=True)
    uvicorn.run(
        application,
        host="127.0.0.1",
        port=args.port,
        log_level="warning",
        access_log=False,
        timeout_graceful_shutdown=5,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

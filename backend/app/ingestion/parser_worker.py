"""隔离 Docling 的模型下载、初始化锁及 CPU 处理，标准输出仅传递结果。"""

import json
import sys
import traceback

from app.ingestion.parser import _convert_sync


def main() -> int:
    try:
        markdown = _convert_sync(sys.argv[1], sys.stdin.buffer.read())
        print(json.dumps({"markdown": markdown}, ensure_ascii=False))
        return 0
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"error": str(exc)[-2000:]}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
